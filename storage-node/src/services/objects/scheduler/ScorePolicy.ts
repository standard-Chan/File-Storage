import { PriorityScore } from "./types";

export interface ScorePolicy {
  calculate(fileSize: number, enqueuedAt: number, now: number): PriorityScore;
}

export interface SizeAndWaitScorePolicyOptions {
  maxSizePriority: number;
  waitBonusWindowMs: number;
  maxWaitBonus: number;
}

/**
 * 기본 스코어 정책
 * - score = sizePriority + waitBonus
 * - 파일이 작을수록 sizePriority를 높게 부여
 * - 오래 queued 상태일수록 waitBonus를 증가시켜, 우선순위를 높인다
 */
export class SizeAndWaitScorePolicy implements ScorePolicy {
  private readonly maxSizePriority: number;
  private readonly waitBonusWindowMs: number;
  private readonly maxWaitBonus: number;

  constructor(options: SizeAndWaitScorePolicyOptions) {
    this.maxSizePriority = options.maxSizePriority;
    this.waitBonusWindowMs = options.waitBonusWindowMs;
    this.maxWaitBonus = options.maxWaitBonus;
  }

  calculate(fileSize: number, enqueuedAt: number, now: number): PriorityScore {
    const sizePriority = this.calculateSizePriority(fileSize);
    const waitBonus = this.calculateWaitBonus(enqueuedAt, now);

    return {
      score: sizePriority + waitBonus,
      sizePriority,
      waitBonus,
    };
  }

  // 용량이 클수록 우선순위를 낮게 설정
  private calculateSizePriority(fileSize: number): number {
    if (fileSize <= 0) {
      return this.maxSizePriority;
    }

    const fileSizeMb = Math.max(1, Math.ceil(fileSize / (1024 * 1024)));
    return Math.max(1, this.maxSizePriority - fileSizeMb + 1);
  }

  // 대기시간이 길수록 우선순위를 높인다
  private calculateWaitBonus(enqueuedAt: number, now: number): number {
    const waitedMs = Math.max(0, now - enqueuedAt);
    const rawBonus = Math.floor(waitedMs / this.waitBonusWindowMs);
    return Math.min(this.maxWaitBonus, rawBonus);
  }
}
