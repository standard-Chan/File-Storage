import { ScorePolicy } from "./scorePolicy/ScorePolicy";

export interface RateAllocationJob {
  jobId: string;
  score: number;
  previousAllocatedRateBps: number;
  fileSize: number;      // 파일 크기 (score 재계산용)
  startedAt: number;     // running 시작 시간 (score 재계산용)
}

export interface RateAllocatorConfig {
  globalIngressLimitBps: number;
  minRatePerJobBps: number;
  enableResidueRebalance: boolean;
  rateStepUpBps: number;
  rateStepDownBps: number;
}

export interface RateAllocationResult {
  allocatedRateByJobIdMap: Map<string, number>;
  totalAllocatedBps: number;
}


/**
 * running 상태 업로드 job들에 대해 대역폭(rate)을 계산하는 Class
 *
 * 역할:
 * - 전체 업로드 대역폭(global limit)을 job 단위로 분배
 *
 * 기능:
 * 1. 각 job에 최소 속도(minRate) 보장
 * 2. score 기반으로 남은 대역폭을 비례 분배
 * 3. 이전 tick 대비 rate 변화량 제한 (step up/down)
 * 4. global 상한 초과 시 낮은 priority job부터 감소
 * 5. (옵션) residue 보정으로 남은 bps 재분배 - (CPU 성능 문제가 발생할 경우 OFF 하기)
 *
 * 보완할 점:
 * - 매 tick 마다 속도 분배 -> 속도 상향조정 -> 속도 하향조정이 진행된다. 
 *  따라서 O(3N) 이 소요된다. 
 * 현재 최대 running jobs의 수가 100 미만이므로 성능상 문제는 없을 수 있지만, 성능 문제가 생길 경우, 분배 + 조정 로직을 하나로 합쳐 처리할 필요가 있다.
*/
export class RateAllocator {
  private readonly config: RateAllocatorConfig;
  private readonly scorePolicy: ScorePolicy;

  constructor(config: RateAllocatorConfig, scorePolicy: ScorePolicy) {
    this.config = config;
    this.scorePolicy = scorePolicy;
  }

  /**
   * 전체 rate allocation 실행
   * 1. score 재계산 (현재 시점 기준 - running job의 경과 시간 기반)
   * 2. 재계산된 score 기반으로 rate 분배
   * 3. step limit 적용 (급격한 변화 제한)
   * 4. global limit 초과 시 재조정
   */
  allocate(runningJobs: RateAllocationJob[]): RateAllocationResult {
    if (runningJobs.length === 0) {
      return { allocatedRateByJobIdMap: new Map<string, number>(), totalAllocatedBps: 0 };
    }

    const minTotalBps = runningJobs.length * this.config.minRatePerJobBps;
    if (minTotalBps > this.config.globalIngressLimitBps) {
      throw new Error("minRate 합이 global 상한을 초과합니다.");
    }

    // 1. running jobs의 score를 재계산 (현재 시점 기준)
    const updatedJobs = this.recalculateJobScores(runningJobs);

    // 2. score 기반 목표 rate 계산
    const targetRateMap = this.allocateRate(updatedJobs);

    // 3. step 제한 적용 (급격한 변화 제한)
    const stepLimitedRateMap = this.applyRateStepLimit(
      runningJobs,
      targetRateMap,
    );

    // 4. global limit 초과 시 조정 (최종 결과)
    const finalRateMap = this.enforceGlobalLimitWithMinRate(
      runningJobs,
      stepLimitedRateMap,
    );

    let total = 0;
    for (const rate of finalRateMap.values()) {
      total += rate;
    }

    return {
      allocatedRateByJobIdMap: finalRateMap,
      totalAllocatedBps: total,
    };
  }

  /**
   * running jobs의 score를 재계산 (현재 시점 기준)
   * - 각 job의 처리 시작 시간(startedAt) 이후 경과 시간을 기반으로 score 재계산
   * - ScorePolicy를 통해 current score를 획득
   */
  private recalculateJobScores(runningJobs: RateAllocationJob[]): RateAllocationJob[] {
    const now = Date.now();
    return runningJobs.map(job => ({
      ...job,
      score: this.scorePolicy.calculate(job.fileSize, now, job.startedAt).score,
    }));
  }

  /**
   * score에 따라 대역폭을 할당
   * minRate를 할당하고, score 비례로 추가 대역폭 분배한다
   * 주의: allocate() 호출 이후 updatedJobs (재계산된 score)를 입력해야 함
   * residue 옵션 ON일 경우 남은 bps 재분배
   */
  private allocateRate(
    runningJobs: RateAllocationJob[],
  ): Map<string, number> {
    const result = new Map<string, number>();

    const minTotalRate = runningJobs.length * this.config.minRatePerJobBps;
    const remaining = this.config.globalIngressLimitBps - minTotalRate;

    const scoreSum = this.calculateScoreSum(runningJobs);
    const usedRate = this.distributeWeightedRate(
      runningJobs,
      result,
      remaining,
      scoreSum,
    );

    // applyResidueRebalance 가 cpu 연산이 들어가므로, 상황에 따라 ON, OFF 하여 사용한다.
    if (!this.config.enableResidueRebalance) return result;
    this.applyResidueRebalance(
      runningJobs,
      result,
      this.config.globalIngressLimitBps - usedRate,
    );

    return result;
  }

  /**
   * score 합 계산 (최소 1 보정 포함)
   */
  private calculateScoreSum(runningJobs: RateAllocationJob[]): number {
    let scoreSum = 0;

    for (const job of runningJobs) {
      scoreSum += Math.max(1, job.score);
    }

    return scoreSum;
  }

  /**
   * minRate 보장 후, 남은 대역폭을 score 비율로 분배
   * 결과를 byJobId에 기록하고 총 사용량 반환
   */
  private distributeWeightedRate(
    runningJobs: RateAllocationJob[],
    byJobId: Map<string, number>,
    remaining: number,
    scoreSum: number,
  ): number {
    let used = 0;

    for (const job of runningJobs) {
      const normalizedScore = Math.max(1, job.score);

      const extraFloat = remaining * (normalizedScore / scoreSum);
      const extra = Math.floor(extraFloat);

      const rate = this.config.minRatePerJobBps + extra;

      byJobId.set(job.jobId, rate);
      used += rate;
    }

    return used;
  }

  /**
   * 남아있는 대역폭residue를 score 높은 순으로 재분배
   */
  private applyResidueRebalance(
    runningJobs: RateAllocationJob[],
    byJobId: Map<string, number>,
    residue: number,
  ): void {
    if (residue <= 0 || runningJobs.length === 0) {
      return;
    }

    const sorted = [...runningJobs].sort((a, b) => {
      const scoreDiff = b.score - a.score;
      if (scoreDiff !== 0) {
        return scoreDiff;
      }
      return a.jobId.localeCompare(b.jobId);
    });

    let cursor = 0;
    let remain = residue;
    while (remain > 0) {
      const target = sorted[cursor % sorted.length];
      const current = byJobId.get(target.jobId) ?? this.config.minRatePerJobBps;
      byJobId.set(target.jobId, current + 1);
      remain -= 1;
      cursor += 1;
    }
  }

  /**
   * 이전 tick 대비 rate 변화량 제한
   * - step up/down 범위 내로 clamp
   * - minRate는 항상 우선 적용
   */
  private applyRateStepLimit(
    runningJobs: RateAllocationJob[],
    targetByJobId: Map<string, number>,
  ): Map<string, number> {
    const limited = new Map<string, number>();

    for (const job of runningJobs) {
      const targetRate =
        targetByJobId.get(job.jobId) ?? this.config.minRatePerJobBps;
      const previous = Math.max(0, job.previousAllocatedRateBps || 0);

      if (previous <= 0) {
        limited.set(
          job.jobId,
          Math.max(this.config.minRatePerJobBps, targetRate),
        );
        continue;
      }

      // 최대 폭 제한
      const minByStep = Math.max(0, previous - this.config.rateStepDownBps); // 최대 감소량
      const maxByStep = previous + this.config.rateStepUpBps;  // 최대 증가량
      const clampedByStep = Math.max(
        minByStep,
        Math.min(targetRate, maxByStep),
      );

      limited.set(
        job.jobId,
        Math.max(this.config.minRatePerJobBps, clampedByStep),
      );
    }

    return limited;
  }

  /**
   * globalIngressLimit 초과 시 초과분 제거
   * - 낮은 score job부터 감소
   * - minRate 이하로는 절대 내려가지 않음
   */
  private enforceGlobalLimitWithMinRate(
    runningJobs: RateAllocationJob[],
    byJobId: Map<string, number>,
  ): Map<string, number> {
    const result = new Map(byJobId);
    let total = 0;
    for (const rate of result.values()) {
      total += rate;
    }

    let overflow = total - this.config.globalIngressLimitBps;
    if (overflow <= 0) {
      return result;
    }

    const lowPriorityFirst = [...runningJobs].sort((a, b) => {
      const scoreDiff = a.score - b.score;
      if (scoreDiff !== 0) {
        return scoreDiff;
      }
      return a.jobId.localeCompare(b.jobId);
    });

    for (const job of lowPriorityFirst) {
      if (overflow <= 0) {
        break;
      }

      const current = result.get(job.jobId) ?? this.config.minRatePerJobBps;
      const reducible = current - this.config.minRatePerJobBps;
      if (reducible <= 0) {
        continue;
      }

      const delta = Math.min(reducible, overflow);
      result.set(job.jobId, current - delta);
      overflow -= delta;
    }

    return result;
  }
}
