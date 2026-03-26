# Phase 3 Rate Allocation - Ver 4: 최적화 분석

## 1. 현재 구현 문제점 분석 (Ver 3)

### 현재 방식: Tick 기반 전체 재할당 (Full Recalculation)

```
매 Tick (250ms마다):
├─ allocateRate()
│  ├─ minRate 할당: 모든 job × minRatePerJobBps
│  ├─ 남은 대역폭 계산: globalLimit - (N × minRate)
│  ├─ Score 합 계산: scoreSum (wait bonus 포함)
│  ├─ Score 비율로 분배: 각 job에 extra 할당
│  └─ Residue rebalance (선택사항): 남은 1bps 재분배
├─ applyRateStepLimit()
│  └─ 이전 rate ± step 범위로 clamp
└─ enforceGlobalLimitWithMinRate()
   └─ Global limit 초과 시 low-score 순 감소
```

### 문제점

1. **계산 중복**
   - `allocateRate()`의 핵심: minRate 블록 + score 비율 분배
   - Running jobs가 변하지 않고, score 변화가 없으면 **동일한 결과** 반복
   - 매 tick마다 불필요한 연산 반복

2. **CPU 오버헤드**
   - N개 job에 대해 매 tick 선형 OS(N) 연산 (allocateRate, applyRateStepLimit, enforceGlobalLimit)
   - 250ms 간격 × 250ms 이상 장시간 보관되는 job들
   - enableResidueRebalance=true 시 추가 정렬/순회 O(N log N)

3. **구현 복잡도**
   - `allocateRate()` → `applyRateStepLimit()` → `enforceGlobalLimit()` 3단계
   - Job 입장/퇴장, score 변화가 섞여 있어 각 단계의 책임이 모호함

---

## 2. 사용자 제안 방식 분석 (최적화 아이디어)

### 제안: Stateful 초기 할당 + Tick 기반 조정

```
Job 입장 시 (Running 프로즈로 전환):
├─ Score 계산
├─ 현재 running jobs 상태 기반 할당
└─ baseRatePerJob 저장 (이후 변하지 않음)

매 Tick (250ms마다):
├─ Score 변화 감지 (wait bonus 증가)
├─ Target rate 계산: baseRate + score_delta 조정
├─ Step limit 적용
└─ Global limit 조정 (최소한의 연산)
```

### 어디가 효율적인가?

| 항목 | Ver 3 | Ver 4 (제안) |
|------|-------|-------------|
| **allocateRate() 호출** | 매 tick | Job 입장 시만 |
| **계산 복잡도** | O(N) 매 tick | O(1) 조정 / O(N) job 입장 |
| **Score 재계산** | 매 tick | 매 tick (변동성 감지) |
| **Memory** | O(1) 상태 | O(N) baseRate 저장 |

### 트레이드오프

**장점:**
- ✅ 초기 할당 연산이 job 입장 시 1회만 실행
- ✅ Tick 단계의 간소화 (조정만 수행)
- ✅ CPU 유휴시간 활용 가능 (job 진입 때만 연산)

**단점:**
- ❌ Job 진입 시 O(N) 현재 상태 snapshot 필요 (running jobs 조회)
- ❌ baseRate 저장으로 메모리 +8 bytes/job
- ❌ Score 변화 처리 로직이 복잡해짐 (delta 기반 조정)

---

## 3. 더 자세한 분석: Score 변화의 실제 영향

### 문제: Score는 변하는가?

```typescript
// Current wait bonus:
waitBonus = Math.min(
  config.maxWaitBonus,
  (now - job.enqueuedAt) / config.waitBonusWindowMs
)
score = sizePriority + waitBonus
```

**매 tick (250ms)마다 score가 변한다!**

예시 (5개 job, 각 20MB/s 대역폭값):
```
Tick 0: Job A score=50 (new) → allocation = 20MB/s
Tick 1: Job A score=51 (wait bonus +1) → allocation = 20.4MB/s (조정 필요)
Tick 2: Job A score=52 → allocation = 20.8MB/s
```

### Ver 4에서의 처리

**Case 1: Score 변화 무시**
```
baseRate = 20MB/s (설정)
Tick마다: 현재 score 반영하지 않음
❌ Wait bonus의 의도 상실 (score 높을수록 priority up)
```

**Case 2: Score delta로만 조정**
```
baseRate = 20MB/s (job 입장 시, score=50 기준)
scoreDelta = current_score - initial_score

Tick 1: scoreDelta = 1 → extra = 0.4MB/s → total = 20.4MB/s ✓
Tick 2: scoreDelta = 2 → extra = 0.8MB/s → total = 20.8MB/s ✓
```

이 경우, **매 tick마다 여전히 score 기반 계산 필요**

---

## 4. 실제 최적화 지점 재평가

### 불필요한 연산은 어디인가?

#### 1️⃣ MinRate 할당 (N × minRate)
- **변함**: Running jobs 개수 N이 변할 때만
- **현재 비용**: 매 tick O(1) (합산)
- **최적화 가능**: Job 입장/퇴장 시만 계산

#### 2️⃣ Score 합 계산 (∑score)
- **변함**: Job score 변화 / job 입장,퇴장 시
- **현재 비용**: 매 tick O(N)
- **최적화 가능성**: 낮음 (score는 매 tick 변함)

#### 3️⃣ Score 비율 분배
- **변함**: Score 합 변화 또는 job 입장/퇴장
- **현재 비용**: 매 tick O(N)
- **최적화 가능성**: Job 변화 시만 재계산, score delta로 조정

#### 4️⃣ Residue rebalance
- **변함**: 할당 결과가 다를 때마다
- **현재 비용**: O(N log N) (선택사항)
- **최적화**: enableResidueRebalance=false로 비활성화

---

## 5. 실제 개선 방안 (Ver 4 구현)

### 방안 1: Job 입장 시 초기 Rate 저장

```typescript
interface RateAllocationJob {
  jobId: string;
  score: number;
  initialScore: number;        // ← Job 입장 시 score snapshot
  baseAllocatedRateBps: number; // ← Job 입장 시 할당 rate
  previousAllocatedRateBps: number;
}
```

**Job 입장 로직 (UploadScheduler.dispatchJob):**
```typescript
// 1. Job을 running으로 전환할 때
const job = ... // queue에서 pop한 job

// 2. 현재 running jobs 기반 inaugural allocation
const rateAllocationInput: RateAllocationInput = {
  runningJobs: Array.from(this.runningJobs.values()).map(j => ({
    jobId: j.jobId,
    score: j.score,
    previousAllocatedRateBps: 0 // 처음 진입
  }))
};

const result = this.rateAllocator.allocate(rateAllocationInput);
const initialRate = result.byJobId.get(job.jobId)!;

// 3. Job에 초기 값 저장
job.allocatedRateBps = initialRate;
job.initialScore = job.score;          // snapshot
job.baseAllocatedRateBps = initialRate; // snapshot

this.runningJobs.set(job.jobId, job);
```

**Tick 로직 (runReallocationTick) - 조정 전용:**
```typescript
private runReallocationTick(): void {
  const runningArray = Array.from(this.runningJobs.values());
  if (runningArray.length === 0) return;

  const scoreDeltaByJobId = new Map<string, number>();
  
  // Score delta만 계산
  for (const job of runningArray) {
    const currentScore = this.scorePolicy.calculateScore(job);
    const delta = currentScore - job.initialScore;
    scoreDeltaByJobId.set(job.jobId, delta);
  }

  // baseRate + delta 조정 (가벼운 연산)
  const adjustedByJobId = this.applyScoreDeltaAdjustment(
    runningArray,
    scoreDeltaByJobId
  );

  // Step limit 적용
  const limitedByJobId = this.applyRateStepLimit(
    runningArray,
    adjustedByJobId
  );

  // Global limit (필요시만)
  const boundedByJobId = this.enforceGlobalLimitWithMinRate(
    runningArray,
    limitedByJobId
  );

  this.applyAllocationResult(boundedByJobId);
}

private applyScoreDeltaAdjustment(
  runningJobs: UploadJob[],
  scoreDeltaByJobId: Map<string, number>
): Map<string, number> {
  const result = new Map<string, number>();
  
  for (const job of runningJobs) {
    const delta = scoreDeltaByJobId.get(job.jobId) ?? 0;
    const deltaRate = delta * this.perScoreBpsWeight;
    const targetRate = Math.max(
      this.config.minRatePerJobBps,
      job.baseAllocatedRateBps + deltaRate
    );
    result.set(job.jobId, targetRate);
  }
  
  return result;
}
```

---

### 방안 2: Job 퇴장 시 Rebalance

Job이 퇴장하면, **남은 job들이 baseRate 재계산 필요** (running job 수 변경)

```typescript
onJobCompleted(jobId: string): void {
  this.runningJobs.delete(jobId);
  
  // Running jobs가 변했으므로 baseRate 재계산 필요
  if (this.runningJobs.size > 0) {
    this.rebalanceBaseRates();
  }
}

private rebalanceBaseRates(): void {
  const runningArray = Array.from(this.runningJobs.values());
  
  // 현재 score 기반 새로운 baseRate 할당
  const result = this.rateAllocator.allocate({
    runningJobs: runningArray.map(j => ({
      jobId: j.jobId,
      score: this.scorePolicy.calculateScore(j),
      previousAllocatedRateBps: 0
    }))
  });
  
  // baseRate 업데이트
  for (const job of runningArray) {
    const newBase = result.byJobId.get(job.jobId)!;
    job.baseAllocatedRateBps = newBase;
    job.initialScore = this.scorePolicy.calculateScore(job);
  }
}
```

---

## 6. 최종 비교: Ver 3 vs Ver 4

| 항목 | Ver 3 | Ver 4 |
|------|-------|-------|
| **Tick 연산 복잡도** | O(N) | O(N) *약간 가벼움* |
| **Job 입장 복잡도** | O(1) 추가 | O(N) |
| **Job 퇴장 복잡도** | O(N) | O(N) (rebalance) |
| **Score 처리** | 매 tick 전체 재계산 | delta 기반 조정 |
| **메모리** | baseline | +16bytes/job (baseRate, initialScore) |
| **CPU 총량** | 안정적 O(N×tick) | Job 변화 기반 O(N×change) |

---

## 7. 결론 및 추천

### 사용자의 관찰: ✅ **부분적으로 타당함**

- ✅ **맞는 부분**: MinRate 할당 로직은 running job 수 변화 시에만 재계산 필요
- ✅ **맞는 부분**: Job 입장 시점에 "초기 기대치" 설정 가능
- ❌ **놓친 부분**: Score는 매 tick 변하므로 조정 로직은 여전히 필요

### 추천

**현재 Ver 3 유지 vs Ver 4 도입 기준:**

| 상황 | 추천 |
|------|------|
| Job 개수 < 10 | Ver 3 유지 (복잡도 이득 미미) |
| Job 개수 10-100 | **Ver 4 고려** (rebalance 패턴) |
| Job 개수 > 100 | **Ver 4 추천** (O(N) tick 누적 비용 큼) |
| Residue rebalance = false | Ver 4 → 더 효율적 |

### 구현 우선순위

1. **Phase 1**: Simplified Ver 4 (baseRate 저장, delta 조정만)
   - enableResidueRebalance=false로 시작
   - Job 입장/퇴장 시 rebalance만 수행

2. **Phase 2**: Full Ver 4 (residue rebalance 통합)
   - Residual 처리를 Job 入장 시만 수행

3. **Phase 3**: Score delta 세분화
   - Size priority와 wait bonus를 분리 추적
   - 각각의 rate 기여도 최적화

---

## 8. Appendix: Score Delta 기반 Rate 균형식

### 문제: Score delta를 Rate로 변환하는 가중치?

**현재:** Score 비율 기반 (score/scoreSum × remaining)

**Ver 4에서:** Score delta → rate delta

```
초기 할당:
baseRate = minRate + (score / scoreSum) × remaining

Tick 후:
scoreDelta = newScore - initialScore
newRate = baseRate + (scoreDelta / scoreSum_baseline) × remaining

문제: scoreSum이 변하면? (다른 job 종료)
```

**해결책:**
```typescript
// Job 입장 시 스냅샷
const perScoreBpsWeight = remaining / scoreSum_at_entry;

// Tick에서
scoreDelta = currentScore - initialScore;
rateAdjustment = scoreDelta * perScoreBpsWeight;
```

이렇게 하면 다른 job 종료 후에도 score delta 조정이 consistent함.
