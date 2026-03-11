import type Database from "better-sqlite3";

export type ReplicationStatus = "RETRYABLE" | "FAILED_PERM";

export type ErrorType = "HTTP_NON_2XX" | "TIMEOUT" | "NETWORK" | "UNKNOWN";

const MAX_RETRY = 10;
const MAX_WAIT_TIME = 3_600_000;
const RETRY_INTERVAL_MS = 10_000;

export interface ReplicationQueueRow {
  bucket: string;
  objectKey: string;
  firstAttemptAt: string;
  lastTriedAt: string | null;
  retryCount: number;
  nextRetryAt: string;
  status: ReplicationStatus;
  lastErrorType: ErrorType | null;
  lastErrorMessage: string | null;
}

export interface ReplicationQueueRepository {
  /**
   * 업로드 직후 복제 대기 등록.
   * - row 없으면 INSERT (retryCount = 0, nextRetryAt = now, 에러 정보 없음)
   * - row 있으면 (재업로드 등) retryCount 초기화, 즉시 재시도 가능 상태로 리셋
   */
  registerReplicationTask(bucket: string, objectKey: string): void;

  /**
   * 업로드 경로에서 복제 실패 시 호출.
   * - row 없으면 INSERT (retryCount = 0)
   * - row 있으면 retryCount++, nextRetryAt 갱신
   */
  upsertOnFailure(
    bucket: string,
    objectKey: string,
    errorType: ErrorType,
    errorMessage: string,
  ): void;

  /**
   * status = RETRYABLE & nextRetryAt <= now 인 row를
   * nextRetryAt ASC 순서로 최대 batchSize 개 반환
   */
  fetchRetryBatch(batchSize: number): ReplicationQueueRow[];

  /** 재시도 복제 성공 시 row 삭제 */
  deleteOnSuccess(bucket: string, objectKey: string): void;

  /**
   * 재시도 복제 실패 시 호출.
   * retryCount++, nextRetryAt 갱신, MAX_RETRY 초과 시 FAILED_PERM
   */
  updateOnRetryFailure(
    bucket: string,
    objectKey: string,
    errorType: ErrorType,
    errorMessage: string,
  ): void;
}

// ---------- helper ----------

function nowIso(): string {
  return new Date().toISOString();
}

/**
 * 대기시간 설정 : retryCount 번째 재시도까지 지수적으로 증가 후 최대 1시간으로 설정
 */
function calcNextRetryTime(retryCount: number): string {
  const delayMs = Math.min(RETRY_INTERVAL_MS * Math.pow(2, retryCount), MAX_WAIT_TIME);
  return new Date(Date.now() + delayMs).toISOString();
}

// ---------- factory ----------

export function createReplicationQueueRepository(
  db: InstanceType<typeof Database>,
): ReplicationQueueRepository {
  const enqueueInitialStmt = db.prepare(`
    INSERT INTO replication_queue
      (bucket, objectKey, firstAttemptAt, lastTriedAt, retryCount, nextRetryAt,
       status, lastErrorType, lastErrorMessage)
    VALUES
      (@bucket, @objectKey, @now, NULL, 0, @now,
       'RETRYABLE', NULL, NULL)
    ON CONFLICT(bucket, objectKey) DO UPDATE SET
      retryCount       = 0,
      lastTriedAt      = NULL,
      nextRetryAt      = @now,
      status           = 'RETRYABLE',
      lastErrorType    = NULL,
      lastErrorMessage = NULL
  `);

  const upsertStmt = db.prepare(`
    INSERT INTO replication_queue
      (bucket, objectKey, firstAttemptAt, lastTriedAt, retryCount, nextRetryAt,
       status, lastErrorType, lastErrorMessage)
    VALUES
      (@bucket, @objectKey, @now, @now, 0, @nextRetryAt,
       'RETRYABLE', @errorType, @errorMessage)
    ON CONFLICT(bucket, objectKey) DO UPDATE SET
      retryCount       = replication_queue.retryCount + 1,
      lastTriedAt      = @now,
      nextRetryAt      = @nextRetryAt,
      status           = CASE
                           WHEN replication_queue.retryCount + 1 >= ${MAX_RETRY}
                           THEN 'FAILED_PERM'
                           ELSE 'RETRYABLE'
                         END,
      lastErrorType    = @errorType,
      lastErrorMessage = @errorMessage
  `);

  const getRetryCountStmt = db.prepare(`
    SELECT retryCount FROM replication_queue
    WHERE bucket = @bucket AND objectKey = @objectKey
  `);

  const fetchBatchStmt = db.prepare(`
    SELECT *
    FROM   replication_queue
    WHERE  status = 'RETRYABLE'
      AND  nextRetryAt <= @now
    ORDER  BY nextRetryAt ASC
    LIMIT  @batchSize
  `);

  const deleteStmt = db.prepare(`
    DELETE FROM replication_queue
    WHERE bucket = @bucket AND objectKey = @objectKey
  `);

  const updateOnRetryFailureStmt = db.prepare(`
    UPDATE replication_queue
    SET
      retryCount       = retryCount + 1,
      lastTriedAt      = @now,
      nextRetryAt      = @nextRetryAt,
      status           = CASE
                           WHEN retryCount + 1 >= ${MAX_RETRY}
                           THEN 'FAILED_PERM'
                           ELSE 'RETRYABLE'
                         END,
      lastErrorType    = @errorType,
      lastErrorMessage = @errorMessage
    WHERE bucket = @bucket AND objectKey = @objectKey
  `);

  return {
    registerReplicationTask(bucket, objectKey) {
      enqueueInitialStmt.run({ bucket, objectKey, now: nowIso() });
    },

    upsertOnFailure(bucket, objectKey, errorType, errorMessage) {
      // 기존 row가 있으면 retryCount+1 회차, 없으면 0 회차(첫 실패)
      const existing = getRetryCountStmt.get({ bucket, objectKey }) as
        | { retryCount: number }
        | undefined;
      const currentRetryCount = existing?.retryCount ?? -1;
      upsertStmt.run({
        bucket,
        objectKey,
        now: nowIso(),
        nextRetryAt: calcNextRetryTime(currentRetryCount + 1),
        errorType,
        errorMessage,
      });
    },

    fetchRetryBatch(batchSize) {
      return fetchBatchStmt.all({
        now: nowIso(),
        batchSize,
      }) as ReplicationQueueRow[];
    },

    deleteOnSuccess(bucket, objectKey) {
      deleteStmt.run({ bucket, objectKey });
    },

    updateOnRetryFailure(bucket, objectKey, errorType, errorMessage) {
      const existing = getRetryCountStmt.get({ bucket, objectKey }) as
        | { retryCount: number }
        | undefined;
      const currentRetryCount = existing?.retryCount ?? 0;
      updateOnRetryFailureStmt.run({
        bucket,
        objectKey,
        now: nowIso(),
        nextRetryAt: calcNextRetryTime(currentRetryCount + 1),
        errorType,
        errorMessage,
      });
    },
  };
}
