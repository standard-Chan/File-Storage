import { Transform, TransformCallback } from "stream";
import { UploadScheduler } from "./UploadScheduler";
import { TokenBucket } from "./TokenBucket";

interface PendingChunk {
  buffer: Buffer;
  offset: number;
  done: TransformCallback;
}

export interface RateControlledTransformConfig {
  jobId: string;
  scheduler: UploadScheduler;
  capacityBytes: number;
  highWaterMarkBytes: number;
  rateLookupIntervalMs: number;
  refillPumpIntervalMs: number;
}

export interface RateControlledTransformStats {
  bytesIn: number;    // Transform가 입력으로 받은 총 바이트 수
  bytesOut: number;   // Transform가 실제 push한 총 바이트 수
  partialWriteCount: number;   // 부분 전송 발생 횟수 (로깅 및 튜닝용)
  throttlePauseCount: number;  // 토큰 부족으로 스로틀 구간이 시작된 횟수 (로깅 및 튜닝용)
  totalThrottledMs: number;    // 토큰 부족 상태로 대기한 누적 시간(ms) (로깅 및 튜닝용)
}

/**
 * scheduler가 부여한 job rate를 실제 스트림 전송 속도로 강제하는 Transform.
 * - chunk streaming 방식으로 부분 전송한다. (전체 토큰이 모일 때까지 기다리지 않는다)
 * - pending queue(FIFO)로 입력 순서를 보장한다.
 */
export class RateControlledTransform extends Transform {
  private readonly jobId: string;
  private readonly scheduler: UploadScheduler;
  private readonly bucket: TokenBucket;
  private readonly pendingQueue: PendingChunk[] = [];

  private readonly rateLookupIntervalMs: number;
  private readonly refillPumpIntervalMs: number;

  private rateLookupTimer: NodeJS.Timeout | null = null;
  private refillPumpTimer: NodeJS.Timeout | null = null;

  private flushing = false;
  private destroyedByError = false;
  private lastThrottleStartMs: number | null = null;

  private readonly stats: RateControlledTransformStats = {
    bytesIn: 0,
    bytesOut: 0,
    partialWriteCount: 0,
    throttlePauseCount: 0,
    totalThrottledMs: 0,
  };

  /**
   * 초기 버킷(rate/capacity)와 두 개의 경량 타이머(rate lookup, refill pump)를 시작한다.
   */
  constructor(config: RateControlledTransformConfig) {
    super({ highWaterMark: config.highWaterMarkBytes });

    this.jobId = config.jobId;
    this.scheduler = config.scheduler;
    this.rateLookupIntervalMs = Math.max(50, config.rateLookupIntervalMs);
    this.refillPumpIntervalMs = Math.max(10, config.refillPumpIntervalMs);

    const initialRateBps = this.scheduler.getCurrentAllocatedRateBps(this.jobId);
    this.bucket = new TokenBucket({
      capacityBytes: config.capacityBytes,
      refillRateBps: initialRateBps,
    });

    this.startRateLookupLoop();
    this.startRefillPumpLoop();
  }

  /**
   * 입력 chunk를 pending queue에 적재하고 즉시 flush를 시도한다.
   */
  _transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback): void {
    this.stats.bytesIn += chunk.length;
    this.pendingQueue.push({
      buffer: chunk,
      offset: 0,
      done: callback,
    });

    this.tryFlushPending();
  }

  /**
   * downstream이 다시 읽을 준비가 되면 flush를 재시도한다.
   */
  _read(_size: number): void {
    this.tryFlushPending();
  }

  /**
   * 입력 종료 후 pending queue가 비워질 때까지 배출을 반복한다.
   */
  _flush(callback: TransformCallback): void {
    const waitDrain = () => {
      this.tryFlushPending();
      if (this.pendingQueue.length === 0) {
        callback();
        return;
      }

      setTimeout(waitDrain, this.refillPumpIntervalMs);
    };

    waitDrain();
  }

  /**
   * 타이머를 해제하고 남은 pending callback을 오류로 종료한다.
   */
  _destroy(error: Error | null, callback: (error?: Error | null) => void): void {
    this.stopRateLookupLoop();
    this.stopRefillPumpLoop();

    if (error) {
      this.destroyedByError = true;
      this.failAllPending(error);
    }

    callback(error);
  }

  /**
   * 관측/로그 수집용 통계를 반환한다.
   */
  getStats(): RateControlledTransformStats {
    return { ...this.stats };
  }

  /**
   * pending queue를 순회하면서 토큰과 downstream 여유가 허용하는 만큼만 부분 전송한다.
   */
  private tryFlushPending(): void {
    if (this.flushing || this.destroyedByError) {
      return;
    }

    this.flushing = true;

    try {
      while (this.pendingQueue.length > 0) {
        const head = this.pendingQueue[0];
        const remaining = head.buffer.length - head.offset;

        if (remaining <= 0) {
          this.pendingQueue.shift();
          head.done();
          continue;
        }

        const spendable = this.bucket.spendableBytes();
        if (spendable <= 0) {
          this.markThrottledStartIfNeeded();
          break;
        }

        const writeBytes = Math.min(remaining, spendable);
        const piece = head.buffer.subarray(head.offset, head.offset + writeBytes);

        const canContinue = this.push(piece);
        this.bucket.consume(writeBytes);

        head.offset += writeBytes;
        this.stats.bytesOut += writeBytes;

        if (writeBytes < remaining) {
          this.stats.partialWriteCount += 1;
        }

        if (head.offset >= head.buffer.length) {
          this.pendingQueue.shift();
          head.done();
        }

        if (!canContinue) {
          break;
        }
      }

      if (this.pendingQueue.length === 0) {
        this.markThrottledEndIfNeeded();
      }
    } catch (error) {
      const flushError = error instanceof Error ? error : new Error(String(error));
      this.failAllPending(flushError);
      this.destroy(flushError);
    } finally {
      this.flushing = false;
    }
  }

  /**
   * scheduler의 현재 할당 rate를 주기적으로 조회해 버킷 rate에 즉시 반영한다.
   */
  private startRateLookupLoop(): void {
    if (this.rateLookupTimer) {
      return;
    }

    this.rateLookupTimer = setInterval(() => {
      try {
        const nextRate = this.scheduler.getCurrentAllocatedRateBps(this.jobId);
        this.bucket.updateRefillRate(nextRate);
      } catch {
        // fail-open: 기존 rate 유지
      }
    }, this.rateLookupIntervalMs);
  }

  /**
   * rate lookup 타이머를 안전하게 종료한다.
   */
  private stopRateLookupLoop(): void {
    if (!this.rateLookupTimer) {
      return;
    }

    clearInterval(this.rateLookupTimer);
    this.rateLookupTimer = null;
  }

  /**
   * pending이 남아 있을 때 주기적으로 flush를 재시도해 토큰 refill을 전송으로 연결한다.
   */
  private startRefillPumpLoop(): void {
    if (this.refillPumpTimer) {
      return;
    }

    this.refillPumpTimer = setInterval(() => {
      if (this.pendingQueue.length === 0) {
        return;
      }

      this.tryFlushPending();
    }, this.refillPumpIntervalMs);
  }

  /**
   * refill pump 타이머를 안전하게 종료한다.
   */
  private stopRefillPumpLoop(): void {
    if (!this.refillPumpTimer) {
      return;
    }

    clearInterval(this.refillPumpTimer);
    this.refillPumpTimer = null;
  }

  /**
   * 스로틀 구간 시작 시각을 기록하고, pause 횟수 통계를 갱신한다.
   */
  private markThrottledStartIfNeeded(): void {
    if (this.lastThrottleStartMs !== null) {
      return;
    }

    this.lastThrottleStartMs = Date.now();
    this.stats.throttlePauseCount += 1;
  }

  /**
   * 스로틀 구간 종료 시 누적 지연 시간을 통계에 반영한다.
   */
  private markThrottledEndIfNeeded(): void {
    if (this.lastThrottleStartMs === null) {
      return;
    }

    const throttledMs = Math.max(0, Date.now() - this.lastThrottleStartMs);
    this.stats.totalThrottledMs += throttledMs;
    this.lastThrottleStartMs = null;
  }

  /**
   * 비정상 종료 시 pending callback을 모두 실패 처리한다.
   */
  private failAllPending(error: Error): void {
    while (this.pendingQueue.length > 0) {
      const pending = this.pendingQueue.shift();
      pending?.done(error);
    }
  }
}
