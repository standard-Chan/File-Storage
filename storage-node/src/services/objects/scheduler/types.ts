export type JobState = "queued" | "running" | "completed" | "failed" | "timed_out";

export interface UploadJob {
  jobId: string;
  bucket: string;
  objectKey: string;
  fileSize: number;
  clientId: string;
  enqueuedAt: number;
  startedAt?: number;
  state: JobState;
  score: number;
  allocatedRateBps: number;
}

export interface SchedulerConfig {
  maxQueuedJobs: number;
  maxQueuedBytes: number;
  maxRunningJobs: number;
  queueTimeoutMs: number;
  globalIngressLimitBps: number;
  minRatePerJobBps: number;
  reallocationIntervalMs: number;
  tokenBucketCapacityBytes: number;
  transformBufferLimitBytes: number;
  waitBonusWindowMs: number;
  maxWaitBonus: number;
  maxSizePriority: number;
}

export interface PriorityScore {
  score: number;
  sizePriority: number;
  waitBonus: number;
}