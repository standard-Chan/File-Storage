export interface TokenBucketConfig {
  capacityBytes: number;
  refillRateBps: number;
}

export interface TokenBucketSnapshot {
  tokensBytes: number;
  refillRateBps: number;
  capacityBytes: number;
  lastRefillAtMs: number;
}

/**
 * 시간 기반 토큰 버킷.
 * - 토큰은 바이트 단위로 누적된다.
 * - 소비는 부분 전송을 위해 요청 바이트보다 작게도 허용된다.
 */
export class TokenBucket {
  private tokensBytes: number;
  private refillRateBps: number;
  private readonly capacityBytes: number;
  private lastRefillAtMs: number;

  /**
   * 버킷을 초기화한다.
   * 시작 시점에는 초기 버스트를 허용하기 위해 capacity만큼 토큰을 채운다.
   */
  constructor(config: TokenBucketConfig) {
    if (!Number.isFinite(config.capacityBytes) || config.capacityBytes <= 0) {
      throw new Error("capacityBytes 는 1 이상이어야 합니다.");
    }
    if (!Number.isFinite(config.refillRateBps) || config.refillRateBps <= 0) {
      throw new Error("refillRateBps 는 1 이상이어야 합니다.");
    }

    this.capacityBytes = config.capacityBytes;
    this.refillRateBps = config.refillRateBps;
    this.tokensBytes = config.capacityBytes;
    this.lastRefillAtMs = Date.now();
  }

  /**
   * 마지막 보정 시각 이후 경과 시간만큼 토큰을 충전한다.
   */
  refill(nowMs: number = Date.now()): void {
    const elapsedMs = Math.max(0, nowMs - this.lastRefillAtMs);
    if (elapsedMs === 0) {
      return;
    }

    const addBytes = (this.refillRateBps * elapsedMs) / 1000;
    this.tokensBytes = Math.min(this.capacityBytes, this.tokensBytes + addBytes);
    this.lastRefillAtMs = nowMs;
  }

  /**
   * 재할당된 rate를 즉시 반영한다.
   * 변경 직전에 refill을 수행해 토큰 계산의 연속성을 유지한다.
   */
  updateRefillRate(newRateBps: number): void {
    if (!Number.isFinite(newRateBps) || newRateBps <= 0) {
      return;
    }

    this.refill();
    this.refillRateBps = Math.max(1, newRateBps);
  }

  /**
   * 지금 시점에 즉시 소비 가능한 정수 바이트를 반환한다.
   */
  spendableBytes(): number {
    this.refill();
    return Math.floor(this.tokensBytes);
  }

  /**
   * 실제 전송한 바이트만큼 토큰을 차감한다.
   */
  consume(bytes: number): void {
    if (!Number.isFinite(bytes) || bytes <= 0) {
      return;
    }

    this.tokensBytes = Math.max(0, this.tokensBytes - bytes);
  }

  /**
   * 디버깅/관찰용 버킷 상태를 반환한다.
   */
  getSnapshot(): TokenBucketSnapshot {
    this.refill();
    return {
      tokensBytes: this.tokensBytes,
      refillRateBps: this.refillRateBps,
      capacityBytes: this.capacityBytes,
      lastRefillAtMs: this.lastRefillAtMs,
    };
  }
}
