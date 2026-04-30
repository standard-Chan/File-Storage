import path from 'path'
import { promises as fsPromises } from 'fs'
import fs from 'fs'
import { Readable, finished } from 'stream'
import { pipeline } from 'stream/promises'
import { MultipartFile } from '@fastify/multipart'
import { FastifyBaseLogger } from 'fastify'
import crypto from 'crypto'
import { HttpError } from '../../utils/HttpError'
import { CONTENT_TYPE_MAP, DEFAULT_CONTENT_TYPE } from '../../constants/contentTypes'

const UPLOAD_BASE_DIR = process.env.UPLOAD_BASE_DIR ?? 'uploads'

/* 현재 진행 중인 DISK 쓰기 작업 수 (pipeline 단위)*/
let _activeDiskWrites = 0

/* 현재 활성 DISK 쓰기 작업 수 반환 (외부 읽기용)*/
export function getActiveDiskWrites(): number {
  return _activeDiskWrites
}

/* 현재 진행 중인 DISK 읽기 스트림 수 */
let _activeDiskReads = 0

/* 현재 활성 DISK 읽기 스트림 수 반환 (외부 읽기용) */
export function getActiveDiskReads(): number {
  return _activeDiskReads
}

/**
 * 객체 상태 enum
 */
export enum ObjectStatus {
  PENDING = 'PENDING',
  COMPLETE = 'COMPLETE',
  FAILED = 'FAILED'
}

/**
 * 파일 정보 타입
 */
export interface FileInfo {
  bucket: string
  objectKey: string
  filename: string
  mimetype: string
  encoding: string
  size: number
  uploadedAt: string
  storagePath: string
  etag?: string
}

/**
 * 파일 업로드 데이터 검증
 */
export function validateFileData(data: MultipartFile | undefined): void {
  if (!data) {
    throw new HttpError(
      400,
      '파일이 업로드되지 않았습니다'
    )
  }
}

/**
 * 파일 정보 수집
 */
export async function collectFileInfo(
  bucket: string,
  objectKey: string,
  filePath: string,
  fileData: MultipartFile
): Promise<FileInfo> {
  const fileStats = await fsPromises.stat(filePath)
  const etag = await generateETag(filePath)
  
  return {
    bucket,
    objectKey: objectKey,
    filename: fileData.filename,
    mimetype: fileData.mimetype,
    encoding: fileData.encoding,
    size: fileStats.size,
    uploadedAt: new Date().toISOString(),
    storagePath: filePath,
    etag
  }
}

/**
 * Raw 스트림을 로컬 파일시스템에 저장 (복제 수신용)
 */
export async function saveStreamToStorage(
  bucket: string,
  objectKey: string,
  stream: Readable,
  log: FastifyBaseLogger,
): Promise<string> {

  const filePath = path.join(process.cwd(), UPLOAD_BASE_DIR, bucket, objectKey)
  const fileDir = path.dirname(filePath)

  await fsPromises.mkdir(fileDir, { recursive: true })

  const writeStream = fs.createWriteStream(filePath)
  writeStream.once('close', () => { _activeDiskWrites-- })
  _activeDiskWrites++
  await pipeline(stream, writeStream)

  return filePath
}

/**
 * Raw 스트림으로 저장된 파일 정보 수집 (복제 수신용)
 */
export async function collectStreamFileInfo(
  bucket: string,
  objectKey: string,
  filePath: string,
  mimetype: string
): Promise<FileInfo> {
  const fileStats = await fsPromises.stat(filePath)
  const etag = await generateETag(filePath)

  return {
    bucket,
    objectKey,
    filename: path.basename(objectKey),
    mimetype,
    encoding: 'binary',
    size: fileStats.size,
    uploadedAt: new Date().toISOString(),
    storagePath: filePath,
    etag,
  }
}

/**
 * 파일의 SHA-256 해시를 생성하여 ETag로 사용
 */
export async function generateETag(filePath: string): Promise<string> {
  const hash = crypto.createHash('sha256')

  await new Promise<void>((resolve, reject) => {
    const readStream = fs.createReadStream(filePath)

    readStream.on('data', (chunk) => {
      hash.update(chunk)
    })

    readStream.on('end', () => {
      resolve()
    })

    readStream.on('error', (error) => {
      reject(error)
    })
  })

  return hash.digest('hex')
}

/**
 * 저장된 파일 삭제 (롤백용)
 */
export async function deleteFile(filePath: string): Promise<void> {
  try {
    await fsPromises.unlink(filePath)
  } catch (error) {
    // 파일이 없어도 무시
  }
}

/**
 * 확장자로 Content-Type 유추
 */
export function getContentTypeFromExtension(objectKey: string): string {
  const ext = path.extname(objectKey).toLowerCase()
  return CONTENT_TYPE_MAP[ext] || DEFAULT_CONTENT_TYPE
}

// ─── 파일 읽기 스트림 ─────────────────────────────────────────────────────────

/**
 * 파일 읽기 스트림 생성
 */
export function getFileStream(bucket: string, objectKey: string): fs.ReadStream {
  const filePath = path.join(process.cwd(), UPLOAD_BASE_DIR, bucket, objectKey)
  
  // 파일 존재 여부 확인 (동기)
  if (!fs.existsSync(filePath)) {
    throw new HttpError(
      404,
      `파일을 찾을 수 없습니다: ${bucket}/${objectKey}`
    )
  }

  const stream = fs.createReadStream(filePath)
  _activeDiskReads++
  finished(stream, () => { _activeDiskReads-- })

  return stream
}
