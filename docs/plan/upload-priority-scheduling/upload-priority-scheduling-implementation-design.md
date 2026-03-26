# 업로드 우선순위 스케줄링 구현 설계

## 0) 범위와 고정 정책

이 문서는 ver3의 `>>` 방향을 구현 가능한 설계로 내리는 문서다.

고정 정책:

- direct upload 기준으로 구현
- 동기 응답 방식 유지
- park(완전 정지) 미사용
- token 0 금지
- maxRunningJobs는 동적 변경이 아닌 고정 상한
- 상한 초과 요청은 큐 대기 후 timeout 또는 큐 상한 초과 시 거절
- 운영 파라미터는 env로 관리
- 실패/중단 파일은 즉시 삭제

---

## 1) 구현 체크리스트

## Phase 1. 스켈레톤 및 타입

- [ ] scheduler용 폴더/파일 생성
- [ ] UploadJob, JobState, SchedulerConfig 타입 정의
- [ ] 우선순위 점수 정책(score=sizePriority+waitBonus) 구현
- [ ] env 파서 및 기본값 유효성 검증 추가

## Phase 2. 큐 + 디스패치

- [ ] 큐 자료구조(우선순위 정렬 + enqueue 시각) 구현
- [ ] maxQueuedJobs/maxQueuedBytes 가드 적용
- [ ] queueTimeoutMs 만료 처리(queued -> timed_out)
- [ ] maxRunningJobs 고정 상한 기반 dispatch 구현

>> 질문
우선순위 큐로 하는건가? 우선순위 정렬 조건은 뭐야? -> 아마 내 생각에는 저용량 파일 + 대기 시간일 것 같다.
그런데 뺄때에는 대기 시간 기준으로 만료처리를 해야할텐데, 이렇게 되면 큐에 등록된 모든 작업을 읽어야하는 비효율이 있을 수도 있지 않겠나?
하지만 작업의 요청 수가 Queue 최대 길이(50-100)을 넘지 않는다는 것을 고려한다면 큰 문제가 없을 것 같긴 하지만, 일정 주기마다 이를 확인해야할텐데, 비효율적일 수 있다. 우선은 그대로 구현하되, 이후 너무 성능이 느려진다면 고려해봐야할 것 같다.


>> 구현
큐는 유일해야하고, 전체에서 1개만 관리해야한다. 싱글톤으로 구현해서, routes에서 주입하거나 가져와서 사용하는 방식으로 사용한다.

## Phase 3. 런타임 속도 재할당

- [ ] RateAllocator 구현(refill rate 재할당)
- [ ] minRatePerJob 강제(token 0 금지)
- [ ] reallocation loop(100~250ms) 구현
- [ ] queued aging(waitBonus) 반영

## Phase 4. 스트림 제어

- [ ] RateControlledTransform 구현(token bucket)
- [ ] transform 내부 버퍼 상한 적용
- [ ] backpressure 기반 감속 확인
- [ ] 업로드 중단/오류 시 자원 해제 루틴 구현

// 주석 메모 (개인적인 메모)
설계 방향 관련
런타임 속도 할당 class와 스트림 제어 class를 어떻게 붙이고, 분리할건지 고민이 필요하다.
런타임 속도 재할당에는 queue 내용도 있기 때문에, 하나의 class 내부에 queue와 token 할당 모두 두는 구조는 좋지 않은 듯 하다

## Phase 5. 라우트 통합

- [ ] PUT 라우트에서 기존 UploadLimiter 직접 거절 흐름 제거
- [ ] scheduler enqueue + 대기 + 실행 승격 흐름 적용
- [ ] objectService 업로드 파이프라인에 transform 삽입
- [ ] 기존 replication/notify 후처리 유지

## Phase 6. 운영/관측/안정성

- [ ] 핵심 메트릭 노출(queue length, queue wait p95, rate by priority)
- [ ] 로그 필드 표준화(jobId, state, score, allocatedRate)
- [ ] 부분 파일 즉시 삭제 정책 적용
- [ ] 문서화(env 목록, 장애 시 동작, timeout 응답 코드)

---

## 2) 권장 디렉토리 구조

아래는 최소 변경으로 시작하는 구조다.

```text
storage-node/src/services/objects/
  objectService.ts
  UploadLimiter.ts                # 단계적으로 사용 중단 예정
  scheduler/
    UploadScheduler.ts            # 메인 오케스트레이터
    types.ts                      # Job/State/Config 타입
    ScorePolicy.ts                # sizePriority + waitBonus
    PriorityQueue.ts              # queued 작업 관리
    RateAllocator.ts              # running 작업 rate 재배분
    SchedulerMetrics.ts           # 메트릭 집계/노출 helper
    errors.ts                     # QueueFull/QueueTimeout 등
    config.ts                     # env 파싱
    constants.ts
  stream/
    RateControlledTransform.ts    # token bucket transform
    TokenBucket.ts                # refill/capacity 계산 로직
```

기존 통합 지점:

- PUT 라우트: [storage-node/src/routes/objects.ts](../../storage-node/src/routes/objects.ts)
- 업로드 서비스: [storage-node/src/services/objects/objectService.ts](../../storage-node/src/services/objects/objectService.ts)

---

## 3) 클래스/함수 설계

## 3.1 핵심 타입

```ts
// scheduler/types.ts
export type JobState = "queued" | "running" | "completed" | "failed" | "timed_out";

export interface UploadJob {
  jobId: string;
  bucket: string;
  objectKey: string;
  fileSize: number;
  clientId: string; // ip 또는 인증 주체 기반
  enqueuedAt: number;
  startedAt?: number;
  state: JobState;
  sizePriority: number;
  waitBonus: number;
  score: number;
  minRateBps: number;
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
  tokenBucketCapacityBytes: number;
  transformBufferLimitBytes: number;
}
```

## 3.2 UploadScheduler

책임:

- queued/running 상태 전이
- dispatch 수행
- queue timeout 감시
- running 목록을 RateAllocator에 전달

핵심 메서드:

```ts
// scheduler/UploadScheduler.ts
class UploadScheduler {
  constructor(config: SchedulerConfig, deps: { now: () => number });

  enqueue(job: UploadJob): { accepted: true } | { accepted: false; reason: "queue_full" };
  waitForRunSlot(jobId: string): Promise<{ ok: true } | { ok: false; reason: "queue_timeout" }>;

  markRunning(jobId: string): void;
  markCompleted(jobId: string): void;
  markFailed(jobId: string, error?: Error): void;

  getAllocatedRate(jobId: string): number;
  startLoops(): void; // reallocation + timeout loop
  stopLoops(): void;
}
```

## 3.3 ScorePolicy

정책:

- score = sizePriority + waitBonus
- latencyClassBonus 없음(현재 범위 제외)

```ts
// scheduler/ScorePolicy.ts
export function calculateSizePriority(fileSize: number): number;
export function calculateWaitBonus(enqueuedAt: number, now: number): number;
export function calculateScore(fileSize: number, enqueuedAt: number, now: number): number;
```

>> 구현 방향
해당 정책은 이후에도 바뀔 수 있을 것 같다. class로 만들어 상속받고, 갈아 끼울 수 있도록 하자


## 3.4 RateAllocator

정책:

- 모든 running job의 allocatedRateBps >= minRatePerJobBps
- 총합 <= globalIngressLimitBps
- share는 score 정규화로 계산

```ts
// scheduler/RateAllocator.ts
export function allocateRates(
  runningJobs: UploadJob[],
  config: Pick<SchedulerConfig, "globalIngressLimitBps" | "minRatePerJobBps">,
): Map<string, number>; // jobId -> allocatedRateBps
```

## 3.5 RateControlledTransform / TokenBucket

정책:

- refill rate를 동적으로 주입받아 속도 제어
- chunk 즉시 전달 불가 시 내부 대기
- 내부 버퍼 상한 초과 금지

```ts
// stream/TokenBucket.ts
class TokenBucket {
  constructor(capacityBytes: number, initialRefillRateBps: number);
  setRefillRateBps(rate: number): void;
  consumeOrGetWaitMs(bytes: number, nowMs: number): { allowed: true } | { allowed: false; waitMs: number };
}

// stream/RateControlledTransform.ts
class RateControlledTransform extends Transform {
  constructor(options: {
    getRefillRateBps: () => number;
    capacityBytes: number;
    bufferLimitBytes: number;
  });
}
```

---

## 4) 라우트 및 서비스 통합 설계

## 4.1 PUT 라우트 변경 포인트

대상: [storage-node/src/routes/objects.ts](../../storage-node/src/routes/objects.ts)

기존:

- UploadLimiter.tryAcquire 실패 시 즉시 429

변경:

1. 요청 검증 후 UploadJob 생성
2. scheduler.enqueue
3. 큐 가득 참이면 즉시 429
4. 수락되면 scheduler.waitForRunSlot(jobId)에서 대기
5. timeout 시 408 정책 응답
6. running 승격 후 objectService.uploadFileWithRateControl 호출

## 4.2 업로드 서비스 변경 포인트

대상: [storage-node/src/services/objects/objectService.ts](../../storage-node/src/services/objects/objectService.ts)

추가 함수 권장:

```ts
export async function uploadFileWithRateControl(
  request: FastifyRequest<{ Querystring: PresignedQuery }>,
  replicationQueue: ReplicationQueueRepository,
  rateControl: { getCurrentRateBps: () => number; capacityBytes: number; bufferLimitBytes: number },
): Promise<FileInfo>;
```

내부:

- body stream -> RateControlledTransform -> file write stream
- 완료 후 기존 후처리(replication, notify) 재사용
- 오류/중단 시 부분 파일 즉시 삭제

>> 의문점 및 구현 방향
왜 내부에 replication, notify를 사용하지? 이 로직은 분리해서 사용해. 굳이 해당 로직 내부에서 처리할 필요가 없어보인다. 
만약, 합당한 이유가 있으면 너의 의도를 나에게 설명해

---

## 5) 실제 처리 플로우 예시 (동기 direct upload)

가정:

- maxRunningJobs=100 (서버 실제 한계 기반 고정)
- 현재 running=100
- queueTimeoutMs=30s

요청 예시:

- t=0s: 101번째 요청(소파일 5MB) 도착
- 상태: queued

흐름:

1. 요청 수락 후 queued 진입
2. running 슬롯이 없으므로 대기
3. 컨트롤 루프는 기존 running 100개의 rate를 계속 재분배
4. t=1.2s: running 중 1개 완료
5. scheduler가 queued 중 최고 score(소파일) 요청을 running 승격
6. 승격 즉시 transform 파이프라인 연결 후 업로드 시작
7. running set 전체 rate 재분배
8. 요청 완료 시 응답

timeout 케이스:

- t=30s까지 승격 실패 시 queued -> timed_out
- 라우트는 timeout 응답 반환

핵심:

- maxRunningJobs는 고정 상한
- 상한 이상은 queued에서만 대기
- running 작업은 park 없이 감속/가속만 수행

---

## 6) env 설계 초안

```env
UPLOAD_SCHEDULER_MAX_QUEUED_JOBS=500
UPLOAD_SCHEDULER_MAX_QUEUED_BYTES=10737418240
UPLOAD_SCHEDULER_MAX_RUNNING_JOBS=100
UPLOAD_SCHEDULER_QUEUE_TIMEOUT_MS=30000
UPLOAD_SCHEDULER_GLOBAL_INGRESS_LIMIT_BPS=20971520
UPLOAD_SCHEDULER_MIN_RATE_PER_JOB_BPS=262144
UPLOAD_SCHEDULER_REALLOCATION_INTERVAL_MS=200
UPLOAD_SCHEDULER_TOKEN_BUCKET_CAPACITY_BYTES=524288
UPLOAD_SCHEDULER_TRANSFORM_BUFFER_LIMIT_BYTES=1048576
```

---

## 7) 테스트 체크리스트

- [ ] running=상한일 때 신규 요청 queued 진입 확인
- [ ] queueTimeoutMs 초과 시 timed_out 전이 확인
- [ ] 소파일 유입 시 높은 allocatedRate 재분배 확인
- [ ] 어떤 running job도 allocatedRate=0이 되지 않음 확인
- [ ] 총 allocatedRate 합 <= globalIngressLimit 확인
- [ ] 클라이언트 중단 시 부분 파일 즉시 삭제 확인
- [ ] replication/notify 기존 동작 회귀 없음 확인

---

## 8) 구현 순서 권장

1. 타입 + config + ScorePolicy
2. PriorityQueue + UploadScheduler(상태 전이)
3. RateAllocator
4. RateControlledTransform
5. PUT 라우트 통합
6. objectService 파이프라인 통합
7. 메트릭 + 로그 + 테스트

---

## 9) 나중에 보완할 항목

- 클라이언트 공정성 고도화(per-client share 캡)
- 우선순위 오남용 방지(인증 기반 정책)
- 런타임 동적 파라미터 조정 API
- resumable 연계 고도화

---

## 10) 한 줄 결론

이 설계는 "고정 running 상한 + queued 대기 + running 감속/가속" 모델로, 현재 요구사항(`>>` 방향)을 그대로 구현 가능한 형태로 분해한 실행 설계다.
