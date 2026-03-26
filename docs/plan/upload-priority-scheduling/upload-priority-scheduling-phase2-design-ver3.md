# 업로드 우선순위 스케줄링 Phase 2 설계 문서 Ver2 Event-Driven

## 1. 목적
- Ver2 설계를 이벤트 기반 디스패치 방식으로 구체화한다.
- 주기 polling(setTimeout tick) 없이 상태 변화 시점에만 dispatch를 실행한다.
- PriorityScore 기반 우선순위 계약을 유지한다.

## 2. 핵심 변경점
- 기존: 주기 tick 루프 중심
- 변경: 이벤트 트리거 중심
- dispatch 진입 시 lock으로 동시 실행을 방지한다.

## 3. 이벤트 기반 dispatch 트리거
다음 3개 이벤트에서만 dispatch를 호출한다.
1. enqueue
2. job 완료(markCompleted)
3. job 실패(markFailed)

트리거 메서드 내부에서 공통으로 `scheduleDispatch()`를 호출한다.

## 4. 동시성 제어(lock)

### 4.1 상태 변수
```ts
private isDispatching = false;
private dispatchQueued = false;
```

### 4.2 동작 규칙
- dispatch 실행 중 추가 이벤트가 들어오면 `dispatchQueued = true`로 표시한다.
- 현재 dispatch가 끝나면 `dispatchQueued`를 확인하고 즉시 1회 더 dispatch를 실행한다.
- 결과적으로 동시에 2개 이상의 dispatch가 실행되지 않는다.

### 4.3 의사코드
```ts
private scheduleDispatch(): void {
  if (this.isDispatching) {
    this.dispatchQueued = true;
    return;
  }

  void this.runDispatch();
}

private async runDispatch(): Promise<void> {
  this.isDispatching = true;
  try {
    do {
      this.dispatchQueued = false;
      this.dispatchOnce();
    } while (this.dispatchQueued);
  } finally {
    this.isDispatching = false;
  }
}
```

## 5. UploadScheduler API (Ver2 Event-Driven)
```ts
class UploadScheduler {
  static initialize(config: SchedulerConfig, scorePolicy: ScorePolicy): void;
  static getInstance(): UploadScheduler;

  enqueue(jobInput: EnqueueInput): Promise<AdmissionGrant>;
  markCompleted(jobId: string): void;
  markFailed(jobId: string, reason?: string): void;

  // 내부
  private scheduleDispatch(): void;
  private runDispatch(): Promise<void>;
  private dispatchOnce(): void;
}
```

## 6. dispatchOnce 상세

### 6.1 처리 순서
1. timeout sweep 수행
2. available 계산
3. while 조건으로 큐에서 작업을 꺼내 running 전이
4. ticket resolve

### 6.2 while 기반 의사코드
```ts
private dispatchOnce(): void {
  const now = Date.now();
  this.sweepTimeout(now);

  let available = this.config.maxRunningJobs - this.runningJobs.size;

  while (available > 0 && !this.queue.isEmpty()) {
    const next = this.queue.dequeue();
    if (!next) {
      break;
    }

    next.state = "running";
    next.startedAt = now;
    this.runningJobs.set(next.jobId, next);

    const ticket = this.waitingTickets.get(next.jobId);
    if (ticket && ticket.state === "waiting") {
      ticket.state = "granted";
      ticket.resolve({ jobId: next.jobId });
    }

    available -= 1;
  }
}
```

## 7. timeout 처리
- timeout 판단은 dispatch 진입 시점마다 수행한다.
- timeout 대상은 queued 상태만 처리한다.
- timeout 전이 시 queue 제거 + ticket reject를 수행한다.

```ts
private sweepTimeout(now: number): void {
  const jobs = this.queue.snapshot();
  for (const job of jobs) {
    if (now - job.enqueuedAt <= this.config.queueTimeoutMs) {
      continue;
    }

    const removed = this.queue.removeByJobId(job.jobId);
    if (!removed) {
      continue;
    }

    job.state = "timed_out";
    const ticket = this.waitingTickets.get(job.jobId);
    if (ticket && ticket.state === "waiting") {
      ticket.state = "timed_out";
      ticket.reject(new Error(`Queue timeout: ${job.jobId}`));
      this.waitingTickets.delete(job.jobId);
    }
  }
}
```

## 8. PriorityQueue 요구 API
- enqueue(job)
- dequeue()
- peek()
- isEmpty()
- size()
- snapshot()
- removeByJobId(jobId)

정렬 기준은 기존과 동일하다.
1. score 내림차순
2. enqueuedAt 오름차순
3. fileSize 오름차순

## 9. 상태 전이
- queued -> running
- running -> completed
- running -> failed
- queued -> timed_out

상태 전이는 UploadScheduler 내부에서만 수행한다.

## 10. 구현 체크리스트

### Scheduler
- [ ] polling tick 제거
- [ ] enqueue/markCompleted/markFailed에서 scheduleDispatch 호출
- [ ] dispatch lock(isDispatching) 적용
- [ ] dispatchQueued 플래그 적용
- [ ] dispatchOnce를 while 기반으로 구현
- [ ] sweepTimeout를 dispatchOnce 선행 단계로 통합

### Queue
- [ ] removeByJobId(jobId)
- [ ] snapshot()

### Tests
- [ ] 이벤트 3종에서만 dispatch가 동작하는지 검증
- [ ] 동시 enqueue 시 dispatch 중복 실행이 없는지 검증
- [ ] while 기반 dispatch로 슬롯이 찰 때까지 할당되는지 검증
- [ ] timeout이 queued에서만 처리되는지 검증

## 11. 확인 필요 사항
현재 요구하신 3개 이벤트( enqueue / 완료 / 실패 )만 트리거로 반영했다.
아래 경우는 runningJobs가 줄어들 수 있어 추가 확인이 필요하다.
- 업로드 취소(cancel)
- 연결 종료/클라이언트 abort
- 내부 예외로 인한 강제 종료(cleanup)

위 이벤트를 지원하면 해당 지점에서도 `scheduleDispatch()` 호출을 추가해야 한다.

## 12. 결론
- Ver2 구현 기준은 이벤트 기반 dispatch + lock 방식으로 확정한다.
- 불필요한 주기 polling을 제거하고, 상태 변화 시점에만 스케줄링을 수행한다.
- 디스패치 반복은 for 대신 while로 정리해 가독성을 높인다.


# 요구사항
>> 네이밍
markCompleted, markFailed 네이밍을 mark가 아닌 job으로 변경하자. 

>> 구현
11번에 확인 필요사항에 적인 부분에 대해서, jobAborted() 함수를 추가적으로 만들어서 처리하자.