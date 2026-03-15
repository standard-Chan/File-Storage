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

  return fileInfo;
}
