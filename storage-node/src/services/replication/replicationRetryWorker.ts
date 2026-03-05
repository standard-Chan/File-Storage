import { FastifyBaseLogger } from "fastify";
import { ReplicationQueueRepository } from "../../repository/replicationQueue";
import {
  checkSecondaryHealth,
  replicateToSecondary,
} from "./replicateToSecondary";
import { classifyReplicationError } from "./classifyError";
import { validateSecondaryNodeIp } from "../validation/replication";
import {
  RETRY_WORKER_BATCH_SIZE,
  RETRY_WORKER_POLL_INTERVAL_MS,
  SECONDARY_MAX_CONCURRENT_DISK_IO,
  SECONDARY_MAX_CONCURRENT_DISK_READS,
  SECONDARY_MAX_CONCURRENT_DISK_WRITES,
  SECONDARY_METRICS_DISK_PATH,
  SECONDARY_METRICS_REQUEST_TIMEOUT_MS,
} from "../../constants/replication";

let intervalId: ReturnType<typeof setInterval> | null = null;

interface DiskMetrics {
  activeDiskWrites: number;
  activeDiskReads: number;
  timestamp: string;
}

/**
 * Secondary 노드의 /metrics/disk 를 조회하여 현재 작업량이 여유 있는지 확인
 * - activeDiskWrites < 5, activeDiskReads < 10 일 때만 true 반환
 * - 요청 실패 / 타임아웃 / 환경변수 미설정 시 false 반환 (복제 스킵)
 */
async function isSecondaryNodeIdle(log: FastifyBaseLogger): Promise<boolean> {
  const secondaryNodeIp = validateSecondaryNodeIp();

  const controller = new AbortController();
  const timeoutId = setTimeout(
    () => controller.abort(),
    SECONDARY_METRICS_REQUEST_TIMEOUT_MS,
  );

  try {
    const isHealthy = await checkSecondaryHealth(secondaryNodeIp, log);
    if (!isHealthy) {
      log.warn("Secondary 노드가 응답하지 않아 복제를 건너뜁니다");
      return false;
    }

    const response = await fetch(
      `${secondaryNodeIp}${SECONDARY_METRICS_DISK_PATH}`,
      {
        signal: controller.signal,
      },
    );

    if (!response.ok) {
      log.warn(
        { status: response.status },
        "[retryWorker] metrics/disk 응답 실패하여 - 복제 스킵합니다",
      );
      return false;
    }

    const metrics = (await response.json()) as DiskMetrics;
    const isIdle =
      metrics.activeDiskWrites < SECONDARY_MAX_CONCURRENT_DISK_WRITES &&
      metrics.activeDiskReads < SECONDARY_MAX_CONCURRENT_DISK_READS &&
      metrics.activeDiskReads + metrics.activeDiskWrites <
        SECONDARY_MAX_CONCURRENT_DISK_IO;

    if (!isIdle) {
      log.debug(
        {
          activeDiskWrites: metrics.activeDiskWrites,
          activeDiskReads: metrics.activeDiskReads,
        },
        "[retryWorker] Secondary 노드 작업량이 초과하여, 복제 보류합니다",
      );
    }

    return isIdle;
  } catch (err) {
    if ((err as { name?: string })?.name === "AbortError") {
      log.warn("[retryWorker] metrics/disk 요청 타임아웃 - 복제 스킵");
    } else {
      log.warn({ err }, "[retryWorker] metrics/disk 요청 실패 - 복제 스킵");
    }
    return false;
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * 실패했던 데이터들을 가져와서, 재복제 요청을 보낸다
 */
async function retryFailedReplications(
  replicationQueue: ReplicationQueueRepository,
  log: FastifyBaseLogger,
): Promise<void> {
  // Secondary 노드의 현재 작업량을 확인하여 복제 가능 여부 판단
  const idle = await isSecondaryNodeIdle(log);
  if (!idle) return;

  const replicationObjects = replicationQueue.fetchRetryBatch(
    RETRY_WORKER_BATCH_SIZE,
  );

  if (replicationObjects.length === 0) return;

  log.debug(
    { count: replicationObjects.length },
    "[retryWorker] 복제 재시도 시작",
  );

  for (const row of replicationObjects) {
    const { bucket, objectKey } = row;

    try {
      await replicateToSecondary(bucket, objectKey, log);
    } catch (err) {
      const errorType = classifyReplicationError(err);
      const errorMessage =
        err instanceof Error ? err.message : "알 수 없는 오류";

      replicationQueue.updateOnRetryFailure(
        bucket,
        objectKey,
        errorType,
        errorMessage,
      );

      log.warn(
        { bucket, objectKey, errorType, errorMessage },
        "[retryWorker] 복제 재시도 실패",
      );
      continue;
    }

    try {
      replicationQueue.deleteOnSuccess(bucket, objectKey);
      log.info({ bucket, objectKey }, "[retryWorker] 복제 성공 - row 삭제");
    } catch (err) {
      log.error(
        { bucket, objectKey, error: err },
        "[retryWorker] 복제 성공 후 row 삭제 실패 (DB 오류)",
      );
    }
  }
}

/**
 * Replication Retry Worker 시작.
 *
 * - POLL_INTERVAL(1초)마다 replication_queue를 polling
 * - inFlight 플래그로 이전 poll이 끝나기 전 다음 poll 진입을 방지
 * - 앱 시작 시 단 한 번만 호출해야 한다
 */
export function startReplicationRetryWorker(
  replicationQueue: ReplicationQueueRepository,
  log: FastifyBaseLogger,
): void {
  if (intervalId !== null) return;

  let isWorking = false;

  intervalId = setInterval(async () => {
    if (isWorking) return;
    isWorking = true;

    try {
      await retryFailedReplications(replicationQueue, log);
    } catch (error) {
      log.error({ error }, "[retryWorker] poll 중 예상치 못한 오류 발생");
    } finally {
      isWorking = false;
    }
  }, RETRY_WORKER_POLL_INTERVAL_MS);

  log.info(
    {
      pollIntervalMs: RETRY_WORKER_POLL_INTERVAL_MS,
      batchSize: RETRY_WORKER_BATCH_SIZE,
    },
    "[retryWorker] 시작",
  );
}

/**
 * Replication Retry Worker 중단.
 * 앱 종료(onClose) 훅에서 호출한다.
 */
export function stopReplicationRetryWorker(log: FastifyBaseLogger): void {
  if (intervalId === null) return;

  clearInterval(intervalId);
  intervalId = null;
  log.info("[retryWorker] 중단");
}
