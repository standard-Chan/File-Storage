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

export interface EnqueueInput {
  jobId: string;
  bucket: string;
  objectKey: string;
  fileSize: number;
  clientId: string;
}

export interface AdmissionGrant {
  jobId: string;
}

export type AdmissionState = "waiting" | "granted" | "timed_out" | "cancelled";

export interface AdmissionTicket {
  jobId: string;
  state: AdmissionState;
  resolve: (grant: AdmissionGrant) => void;
  reject: (error: Error) => void;
}