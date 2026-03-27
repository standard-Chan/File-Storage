import { FastifyBaseLogger, FastifyRequest } from "fastify";
import { validatePresignedUrlRequest } from "../validation/presignedUrl";
import {
  saveStreamToStorage,
  collectStreamFileInfo,
  getFileStream,
  getContentTypeFromExtension,
  FileInfo,
} from "../storage/fileStorage";
import { DEFAULT_CONTENT_TYPE } from "../../constants/contentTypes";
import { validateReplicationBodyStream } from "../validation/replication";
import { ReplicationQueueRepository } from "../../repository/replicationQueue";
import { PresignedQuery } from "../../routes/objects";
import { NodeIpDetector } from "../../utils/NodeIpDetector";
import { getOrCreateUploadScheduler } from "./scheduler/runtime";
import { loadSchedulerConfig } from "./scheduler/config";
import { RateControlledTransform } from "./scheduler/RateControlledTransform";

export interface DownloadResult {
  fileStream: ReturnType<typeof getFileStream>;
  contentType: string;
}

/**
 * 파일 다운로드 서비스
 * - Presigned URL 검증
 * - 파일 스트림 및 Content-Type 반환
 */
export async function downloadFile(
  request: FastifyRequest<{ Querystring: PresignedQuery }>,
): Promise<DownloadResult> {
  const { bucket, objectKey } = request.query;
  request.log.info({ objectKey }, "GET request received");

  validatePresignedUrlRequest(request.query, "GET");

  const fileStream = getFileStream(bucket, objectKey);
  const contentType = getContentTypeFromExtension(objectKey);

  return { fileStream, contentType };
}

/**
 * 파일 업로드 서비스 (Raw Stream 방식)
 * - Presigned URL 검증
 * - request body stream -> 파일시스템에 저장
 * - replication_queue TABLE에 복제 정보 등록
 */
export async function uploadFile(
  request: FastifyRequest<{ Querystring: PresignedQuery }>,
  replicationQueue: ReplicationQueueRepository,
): Promise<FileInfo> {
  const { bucket, objectKey } = request.query;
  const mimetype = request.headers["content-type"] ?? DEFAULT_CONTENT_TYPE;
  const bodyStream = request.body;

  request.log.info({ objectKey }, "PUT request received");

  validatePresignedUrlRequest(request.query, "PUT");
  validateReplicationBodyStream(bodyStream);

  const scheduler = getOrCreateUploadScheduler();
  const schedulerConfig = loadSchedulerConfig();
  const jobId = `${bucket}/${objectKey}/${Date.now()}-${request.id}`;

  await scheduler.enqueue({
    jobId,
    bucket,
    objectKey,
    fileSize: Number(request.query.fileSize),
    clientId: request.id,
  });

  const transform = new RateControlledTransform({
    jobId,
    scheduler,
    capacityBytes: schedulerConfig.tokenBucketCapacityBytes,
    highWaterMarkBytes: schedulerConfig.transformBufferLimitBytes,
    rateLookupIntervalMs: schedulerConfig.rateLookupIntervalMs,
    refillPumpIntervalMs: schedulerConfig.refillPumpIntervalMs,
  });

  const throttledStream = bodyStream.pipe(transform);

  let filePath = "";
  try {
    filePath = await saveStreamToStorage(
      bucket,
      objectKey,
      throttledStream,
      request.log,
    );
    scheduler.jobCompleted(jobId);
  } catch (error) {
    scheduler.jobFailed(
      jobId,
      error instanceof Error ? error.message : "upload pipeline failed",
    );
    throw error;
  }

  const fileInfo = await collectStreamFileInfo(
    bucket,
    objectKey,
    filePath,
    mimetype,
  );
  request.log.info({ fileInfo }, "파일 업로드 성공");

  replicationQueue.registerReplicationTask(bucket, objectKey);
  request.log.info({ bucket, objectKey }, "replication_queue에 복제 등록 완료");

  if (bucket == "TRUE") {
    notifyUploadComplete(
      {
        bucket,
        objectKey,
        fileSize: fileInfo.size,
        etag: fileInfo.etag ?? "",
        storagePath: fileInfo.storagePath,
        primaryNodeIp: NodeIpDetector.getCurrentNodeIp(),
      },
      request.log,
    );
  }

  return fileInfo;
}

/**
 * Control Plane에 업로드 완료 통보
 * @param uploadInfo 업로드 완료 정보
 * @param log Fastify 로거
 * TODO: Retry 로직 필요 (exponential backoff)
 *       - 첫 시도 실패 시 일정 시간 간격으로 재시도
 *       - 최대 재시도 횟수 제한
 */
async function notifyUploadComplete(
  uploadInfo: {
    bucket: string;
    objectKey: string;
    fileSize: number;
    etag: string;
    storagePath: string;
    primaryNodeIp: string;
  },
  log: FastifyBaseLogger,
) {
  try {
    const controlPlaneUrl = process.env.CONTROL_PLANE_URL;
    if (!controlPlaneUrl) {
      throw new Error("CONTROL_PLANE_URL 값이 설정되지 않았습니다.");
    }

    log.info(
      {
        bucket: uploadInfo.bucket,
        objectKey: uploadInfo.objectKey,
        primaryNodeIp: uploadInfo.primaryNodeIp,
        controlPlaneUrl,
      },
      "[UPLOAD COMPLETE] control plane로 업로드 요청 시도",
    );

    const response = await fetch(
      `${controlPlaneUrl}/api/stored-objects/upload-complete`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(uploadInfo),
      },
    );

    if (!response.ok) {
      log.error(
        { status: response.status, statusText: response.statusText },
        "[UPLOAD COMPLETE] control plane으로 업로드 성공 요청 전송 실패",
      );
      throw new Error(
        `Upload complete failed: ${response.status} ${response.statusText}`,
      );
    }

    log.info(
      { bucket: uploadInfo.bucket, objectKey: uploadInfo.objectKey },
      "[upload complete] control plane으로 업로드 정보 전송 완료",
    );
  } catch (error: unknown) {
    // TODO : 재시도 로직 필요

    log.error(
      error instanceof Error
        ? {
            message: error.message,
            stack: error.stack,
            name: error.name,
          }
        : { error },
      "[upload complete] control plane 호출 실패",
    );

    throw error;
  }
}
