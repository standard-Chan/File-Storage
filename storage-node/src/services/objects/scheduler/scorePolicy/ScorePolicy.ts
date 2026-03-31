import { PriorityScore } from "../types";

export interface ScorePolicy {
  calculate(fileSize: number, now: number, registeredAt: number): PriorityScore;
}

export interface SizeAndWaitScorePolicyOptions {
  maxSizePriority: number;
  maxWaitBonus?: number; // 기본값: 100
  elapsedTimeMaxMs?: number; // 기본값: 600000ms (10분)
}

/**
 * 기본 스코어 정책 - Score 재분배 적용 버전
 * - score = sizePriority + waitBonus
 * - sizePriority: 파일이 작을수록 높은 점수 (파일 크기 기반, 변경 없음)
 * - waitBonus: t/(t+T) 함수 기반 (처리/대기 시간이 길수록 증가)
 *
 * Queue 상태:
 *   - registeredAt = enqueuedAt (queue 진입 시간)
 *   - waitBonus는 queue에서 대기한 시간 기반
 *
 * Running 상태:
 *   - registeredAt = startedAt (running 시작 시간)
 *   - waitBonus는 running 중 경과 시간 기반
 *   - 매 tick마다 재계산됨
 */
export class SizeAndWaitScorePolicy implements ScorePolicy {
  private readonly maxSizePriority: number;
  private readonly maxWaitBonus: number;
  private readonly elapsedTimeMaxMs: number;

  constructor(options: SizeAndWaitScorePolicyOptions) {
    this.maxSizePriority = options.maxSizePriority;
    this.maxWaitBonus = options.maxWaitBonus ?? 100; // 기본값: 100
    this.elapsedTimeMaxMs = options.elapsedTimeMaxMs ?? 600000; // 기본값: 10분
  }

  calculate(fileSize: number, now: number, registeredAt: number): PriorityScore {
    const sizePriority = this.calculateSizePriority(fileSize);
    const waitBonus = this.calculateWaitBonus(now, registeredAt);

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

  /**
   * t/(t+T) 함수를 이용한 waitBonus 계산
   * - 초반에는 천천히, 이후 적당한 속도로 증가
   * - elapsedTimeMaxMs 시간 후 최대값(maxWaitBonus)에 수렴
   */
  private calculateWaitBonus(now: number, registeredAt: number): number {
    const elapsedMs = Math.max(0, now - registeredAt);
    
    // t / (t + T) 함수 적용
    const ratio = elapsedMs / (elapsedMs + this.elapsedTimeMaxMs);
    const rawBonus = Math.floor(ratio * this.maxWaitBonus);
    
    return Math.min(this.maxWaitBonus, rawBonus);
  }
}
