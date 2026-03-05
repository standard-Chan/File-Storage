// ─── HTTP 헤더 ────────────────────────────────────────────────────────────────

/** 복제 요청용 커스텀 헤더 */
export const REPLICATION_REQUEST_HEADER = "X-Replication-Request";
export const REPLICATION_REQUEST_HEADER_LOWER = "x-replication-request" as const;

// ─── API 경로 ─────────────────────────────────────────────────────────────────

export const REPLICATION_ENDPOINT_PATH = "/internal/replications";
export const SECONDARY_METRICS_DISK_PATH = "/metrics/disk";

// ─── 타임아웃 / 인터벌 ───────────────────────────────────────────────────────

/** 환경변수 미설정 시 사용하는 복제 요청 기본 타임아웃 (ms) */
export const REPLICATION_DEFAULT_TIMEOUT_MS = 10_000;
/** Retry Worker가 replication_queue를 polling하는 주기 (ms) */
export const RETRY_WORKER_POLL_INTERVAL_MS = 10_000;
/** /metrics/disk 헬스체크 요청에 적용하는 타임아웃 (ms) */
export const SECONDARY_METRICS_REQUEST_TIMEOUT_MS = 3_000;

// ─── Retry Worker 설정 ────────────────────────────────────────────────────────

export const RETRY_WORKER_BATCH_SIZE = 5;

// ─── Secondary 노드 부하 임계값 ──────────────────────────────────────────────

/** 아래 값 이상이면 Secondary 노드가 바쁜 것으로 간주하여 복제를 스킵 */
export const SECONDARY_MAX_CONCURRENT_DISK_WRITES = 15;
export const SECONDARY_MAX_CONCURRENT_DISK_READS = 20;
export const SECONDARY_MAX_CONCURRENT_DISK_IO = 20
