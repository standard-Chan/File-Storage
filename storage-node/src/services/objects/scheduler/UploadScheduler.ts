import { PriorityQueue } from "./PriorityQueue";
import { ScorePolicy } from "./ScorePolicy";
import {
  AdmissionGrant,
  AdmissionTicket,
  EnqueueInput,
  SchedulerConfig,
  UploadJob,
} from "./types";

export class UploadScheduler {
  private static instance: UploadScheduler | null = null;

  private readonly queue: PriorityQueue;
  private readonly waitingTickets = new Map<string, AdmissionTicket>();
  private readonly runningJobs = new Map<string, UploadJob>();
  private readonly config: SchedulerConfig;
  private readonly scorePolicy: ScorePolicy;

  private isDispatching = false;
  private dispatchQueued = false;
  private started = false;

  private constructor(config: SchedulerConfig, scorePolicy: ScorePolicy) {
    this.config = config;
    this.scorePolicy = scorePolicy;
    this.queue = new PriorityQueue(config.maxQueuedJobs);
  }

  static initialize(config: SchedulerConfig, scorePolicy: ScorePolicy): void {
    if (UploadScheduler.instance) {
      throw new Error("UploadScheduler는 이미 초기화되었습니다.");
    }

    UploadScheduler.instance = new UploadScheduler(config, scorePolicy);
  }

  static getInstance(): UploadScheduler {
    if (!UploadScheduler.instance) {
      throw new Error("UploadScheduler가 초기화되지 않았습니다.");
    }

    return UploadScheduler.instance;
  }

  start(): void {
    this.started = true;
    this.scheduleDispatch();
  }

  stop(): void {
    this.started = false;
  }

   /**
   * 작업을 큐에 추가하고 실행 허가 Promise 반환
   * 사용 방식 
   * await scheduler.enqueue(jobInput);
   * 이후 resolve 될때까지 await로 대기한다.
   */
  enqueue(jobInput: EnqueueInput): Promise<AdmissionGrant> {
    if (!this.started) {
      throw new Error("UploadScheduler가 시작되지 않았습니다.");
    }
    if (this.runningJobs.has(jobInput.jobId) || this.waitingTickets.has(jobInput.jobId)) {
      throw new Error(`중복 jobId 입니다: ${jobInput.jobId}`);
    }
    if (!Number.isFinite(jobInput.fileSize) || jobInput.fileSize <= 0) {
      throw new Error("fileSize는 1 이상이어야 합니다.");
    }

    const queuedBytes = this.getQueuedBytes();
    if (queuedBytes + jobInput.fileSize > this.config.maxQueuedBytes) {
      throw new Error("큐 용량을 초과했습니다.");
    }

    const now = Date.now();
    const priority = this.scorePolicy.calculate(jobInput.fileSize, now, now);
    const job: UploadJob = {
      ...jobInput,
      enqueuedAt: now,
      state: "queued",
      score: priority.score,
      allocatedRateBps: 0,
    };

    this.queue.enqueue(job);

    const admissionPromise = new Promise<AdmissionGrant>((resolve, reject) => {
      this.waitingTickets.set(job.jobId, {
        jobId: job.jobId,
        state: "waiting",
        resolve,
        reject,
      });
    });

    this.scheduleDispatch();
    return admissionPromise;
  }

  jobCompleted(jobId: string): void {
    const runningJob = this.runningJobs.get(jobId);
    if (!runningJob) return;

    runningJob.state = "completed";
    this.runningJobs.delete(jobId);
    this.scheduleDispatch();
  }

  jobFailed(jobId: string, reason?: string): void {
    const runningJob = this.runningJobs.get(jobId);
    if (!runningJob) {
      return;
    }

    runningJob.state = "failed";
    this.runningJobs.delete(jobId);

    const ticket = this.waitingTickets.get(jobId);
    if (ticket && ticket.state === "waiting") {
      ticket.state = "cancelled";
      ticket.reject(new Error(reason ?? `업로드 실패: ${jobId}`));
      this.waitingTickets.delete(jobId);
    }

    this.scheduleDispatch();
  }

  jobAborted(jobId: string, reason?: string): void {
    const runningJob = this.runningJobs.get(jobId);
    if (runningJob) {
      runningJob.state = "failed";
      this.runningJobs.delete(jobId);
      this.scheduleDispatch();
      return;
    }

    const queuedJob = this.queue.removeByJobId(jobId);
    if (!queuedJob) {
      return;
    }

    const ticket = this.waitingTickets.get(jobId);
    if (ticket && ticket.state === "waiting") {
      ticket.state = "cancelled";
      ticket.reject(new Error(reason ?? `업로드 중단: ${jobId}`));
      this.waitingTickets.delete(jobId);
    }

    this.scheduleDispatch();
  }

  /**
   * dispatch 실행 요청 (중복 실행 방지)
   */
  private scheduleDispatch(): void {
    if (!this.started) return;

    // 실행 중인 경우 flag 설정으로, 현재 실행이 종료되면 재실행한다
    if (this.isDispatching) {
      this.dispatchQueued = true;
      return;
    }

    void this.runDispatch();
  }


  private async runDispatch(): Promise<void> {
    this.isDispatching = true;
    try {
      do {
        this.dispatchQueued = false;
        this.dispatchOnce();
      } while (this.dispatchQueued); // 실행 도중, 호출되는 경우, 한번 더 실행한다.
    } finally {
      this.isDispatching = false;
    }
  }

  /**
   *  dispatch - 실행 가능한 job을 running으로 이동시킨다.
   */
  private dispatchOnce(): void {
    const now = Date.now();
    this.sweepTimeout(now);
    this.refreshQueuedScores(now);

    let available = this.config.maxRunningJobs - this.runningJobs.size;
    while (available > 0 && !this.queue.isEmpty()) {
      const next = this.queue.dequeue();
      if (!next) {
        break;
      }

      next.state = "running";
      next.startedAt = now;
      this.runningJobs.set(next.jobId, next);

      const ticket = this.waitingTickets.get(next.jobId);
      if (ticket && ticket.state === "waiting") {
        ticket.state = "granted";
        ticket.resolve({ jobId: next.jobId });
        this.waitingTickets.delete(next.jobId);
      }

      available -= 1;
    }
  }

  /**
   * 큐에서 timeout된 작업 제거 및 ticket reject 처리
   */
  private sweepTimeout(now: number): void {
    const jobs = this.queue.snapshot();
    for (const job of jobs) {
      if (now - job.enqueuedAt <= this.config.queueTimeoutMs) {
        continue;
      }

      const removed = this.queue.removeByJobId(job.jobId);
      if (!removed) {
        continue;
      }

      removed.state = "timed_out";
      const ticket = this.waitingTickets.get(removed.jobId);
      if (ticket && ticket.state === "waiting") {
        ticket.state = "timed_out";
        ticket.reject(new Error(`Queue timeout: ${removed.jobId}`));
        this.waitingTickets.delete(removed.jobId);
      }
    }
  }

  /** 
   * 대기 중인 작업들의 score 재계산 후 heap 재정렬
   */
  private refreshQueuedScores(now: number): void {
    const jobs = this.queue.snapshot();
    if (jobs.length === 0) {
      return;
    }

    for (const job of jobs) {
      const score = this.scorePolicy.calculate(job.fileSize, job.enqueuedAt, now);
      job.score = score.score;
    }

    this.queue.reheapify();
  }

  private getQueuedBytes(): number {
    return this.queue.snapshot().reduce((sum, job) => sum + job.fileSize, 0);
  }
}