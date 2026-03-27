# Phase 4 구현 결과 정리

## 1. 이번 작업에서 실제 구현된 항목

다음 항목을 코드로 반영했다.

1. 부분 전송 가능한 Token Bucket 구현
- 토큰이 chunk 전체 크기에 못 미쳐도, 가능한 바이트만 즉시 전송
- 남은 바이트는 pending queue(offset)로 유지 후 refill 시 이어서 전송

2. 즉시 Refill Rate 반영
- Scheduler의 allocatedRateBps를 주기적으로 조회
- 조회한 rate를 즉시 token bucket refill rate로 반영
- fail-open: 조회 실패 시 이전 rate 유지

3. RateControlledTransform 도입
- FIFO pending queue로 순서 보장
- _transform에서 queue 적재 후 즉시 flush 시도
- _read 재진입과 pump loop로 backpressure/토큰 대기 모두 처리

4. 업로드 파이프라인 통합
- uploadFile 경로에 scheduler admission + RateControlledTransform 연결
- 성공 시 jobCompleted, 실패 시 jobFailed 호출

5. 설정값 확장
- rateLookupIntervalMs 추가
- refillPumpIntervalMs 추가
- 검증 로직 추가

---

## 2. CPU 영향 고려한 Interval 최종값

## 최종 기본값
- rateLookupIntervalMs: 250ms
- refillPumpIntervalMs: 25ms

## 판단 근거
1. rateLookupIntervalMs
- Scheduler 재할당 tick 기본값이 250ms이므로, 이보다 훨씬 짧은 lookup은 같은 값을 반복 조회할 가능성이 높다.
- 50ms lookup은 반응은 빠르지만, 동시 업로드 수가 증가하면 불필요한 timer wake-up이 누적된다.
- 따라서 기본은 250ms로 맞춰 CPU 낭비를 줄이고, 필요 시 환경변수로만 더 짧게 조정하도록 했다.

2. refillPumpIntervalMs
- 너무 길면(예: 100ms) 부분 전송 체감 지연이 커진다.
- 너무 짧으면(예: 1~5ms) event loop wake-up이 많아져 I/O 처리에 간섭한다.
- 25ms는 지연/CPU의 균형점으로 설정했다.

## 운영 가이드
- 업로드 동시성 낮음, 낮은 지연 중요: pump 10~20ms
- 업로드 동시성 높음, CPU 안정성 중요: pump 25~40ms
- lookup은 가능하면 scheduler tick 이상으로 유지 권장

---

## 3. partialWriteCount가 필요한 이유

partialWriteCount는 아래 상황을 정량화한다.

- 한 번의 flush에서 chunk 전체를 못 보내고 일부만 전송한 횟수
- 즉, 토큰/다운스트림 제약으로 인해 chunk가 쪼개져 전송된 빈도

의미:
1. 스로틀 강도 관찰
- 값이 높을수록 전송이 자주 잘리고 있다는 뜻

2. 튜닝 지표
- pump interval이 너무 길거나, capacity가 너무 작으면 증가
- rate 변화가 급격해도 증가할 수 있음

3. 장애 진단 보조
- bytesOut은 증가하는데 partialWriteCount가 비정상적으로 급증하면
  token 정책 또는 downstream 병목 가능성을 빠르게 의심할 수 있다.

---

## 4. 통계 필드 역할 정리

RateControlledTransformStats

1. bytesIn
- Transform가 입력으로 받은 총 바이트 수

2. bytesOut
- Transform가 실제 push한 총 바이트 수

3. partialWriteCount
- 부분 전송 발생 횟수
- writeBytes < remaining 조건에서 증가

4. throttlePauseCount
- 토큰 부족으로 스로틀 구간이 시작된 횟수

5. totalThrottledMs
- 토큰 부족 상태로 대기한 누적 시간(ms)

해석 팁
- bytesIn ≈ bytesOut + pending 잔량
- partialWriteCount 상승 + totalThrottledMs 상승: 토큰 제약 강함
- throttlePauseCount 높고 totalThrottledMs 낮음: 짧은 스로틀이 자주 발생

---

## 5. 메서드 주석 반영 상태

이번에 추가한 구현 코드의 주요 메서드 상단에 설명 주석을 넣었다.

대상 파일:
- storage-node/src/services/objects/scheduler/TokenBucket.ts
- storage-node/src/services/objects/scheduler/RateControlledTransform.ts
- storage-node/src/services/objects/scheduler/runtime.ts

주석 원칙:
- 메서드의 책임, 입력/출력 성격, 실패 시 처리 방식을 간결하게 기술
- 구현 라인별 설명은 피하고, 동작 의도를 설명

---

## 6. 변경 파일 목록

신규 파일
- storage-node/src/services/objects/scheduler/TokenBucket.ts
- storage-node/src/services/objects/scheduler/RateControlledTransform.ts
- storage-node/src/services/objects/scheduler/runtime.ts
- docs/phase4-implementation-result.md

수정 파일
- storage-node/src/services/objects/objectService.ts
- storage-node/src/services/objects/scheduler/types.ts
- storage-node/src/services/objects/scheduler/config.ts
- storage-node/src/services/objects/scheduler/UploadScheduler.ts

---

## 7. 컴파일 검증 결과

- 명령: npm run build:ts
- 결과: 성공 (TypeScript 컴파일 통과)
