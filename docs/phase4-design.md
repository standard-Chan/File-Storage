# Phase 4: RateControlledTransform - 동적 Rate 제한 적용

## 목차
1. [개요](#개요)
2. [설계 개념](#설계-개념)
3. [아키텍처](#아키텍처)
4. [핵심 컴포넌트](#핵심-컴포넌트)
5. [구현 예제](#구현-예제)
6. [에러 처리](#에러-처리)
7. [통합 흐름](#통합-흐름)

---

## 개요

### 목적
Phase 3에서 계산한 **동적 Rate 할당값**을 실제 네트워크에 적용하여 **실시간 rate limiting**을 수행

### 핵심 요소
- **Token Bucket**: 시간 기반 rate limiting
- **Transform Stream**: Node.js stream 파이프라인 통합
- **Dynamic Rate Update**: 매 250ms 할당 변경 시 동적 반영
- **Backpressure Handling**: Stream의 `pause()/resume()` 연동

### Phase 3과의 연결
```
Phase 3 (RateAllocator)
  ↓
  allocatedRateBps update (매 250ms)
  ↓
Phase 4 (RateControlledTransform)
  ↓
  실제 전송 rate 제어
  ↓
  Network I/O
```

---

## 설계 개념

### 1. Token Bucket 알고리즘

#### 원리
```
매 시간 T마다:
  tokens = min(capacity, tokens + rate * (T / 1000ms))
  
chunk 전송 시:
  if tokens >= chunk.size:
    tokens -= chunk.size
    write(chunk)
  else:
    wait until tokens available
```

#### 예제
```
rate = 1MB/s (1,000,000 bps)
capacity = 1MB (1,000,000 bytes)
interval = 100ms

Tick 0:
  tokens = 1MB
  
chunk 512KB 도착:
  tokens = 1MB
  tokens >= 512KB → 전송
  tokens = 512KB
  
Tick 1 (100ms 후):
  tokens += 1MB/s × 100ms = 100KB
  tokens = 612KB
  
chunk 1MB 도착:
  tokens = 612KB < 1MB → 대기
  Tick 2까지 대기하여 tokens = 712KB < 1MB
  Tick 3에서 tokens = 812KB < 1MB
  Tick 4에서 tokens = 912KB < 1MB
  Tick 5에서 tokens = 1,012KB >= 1MB → 전송
```



### 2. Dynamic Rate 적용 전략

#### 방식 1: Refill Rate 즉시 업데이트
```
매 250ms (reallocationTick):
  newRate = scheduler.getCurrentAllocatedRateBps(jobId)
  tokenBucket.setRefillRate(newRate)
```

**장점:**
- 구현 간단
- 새로운 rate 즉시 반영

**단점:**
- Rate 급격한 변화 시 "부스트" 효과 발생 가능
- 예: 100MB/s → 200MB/s로 변경 시 갑자기 2배 속도로 전송

#### 방식 2: Token Capacity 기반 smooth transition
```
이전 rate: 100MB/s
새 rate: 200MB/s

capacity = max(rate × refillInterval, minCapacity)
    = max(200MB/s × 250ms, 512KB)
    = 50MB

→ 50MB 토큰이 쌓이면서 자연스럽게 가속
```

**장점:**
- 부드러운 rate 전환
- 네트워크 jitter 흡수

**단점:**
- 메모리 사용량 증가



### 3. Stream Backpressure 연동

#### 문제
```
Transform stream write가 느린데 readable 스트림이 빠르게 push
→ 메모리 누적 (highWaterMark 초과)
```

#### 해결책
```typescript
// Transform._transform
if (!tokenBucket.canConsume(chunk.length)) {
  // pause upstream
  this.pause();
  
  // 나중에 resume
  tokenBucket.onTokensAvailable(() => {
    this.resume();
  });
}
```


---

## 아키텍처

### 컴포넌트 다이어그램

```
┌─────────────────────────────────────────────────┐
│  UploadScheduler                                │
│  ├─ allocatedRateBps: Map<jobId, rate>         │
│  └─ getCurrentAllocatedRateBps(jobId): number  │
└────────────┬────────────────────────────────────┘
             │ query rate (매 chunk 처리)
             ↓
┌─────────────────────────────────────────────────┐
│  RateControlledTransform extends Transform     │
│  ├─ tokenBucket: TokenBucket                  │
│  ├─ config: RateControlConfig                 │
│  └─ _transform(chunk, encoding, callback)     │
└────────────┬────────────────────────────────────┘
             │ rate limiting 적용
             ↓
┌─────────────────────────────────────────────────┐
│  NodeJS Duplex/Writable Stream                 │
│  (S3 업로드 또는 파일 저장)                    │
└─────────────────────────────────────────────────┘
```

### 상태 머신

```
Transform 초기화
  ↓
─────────────────────────────────────
[RATE_LIMITING] ←─────────────┐
  │                           │
  ├─ chunk 도착              │
  │  ├─ rate lookup          │
  │  │  ├─ can consume tokens │
  │  │  │  ├─ YES → write    │
  │  │  │  └─ NO → pause     │
  │  │  └─ rate 변경 감지 → 처리
  │  └─ callback()           │
  │                           │
  └─ [CLEANUP]               │
     ├─ timers 정리      │
     ├─ listeners 제거   │
     └─ resource cleanup ─┘
```

---

## 핵심 컴포넌트

### 1. TokenBucket 클래스

#### 인터페이스
```typescript
export interface TokenBucketConfig {
  capacityBytes: number;        // 최대 토큰 용량
  refillRateBps: number;        // 초당 refill rate (bps → bytes/s)
  minRefillIntervalMs: number;  // 최소 refill 간격
  strictMode?: boolean;         // true: capacity 초과 불가, false: 초과 허용
}

export interface TokenBucketSnapshot {
  tokensAvailable: number;
  refillRateBps: number;
  nextRefillAt: number;
}

export class TokenBucket {
  private tokensAvailable: number;
  private refillRateBps: number;
  private lastRefillAt: number;
  private readonly config: TokenBucketConfig;
  private pendingRequests: Array<() => void>;

  constructor(config: TokenBucketConfig);
  
  // 토큰 사용 가능 여부 확인
  canConsume(bytes: number): boolean;
  
  // 토큰 소비 (반드시 canConsume 확인 후 호출)
  consume(bytes: number): void;
  
  // 토큰 충전 (시간 경과)
  refill(): void;
  
  // Rate 동적 업데이트
  updateRefillRate(newRateBps: number): void;
  
  // 토큰 대기 (callback)
  waitForTokens(bytes: number, callback: () => void): void;
  
  // 상태 조회
  getSnapshot(): TokenBucketSnapshot;
}
```

#### 구현 개요
```typescript
export class TokenBucket {
  private tokensAvailable: number;
  private refillRateBps: number;
  private lastRefillAt: number;
  private readonly config: TokenBucketConfig;
  private pendingRequests: Array<() => void> = [];

  constructor(config: TokenBucketConfig) {
    this.config = config;
    this.refillRateBps = config.refillRateBps;
    this.tokensAvailable = config.capacityBytes;
    this.lastRefillAt = Date.now();
  }

  canConsume(bytes: number): boolean {
    this.refill();
    return this.tokensAvailable >= bytes;
  }

  consume(bytes: number): void {
    if (!this.canConsume(bytes)) {
      throw new Error(`토큰 부족: 필요 ${bytes}, 보유 ${this.tokensAvailable}`);
    }
    this.tokensAvailable -= bytes;
  }

  private refill(): void {
    const now = Date.now();
    const elapsedMs = Math.max(
      this.config.minRefillIntervalMs,
      now - this.lastRefillAt
    );
    const refillBsPerMs = this.refillRateBps / 1000;
    const tokensToAdd = elapsedMs * refillBsPerMs;
    
    this.tokensAvailable = Math.min(
      this.config.capacityBytes,
      this.tokensAvailable + tokensToAdd
    );
    this.lastRefillAt = now;
  }

  updateRefillRate(newRateBps: number): void {
    this.refill(); // 변경 전 기존 rate로 토큰 충전
    this.refillRateBps = Math.max(1, newRateBps); // 최소 1bps
  }

  waitForTokens(bytes: number, callback: () => void): void {
    this.pendingRequests.push(callback);
    this.checkPendingRequests();
  }

  private checkPendingRequests(): void {
    while (this.pendingRequests.length > 0) {
      if (this.canConsume(this.pendingRequests[0] as any)) {
        break;
      }
      const cb = this.pendingRequests.shift();
      cb?.();
    }
  }

  getSnapshot(): TokenBucketSnapshot {
    this.refill();
    return {
      tokensAvailable: this.tokensAvailable,
      refillRateBps: this.refillRateBps,
      nextRefillAt: this.lastRefillAt + 1000 / (this.refillRateBps / 1000),
    };
  }
}
```

### 2. RateControlledTransform 클래스

#### 인터페이스
```typescript
export interface RateControlConfig {
  jobId: string;
  scheduler: UploadScheduler;
  tokenBucketCapacityBytes: number;
  minRefillIntervalMs: number;
  highWaterMarkBytes: number;
  lowWaterMarkBytes: number;
  statsCollectionEnabled?: boolean;
}

export interface RateTransformStats {
  bytesProcessed: number;
  bytesThrottled: number;
  pauseCount: number;
  resumeCount: number;
  totalPauseTimeMs: number;
  averageRateBps: number;
}

export class RateControlledTransform extends Transform {
  private readonly jobId: string;
  private readonly scheduler: UploadScheduler;
  private readonly tokenBucket: TokenBucket;
  private readonly config: RateControlConfig;
  
  private isPaused = false;
  private pausedAt = 0;
  private stats: RateTransformStats;
  private rateLookupTimer: NodeJS.Timeout | null = null;

  constructor(config: RateControlConfig);
  
  // Transform._transform override
  _transform(
    chunk: Buffer,
    encoding: string,
    callback: (error?: Error) => void
  ): void;

  // Transform._flush override
  _flush(callback: (error?: Error) => void): void;

  // 동적 rate 업데이트 감시
  private startRateLookupLoop(): void;
  private stopRateLookupLoop(): void;

  // Backpressure 처리
  private onTokensAvailable(): void;

  getStats(): RateTransformStats;
}
```

#### 구현 개요
```typescript
export class RateControlledTransform extends Transform {
  private readonly jobId: string;
  private readonly scheduler: UploadScheduler;
  private readonly tokenBucket: TokenBucket;
  private readonly config: RateControlConfig;
  
  private isPaused = false;
  private pausedAt = 0;
  private stats: RateTransformStats = {
    bytesProcessed: 0,
    bytesThrottled: 0,
    pauseCount: 0,
    resumeCount: 0,
    totalPauseTimeMs: 0,
    averageRateBps: 0,
  };
  private rateLookupTimer: NodeJS.Timeout | null = null;

  constructor(config: RateControlConfig) {
    super({
      highWaterMark: config.highWaterMarkBytes,
    });
    this.jobId = config.jobId;
    this.scheduler = config.scheduler;
    this.config = config;
    this.tokenBucket = new TokenBucket({
      capacityBytes: config.tokenBucketCapacityBytes,
      refillRateBps: scheduler.getCurrentAllocatedRateBps(jobId),
      minRefillIntervalMs: config.minRefillIntervalMs,
    });
    this.startRateLookupLoop();
  }

  _transform(
    chunk: Buffer,
    encoding: string,
    callback: (error?: Error) => void
  ): void {
    const chunkSize = chunk.length;

    // 토큰 확인
    if (this.tokenBucket.canConsume(chunkSize)) {
      this.tokenBucket.consume(chunkSize);
      this.stats.bytesProcessed += chunkSize;
      
      // backpressure 처리
      const canContinue = this.push(chunk);
      
      if (!canContinue && !this.isPaused) {
        this.isPaused = true;
        this.pausedAt = Date.now();
        this.stats.pauseCount++;
        this.pause();
      }

      callback();
    } else {
      // 토큰 부족 → 대기
      this.stats.bytesThrottled += chunkSize;
      
      if (!this.isPaused) {
        this.isPaused = true;
        this.pausedAt = Date.now();
        this.stats.pauseCount++;
        this.pause();
      }

      // 토큰 충전 대기
      this.tokenBucket.waitForTokens(chunkSize, () => {
        callback();
        this.onTokensAvailable();
      });
    }
  }

  _flush(callback: (error?: Error) => void): void {
    this.stopRateLookupLoop();
    
    // pause 해제 및 실행 재개
    if (this.isPaused) {
      this.resume();
    }

    callback();
  }

  private startRateLookupLoop(): void {
    // 50ms 간격으로 rate 업데이트 확인 (reallocationInterval 보다 자주)
    this.rateLookupTimer = setInterval(() => {
      const newRateBps = this.scheduler.getCurrentAllocatedRateBps(this.jobId);
      this.tokenBucket.updateRefillRate(newRateBps);
    }, 50); // configurable
  }

  private stopRateLookupLoop(): void {
    if (this.rateLookupTimer) {
      clearInterval(this.rateLookupTimer);
      this.rateLookupTimer = null;
    }
  }

  private onTokensAvailable(): void {
    if (this.isPaused) {
      this.isPaused = false;
      this.stats.resumeCount++;
      this.stats.totalPauseTimeMs += Date.now() - this.pausedAt;
      this.resume();
    }
  }

  getStats(): RateTransformStats {
    const elapsedMs = Date.now() - this.createdAt; // ← 생성 시점 기록 필요
    this.stats.averageRateBps = (this.stats.bytesProcessed * 8) / (elapsedMs / 1000);
    return this.stats;
  }
}
```

---

## 구현 예제

### 예제 1: 기본 사용법 (PUT 라우트)

```typescript
// routes/objects.ts
import { RateControlledTransform } from "../scheduler/RateControlledTransform";

app.put('/objects/:bucket/:objectKey', async (req, reply) => {
  const { bucket, objectKey } = req.params;
  const contentLength = parseInt(req.headers['content-length'] || '0', 10);

  // 1. Scheduler에 job enqueue
  const jobId = `${bucket}/${objectKey}/${Date.now()}`;
  const grant = await scheduler.enqueue({
    jobId,
    bucket,
    objectKey,
    fileSize: contentLength,
    clientId: req.id,
  });

  // 2. RateControlledTransform 생성
  const rateControl = new RateControlledTransform({
    jobId,
    scheduler,
    tokenBucketCapacityBytes: config.tokenBucketCapacityBytes,
    minRefillIntervalMs: 10, // 10ms
    highWaterMarkBytes: 64 * 1024, // 64KB
    lowWaterMarkBytes: 16 * 1024,  // 16KB
  });

  // 3. 파이프라인 연결
  const uploadPromise = new Promise((resolve, reject) => {
    req
      .pipe(rateControl)
      .pipe(fs.createWriteStream(`/data/${bucket}/${objectKey}`))
      .on('finish', () => {
        scheduler.jobCompleted(jobId);
        resolve({
          bucket,
          objectKey,
          size: contentLength,
          stats: rateControl.getStats(),
        });
      })
      .on('error', (err) => {
        scheduler.jobFailed(jobId, err.message);
        reject(err);
      });
  });

  reply.send(await uploadPromise);
});
```

### 예제 2: 동적 rate 변경 시나리오

```
초기 상태:
  Job A: allocated = 10MB/s
  Job B: allocated = 10MB/s
  Total = 20MB/s

Tick 1 (250ms 후):
  Job A 계산: score up → allocated = 15MB/s
  Job B 계산: score down → allocated = 5MB/s
  
  RateControlledTransform A:
    tokenBucket.updateRefillRate(15MB/s) ✓ 즉시 반영
  
  RateControlledTransform B:
    tokenBucket.updateRefillRate(5MB/s) ✓ 즉시 반영
    
  → 동시에 두 upload의 rate가 조정됨
```

### 예제 3: Backpressure 처리

```
Case 1: Rate 제한으로 pause
────────────────────────────
Readable (빠름: chunk/1ms)
  → RateControl (느림: 10MB/s 제한)
    → Writable (느림: 8MB/s)

1. chunk 도착, rate 제한
   → pause() 호출
   → 나머지 chunk 버퍼됨 (highWaterMark까지)

2. 토큰 충전되어 resume()
   → buffered chunks 처리

Case 2: Downstream backpressure
────────────────────────────
Readable (중간)
  → RateControl (빠름: 100MB/s)
    → Writable (느림: disk I/O)

1. downstream write() 반환 false
   → pause() 호출
   
2. downstream drain 이벤트
   → resume() 호출
```

---

## 에러 처리

### 1. Token 부족 시

```typescript
if (!this.tokenBucket.canConsume(chunkSize)) {
  // 토큰 충전 대기
  this.tokenBucket.waitForTokens(chunkSize, callback);
}
```

**에러 시나리오:**
- `waitForTokens()` timeout → 설정 가능한 타임아웃 필요
- Rate가 0으로 설정되면? → minRate 강제 적용

### 2. Scheduler 조회 실패

```typescript
private startRateLookupLoop(): void {
  this.rateLookupTimer = setInterval(() => {
    try {
      const newRateBps = this.scheduler.getCurrentAllocatedRateBps(this.jobId);
      this.tokenBucket.updateRefillRate(newRateBps);
    } catch (err) {
      // Scheduler 에러 → 이전 rate 유지
      console.warn(`Rate lookup 실패 (jobId=${this.jobId}):`, err.message);
    }
  }, 50);
}
```

### 3. Backpressure Timeout

```typescript
private readonly backpressureTimeoutMs = 30000; // 30초

_transform(chunk, encoding, callback) {
  if (tokenBucket.canConsume(chunk.length)) {
    // ... process
  } else {
    const timeout = setTimeout(() => {
      callback(new Error('Backpressure timeout'));
    }, this.backpressureTimeoutMs);
    
    this.tokenBucket.waitForTokens(chunk.length, () => {
      clearTimeout(timeout);
      callback();
    });
  }
}
```

---

## 통합 흐름

### 전체 Flow Chart

```
[Upload 시작]
    ↓
[UploadScheduler.enqueue()]
    ├─ Job을 queued로 추가
    ├─ waiting ticket 생성
    └─ dispatch 스케줄
    ↓
[dispatcher thread]
    ├─ queued job 확인
    ├─ running slots 확인
    └─ dispatchJob() → state: running으로 전환
    ↓
[HTTP handler]
    ├─ RateControlledTransform 생성
    │   └─ tokenBucket 초기화 (현재 rate 기반)
    │   └─ rateLookupLoop 시작
    │
    ├─ req → RateControl → writeStream → disk
    │
    └─ 매 chunk에서:
        ├─ tokenBucket.canConsume()?
        ├─ YES → write, consume tokens
        ├─ NO → pause, wait tokens
        └─ 동시에 rate lookup (50ms interval)
              scheduler.getCurrentAllocatedRateBps() 조회
    ↓
[Reallocation Tick (250ms)]
    ├─ runningJobs score 재계산
    ├─ allocator.allocate()
    ├─ job.allocatedRateBps 업데이트
    │
    └─ RateControl 자동 감지 (rateLookupLoop)
           tokenBucket.updateRefillRate()
    ↓
[Upload 완료]
    ├─ Transform._flush() 호출
    ├─ scheduler.jobCompleted()
    ├─ running slots 해제
    └─ 대기 중인 queued job dispatch
```

### 시간축 데이터 흐름

```
T=0ms: HTTP request 도착
  ├─ enqueue(job)
  ├─ RateControl 생성 (rate=10MB/s)
  └─ chunk 1 도착

T=10ms: chunk 2, 3 도착
  ├─ tokenBucket.canConsume() → YES
  └─ write

T=50ms: rateLookupLoop tick
  ├─ query rate = 10MB/s (확인)
  └─ tokenBucket.updateRefillRate(10MB/s)

T=100ms: chunk 파이프라인 처리 중
  ├─ bytesProcessed = 512KB
  └─ highWaterMark 체크

T=250ms: reallocationTick
  ├─ Job A score = 55 (wait bonus +5)
  ├─ Job B score = 50
  ├─ allocator.allocate() → Job A: 12MB/s, Job B: 8MB/s
  └─ job.allocatedRateBps = 12MB/s

T=260ms: rateLookupLoop tick
  ├─ query rate = 12MB/s (변경 감지)
  ├─ tokenBucket.updateRefillRate(12MB/s)
  └─ 남은 토큰: 2.5MB → 빠르게 소비 시작

T=900ms: chunk 처리 완료
  ├─ _flush() 호출
  └─ scheduler.jobCompleted(jobId)

T=950ms: 다음 queued job dispatch
  └─ repeat...
```

---

## Phase 4 구현 체크리스트

### TokenBucket 구현
- [ ] TokenBucket 클래스 생성
- [ ] canConsume(), consume() 구현
- [ ] refill() 로직 (시간 기반 토큰 생성)
- [ ] updateRefillRate() 동적 업데이트
- [ ] waitForTokens() 대기 메커니즘
- [ ] 테스트 (unit: 토큰 생성, 소비, 기다림)

### RateControlledTransform 구현
- [ ] Transform 클래스 상속
- [ ] _transform() 구현 (rate limiting 로직)
- [ ] _flush() 구현 (리소스 정리)
- [ ] rateLookupLoop 구현 (50ms interval)
- [ ] Backpressure 처리 (pause/resume)
- [ ] Stats 수집

### 통합 테스트
- [ ] PUT 라우트 연결
- [ ] UploadScheduler와 함께 동작
- [ ] Dynamic rate 변경 감시
- [ ] 동시 다중 upload
- [ ] Backpressure 벤치마크

### 설정 추가 (config.ts)
- [ ] tokenBucketCapacityBytes
- [ ] rateLookupIntervalMs (default: 50ms)
- [ ] highWaterMarkBytes
- [ ] lowWaterMarkBytes
- [ ] 관련 환경변수 파싱

---

## 다음 단계

### Phase 5: 라우트 통합
- PUT /objects/:bucket/:objectKey 에 RateControlledTransform 적용
- multipart upload와의 연동
- 기존 objectService 수정

### Phase 6: 모니터링 & 로깅
- Scheduler metrics (running jobs, allocated rate, scores)
- Transform stats (bytesProcessed, throttleTime, pause/resume count)
- Rate allocation 히스토리 로깅
- Prometheus 메트릭 노출


---

## 요구사항
>> 의문사항 및 token bucket의 구현 방향성
이전에 token bucket 알고리즘으로 구현하기로 했는데, 너가 제안한 방향과 내가 의도한 처리 방식이 다른 것 같아. 
내가 의도한 방향은 token = 0 이 될때까지 다 쓰고, 다시 채워지면, 다시 0이 될때까지 쓰는 구조야. 즉, token이 충분하지 않더라도 부분적으로 전송하여 streaming 하는 방식이지.
하지만 너는 업로드하는 용량까지 토큰이 모두 채워지면 비로소 전송하는 방식으로 진행하는 것 같아. 내가 의도한 방향대로 진행해줘.


>> 제안 - refill rate 즉시 업데이트
방식 1번.
어차피 TCP 혼잡제어/흐름제어 때문에 자연스럽게 가속될거야. 그러니 메모리 사용량이 적은 방향으로 진행시켜