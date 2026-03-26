import { SchedulerConfig } from "./types";

const DEFAULTS: SchedulerConfig = {
  maxQueuedJobs: 500,
  maxQueuedBytes: 10 * 1024 * 1024 * 1024,
  maxRunningJobs: 100,
  queueTimeoutMs: 30_000,
  globalIngressLimitBps: 20 * 1024 * 1024,
  minRatePerJobBps: 256 * 1024,
  reallocationIntervalMs: 200,
  tokenBucketCapacityBytes: 512 * 1024,
  transformBufferLimitBytes: 1024 * 1024,
  waitBonusWindowMs: 5_000,
  maxWaitBonus: 20,
  maxSizePriority: 100,
};

function parsePositiveInt(value: string | undefined, fallback: number): number {
  if (!value) {
    return fallback;
  }

  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`유효하지 않은 양의 정수 환경변수 값: ${value}`);
  }

  return parsed;
}

function parseNonNegativeInt(value: string | undefined, fallback: number): number {
  if (!value) {
    return fallback;
  }

  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`유효하지 않은 0 이상 정수 환경변수 값: ${value}`);
  }

  return parsed;
}

function validateSchedulerConfig(config: SchedulerConfig): SchedulerConfig {
  if (config.globalIngressLimitBps < config.minRatePerJobBps) {
    throw new Error(
      "UPLOAD_SCHEDULER_GLOBAL_INGRESS_LIMIT_BPS 는 UPLOAD_SCHEDULER_MIN_RATE_PER_JOB_BPS 이상이어야 합니다.",
    );
  }

  if (config.maxRunningJobs * config.minRatePerJobBps > config.globalIngressLimitBps) {
    throw new Error(
      "maxRunningJobs * minRatePerJobBps 가 globalIngressLimitBps 를 초과합니다. maxRunningJobs 또는 minRatePerJobBps 를 낮추거나 globalIngressLimitBps 를 높이세요.",
    );
  }

  return config;
}

export function loadSchedulerConfig(
  env: NodeJS.ProcessEnv = process.env,
): SchedulerConfig {
  const config: SchedulerConfig = {
    maxQueuedJobs: parsePositiveInt(
      env.UPLOAD_SCHEDULER_MAX_QUEUED_JOBS,
      DEFAULTS.maxQueuedJobs,
    ),
    maxQueuedBytes: parsePositiveInt(
      env.UPLOAD_SCHEDULER_MAX_QUEUED_BYTES,
      DEFAULTS.maxQueuedBytes,
    ),
    maxRunningJobs: parsePositiveInt(
      env.UPLOAD_SCHEDULER_MAX_RUNNING_JOBS,
      DEFAULTS.maxRunningJobs,
    ),
    queueTimeoutMs: parsePositiveInt(
      env.UPLOAD_SCHEDULER_QUEUE_TIMEOUT_MS,
      DEFAULTS.queueTimeoutMs,
    ),
    globalIngressLimitBps: parsePositiveInt(
      env.UPLOAD_SCHEDULER_GLOBAL_INGRESS_LIMIT_BPS,
      DEFAULTS.globalIngressLimitBps,
    ),
    minRatePerJobBps: parsePositiveInt(
      env.UPLOAD_SCHEDULER_MIN_RATE_PER_JOB_BPS,
      DEFAULTS.minRatePerJobBps,
    ),
    reallocationIntervalMs: parsePositiveInt(
      env.UPLOAD_SCHEDULER_REALLOCATION_INTERVAL_MS,
      DEFAULTS.reallocationIntervalMs,
    ),
    tokenBucketCapacityBytes: parsePositiveInt(
      env.UPLOAD_SCHEDULER_TOKEN_BUCKET_CAPACITY_BYTES,
      DEFAULTS.tokenBucketCapacityBytes,
    ),
    transformBufferLimitBytes: parsePositiveInt(
      env.UPLOAD_SCHEDULER_TRANSFORM_BUFFER_LIMIT_BYTES,
      DEFAULTS.transformBufferLimitBytes,
    ),
    waitBonusWindowMs: parsePositiveInt(
      env.UPLOAD_SCHEDULER_WAIT_BONUS_WINDOW_MS,
      DEFAULTS.waitBonusWindowMs,
    ),
    maxWaitBonus: parseNonNegativeInt(
      env.UPLOAD_SCHEDULER_MAX_WAIT_BONUS,
      DEFAULTS.maxWaitBonus,
    ),
    maxSizePriority: parsePositiveInt(
      env.UPLOAD_SCHEDULER_MAX_SIZE_PRIORITY,
      DEFAULTS.maxSizePriority,
    ),
  };

  return validateSchedulerConfig(config);
}
