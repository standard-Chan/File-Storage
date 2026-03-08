import { FastifyRequest } from "fastify";
import {
  saveStreamToStorage,
  collectStreamFileInfo,
  FileInfo,
} from "../storage/fileStorage";
import {
  validateReplicationHeader,
  validateReplicationParams,
  validateReplicationBodyStream,
} from "../validation/replication";
import {
  REPLICATION_REQUEST_HEADER_LOWER,
} from "../../constants/replication";
import { DEFAULT_CONTENT_TYPE } from "../../constants/contentTypes";

export interface ReplicateQuery {
  bucket: string;
  objectKey: string;
}

/**
 * Secondary 노드에서 Primary의 복제 데이터를 수신하여 저장
 * @param request Fastify 요청 객체 (query: bucket/objectKey, headers, body 포함)
 * @returns 저장된 파일 정보
 */
export async function receiveReplication(
  request: FastifyRequest<{ Querystring: ReplicateQuery }>,
): Promise<FileInfo> {
  const { bucket, objectKey } = request.query;
  const replicationHeader = request.headers[REPLICATION_REQUEST_HEADER_LOWER];
  const contentType = request.headers["content-type"];
  const bodyStream = request.body;

  validateReplicationHeader(replicationHeader);
  validateReplicationParams(bucket, objectKey);
  validateReplicationBodyStream(bodyStream);
  request.log.info({ bucket, objectKey }, "[Replication] request received");

  const mimetype = contentType ?? DEFAULT_CONTENT_TYPE;

  const filePath = await saveStreamToStorage(
    bucket,
    objectKey,
    bodyStream,
  );

  const fileInfo = await collectStreamFileInfo(
    bucket,
    objectKey,
    filePath,
    mimetype,
  );

  request.log.info({ fileInfo }, "[Replication] 파일 복제를 완료하였습니다");

  return fileInfo;
}

