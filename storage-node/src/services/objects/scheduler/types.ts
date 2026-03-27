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
  enableResidueRebalance: boolean; //  잔여 속도 분배 여부 (True 시 = 대역폭을 모두 사용 가능 & CPU 사용량 up)
  rateStepUpBps: number;  // 최소 업로드 속도 증가량
  rateStepDownBps: number;
  reallocationErrorThreshold: number;
  tokenBucketCapacityBytes: number;
  rateLookupIntervalMs: number;  // 각 jobs의 rate 반영 주기
  refillPumpIntervalMs: number;  // 각 stream의 토큰 갱신 주기
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