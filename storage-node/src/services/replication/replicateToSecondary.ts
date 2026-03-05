import { HttpError } from "../../utils/HttpError";
import { FastifyBaseLogger } from "fastify";
import {
  getContentTypeFromExtension,
  getFileStream,
} from "../storage/fileStorage";
import { validateSecondaryNodeIp } from "../validation/replication";
import {
  HTTP_STATUS_BAD_GATEWAY,
  HTTP_STATUS_GATEWAY_TIMEOUT,
} from "../../constants/httpStatus";
import {
  REPLICATION_DEFAULT_TIMEOUT_MS,
  REPLICATION_ENDPOINT_PATH,
  REPLICATION_REQUEST_HEADER,
  SECONDARY_METRICS_REQUEST_TIMEOUT_MS,
} from "../../constants/replication";
import { HEALTH_CHECK_PATH } from "../../constants/healthCheck";

/**
 * Secondary 노드의 /health 엔드포인트를 호출하여 서버 가동 여부 확인
 * 응답이 없거나 오류 발생 시 false 반환 (복제 skip)
 */
export async function checkSecondaryHealth(
  secondaryNodeIp: string,
  log: FastifyBaseLogger,
): Promise<boolean> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), SECONDARY_METRICS_REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(`${secondaryNodeIp}${HEALTH_CHECK_PATH}`, {
      method: "GET",
      signal: controller.signal,
    });
    return response.ok;
  } catch {
    log.warn({ secondaryNodeIp }, "Secondary 노드 헬스체크 실패");
    return false;
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * 환경변수에서 복제 타임아웃(ms)을 읽어 반환
 * REPLICATION_TIMEOUT_MS 미설정 시 기본값 10,000ms 사용
 */
function getTimeoutMs(): number {
  const limitTime = process.env.REPLICATION_TIMEOUT_MS;
  if (!limitTime) return REPLICATION_DEFAULT_TIMEOUT_MS;
  const parsed = parseInt(limitTime, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : REPLICATION_DEFAULT_TIMEOUT_MS;
}

/**
 * Secondary 노드에 파일 복제
 *
 * - SECONDARY_ENDPOINT 환경변수에 설정된 주소로 PUT /internal/replications 요청
 * - X-Replication-Request 헤더 포함
 * - REPLICATION_TIMEOUT_MS(기본 10초) 초과 시 AbortError → HttpError(500) 변환
 *
 * @param bucket    버킷 이름
 * @param objectKey 오브젝트 키
 * @param filePath  디스크에 저장된 파일의 절대 경로
 */
export async function replicateToSecondary(
  bucket: string,
  objectKey: string,
  log: FastifyBaseLogger,
): Promise<void> {
  const secondaryNodeIp = validateSecondaryNodeIp();

  const url =
    `${secondaryNodeIp}${REPLICATION_ENDPOINT_PATH}` +
    `?bucket=${encodeURIComponent(bucket)}&objectKey=${encodeURIComponent(objectKey)}`;

  const fileStream = getFileStream(bucket, objectKey);

  // timeout 설정
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), getTimeoutMs());
  controller.signal.addEventListener("abort", () => {
    fileStream.destroy();
  });

  try {
    const response = await fetch(url, {
      method: "PUT",
      headers: {
        [REPLICATION_REQUEST_HEADER]: "true",
        "Content-Type": getContentTypeFromExtension(objectKey),
      },
      body: fileStream,
      signal: controller.signal,
      duplex: "half",
    });

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      log.error({ bucket, objectKey, status: response.status, body }, "Secondary 복제 실패");
      throw new HttpError(
        response.status,
        `Secondary 복제 실패 (HTTP ${response.status})`,
        { body },
      );
    }
  } catch (error) {
    if (error instanceof HttpError) throw error;

    if ((error as { name?: string })?.name === "AbortError") {
      log.error({ bucket, objectKey }, `Secondary 복제 타임아웃 (${getTimeoutMs()}ms 초과)`);
      // 504 Gateway Timeout: 우리 쪽 AbortController가 중단한 경우
      throw new HttpError(
        HTTP_STATUS_GATEWAY_TIMEOUT,
        `Secondary 복제 타임아웃 (${getTimeoutMs()}ms 초과)`,
      );
    }

    log.error({ error, bucket, objectKey }, "Secondary 복제 중 네트워크 오류가 발생했습니다");
    // 502 Bad Gateway: fetch 자체가 실패한 경우 (연결 거부, DNS 실패 등)
    throw new HttpError(HTTP_STATUS_BAD_GATEWAY, "Secondary 복제 중 네트워크 오류가 발생했습니다", {
      error: error instanceof Error ? error.message : "알 수 없는 오류",
    });
  } finally {
    clearTimeout(timeoutId);
  }
}
