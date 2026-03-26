# 업로드 우선순위 스케줄링 Phase 2 설계 문서

## 1. Phase 2 개요

### 1.1 목표
Phase 1의 타입/설정/정책을 기반으로, **큐 관리 + 스케줄러 메인 로직** 을 구현한다.

### 1.2 구현 범위

| 컴포넌트 | 책임 | 파일 |
|---------|------|------|
| PriorityQueue | 작업을 우선순위로 정렬하여 관리 | `scheduler/PriorityQueue.ts` |
| UploadScheduler | 큐/실행 작업 관리 + 상태 전이 | `scheduler/UploadScheduler.ts` |

### 1.3 의존성
- Phase 1 완료: types.ts, config.ts, ScorePolicy.ts ✓
- envParser.ts 보조 ✓

---

## 2. PriorityQueue 설계

### 2.1 용도
- 우선순위 기반 job 정렬
- score 계산에 따른 동적 재정렬 (실시간 waitBonus 변화)
- Timeout 만료 추적

### 2.2 데이터 구조

```typescript
/**
 * 최소-최대 힙 기반 우선순위 큐
 * 자바의 PriorityQueue처럼 동작
 */
export class PriorityQueue {
  private items: UploadJob[] = [];
  private readonly scorePolicy: ScorePolicy;
  private readonly maxSize: number;

  constructor(scorePolicy: ScorePolicy, maxSize: number);
  enqueue(job: UploadJob): void;
  dequeue(): UploadJob | undefined;
  peek(): UploadJob | undefined;
  size(): number;
  isEmpty(): boolean;
  isFull(): boolean;
  findTimedOutJobs(now: number, queueTimeoutMs: number): UploadJob[];
}
```

### 2.3 Comparator 로직

정렬 기준 (내림차순):

```
1. score (높을수록 우선) → calculateScore() 호출
   - score = sizePriority + waitBonus
   - waitBonus는 현재 시간 기반 계산
2. enqueuedAt (오름차순, 타이브레이커1)  
   - 먼저 들어온 작업 우선
3. fileSize (오름차순, 타이브레이커2)
   - 파일 작은 것 우선
```

**구현 상세:**

```typescript
private compare(jobA: UploadJob, jobB: UploadJob): number {
  // score 계산 (현재 시간 기반)
  const now = Date.now();
  const scoreA = this.scorePolicy.calculate(jobA.fileSize, jobA.enqueuedAt, now).score;
  const scoreB = this.scorePolicy.calculate(jobB.fileSize, jobB.enqueuedAt, now).score;

  // 1. score 내림차순
  if (scoreA !== scoreB) {
    return scoreB - scoreA; // 내림차순 (높을수록 앞)
  }

  // 2. enqueuedAt 오름차순 (타이브레이커1)
  if (jobA.enqueuedAt !== jobB.enqueuedAt) {
    return jobA.enqueuedAt - jobB.enqueuedAt;
  }

  // 3. fileSize 오름차순 (타이브레이커2)
  return jobA.fileSize - jobB.fileSize;
}
```

### 2.4 주요 메서드

#### enqueue(job: UploadJob): void
- 작업을 큐에 추가
- 최대 크기 초과 시: 에러 발생
- 내부: heap insertion (O(log n))

```typescript
/**
 * 작업을 큐에 추가한다 (비차단 작업)
 * 큐가 full 상태이면 에러 발생
 * @param job 추가할 작업
 * @throws Error 큐가 가득 찼거나 job이 null이면 발생
 */
enqueue(job: UploadJob): void {
  if (this.isFull()) {
    throw new Error(`우선순위 큐 가득 참: max=${this.maxSize}`);
  }
  if (!job) {
    throw new Error("null job을 enqueue할 수 없습니다");
  }
  // heap 추가 + bubble-up
  this.items.push(job);
  this.bubbleUp(this.items.length - 1);
}
```

#### dequeue(): UploadJob | undefined
- 우선순위 1위 작업 제거 및 반환
- 큐가 비어있으면 undefined 반환

```typescript
/**
 * 우선순위 1위 작업을 제거하고 반환한다
 * @returns 제거된 작업, 또는 빈 큐면 undefined
 */
dequeue(): UploadJob | undefined {
  if (this.isEmpty()) {
    return undefined;
  }

  const removed = this.items[0];
  const last = this.items.pop()!;

  if (this.items.length > 0) {
    this.items[0] = last;
    this.bubbleDown(0);
  }

  return removed;
}
```

#### findTimedOutJobs(now: number, queueTimeoutMs: number): UploadJob[]
- 현재 시간 기준, 대기 초과 작업 탐색
- **O(n) 선형 스캔** - 현재 최대 500~1000 작업 수준에서 허용 가능
- 상태 변경은 하지 않음 (UploadScheduler에서 상태 전이 담당)

```typescript
/**
 * 큐에서 타임아웃된 작업들을 찾는다
 * O(n) 선형 스캔 수행 (큐 크기가 작으므로 실용적)
 *
 * @param now 현재 시간 (milliseconds since epoch)
 * @param queueTimeoutMs 타임아웃 기준 (ms)
 * @returns 타임아웃된 작업들 (상태 변경 미실시)
 *
 * 타임아웃 조건: (now - job.enqueuedAt) > queueTimeoutMs
 */
findTimedOutJobs(now: number, queueTimeoutMs: number): UploadJob[] {
  const timedOut: UploadJob[] = [];
  for (const job of this.items) {
    if (now - job.enqueuedAt > queueTimeoutMs) {
      timedOut.push(job);
    }
  }
  return timedOut;
}
```

#### peek(): UploadJob | undefined
- 다음 실행 예정 작업 조회 (제거 없음)

```typescript
/**
 * 우선순위 1위 작업을 반환한다 (제거 없음)
 * @returns 1위 작업, 또는 빈 큐면 undefined
 */
peek(): UploadJob | undefined {
  return this.items.length > 0 ? this.items[0] : undefined;
}
```

#### size(): number
- 현재 큐 내 작업 수

#### isEmpty(): boolean
- 큐 비여 있는지 확인

#### isFull(): boolean
- 큐 가득 차 있는지 확인

### 2.5 내부 헬퍼 메서드

#### bubbleUp(index: number): void
삽입 직후 heap 성질 복구 (올라가면서 비교)

```typescript
/**
 * 주어진 인덱스부터 루트로 향해 올라가며 heap 성질을 복구한다
 * @param index bubble-up 시작 위치
 */
private bubbleUp(index: number): void {
  while (index > 0) {
    const parentIndex = Math.floor((index - 1) / 2);
    if (this.compare(this.items[parentIndex], this.items[index]) > 0) {
      // parent가 child보다 높은 우선순위면 => 교환 필요
      [this.items[parentIndex], this.items[index]] = [this.items[index], this.items[parentIndex]];
      index = parentIndex;
    } else {
      break;
    }
  }
}
```

#### bubbleDown(index: number): void
삭제 직후 heap 성질 복구 (내려가면서 비교)

```typescript
/**
 * 주어진 인덱스부터 리프로 향해 내려가며 heap 성질을 복구한다
 * @param index bubble-down 시작 위치
 */
private bubbleDown(index: number): void {
  const size = this.items.length;
  while (true) {
    let smallest = index;
    const leftChild = 2 * index + 1;
    const rightChild = 2 * index + 2;

    if (leftChild < size && this.compare(this.items[leftChild], this.items[smallest]) < 0) {
      smallest = leftChild;
    }
    if (rightChild < size && this.compare(this.items[rightChild], this.items[smallest]) < 0) {
      smallest = rightChild;
    }

    if (smallest !== index) {
      [this.items[smallest], this.items[index]] = [this.items[index], this.items[smallest]];
      index = smallest;
    } else {
      break;
    }
  }
}
```

---

## 3. UploadScheduler 설계

### 3.1 용도
- 전역 1개 인스턴스 (Singleton)
- import한 실행 중인 작업 가용 대역폭 할당
- 큐 대기 + 상태 전이 관리
- Timeout 모니터링

### 3.2 클래스 구조

```typescript
/**
 * 업로드 스케줄러 Singleton
 * 
 * 책임:
 * 1. 작업 큐 관리 (PriorityQueue 보유)
 * 2. 활성 작업 관리 (jobsRunning Map)
 * 3. 상태 전이 (enqueue → running → completed/timed_out)
 * 4. Timeout 모니터링 + 상태 업데이트
 */
export class UploadScheduler {
  private static instance: UploadScheduler | null = null;
  private queue: PriorityQueue;
  private jobsRunning: Map<string, UploadJob> = new Map();
  private config: SchedulerConfig;
  private scorePolicy: ScorePolicy;
  private timeoutLoopHandle: NodeJS.Timeout | null = null;

  private constructor(
    config: SchedulerConfig,
    scorePolicy: ScorePolicy,
  );

  static getInstance(): UploadScheduler;
  static initialize(config: SchedulerConfig, scorePolicy: ScorePolicy): void;

  enqueue(uploadId: string, fileSize: number): void;
  waitForRunSlot(uploadId: string): Promise<void>;
  markRunning(uploadId: string): boolean;
  markCompleted(uploadId: string): void;
  getJobState(uploadId: string): JobState;
  startTimeoutMonitoring(): void;
  stopTimeoutMonitoring(): void;
}
```

### 3.3 Singleton 패턴

```typescript
/**
 * UploadScheduler의 유일한 인스턴스를 반환한다
 * 초기화 이전 호출 시: 에러 발생
 * 초기화 이후 호출 시: 동일한 인스턴스 반환
 * @returns UploadScheduler 싱글톤 인스턴스
 */
static getInstance(): UploadScheduler {
  if (!UploadScheduler.instance) {
    throw new Error("UploadScheduler이 초기화되지 않았습니다. initialize()를 먼저 호출하세요.");
  }
  return UploadScheduler.instance;
}

/**
 * UploadScheduler를 초기화한다
 * 앱 시작 시 1회만 호출되어야 함
 * @param config 스케줄러 설정
 * @param scorePolicy 우선순위 정책
 * @throws Error 이미 초기화된 경우 발생
 */
static initialize(config: SchedulerConfig, scorePolicy: ScorePolicy): void {
  if (UploadScheduler.instance) {
    throw new Error("UploadScheduler는 이미 초기화되었습니다.");
  }
  UploadScheduler.instance = new UploadScheduler(config, scorePolicy);
}
```

### 3.4 상태 전이 다이어그램

```
┌─────────────────────────────────────────────────────────────┐
│                       Work Flow                              │
└─────────────────────────────────────────────────────────────┘

1. enqueue(uploadId, fileSize)
   ┌──────────────────┐
   │ 상태: initial    │
   │ job 객체 생성    │
   └────────┬─────────┘
            │ (처음 들어옴)
            ▼
   ┌──────────────────────────┐
   │ 상태: queued             │
   │ job.enqueuedAt = now     │
   │ queue.enqueue(job)       │
   │ (큐 크기, 시간 확인)     │
   └────────┬─────────────────┘
            │ (queue에서 대기)
            │ (timeout loop이 주기적으로 스캔)
            │
            ├─ timeout ────→ ┌──────────────────────────┐
            │                 │ 상태: timed_out         │
            │                 │ queue에서 제거          │
            │                 │ 에러 응답 생성          │
            │                 └──────────────────────────┘
            │
            ▼ (waitForRunSlot으로 대기)
   ┌──────────────────────────┐
   │ 상태: running            │
   │ jobsRunning에 추가       │
   │ queue에서 제거           │
   │ (maxRunningJobs 제한)    │
   └────────┬─────────────────┘
            │
            ├─ 업로드 성공 ──→ ┌──────────────────────────┐
            │                  │ 상태: completed         │
            │                  │ jobsRunning에서 제거    │
            │                  └──────────────────────────┘
            │
            └─ 업로드 실패 ──→ ┌──────────────────────────┐
                               │ 상태: failed            │
                               │ jobsRunning에서 제거    │
                               └──────────────────────────┘
```

### 3.5 주요 메서드

#### enqueue(uploadId: string, fileSize: number): void

**목적:** 새 업로드 작업을 큐에 추가

**검증:**
- uploadId 중복 여부 (queued + running 모두 확인)
- fileSize 양수 확인
- maxQueuedJobs + maxRunningJobs 합 초과 여부
- maxQueuedBytes 총합 초과 여부

```typescript
/**
 * 업로드 작업을 큐에 추가한다
 *
 * 프로세스:
 * 1. 중복 uploadId 검사
 * 2. fileSize/uploadId 유효성 검사
 * 3. 큐 크기/총 바이트 제한 검사
 * 4. UploadJob 생성 (state: queued, enqueuedAt: now)
 * 5. queue.enqueue() 호출
 *
 * @param uploadId 고유 업로드 식별자 (중복 금지)
 * @param fileSize 파일 크기 (bytes, 양수)
 * @throws Error 유효성 검사 실패 시 발생
 *   - "uploadId {uploadId}는 이미 대기/실행 중입니다"
 *   - "fileSize는 1 이상이어야 합니다"
 *   - "큐가 가득 찼습니다: {현재}/{최대}"
 *   - "큐 용량 초과: {현재}+{fileSize}>{최대}"
 */
enqueue(uploadId: string, fileSize: number): void {
  // 1. 중복 검사
  if (this.jobsRunning.has(uploadId) || this.findJobInQueue(uploadId)) {
    throw new Error(`uploadId ${uploadId}는 이미 대기/실행 중입니다`);
  }

  // 2. fileSize 검사
  if (!Number.isFinite(fileSize) || fileSize <= 0) {
    throw new Error("fileSize는 1 이상이어야 합니다");
  }

  // 3. 큐 크기 검사
  if (this.queue.size() >= this.config.maxQueuedJobs) {
    throw new Error(`큐가 가득 찼습니다: ${this.queue.size()}/${this.config.maxQueuedJobs}`);
  }

  // 4. 큐 용량 검사 (바이트 합)
  const currentQueueBytes = this.getTotalQueuedBytes();
  if (currentQueueBytes + fileSize > this.config.maxQueuedBytes) {
    throw new Error(`큐 용량 초과: ${currentQueueBytes}+${fileSize}>${this.config.maxQueuedBytes}`);
  }

  // 5. Job 생성 및 enqueue
  const job: UploadJob = {
    uploadId,
    fileSize,
    enqueuedAt: Date.now(),
    state: "queued",
  };

  this.queue.enqueue(job);
}
```

#### waitForRunSlot(uploadId: string): Promise<void>

**목적:** 큐에 있는 작업이 "다음 실행 순서"가 될 때까지 대기

**로직:**
- uploadId의 job이 queue.peek() == job 이 될 때까지 폴링 (100ms 간격 권장)
- timeout 설정 (queueTimeoutMs 기준)

```typescript
/**
 * 업로드 작업이 실행할 "준비"가 될 때까지 대기한다
 *
 * 프로세스:
 * 1. uploadId가 큐에 있는지 확인
 * 2. queue.peek() == 해당 job이 될 때까지 폴링
 * 3. timeout 초과 시: timeout 상태로 전이 후 에러 발생
 * 4. 준비 완료 시: 대기 해제 (markRunning 호출 가능)
 *
 * @param uploadId 업로드 ID
 * @returns Promise (실행 준비 시 resolve, timeout 시 reject)
 * @throws Error timeout 초과 시 발생
 */
async waitForRunSlot(uploadId: string): Promise<void> {
  const startTime = Date.now();
  const timeoutMs = this.config.queueTimeoutMs;

  return new Promise((resolve, reject) => {
    const poll = () => {
      const now = Date.now();

      // 1. Timeout 체크
      if (now - startTime > timeoutMs) {
        this.markTimedOut(uploadId);
        return reject(new Error(`Queue timeout: ${uploadId}`));
      }

      // 2. Peek 체크 (다음 실행 순서인지)
      const nextJob = this.queue.peek();
      if (nextJob && nextJob.uploadId === uploadId) {
        return resolve();
      }

      // 3. 아직 대기 중 → 재폴링 예약
      setTimeout(poll, 100);
    };

    poll();
  });
}
```

#### markRunning(uploadId: string): boolean

**목적:** queued → running 상태 전이

**검증:**
- uploadId의 job이 queue.peek() 맨 앞인지 확인
- maxRunningJobs 초과 여부 확인

```typescript
/**
 * 업로드 작업을 running 상태로 전이한다
 *
 * 프로세스:
 * 1. queue.peek() == uploadId 인지 확인 (준비
 * 2. maxRunningJobs 제한 확인
 * 3. queue.dequeue() 호출
 * 4. jobsRunning에 추가
 * 5. job.state = "running" 변경
 *
 * @param uploadId 업로드 ID
 * @returns 전이 성공 여부
 *   - true: running 상태로 전이됨
 *   - false: 조건 미충족 (다시 시도 또는 대기)
 */
markRunning(uploadId: string): boolean {
  // 1. Peek 확인 (순서 맞는지)
  const nextJob = this.queue.peek();
  if (!nextJob || nextJob.uploadId !== uploadId) {
    return false;
  }

  // 2. maxRunningJobs 확인
  if (this.jobsRunning.size >= this.config.maxRunningJobs) {
    return false;
  }

  // 3. Dequeue
  const job = this.queue.dequeue();
  if (!job) {
    return false;
  }

  // 4. Running 맵에 추가
  job.state = "running";
  this.jobsRunning.set(uploadId, job);

  return true;
}
```

#### markCompleted(uploadId: string): void

**목적:** running → completed 상태 전이

```typescript
/**
 * 업로드 작업을 completed 상태로 전이한다
 *
 * @param uploadId 업로드 ID
 * @throws Error 해당 job이 running이 아니면 발생
 */
markCompleted(uploadId: string): void {
  const job = this.jobsRunning.get(uploadId);
  if (!job) {
    throw new Error(`Job not running: ${uploadId}`);
  }

  job.state = "completed";
  this.jobsRunning.delete(uploadId);
}
```

#### getJobState(uploadId: string): JobState

**목적:** 작업의 현재 상태 조회

```typescript
/**
 * 작업의 현재 상태를 반환한다
 *
 * @param uploadId 업로드 ID
 * @returns JobState (초기/queued/running/completed/timed_out/failed)
 * @returns "unknown" job이 없으면 반환
 */
getJobState(uploadId: string): JobState {
  const runningJob = this.jobsRunning.get(uploadId);
  if (runningJob) {
    return runningJob.state;
  }

  const queuedJob = this.findJobInQueue(uploadId);
  if (queuedJob) {
    return queuedJob.state;
  }

  return "unknown";
}
```

### 3.6 Timeout 모니터링

#### startTimeoutMonitoring(): void

**목적:** 백그라운드에서 주기적으로 타임아웃 작업 스캔

**로직:**
- 매 reallocationIntervalMs마다 실행
- findTimedOutJobs() 호출
- 각 타임아웃 작업에 대해 markTimedOut() 수행

```typescript
/**
 * 백그라운드 타임아웃 모니터링을 시작한다
 *
 * 주기: reallocationIntervalMs (기본 200ms)
 * 작업: O(n) 선형 스캔 → 타임아웃 작업 감시 → 상태 전이
 *
 * 주의: initialize() 직후 호출되어야 함
 */
startTimeoutMonitoring(): void {
  if (this.timeoutLoopHandle !== null) {
    return; // 이미 실행 중
  }

  const scan = () => {
    const now = Date.now();
    const timedOut = this.queue.findTimedOutJobs(now, this.config.queueTimeoutMs);

    for (const job of timedOut) {
      this.markTimedOut(job.uploadId);
    }

    // 다음 스캔 예약
    this.timeoutLoopHandle = setTimeout(scan, this.config.reallocationIntervalMs);
  };

  scan();
}
```

#### stopTimeoutMonitoring(): void

**목적:** 백그라운드 모니터링 중단 (앱 종료 시)

```typescript
/**
 * 백그라운드 타임아웃 모니터링을 중단한다
 * 앱 종료 시 호출되어야 함
 */
stopTimeoutMonitoring(): void {
  if (this.timeoutLoopHandle !== null) {
    clearTimeout(this.timeoutLoopHandle);
    this.timeoutLoopHandle = null;
  }
}
```

#### markTimedOut(uploadId: string): void (Private)

```typescript
/**
 * 작업을 timed_out 상태로 전이한다
 * queue 또는 jobsRunning에서 모두 가능
 * @param uploadId 업로드 ID (private 헬퍼)
 */
private markTimedOut(uploadId: string): void {
  // 1. Running에서 찾기
  const runningJob = this.jobsRunning.get(uploadId);
  if (runningJob) {
    runningJob.state = "timed_out";
    this.jobsRunning.delete(uploadId);
    return;
  }

  // 2. Queue에서 찾기 및 제거
  const queuedJob = this.findJobInQueue(uploadId);
  if (queuedJob) {
    queuedJob.state = "timed_out";
    // Note: PriorityQueue에 직접 제거 API가 없으므로
    // 별도 구현 필요 (Phase 3에서 보완)
  }
}
```

### 3.7 헬퍼 메서드 (Private)

#### findJobInQueue(uploadId: string): UploadJob | null

```typescript
/**
 * 큐에서 uploadId로 job을 검색한다
 * O(n) 선형 검색
 */
private findJobInQueue(uploadId: string): UploadJob | null {
  // 주의: PriorityQueue의 items가 public이어야 함
  // 또는 PriorityQueue에 검색 메서드 추가
}
```

#### getTotalQueuedBytes(): number

```typescript
/**
 * 큐에 있는 모든 작업의 fileSize 합계를 반환한다
 */
private getTotalQueuedBytes(): number {
  // PriorityQueue의 모든 작업 순회
}
```

---

## 4. PriorityQueue 추가 API (필요 시)

현재 필요한 메서드:

- `enqueue(job)` ✓
- `dequeue()` ✓
- `peek()` ✓
- `findTimedOutJobs(now, timeoutMs)` ✓
- `size()` ✓
- `isEmpty()` ✓
- `isFull()` ✓

추후 필요 가능:

- `remove(uploadId)` - timed_out 작업 제거 (Phase 3)
- `getAllJobs()` - 메트릭/로깅 (Phase 6)

---

## 5. 설계 고려사항

### 5.1 동시성
- Node.js는 단일 스레드이므로 race condition 위험이 낮음
- 그러나 비동기 작업(waitForRunSlot) 간 상태 변경 주의 필요

### 5.2 Timeout 구현
- 현재: 주기적 O(n) 스캔 수용
- 최대 500~1000 작업에서 허용 가능
- 향후: time wheel 또는 min-heap(별도) 도입 고려

### 5.3 에러 처리
- 중복 uploadId: 에러 발생 (클라이언트 재전송 또는 고유ID 생성 필수)
- Queue full: HTTP 429 (Too Many Requests) 응답
- Timeout: HTTP 504 (Gateway Timeout) 응답

---

## 6. 구현 체크리스트

### PriorityQueue.ts
- [ ] class 및 생성자
- [ ] enqueue() + bubbleUp()
- [ ] dequeue() + bubbleDown()
- [ ] peek()
- [ ] size(), isEmpty(), isFull()
- [ ] findTimedOutJobs()
- [ ] 비교 함수 (comparator)
- [ ] JSDoc 주석 (모든 메서드)

### UploadScheduler.ts
- [ ] class 및 Singleton 패턴 (getInstance, initialize)
- [ ] enqueue()
- [ ] waitForRunSlot()
- [ ] markRunning()
- [ ] markCompleted()
- [ ] getJobState()
- [ ] startTimeoutMonitoring()
- [ ] stopTimeoutMonitoring()
- [ ] 헬퍼 메서드 (markTimedOut, findJobInQueue, getTotalQueuedBytes)
- [ ] JSDoc 주석 (모든 메서드)

### Unit Tests
- [ ] PriorityQueue 정렬 테스트
- [ ] UploadScheduler 상태 전이 테스트
- [ ] Timeout 스캔 테스트

---

## 7. Phase 3 이후 예정

- **Phase 3**: RateAllocator (실행 중 작업에게 대역폭 동적 할당)
- **Phase 4**: RateControlledTransform (token bucket + stream backpressure)
- **Phase 5**: Route 통합 (upload route에 scheduler 적용)
- **Phase 6**: Metrics & Logging (모니터링)


---
# 요구사항

>> 주석 관련 요구사항
주석 너무 구체적으로 적지마. 핵심만 작성해줘. 주석에는 예시, 사례는 담지마.
의도 이런것들을 코드에 주석으로 달지 말고, 설계 문서에 담아. 

>> 구현  참고
ScorePolicy.ts 에서 PriorityScoreInQueue에서 PriorityScore로 네이밍 변경했어. 앞으로 calculate를 사용할때에는 해당 타입으로 사용해.

## 필수 - 의문사항

Priority Queue 부분까지는 잘 설계했어. 하지만, UploadScheduler 부분은 재설계가 필요하다고 봐.

현재 waitForRunSlot 시에, enqueue 등록 후에 upload id를 waitForRunSlot로 실행시켜서, 등록된 모든 upload id에 대해서 polling을 하고 있는 방식이라고 봤어. 이게 너가 의도한게 맞는지 확인해.
그리고 맞다면, 해당 방식은 너무 비효율적이라고 생각해. 우선순위 큐를 만든 이유가 없는 방식이야. 
차라리 우선순위 큐에서 가장 우선순위가 높은 작업으르 주기적으로 polling을 해서 작업에 넣어. 그러면 1개만 확인하면 되는데, 너가 제안한 waitForRunSlot 방식은 모든 작업을 다 확인해야하는거잖아. 
이 부분을 다시 설계가 필요할 것 같아. 너가 의도한 방향이랑 내가 생각한 방향이랑 전혀 달라.

너가 의도한 방향을 나에게 설명해. 그리고 나의 방향과 비교해봐.