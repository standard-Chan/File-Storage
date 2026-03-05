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
import { classifyReplicationError } from "../replication/classifyError";
import { PresignedQuery } from "../../routes/objects";
import { replicateToSecondary } from "../replication/replicateToSecondary";

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
 * - request body stream -> 파일시스템에 저장 → Secondary 복제
 * - Secondary 복제 실패 시 replication_queue에 넣기
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

  const filePath = await saveStreamToStorage(bucket, objectKey, bodyStream);
  const fileInfo = await collectStreamFileInfo(
    bucket,
    objectKey,
    filePath,
    mimetype,
  );
  request.log.info({ fileInfo }, "파일 업로드 성공");

  try {
    replicateToSecondary(bucket, objectKey, request.log);
    request.log.info({ bucket, objectKey }, "Secondary-Node 복제 완료");
  } catch (error) {
    const errorType = classifyReplicationError(error);
    const errorMessage =
      error instanceof Error ? error.message : "알 수 없는 오류";

    request.log.warn(
      { bucket, objectKey, errorType, errorMessage },
      "Secondary 복제 요청이 전달되지 않았습니다. replication_queue에 등록",
    );

    replicationQueue.upsertOnFailure(
      bucket,
      objectKey,
      errorType,
      errorMessage,
    );
  }

  return fileInfo;
}
