# Phase 4 Design Ver2

## 1) 요구사항 반영 결론

이번 Ver2는 아래 2가지를 고정 결정으로 반영한다.

1. Token 부족 시 chunk 전체를 기다리지 않는다.
- token이 0이 될 때까지 가능한 바이트를 먼저 전송한다.
- 남은 바이트는 내부 pending 버퍼에 보관하고, token이 refill 되면 이어서 전송한다.

2. Refill rate 업데이트는 즉시 반영한다.
- Scheduler의 allocatedRateBps 변경값을 주기적으로 조회해 곧바로 token bucket refill rate에 적용한다.
- capacity를 크게 키우지 않고, 고정된 소용량 capacity로 메모리 사용량을 낮춘다.

요약: "부분 전송 스트리밍 + 즉시 rate 반영 + 저메모리"

---

## 2) Ver1 대비 핵심 변경점

### 기존 제안의 문제
- token이 chunk 크기보다 작으면 전송을 보류하는 구조는 실제 스트리밍 특성과 맞지 않는다.
- 큰 chunk가 들어오면 head-of-line blocking이 길어질 수 있다.

### Ver2 개선
- chunk를 조각으로 나누어 전송한다.
- 매 flush 시점마다 "보낼 수 있는 만큼만" 보낸다.
- pending queue는 유지하되, queue head를 점진적으로 소진한다.

---

## 3) 목표 동작 모델

## 용어
- token: 현재 즉시 전송 가능한 바이트 예산
- refillRateBps: 초당 보충 바이트
- capacityBytes: token 최대치
- pending queue: 아직 다 보내지 못한 chunk의 남은 구간 목록

## 불변 조건
1. token은 0 미만이 되지 않는다.
2. token은 capacityBytes를 초과하지 않는다.
3. 입력 순서를 보장한다. (FIFO)
4. 각 chunk callback은 해당 chunk가 모두 전송된 뒤 1회 호출된다.

---

## 4) 자료구조 제안

```ts
interface PendingChunk {
  buffer: Buffer;
  offset: number; // 이미 전송한 바이트 수
  done: (err?: Error) => void;
}

interface TokenBucketState {
  tokensBytes: number;
  refillRateBps: number;
  lastRefillAtMs: number;
}

interface RateControlStats {
  bytesIn: number;
  bytesOut: number;
  partialWriteCount: number;
  throttlePauseCount: number;
  totalThrottledMs: number;
}
```

---

## 5) TokenBucket Pseudocode (부분 전송용)

```ts
/** 토큰을 관리하는 용도의 class */
class TokenBucket {
  tokensBytes: number  // 현재 사용 가능한 토큰
  refillRateBps: number
  capacityBytes: number
  lastRefillAtMs: number

  constructor(capacityBytes, initialRateBps) {
    this.capacityBytes = capacityBytes
    this.refillRateBps = Math.max(1, initialRateBps)
    this.tokensBytes = capacityBytes // 시작 버스트 허용
    this.lastRefillAtMs = nowMs()
  }

  refill(now = nowMs()) {
    const elapsedMs = Math.max(0, now - this.lastRefillAtMs)
    if (elapsedMs === 0) return

    const add = (this.refillRateBps * elapsedMs) / 1000
    this.tokensBytes = Math.min(this.capacityBytes, this.tokensBytes + add)
    this.lastRefillAtMs = now
  }

  updateRefillRate(newRateBps) {
    // 기존 rate 기준으로 먼저 정산 후 즉시 교체
    this.refill(nowMs())
    this.refillRateBps = Math.max(1, newRateBps)
  }

  spendableBytes() {
    this.refill(nowMs())
    return Math.floor(this.tokensBytes)
  }

  consume(bytes) {
    this.tokensBytes -= bytes
    if (this.tokensBytes < 0) this.tokensBytes = 0
  }
}
```

---

## 6) RateControlledTransform Pseudocode (핵심)

핵심은 "한 chunk를 다 못 보내도 일부를 먼저 push"하는 것이다.

```ts
class RateControlledTransform extends Transform {
  scheduler
  jobId
  bucket

  pendingQueue: PendingChunk[] = []
  flushing = false
  destroyed = false
  createdAtMs = nowMs()
  lastThrottleStartMs: number | null = null

  // low-memory 전략: 고정 소용량 capacity 사용
  // 예) capacityBytes = max(64KB, allocatedRateBps * 0.05)
  constructor(config) {
    super({ highWaterMark: config.highWaterMarkBytes })
    this.jobId = config.jobId
    this.scheduler = config.scheduler

    const initialRate = scheduler.getCurrentAllocatedRateBps(jobId)
    this.bucket = new TokenBucket(config.capacityBytes, initialRate)

    this.startRateLookupLoop(config.rateLookupIntervalMs) // 즉시 업데이트 전략
    this.startRefillPump(config.refillPumpIntervalMs)     // pending flush용
  }

  _transform(chunk, _enc, callback) {
    this.stats.bytesIn += chunk.length
    this.pendingQueue.push({ buffer: chunk, offset: 0, done: callback })
    this.tryFlushPending()
  }

  _read(_size) {
    // downstream이 다시 받을 준비가 되면 호출됨
    this.tryFlushPending()
  }

  tryFlushPending() {
    if (this.flushing || this.destroyed) return
    this.flushing = true

    try {
      while (this.pendingQueue.length > 0) {
        const head = this.pendingQueue[0]

        const remaining = head.buffer.length - head.offset
        if (remaining <= 0) {
          this.pendingQueue.shift()
          head.done()
          continue
        }

        const spendable = this.bucket.spendableBytes()
        if (spendable <= 0) {
          this.markThrottledStartIfNeeded()
          break
        }

        // 부분 전송: 전부 못 보내도 가능한 만큼 전송
        const writeBytes = Math.min(remaining, spendable)
        const piece = head.buffer.subarray(head.offset, head.offset + writeBytes)

        const ok = this.push(piece)
        this.bucket.consume(writeBytes)
        head.offset += writeBytes
        this.stats.bytesOut += writeBytes

        if (writeBytes < remaining) {
          this.stats.partialWriteCount += 1
        }

        if (head.offset >= head.buffer.length) {
          this.pendingQueue.shift()
          head.done()
        }

        if (!ok) {
          // readable buffer가 찼음. _read에서 재진입
          break
        }
      }

      if (this.pendingQueue.length === 0) {
        this.markThrottledEndIfNeeded()
      }
    } catch (e) {
      this.failAllPending(e as Error)
      this.destroy(e as Error)
    } finally {
      this.flushing = false
    }
  }

  startRateLookupLoop(intervalMs) {
    this.rateTimer = setInterval(() => {
      try {
        const newRate = this.scheduler.getCurrentAllocatedRateBps(this.jobId)
        this.bucket.updateRefillRate(newRate) // 방식1: 즉시 반영
      } catch {
        // fail-open: 이전 rate 유지
      }
    }, intervalMs)
  }

  startRefillPump(intervalMs) {
    this.pumpTimer = setInterval(() => {
      if (this.pendingQueue.length === 0) return
      this.tryFlushPending()
    }, intervalMs)
  }

  _flush(done) {
    // 입력 종료 후 pending 완전 배출될 때까지 대기
    const waitDrain = () => {
      this.tryFlushPending()
      if (this.pendingQueue.length === 0) return done()
      setTimeout(waitDrain, 5)
    }
    waitDrain()
  }

  _destroy(err, done) {
    this.destroyed = true
    clearInterval(this.rateTimer)
    clearInterval(this.pumpTimer)
    if (err) this.failAllPending(err)
    done(err)
  }
}
```

---

## 7) 실제 시간 흐름 예시 (확장판)

시나리오
- Job A 단일 업로드 시작
- 초기 allocatedRateBps = 4MB/s
- capacityBytes = 128KB (저메모리 고정)
- refillPumpInterval = 10ms
- rateLookupInterval = 50ms
- 입력 chunk는 256KB 단위로 도착

초기 상태
- t=0ms, tokens=128KB

### t=0ms
- upstream이 chunk#1(256KB) 전달
- spendable=128KB
- 즉시 128KB 부분 전송
- 남은 128KB는 pending 유지
- tokens=0
- callback 미호출 (chunk 완전 전송 전)

### t=10ms (pump)
- refill: 4MB/s 기준 40KB 충전
- pending head 남은 128KB 중 40KB 전송
- 남은 88KB
- tokens=0

### t=20ms
- 40KB 전송
- pending 48KB

### t=30ms
- 40KB 전송
- pending 8KB

### t=40ms
- 8KB 전송으로 chunk#1 완료
- chunk#1 callback 호출
- 남는 token 32KB

### t=45ms
- upstream chunk#2(256KB) 도착
- 즉시 32KB 전송
- pending 224KB
- tokens=0

### t=50ms (rate lookup tick)
- Scheduler 재할당 결과: 6MB/s로 상승
- updateRefillRate(6MB/s) 즉시 반영
- 이후 refill 속도는 10ms당 60KB

### t=60ms
- 60KB 전송
- pending 164KB

### t=70ms
- 60KB 전송
- pending 104KB

### t=80ms
- 60KB 전송
- pending 44KB

### t=90ms
- 44KB 전송으로 chunk#2 완료
- callback 호출
- token 잔량 16KB

### t=95ms
- chunk#3(256KB) 도착
- 즉시 16KB 전송
- pending 240KB

### t=100ms
- 재할당으로 3MB/s로 하향 (혼잡/경쟁 증가)
- updateRefillRate(3MB/s)
- 이후 refill은 10ms당 30KB

### t=110ms ~ t=180ms
- 매 10ms마다 30KB씩 전송
- chunk#3가 여러 번 부분 전송으로 소진
- callback은 완전 소진 시점에 1회 호출

### t=190ms
- downstream이 느려져 push()가 false 반환
- tryFlushPending 중단
- pending은 그대로 유지
- 이후 _read 호출 시 재개

### t=205ms (_read 재호출)
- downstream 수신 여유 회복
- tryFlushPending 재진입
- 남은 token + pending 기준으로 전송 재개

### t=250ms
- Scheduler 재할당 tick
- 3MB/s -> 5MB/s 상승
- 즉시 반영
- 메모리(capacityBytes)는 128KB로 그대로 유지

### 요약 관찰 포인트
1. chunk 단위 대기가 아니라 byte 단위 연속 배출이 일어난다.
2. rate 변동은 다음 pump 주기부터 즉시 체감된다.
3. capacity를 고정하면 메모리 상한이 안정적이다.
4. push backpressure와 token throttle이 동시에 작동해도 순서 보장(FIFO)은 유지된다.

---

## 8) 설정값 권장안 (Ver2)

- rateLookupIntervalMs: 50
- refillPumpIntervalMs: 10
- capacityBytes: max(64KB, min(256KB, allocatedRateBps * 0.05))
- highWaterMarkBytes: 64KB

의도
- lookup은 250ms scheduler tick보다 빠르게 추적
- pump는 짧게 가져가서 부분 전송 체감 지연 최소화
- capacity는 고정/작게 유지해 메모리 절약

---

## 9) 구현 순서 제안

1. TokenBucket를 "부분 소진 가능" 형태로 구현
2. RateControlledTransform에 pendingQueue + offset 기반 부분 전송 추가
3. _read 재진입 및 refillPump 루프 연결
4. Scheduler rate 즉시 반영 루프 연결
5. 통합 테스트
- 큰 chunk(>=256KB)에서 부분 전송 로그 검증
- rate 상승/하강 전환 latency 측정
- downstream backpressure 동시 상황 검증


---

## 요구사항

>> Interval 간격이 너무 짧으면 CPU 작업이 너무 많아지고 지연될 것 같아.
현재 CPU가 IO 작업에 많은 연산을 하는데, 이에 영향을 끼칠 것 같아. 너가 판단해서 설정값 설정하고, 이에 대한 설명을 md 문서에 작성해줘

>> 주석
구현한 코드의 메서드위에 주석 설명 달아줘. (메서드 설명)

>> 질문
```ts
        if (writeBytes < remaining) {
          this.stats.partialWriteCount += 1
        }
```
여기에 partial write count 는 왜있는거야? 
각각의 필드가 어떤 역할을 하는건지 .md 문서에 정리해줘.