# 업로드 우선순위 스케줄링 Phase 3 설계 문서

## 1. 문서 목적
Phase 3의 목표는 running 상태 업로드들에 대한 대역폭을 동적으로 재할당하는 것이다.

이 문서는 구현 코드가 아니라 설계 기준 문서이며, 다음 피드백을 받기 위한 초안이 아닌 완성 설계안이다.

## 2. 설계 의도

### 2.1 왜 Phase 3가 필요한가
Phase 2는 큐 입장과 실행 승격을 제어한다.
하지만 running 이후 속도를 제어하지 않으면, 큰 파일이 작은 파일의 체감 지연을 악화시킬 수 있다.

Phase 3는 running 단계에서 속도를 재분배해 다음을 달성한다.
- 작은 파일의 완료 시간을 단축
- 대기열 없이 실행 중인 작업 간 공정성 유지
- 특정 작업 starvation 방지

### 2.2 어떤 원칙으로 재할당하는가
- token 0 금지: 모든 running job은 최소 대역폭을 보장
- global 상한 준수: 총 할당률은 globalIngressLimitBps를 넘지 않음
- score 기반 가중치: 남는 대역폭은 score 비율로 분배
- 안정성 우선: 급격한 rate 변동을 제한

## 3. 범위

포함:
- RateAllocator 설계
- reallocation tick 설계
- Scheduler와 Transform 연결 계약 정의
- 관측 지표/검증 기준 정의

제외:
- 스트림 내부 토큰버킷 구현 상세(Phase 4)
- 라우트 통합(Phase 5)

## 4. 구성 요소

### 4.1 RateAllocator
입력된 running job 목록과 설정값을 이용해 job별 allocatedRateBps를 계산한다.

### 4.2 ReallocationCoordinator
UploadScheduler 내부에서 주기 tick을 실행하고,
RateAllocator 결과를 running job 메타데이터에 반영한다.

### 4.3 RateProvider 계약
각 업로드 스트림은 자신의 현재 refill rate를 조회할 수 있어야 한다.
Phase 3에서는 조회 계약까지만 확정한다.

## 5. 데이터/인터페이스 설계

### 5.1 타입
```ts
interface RateAllocationInput {
  runningJobs: Array<{
    jobId: string;
    score: number;
  }>;
  globalIngressLimitBps: number;
  minRatePerJobBps: number;
}

interface RateAllocationResult {
  byJobId: Map<string, number>; // allocatedRateBps
  totalAllocatedBps: number;
}
```

### 5.2 RateAllocator 시그니처
```ts
allocate(input: RateAllocationInput): RateAllocationResult
```

### 5.3 UploadScheduler 추가 계약
```ts
startReallocationLoop(): void
stopReallocationLoop(): void
getCurrentAllocatedRateBps(jobId: string): number
```

## 6. 할당 알고리즘

### 6.1 전제 검증
- runningJobs 길이가 0이면 빈 결과 반환
- n * minRatePerJobBps <= globalIngressLimitBps 가 항상 성립해야 함
- 불성립 시 config 오류로 간주

### 6.2 1단계: 최소 보장 할당
모든 running job에 minRatePerJobBps를 먼저 할당한다.

```text
baseTotal = n * minRatePerJobBps
remaining = globalIngressLimitBps - baseTotal
```

### 6.3 2단계: score 비례 추가 할당
remaining > 0이면 score 합으로 정규화해 추가 할당한다.

```text
extra_i = remaining * (score_i / scoreSum)
allocated_i = minRatePerJobBps + extra_i
```

### 6.4 3단계: 정수화/잔여 처리
- 실수 연산 결과는 bps 정수로 내림
- 내림으로 발생한 잔여 bps는 score 높은 순으로 1bps씩 분배
- 최종 총합이 globalIngressLimitBps와 정확히 일치하도록 보정

## 7. 재할당 주기

### 7.1 기본 주기
- reallocationIntervalMs 사용
- 권장 범위: 100~250ms

### 7.2 왜 주기가 필요한가
Phase 2는 이벤트 기반 dispatch를 사용한다.
하지만 running 중 score 변화(완료 임박, job 변동 등)를 반영하려면 일정 주기의 재할당이 필요하다.

### 7.3 실행 모델
- 단일 루프만 허용
- 루프 재진입 방지 플래그 사용
- stop 시 즉시 종료

## 8. Scheduler 연동 흐름

1. Reallocation tick 시작
2. runningJobs 스냅샷 수집
3. RateAllocator.allocate 호출
4. 각 job의 allocatedRateBps 갱신
5. rate 변경 이벤트를 스트림 측 조회 경로로 노출

## 9. 안정화 규칙

### 9.1 급격한 변동 제한
연속 tick 사이 rate 변화폭을 제한한다.
- maxStepUpBps
- maxStepDownBps

해당 파라미터는 선택값으로 두고 기본은 비활성화한다.

### 9.2 score 이상치 보호
- score 하한: 1
- score 상한: config.maxSizePriority + config.maxWaitBonus

## 10. 장애/예외 처리

- runningJobs가 비면 allocation skip
- 특정 job이 중간에 종료되면 다음 tick에서 제외
- allocate 중 예외 발생 시 이전 allocatedRateBps 유지
- 연속 예외 횟수 임계치 초과 시 경고 로그 출력

## 11. 관측 지표

필수 지표:
- scheduler_running_jobs
- scheduler_total_allocated_bps
- scheduler_job_allocated_rate_bps{jobId}
- scheduler_reallocation_duration_ms
- scheduler_reallocation_error_total

권장 지표:
- scheduler_rate_change_abs_bps_sum
- scheduler_rate_fairness_index

## 12. 테스트 설계

단위 테스트:
- minRate 보장 검증
- total <= global 상한 검증
- score 비례 분배 검증
- 잔여 bps 보정 검증

통합 테스트:
- running job 추가/완료 시 다음 tick 반영 검증
- 재할당 루프 start/stop 검증
- 예외 발생 시 이전 값 유지 검증

성능 테스트:
- running 100개 기준 tick 지연 측정
- 100~250ms 주기에서 CPU 사용량 추정

## 13. 구현 전 확인 필요 사항

1. rate 변동 제한(maxStepUp/Down)을 1차 릴리스에서 켤지 여부
2. job별 allocatedRate를 외부 메트릭에서 jobId 라벨로 노출할지 여부
3. 재할당 예외 시 fail-open(기존 값 유지) 정책 확정 여부

## 14. 결론

Phase 3는 minRate 보장 + score 비례 분배를 중심으로 설계한다.
Phase 2의 이벤트 기반 dispatch와 충돌하지 않도록,
running 제어는 별도의 재할당 루프로 독립시킨다.

이 설계가 승인되면 Phase 3 구현은 다음 순서로 진행한다.
1. RateAllocator 구현
2. UploadScheduler reallocation loop 연동
3. getCurrentAllocatedRateBps 조회 경로 확정
4. 단위/통합 테스트 추가

# 요구사항 및 질의사항
>> 요구사항
설계가 별도로 분리되어있어, 하나의 흐름으로 읽기가 어려움.
실제 예시를 바탕으로 이해할 수 있도록 설명하고 의사 코드를 설계하여 md 문서로 다시 작성.
현 문서상 특이사항은 없고, 위 요구사항을 바탕으로 문서 작성.
+ 구현 전 확인 필요사항을 이해하지 못하겠음. 구체적으로 다시 작성할것.


>> 네이밍 변경 
```ts
targetByJobId
limitedByJobId
boundedByJobId
```
위 값이 뭘 말하는지, 단수인지 여러 값들을 담고있는 타입인지 유추하기가 어렵다. 이름만으로 뭘 담고있는지 확인할 수 있도록 수정해라