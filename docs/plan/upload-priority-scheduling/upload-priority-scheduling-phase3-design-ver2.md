# 업로드 우선순위 스케줄링 Phase 3 설계 문서 Ver2

## 1. 문서 목적
이 문서는 Phase 3를 한 번에 읽을 수 있도록 실제 동작 흐름 중심으로 정리한 설계 문서다.

핵심 목표는 하나다.
running 상태 업로드들의 대역폭을 주기적으로 재할당해서 작은 파일 체감 성능을 올리되, 큰 파일도 최소 속도를 보장하는 것이다.

---

## 2. 설계 의도

### 2.1 문제
Phase 2까지는 queue 진입과 running 승격을 제어한다.
하지만 running 이후에는 속도 분배 기준이 없어, 특정 상황에서 큰 파일이 전체 대역폭을 오래 점유할 수 있다.

### 2.2 해결 의도
Phase 3는 running 집합에 대해 짧은 주기로 재할당을 수행한다.

원칙:
- 모든 running job에 최소 속도 보장
- 남는 대역폭은 score 비율로 분배
- 전체 합은 global 상한 이내 유지

결과적으로:
- 작은 파일은 더 빨리 끝남
- 큰 파일도 0으로 떨어지지 않음
- running 집합 변화에 빠르게 적응

---

## 3. 한 번에 보는 전체 흐름

1. UploadScheduler가 주기 tick을 실행한다.
2. 현재 runningJobs를 스냅샷으로 가져온다.
3. RateAllocator가 job별 목표 속도를 계산한다.
4. 계산 결과를 UploadScheduler가 runningJobs.allocatedRateBps에 반영한다.
5. 각 스트림은 getCurrentAllocatedRateBps(jobId)를 통해 최신 목표 속도를 읽는다.
6. 다음 tick에서 같은 과정을 반복한다.

즉, Phase 3의 핵심은 다음 한 줄이다.
스케줄러가 주기적으로 계산하고, 스트림은 읽어서 따른다.

---

## 4. 실제 예시 기반 설명

조건:
- globalIngressLimitBps = 20MB/s
- minRatePerJobBps = 1MB/s
- runningJobs = 3개
- score: A=100, B=50, C=25

### 4.1 1단계: 최소 보장
- A: 1MB/s
- B: 1MB/s
- C: 1MB/s
- baseTotal = 3MB/s
- remaining = 17MB/s

### 4.2 2단계: score 비례 분배
- scoreSum = 175
- A extra = 17 * (100/175) = 9.714...
- B extra = 17 * (50/175) = 4.857...
- C extra = 17 * (25/175) = 2.428...

### 4.3 3단계: 정수화 및 잔여 보정
- 내림 적용 후 남는 bps를 높은 score 순으로 1bps씩 분배
- 최종 합은 정확히 20MB/s로 맞춘다.

핵심 포인트:
- C도 최소 1MB/s는 확보
- A가 가장 큰 추가 분배를 받음
- 총합은 상한을 넘지 않음



---

## 5. 컴포넌트 책임

### 5.1 RateAllocator
입력:
- running job 목록(jobId, score)
- globalIngressLimitBps
- minRatePerJobBps

출력:
- jobId -> allocatedRateBps 맵
- totalAllocatedBps

책임:
- 분배 계산만 수행
- 상태 보관 없음

### 5.2 UploadScheduler 내부 Reallocation Loop
책임:
- tick 스케줄링
- running 스냅샷 수집
- allocator 호출
- 결과 반영

### 5.3 Stream 측 조회 계약
책임:
- 주입된 jobId로 현재 목표 속도 조회
- 실제 전송 제어는 Phase 4에서 구현

---

## 6. 의사코드

### 6.1 Reallocation Loop 의사코드
```ts
startReallocationLoop() {
  if (reallocRunning) return
  reallocRunning = true
  timer = setInterval(() => {
    if (!reallocRunning) return

    const running = snapshotRunningJobs()
    if (running.length === 0) return

    const result = allocator.allocate({
      runningJobs: running.map(j => ({ jobId: j.jobId, score: j.score })),
      globalIngressLimitBps: config.globalIngressLimitBps,
      minRatePerJobBps: config.minRatePerJobBps,
    })

    for (const [jobId, rate] of result.byJobId) {
      const job = runningJobs.get(jobId)
      if (job) job.allocatedRateBps = rate
    }
  }, config.reallocationIntervalMs)
}

stopReallocationLoop() {
  reallocRunning = false
  clearInterval(timer)
}
```

### 6.2 RateAllocator 의사코드
```ts
allocate(input) {
  const n = input.runningJobs.length
  if (n === 0) return emptyResult()

  const baseTotal = n * input.minRatePerJobBps
  if (baseTotal > input.globalIngressLimitBps) {
    throw ConfigError("minRate 합이 global 상한 초과")
  }

  const remaining = input.globalIngressLimitBps - baseTotal
  const scoreSum = sum(max(1, job.score) for job in input.runningJobs)

  const map = new Map()
  let used = 0

  for (job of input.runningJobs) {
    const normalizedScore = max(1, job.score)
    const extraFloat = remaining * (normalizedScore / scoreSum)
    const extra = floor(extraFloat)
    const rate = input.minRatePerJobBps + extra
    map.set(job.jobId, rate)
    used += rate
  }

  let residue = input.globalIngressLimitBps - used
  const sorted = sortByScoreDesc(input.runningJobs)
  let i = 0
  while (residue > 0) {
    const target = sorted[i % sorted.length]
    map.set(target.jobId, map.get(target.jobId) + 1)
    residue -= 1
    i += 1
  }

  return { byJobId: map, totalAllocatedBps: input.globalIngressLimitBps }
}
```

---

## 7. 데이터 계약

### 7.1 입력 계약
- score는 1 이상 정수로 정규화 후 사용
- runningJobs에는 중복 jobId가 없어야 함

### 7.2 출력 계약
- 모든 rate는 minRatePerJobBps 이상
- totalAllocatedBps는 globalIngressLimitBps 이하
- 가능하면 정확히 globalIngressLimitBps에 맞춤

---

## 8. 예외 및 실패 처리

- runningJobs가 0개면 계산 생략
- 계산 중 예외 발생 시 기존 allocatedRateBps 유지
- 예외 카운트 누적 및 경고 로그 출력
- 다음 tick에서 자동 재시도

---

## 9. 테스트 기준

단위 테스트:
- 최소 보장 검증
- 상한 준수 검증
- score 비례 검증
- 잔여 bps 보정 검증

통합 테스트:
- running 추가/완료 후 다음 tick 반영
- loop start/stop 동작
- allocator 예외 시 기존 값 유지

성능 테스트:
- running 100개 기준 tick 소요 시간
- 100~250ms 주기에서 CPU 사용량 관찰

---

## 10. 구현 전 확인 필요 사항 (구체화)

아래 3개 항목은 구현 전 의사결정이 필요하다.
각 항목은 기본 권장값도 함께 제시한다.

### 10.1 Rate 변동 제한 적용 여부
질문:
- 매 tick마다 rate가 크게 흔들리는 것을 제한할지?

선택지:
- A안: 비활성화 (단순, 즉시 반응)
- B안: 활성화 (안정적, 반응은 다소 느림)

권장:
- 1차 구현은 A안(비활성화)
- 모니터링 후 변동성이 크면 B안 적용

### 10.2 jobId 라벨 메트릭 노출 여부
질문:
- scheduler_job_allocated_rate_bps에 jobId 라벨을 직접 붙일지?

선택지:
- A안: jobId 라벨 사용 (디버깅 용이, 시계열 cardinality 증가)
- B안: 미사용, 집계 지표만 노출 (운영 안정)

권장:
- 기본은 B안
- 디버깅 모드에서만 A안 허용

### 10.3 Allocation 예외 시 정책
질문:
- allocator 실패 시 어떤 동작을 할지?

선택지:
- A안: fail-open (기존 rate 유지)
- B안: fail-closed (minRate로 강제 재설정)

권장:
- A안(fail-open)
- 이유: 트래픽 급락/급변을 피하고 서비스 연속성을 우선

---

## 11. 최종 결론
Phase 3는 다음 규칙으로 확정한다.
- running 집합에 대한 주기 재할당
- minRate 보장 + score 비례 분배
- global 상한 준수
- 실패 시 안전하게 복구 가능한 운영 정책

승인 후 구현 순서:
1. RateAllocator 구현
2. UploadScheduler reallocation loop 연결
3. getCurrentAllocatedRateBps 경로 연결
4. 단위/통합/성능 테스트 추가


---
# 요구사항

>> 코드 명시적으로 변경하기
```ts
startReallocationLoop() {
  if (reallocRunning) return
  reallocRunning = true
  timer = setInterval(() => {
    if (!reallocRunning) return

    const running = snapshotRunningJobs()
    if (running.length === 0) return

    const result = allocator.allocate({
      runningJobs: running.map(j => ({ jobId: j.jobId, score: j.score })),
      globalIngressLimitBps: config.globalIngressLimitBps,
      minRatePerJobBps: config.minRatePerJobBps,
    })

    for (const [jobId, rate] of result.byJobId) {
      const job = runningJobs.get(jobId)
      if (job) job.allocatedRateBps = rate
    }
  }, config.reallocationIntervalMs)
}
```
위 코드에서 
const job = runningJobs.get(jobId)
if (job) job.allocatedRateBps = rate
부분의 job이 복사본인지 원본인지 코드만 보고 확신이 안돼. 물론 참조값이니 같이 변경되겠지만, 코드만 읽어도 명확하게 알 수 있도록 수정이 필요해.
해당 코드 부분을 별도로 추출해서, 메서드 이름으로 의도를 알 수 있게 만들어.
다음 예시처럼.
```ts
for (const [jobId, rate] of result.byJobId) {
  updateJobRate(jobId, rate)
}

function updateJobRate(jobId: string, rate: number) {
  const job = runningJobs.get(jobId)
  if (!job) return

  job.allocatedRateBps = rate
}
```

>> 정수화 및 잔여 보정 로직

```ts
allocate(input) {
  const n = input.runningJobs.length
  if (n === 0) return emptyResult()

  const baseTotal = n * input.minRatePerJobBps
  if (baseTotal > input.globalIngressLimitBps) {
    throw ConfigError("minRate 합이 global 상한 초과")
  }

  const remaining = input.globalIngressLimitBps - baseTotal
  const scoreSum = sum(max(1, job.score) for job in input.runningJobs)

  const map = new Map()
  let used = 0

  for (job of input.runningJobs) {
    const normalizedScore = max(1, job.score)
    const extraFloat = remaining * (normalizedScore / scoreSum)
    const extra = floor(extraFloat)
    const rate = input.minRatePerJobBps + extra
    map.set(job.jobId, rate)
    used += rate
  }

  let residue = input.globalIngressLimitBps - used
  const sorted = sortByScoreDesc(input.runningJobs)
  let i = 0
  while (residue > 0) {
    const target = sorted[i % sorted.length]
    map.set(target.jobId, map.get(target.jobId) + 1)
    residue -= 1
    i += 1
  }

  return { byJobId: map, totalAllocatedBps: input.globalIngressLimitBps }
}
```

해당 로직(residue 관련 부분)에서 연산이 여러번 필요할 수 있을 것 같아.처음에 O(n)으로 읽고, 잔여 보정하기 위해서 다시 위에서부터 O(n)으로 읽게 되는 것 같아.
따라서 해당 연산이 반드시 필요한게 아니라면 굳이 추가하지 않아도 괜찮을 것 같다고 생각이 들어.
추후에 CPU 사용량을 직접 확인하고, 상황에 따라서 추가하거나 뺄 수 있도록 만들어줘.

>> 구현 전 확인 필요사항 10.1
어차피 TCP 혼잡제어 때문에, rate 비율이 갑자기 증가해도 큰 변화가 없다고 생각해. 오히려 rate 비율이 갑자기 증가하면 그만큼 리소스를 차지하기 때문에, TCP 속도는 안나오는데 rate만 차지해버리는 리소스 낭비가 발생한다고 생각해. rate가 갑자기 크게 감소하는 경우도 마찬가지야. B안을 선택해서 rate가 안정적으로 변화하도록 구현해

>> 10.2 
굳이 job id별로 메트릭 수집하기 위해서 라벨링 할필요는 없어. B안으로 진행해

>> 10.3 
A안으로 진행해.