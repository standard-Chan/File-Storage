import { SchedulerConfig } from "./types";
import { parseBoolean, parsePositiveInt, parseNonNegativeInt } from "../../../utils/envParser";

const DEFAULTS: SchedulerConfig = {
  maxQueuedJobs: 500,
  maxQueuedBytes: 10 * 1024 * 1024 * 1024,
  maxRunningJobs: 100,
  queueTimeoutMs: 30_000,
  globalIngressLimitBps: 70 * 1024 * 1024,
  minRatePerJobBps: 256 * 1024,
  reallocationIntervalMs: 250,
  enableResidueRebalance: true,
  rateStepUpBps: 256 * 1024,
  rateStepDownBps: 512 * 1024,
  reallocationErrorThreshold: 10,
  tokenBucketCapacityBytes: 512 * 1024,
  rateLookupIntervalMs: 250,
  refillPumpIntervalMs: 25,
  transformBufferLimitBytes: 1024 * 1024,
  waitBonusWindowMs: 5_000,
  maxWaitBonus: 20,
  maxSizePriority: 100,
};

/**
 * 스케줄러 설정 값의 유효성 검증
 */
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

  if (config.rateStepUpBps <= 0 || config.rateStepDownBps <= 0) {
    throw new Error("rateStepUpBps, rateStepDownBps 는 1 이상이어야 합니다.");
  }

  if (config.refillPumpIntervalMs <= 0 || config.rateLookupIntervalMs <= 0) {
    throw new Error("refillPumpIntervalMs, rateLookupIntervalMs 는 1 이상이어야 합니다.");
  }

  if (config.refillPumpIntervalMs < 10) {
    throw new Error("refillPumpIntervalMs 는 10ms 이상을 권장합니다.");
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
    enableResidueRebalance: parseBoolean(
      env.UPLOAD_SCHEDULER_ENABLE_RESIDUE_REBALANCE,
      DEFAULTS.enableResidueRebalance,
    ),
    rateStepUpBps: parsePositiveInt(
      env.UPLOAD_SCHEDULER_RATE_STEP_UP_BPS,
      DEFAULTS.rateStepUpBps,
    ),
    rateStepDownBps: parsePositiveInt(
      env.UPLOAD_SCHEDULER_RATE_STEP_DOWN_BPS,
      DEFAULTS.rateStepDownBps,
    ),
    reallocationErrorThreshold: parsePositiveInt(
      env.UPLOAD_SCHEDULER_REALLOCATION_ERROR_THRESHOLD,
      DEFAULTS.reallocationErrorThreshold,
    ),
    tokenBucketCapacityBytes: parsePositiveInt(
      env.UPLOAD_SCHEDULER_TOKEN_BUCKET_CAPACITY_BYTES,
      DEFAULTS.tokenBucketCapacityBytes,
    ),
    rateLookupIntervalMs: parsePositiveInt(
      env.UPLOAD_SCHEDULER_RATE_LOOKUP_INTERVAL_MS,
      DEFAULTS.rateLookupIntervalMs,
    ),
    refillPumpIntervalMs: parsePositiveInt(
      env.UPLOAD_SCHEDULER_REFILL_PUMP_INTERVAL_MS,
      DEFAULTS.refillPumpIntervalMs,
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
