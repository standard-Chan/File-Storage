import { FastifyRequest } from "fastify";
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
  request: FastifyRequest<{ Querystring: PresignedQuery }>
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

  const filePath = await saveStreamToStorage(
    bucket,
    objectKey,
    bodyStream,
    request.log,
  );
  const fileInfo = await collectStreamFileInfo(
    bucket,
    objectKey,
    filePath,
    mimetype,
  );
  request.log.info({ fileInfo }, "파일 업로드 성공");

  replicationQueue.registerReplicationTask(bucket, objectKey);
  request.log.info({ bucket, objectKey }, "replication_queue에 복제 등록 완료");

  notifyUploadComplete({
    bucket,
    objectKey,
    fileSize: fileInfo.size,
    etag: fileInfo.etag ?? "",
    storagePath: fileInfo.storagePath,
    primaryNodeIp: NodeIpDetector.getCurrentNodeIp(),
  }, request.log);

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
  log: any
) {
  try {
    const controlPlaneUrl = process.env.CONTROL_PLANE_URL;
    if (!controlPlaneUrl) {
      log.warn("CONTROL_PLANE_URL environment variable is not set");
      return;
    }

    log.info(
      { bucket: uploadInfo.bucket, objectKey: uploadInfo.objectKey, primaryNodeIp: uploadInfo.primaryNodeIp },
      "Sending upload complete notification to control plane"
    );

    const response = await fetch(`${controlPlaneUrl}/api/storage/upload-complete`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(uploadInfo),
    });

    if (!response.ok) {
      log.error(
        { status: response.status, statusText: response.statusText },
        "Upload complete notification failed"
      );
      return;
    }

    log.info(
      { bucket: uploadInfo.bucket, objectKey: uploadInfo.objectKey },
      "Upload complete notification sent successfully"
    );
  } catch (error) {
    log.error(
      { error, bucket: uploadInfo.bucket, objectKey: uploadInfo.objectKey },
      "Error sending upload complete notification"
    );
    // TODO: Retry 로직 필요
  }
}
