import path from "path";
import { promises as fsPromises } from "fs";
import fs from "fs";
import { Readable, Transform, finished } from "stream";
import { pipeline } from "stream/promises";
import { MultipartFile } from "@fastify/multipart";
import crypto from "crypto";
import { HttpError } from "../../utils/HttpError";
import {
  CONTENT_TYPE_MAP,
  DEFAULT_CONTENT_TYPE,
} from "../../constants/contentTypes";

/**
 * 전체 요청 합산 디스크 쓰기 속도 제한 (bytes/sec). 0이면 제한 없음.
 * 예) 2 * 1024 * 1024 → 모든 동시 업로드 합산 2MB/s
 */
const DISK_WRITE_BPS: number = 1000 * 1024 * 1024;

// 전역 토큰 버킷 - 모든 동시 요청이 공유
let _diskTokens = DISK_WRITE_BPS;
let _diskLastRefill = Date.now();

/**
 * 전역 토큰 버킷에서 bytes만큼 소비될 때까지 대기
 * 모든 동시 요청이 이 버킷을 공유하므로 합산 속도가 DISK_WRITE_BPS로 제한됨
 */
function consumeDiskTokens(bytes: number): Promise<void> {
  return new Promise((resolve) => {
    const tryConsume = () => {
      const now = Date.now();
      const elapsed = (now - _diskLastRefill) / 1000;
      _diskTokens = Math.min(
        DISK_WRITE_BPS,
        _diskTokens + elapsed * DISK_WRITE_BPS,
      );
      _diskLastRefill = now;

      if (_diskTokens >= bytes) {
        _diskTokens -= bytes;
        resolve();
      } else {
        const waitMs = Math.max(
          1,
          ((bytes - _diskTokens) / DISK_WRITE_BPS) * 1000,
        );
        setTimeout(tryConsume, waitMs);
      }
    };
    tryConsume();
  });
}

/** 디스크 쓰기 속도 제한 Transform 스트림 생성 (전역 토큰 버킷 사용) */
function createDiskThrottle(): Transform {
  const CHUNK = 64 * 1024; // 64KB 단위로 처리

  return new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      let offset = 0;
      const pushNext = async () => {
        if (offset >= chunk.length) {
          callback();
          return;
        }
        const slice = chunk.subarray(offset, offset + CHUNK);
        offset += slice.length;
        await consumeDiskTokens(slice.length);
        this.push(slice);
        pushNext();
      };
      pushNext();
    },
  });
}

/* 현재 진행 중인 DISK 쓰기 작업 수 (pipeline 단위)*/
let _activeDiskWrites = 0;

/* 현재 활성 DISK 쓰기 작업 수 반환 (외부 읽기용)*/
export function getActiveDiskWrites(): number {
  return _activeDiskWrites;
}

/* 현재 진행 중인 DISK 읽기 스트림 수 */
let _activeDiskReads = 0;

/* 현재 활성 DISK 읽기 스트림 수 반환 (외부 읽기용) */
export function getActiveDiskReads(): number {
  return _activeDiskReads;
}

/**
 * 객체 상태 enum
 */
export enum ObjectStatus {
  PENDING = "PENDING",
  COMPLETE = "COMPLETE",
  FAILED = "FAILED",
}

/**
 * 파일 정보 타입
 */
export interface FileInfo {
  bucket: string;
  objectKey: string;
  filename: string;
  mimetype: string;
  encoding: string;
  size: number;
  uploadedAt: string;
  storagePath: string;
  etag?: string;
}

/**
 * 파일 업로드 데이터 검증
 */
export function validateFileData(data: MultipartFile | undefined): void {
  if (!data) {
    throw new HttpError(400, "파일이 업로드되지 않았습니다");
  }
}

/**
 * 파일을 로컬 파일시스템에 저장
 */
export async function saveFileToStorage(
  bucket: string,
  objectKey: string,
  fileData: MultipartFile,
): Promise<string> {
  const filePath = path.join(process.cwd(), "uploads", bucket, objectKey);
  const fileDir = path.dirname(filePath);

  // 디렉토리 생성 (없으면)
  await fsPromises.mkdir(fileDir, { recursive: true });

  // 파일 저장
  const writeStream = fs.createWriteStream(filePath);
  writeStream.once("close", () => {
    _activeDiskWrites--;
  });
  _activeDiskWrites++;
  await pipeline(fileData.file, writeStream);

  return filePath;
}

/**
 * 파일 정보 수집
 */
export async function collectFileInfo(
  bucket: string,
  objectKey: string,
  filePath: string,
  fileData: MultipartFile,
): Promise<FileInfo> {
  const fileStats = await fsPromises.stat(filePath);
  const etag = await generateETag(filePath);

  return {
    bucket,
    objectKey: objectKey,
    filename: fileData.filename,
    mimetype: fileData.mimetype,
    encoding: fileData.encoding,
    size: fileStats.size,
    uploadedAt: new Date().toISOString(),
    storagePath: filePath,
    etag,
  };
}

/**
 * Raw 스트림을 로컬 파일시스템에 저장 (복제 수신용)
 */
export async function saveStreamToStorage(
  bucket: string,
  objectKey: string,
  stream: Readable,
): Promise<string> {
  const filePath = path.join(process.cwd(), "uploads", bucket, objectKey);
  const fileDir = path.dirname(filePath);

  await fsPromises.mkdir(fileDir, { recursive: true });

  const writeStream = fs.createWriteStream(filePath, {
    highWaterMark: 64 * 1024 * 1024,
  });
  writeStream.once("close", () => {
    _activeDiskWrites--;
  });
  _activeDiskWrites++;

  if (DISK_WRITE_BPS > 0) {
    await pipeline(stream, createDiskThrottle(), writeStream);
  } else {
    await pipeline(stream, writeStream);
  }

  return filePath;
}

/**
 * Raw 스트림으로 저장된 파일 정보 수집 (복제 수신용)
 */
export async function collectStreamFileInfo(
  bucket: string,
  objectKey: string,
  filePath: string,
  mimetype: string,
): Promise<FileInfo> {
  const fileStats = await fsPromises.stat(filePath);
  const etag = await generateETag(filePath);

  return {
    bucket,
    objectKey,
    filename: path.basename(objectKey),
    mimetype,
    encoding: "binary",
    size: fileStats.size,
    uploadedAt: new Date().toISOString(),
    storagePath: filePath,
    etag,
  };
}

/**
 * 파일의 SHA-256 해시를 생성하여 ETag로 사용
 */
export async function generateETag(filePath: string): Promise<string> {
  const fileBuffer = await fsPromises.readFile(filePath);
  const hash = crypto.createHash("sha256");
  hash.update(fileBuffer);
  return hash.digest("hex");
}

/**
 * 저장된 파일 삭제 (롤백용)
 */
export async function deleteFile(filePath: string): Promise<void> {
  try {
    await fsPromises.unlink(filePath);
  } catch (error) {
    // 파일이 없어도 무시
  }
}

/**
 * 확장자로 Content-Type 유추
 */
export function getContentTypeFromExtension(objectKey: string): string {
  const ext = path.extname(objectKey).toLowerCase();
  return CONTENT_TYPE_MAP[ext] || DEFAULT_CONTENT_TYPE;
}

/**
 * 파일 읽기 스트림 생성
 */
export function getFileStream(
  bucket: string,
  objectKey: string,
): fs.ReadStream {
  const filePath = path.join(process.cwd(), "uploads", bucket, objectKey);

  // 파일 존재 여부 확인 (동기)
  if (!fs.existsSync(filePath)) {
    throw new HttpError(404, `파일을 찾을 수 없습니다: ${bucket}/${objectKey}`);
  }

  const stream = fs.createReadStream(filePath, {
    highWaterMark: 64 * 1024 * 1024,
  });
  _activeDiskReads++;
  finished(stream, () => {
    _activeDiskReads--;
  });

  return stream;
}
