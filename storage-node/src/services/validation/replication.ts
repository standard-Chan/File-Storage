import { Readable } from "stream";
import { HttpError } from "../../utils/HttpError";

/**
 * 복제 요청 헤더 검증
 * @param replicationHeader X-Replication-Request 헤더 값
 * @throws {HttpError} 헤더가 없으면 403 에러
 */
export function validateReplicationHeader(
  replicationHeader: string | string[] | undefined,
): void {
  if (!replicationHeader) {
    throw new HttpError(403, "복제 요청이 거부되었습니다", {
      reason: "X-Replication-Request 헤더가 필요합니다",
    });
  }
}

/**
 * 복제 요청 필수 파라미터 검증
 * @param bucket 버킷 이름
 * @param objectKey 오브젝트 키
 * @throws {HttpError} 필수 파라미터가 없으면 400 에러
 */
export function validateReplicationParams(
  bucket: string | undefined,
  objectKey: string | undefined,
): void {
  if (!bucket || !objectKey) {
    throw new HttpError(400, "필수 파라미터가 누락되었습니다", {
      required: ["bucket", "objectKey"],
    });
  }
}

/**
 * 복제 요청 바디 스트림 검증
 * @param body 요청 바디
 * @throws {HttpError} 스트림이 아니면 400 에러
 */
export function validateReplicationBodyStream(
  body: unknown,
): asserts body is Readable {
  if (!body || typeof (body as Readable).pipe !== "function") {
    throw new HttpError(400, "파일 스트림이 전달되지 않았습니다");
  }
}

/**
 * 복제 처리 여부
 * 목적 : 다중화 처리를 ON OFF 하기 위함
 */
export function isReplicationEnabled(): boolean {
  const value = process.env.REPLICATION_ENABLED;
  return value?.toLowerCase() === "true";
}

/**
 * Secondary 노드 IP 환경변수 검증
 * @returns SECONDARY_NODE_IP 환경변수 값
 * @throws {HttpError} 환경변수가 없으면 500 에러
 */
export function validateSecondaryNodeIp(): string {
  const secondaryNodeIp = process.env.SECONDARY_NODE_IP;
  if (!secondaryNodeIp) {
    throw new HttpError(500, "복제할 대상 IP 환경변수값이 설정되지 않았습니다");
  }
  return secondaryNodeIp;
}
