# 업로드 우선순위 스케줄링 Phase 2 설계 문서 Ver2

## 1. 목적
- UploadScheduler를 중앙 디스패처 방식으로 재설계한다.
- 기존 waitForRunSlot 기반 개별 폴링 방식은 사용하지 않는다.
- PriorityScore 타입 기준으로 점수 계산 계약을 유지한다.

## 2. 필수 의문사항 답변

### 2.1 내가 의도했던 방향
- 이전 제안의 waitForRunSlot은 업로드 요청 단위로 대기 루프를 두는 구조였다.
- 이 방식은 구현이 단순하지만, 대기 작업 수가 늘수록 폴링 비용이 커진다.
- 결과적으로 우선순위 큐가 있어도 각 요청이 자체적으로 상태를 확인하므로 비효율이 생긴다.

### 2.2 사용자 제안 방향
- 중앙 스케줄러가 큐의 최상위 작업만 확인하고 실행 슬롯에 배치한다.
- 작업 선택 책임을 Scheduler 한 곳으로 모아 우선순위 큐의 이점을 직접 활용한다.
- 대기 작업 전체가 폴링하지 않으므로 제어 지점이 단순해진다.

### 2.3 비교 결론
- 이번 Ver2에서는 사용자 제안 방향을 채택한다.
- 즉, "요청별 폴링"이 아니라 "중앙 디스패처 루프"를 사용한다.

## 3. 핵심 아키텍처

### 3.1 구성 요소
- PriorityQueue
- UploadScheduler (Singleton)
- AdmissionTicket (작업별 Promise 제어 객체)
- TimeoutScanner (중앙 만료 처리)

### 3.2 동작 원칙
- enqueue 시 job을 큐에 넣고 Promise를 반환한다.
- Scheduler는 단일 루프에서 다음 실행 가능 작업을 꺼내 running으로 전이한다.
- 선택 기준은 PriorityQueue comparator를 따른다.
- timeout 검사도 Scheduler 루프에서 처리한다.

## 4. 상태 전이
- queued -> running
- running -> completed
- running -> failed
- queued -> timed_out

상태 전이는 UploadScheduler만 수행한다.

## 5. PriorityQueue 설계 확정

### 5.1 정렬 기준
1. score 내림차순
2. enqueuedAt 오름차순
3. fileSize 오름차순

### 5.2 필수 메서드
- enqueue(job)
- dequeue()
- peek()
- removeByJobId(jobId)
- size()
- isEmpty()
- snapshot()

removeByJobId는 timeout 처리와 취소 처리에 사용한다.

## 6. UploadScheduler Ver2 설계

### 6.1 public API
```ts
class UploadScheduler {
  static initialize(config: SchedulerConfig, scorePolicy: ScorePolicy): void;
  static getInstance(): UploadScheduler;

  enqueue(jobInput: EnqueueInput): Promise<AdmissionGrant>;
  markCompleted(jobId: string): void;
  markFailed(jobId: string, reason?: string): void;

  start(): void;
  stop(): void;
}
```

### 6.2 내부 자료구조
```ts
type AdmissionState = "waiting" | "granted" | "timed_out" | "cancelled";

interface AdmissionTicket {
  jobId: string;
  state: AdmissionState;
  resolve: (grant: AdmissionGrant) => void;
  reject: (error: Error) => void;
}
```

- waitingTickets: Map<jobId, AdmissionTicket>
- runningJobs: Map<jobId, UploadJob>
- queue: PriorityQueue

### 6.3 중앙 디스패처 루프
- 단일 tick 루프에서 다음 순서로 처리한다.
1. timeout sweep
2. available slot 계산
3. slot 수만큼 queue.dequeue로 작업 선택
4. selected job을 running으로 전이
5. 해당 ticket resolve

### 6.4 루프 의사코드
```ts
private tick(now: number): void {
  this.sweepTimeout(now);

  const available = this.config.maxRunningJobs - this.runningJobs.size;
  for (let i = 0; i < available; i += 1) {
    const next = this.queue.dequeue();
    if (!next) break;

    next.state = "running";
    next.startedAt = now;
    this.runningJobs.set(next.jobId, next);

    const ticket = this.waitingTickets.get(next.jobId);
    if (ticket && ticket.state === "waiting") {
      ticket.state = "granted";
      ticket.resolve({ jobId: next.jobId });
    }
  }
}
```

## 7. waitForRunSlot 대체 전략
- waitForRunSlot 메서드는 제거한다.
- enqueue가 Promise<AdmissionGrant>를 반환하고, 이 Promise가 실행 허가 신호 역할을 한다.
- 요청 단위 폴링 없이 이벤트 기반으로 대기 해제한다.

## 8. Timeout 처리 재설계

### 8.1 원칙
- timeout은 queued 상태에만 적용한다.
- timeout 판단과 상태 전이는 Scheduler가 단일 지점에서 수행한다.

### 8.2 처리 순서
1. queue.snapshot() 순회
2. now - enqueuedAt > queueTimeoutMs 조건 확인
3. removeByJobId(jobId) 수행
4. job.state = timed_out
5. waiting ticket reject

## 9. ScorePolicy / 타입 계약
- ScorePolicy.calculate의 반환 타입은 PriorityScore를 사용한다.
- UploadJob.score 갱신 시 PriorityScore.score 값을 반영한다.
- 타입 명세는 현재 코드 기준을 따른다.

## 10. 구현 체크리스트 (Ver2)

### PriorityQueue.ts
- [ ] removeByJobId(jobId) 추가
- [ ] snapshot() 추가
- [ ] comparator를 PriorityScore 기준으로 유지

### UploadScheduler.ts
- [ ] waitForRunSlot 제거
- [ ] enqueue Promise 기반 AdmissionTicket 도입
- [ ] 중앙 tick 루프 구현
- [ ] timeout sweep 단일화
- [ ] running 전이 시 ticket resolve
- [ ] timed_out 전이 시 ticket reject

### 테스트
- [ ] 대기 작업 수 증가 시 요청별 폴링이 없는지 검증
- [ ] 우선순위 높은 작업이 먼저 running 전이되는지 검증
- [ ] timeout 전이가 queued에서만 발생하는지 검증

## 11. 결론
- Ver2는 "중앙 디스패처 + 우선순위 큐" 구조로 확정한다.
- 사용자 우려였던 개별 폴링 비용을 제거한다.
- Phase 2 구현은 본 Ver2 문서를 기준으로 진행한다.


---

# 요구사항
>> 작업을 추가하는 방식을 polling에서 event 감지 방식으로 변경
현재 작업을 추가할 때, setTimeout으로 polling 방식을 사용중인것 같아. 이 방식은 필요하지 않는 순간에도 로직을 돌리기 때문에 비효율적이야. 따라서 상태 변화가 되는 시점에만 dispatch 실행해서 로직을 돌리도록 해.
상태 변화 시점은 다음 3개야.
1. enqueue
2. job 완료
3. job 실패
혹시 runningJob이 줄어드는 경우가 더 있다면, 그것또한 상태 변화로 넣을 필요가 있어. (우선은 이렇게 3개만 추가해서 구현하고, 만약 더 있다면, 마지막에 텍스트로 확인이 필요한 사항으로 추가해줘.)

다만 동시에 호출하게 될 경우에는 문제가 생길 수 있으니까, lock을 걸어서 동시 호출을 막아.
혹시 내가 고려하지 못한 사항이 있다면 말하고.


>> 리팩토링

loop 의사코드에서 queue를 for문으로 순회하는 코드로 너가 작성했어.
```typescript
private tick(now: number): void {
  this.sweepTimeout(now);

  const available = this.config.maxRunningJobs - this.runningJobs.size;
  for (let i = 0; i < available; i += 1) {
    const next = this.queue.dequeue();
    if (!next) break;

    next.state = "running";
    next.startedAt = now;
    this.runningJobs.set(next.jobId, next);

    const ticket = this.waitingTickets.get(next.jobId);
    if (ticket && ticket.state === "waiting") {
      ticket.state = "granted";
      ticket.resolve({ jobId: next.jobId });
    }
  }
}
```
이 방식 말고, while(available 확인 및 queue가 빌때까지) 로 해서, for문에 비해서 더 가독성 좋게 만들어줘


## 이해를 위한 메모용 (구현할때 참고X, 개인용)
이건 프롬프트에 넣지마. 내가 개인적으로 메모하려고 작성한거야.
위에 ticket을 resolve 하는데, 이 구현이 뭔지 설명한것.
```typescript
enqueue(job): Promise<AdmissionGrant> {
  return new Promise((resolve, reject) => {
    const ticket = {
      jobId: job.jobId,
      state: "waiting",
      resolve,
      reject
    };

    this.waitingTickets.set(job.jobId, ticket);
    this.queue.enqueue(job);
  });
}
```
작업이 들어오면 위의 형태로 await 걸리게 됨. 이를 해제하는 방법은 ticket 안에 있는 resolve를 호출하는 것임.
```typescript
    const ticket = this.waitingTickets.get(next.jobId);
    if (ticket && ticket.state === "waiting") {
      ticket.state = "granted";
      ticket.resolve({ jobId: next.jobId });
    }
```
위를 다시 보면, 현재 waitingTickets에 있는 resolve를 가져와서 호출하게 되는 것. 그러면 enqueue에 걸려있는 await가 풀리게된다. 