# Phase4 실행 설계서 (코드 변경 전)

## 문서 목적
이 문서는 지금 시점에서 코드 작업 없이, 다음 구현에서 정확히 어떤 파일의 어떤 지점을 어떻게 바꾸고 무엇을 추가할지 정의한다.

---

## 1. 범위

## 포함
- 업로드 경로 안정화(P0)
- 설정 운영화(P0)
- 회귀 테스트 설계(P0)
- 성능 벤치마크/메트릭 설계(P1)

## 제외
- 실제 코드 수정
- 실제 테스트 실행 결과 첨부
- 운영 배포 변경

---

## 2. 현재 상태 요약

- Phase4 핵심 구조(부분 전송 + 즉시 rate 반영)는 구현되어 있다.
- 남은 작업은 "운영 안정성", "관측 가능성", "튜닝 근거 확보"에 집중된다.
- 특히 실패 경로 롤백, timer/queue 종료 정합성, 응답 표준화가 우선순위가 가장 높다.

---

## 3. 파일별 변경 설계

## A. 업로드 실패 경로 정리

### 대상 파일
- storage-node/src/services/objects/objectService.ts
- storage-node/src/services/storage/fileStorage.ts

### 변경 목표
1. 업로드 실패 시 파일 롤백을 명시적으로 보장
2. scheduler 상태 정리를 성공/실패/중단 케이스별로 분기 명확화
3. 에러 응답 메시지 형식 표준화

### 상세 설계
- upload 파이프라인에서 오류 발생 시 아래 순서로 처리
  1) scheduler.jobFailed(jobId, reason)
  2) 저장 중인 대상 파일 삭제 시도 (best effort)
  3) 원본 에러 throw
- 삭제 실패는 본 에러를 덮지 않고 warn 로그만 남긴다.
- enqueue 실패, validate 실패, pipeline 실패를 구분하여 메시지 표준 키를 유지한다.

### 완료 기준
- 장애 유도 테스트에서 실패 후 대상 파일 잔존 0건
- runningJobs 유령 상태 미발생

---

## B. Transform 종료 정합성 강화

### 대상 파일
- storage-node/src/services/objects/scheduler/RateControlledTransform.ts

### 변경 목표
1. destroy/flush 경합 시 callback 중복 호출 방지
2. pending queue drain 시점 보장
3. throttle 구간 통계 누락 방지

### 상세 설계
- PendingChunk에 completed 플래그(또는 doneOnce 래퍼)를 도입해 callback idempotent 보장
- _flush 종료 직전 lastThrottleStartMs가 남아 있으면 totalThrottledMs 정산
- _destroy에서 timer clear 후 failAllPending 호출 순서 고정
- failAllPending은 queue snapshot 기반 단일 패스로 실행

### 완료 기준
- 동일 chunk callback 중복 호출 0건
- 종료 직전 throttle 시간 누락 0건

>> 보류
해당 내용이 어떤 목적으로 하는건지, 어떤 원리로 막는건지, 당장 필요한 건지 내가 이해를 못했어. 
아직은 도입하면 더 복잡해질것 같아서, 추후에 필요성을 느낄 때 도입할게. 
보완해야할 점을 모아서 새로운 md 문서에 에 작성해둬.

---

## C. Scheduler 연동 안정화

### 대상 파일
- storage-node/src/services/objects/scheduler/UploadScheduler.ts
- storage-node/src/services/objects/scheduler/runtime.ts

### 변경 목표
1. 재할당 루프/dispatch 루프 상태 관측 지점 추가
2. 재초기화/중복 start 방지 명확화

### 상세 설계
- runtime 초기화 시 start() 다중 호출 보호 로직 재확인
- reallocation 실패 누적 카운트 임계치 도달 시 structured log 필드 표준화
- enqueue/jobCompleted/jobFailed 호출 시 공통 correlation 필드(jobId, clientId) 로그 컨벤션 정의

### 완료 기준
- 중복 초기화로 인한 예외 0건
- 로그에서 job lifecycle 추적 가능

>> 보류
이것도 마찬가지로, 아직은 reallocation 실패 여부를 정확하게 알 수 없어서, 당장 도입이 필요한지 의문이야.
우선은 보류하고 보완해야할 점을 모아둔 md 문서에 추가해줘.
내가 나중에 맥락을 보고 이해할 수 있도록 
도입 목적, 필요한 이유, 변경할 사항 등을 정리해서 작성해.


---

## D. 설정값 운영 프로파일 문서화

### 대상 파일
- storage-node/src/services/objects/scheduler/config.ts
- docs/phase4-implementation-result.md
- README.md

### 변경 목표
1. dev/staging/prod 권장값을 문서로 고정
2. interval 관련 주의사항을 운영자 관점으로 설명

### 상세 설계
- 환경별 권장 프로파일 표 작성
  - Dev: lookup 250, pump 25
  - Staging: lookup 250, pump 25 (기본)
  - Prod-HighCPU: lookup 250~500, pump 30~40
  - Prod-LowLatency: lookup 125~250, pump 15~25
- token capacity는 메모리 상한 정책으로 설명
  - 기본 512KB, 노드 메모리/동시성에 맞춘 상한 가이드 제시

### 완료 기준
- 환경변수 표가 README에 존재
- 운영자가 값 변경 기준을 문서만으로 판단 가능

---

## E. 회귀 테스트 설계

### 대상 파일
- storage-node/test/routes/
- storage-node/test/services/
- storage-node/test/helper.ts

### 추가할 테스트 케이스
1. 단일 업로드 성공
- 기대: 201, 파일 저장, scheduler jobCompleted

2. 업로드 중 pipeline 실패
- 기대: 에러 응답, scheduler jobFailed, 파일 롤백

3. 동시 업로드 다중(10/50)
- 기대: 프로세스 안정, 요청 순서 보장(FIFO 대기)

4. rate 상승/하강 전환
- 기대: bytesOut 증가 추세 정상, throttle 지표 변동 확인

5. backpressure 상황
- 기대: 프로세스 hang 없음, flush 종료 보장

### 완료 기준
- 핵심 케이스 자동화
- CI에서 재현 가능

---

## F. 메트릭/로깅 설계

### 대상 파일
- storage-node/src/routes/metrics.ts
- storage-node/src/services/objects/scheduler/RateControlledTransform.ts
- storage-node/src/services/objects/scheduler/UploadScheduler.ts

### 추가 메트릭
- scheduler_running_jobs (gauge)
- scheduler_total_allocated_bps (gauge)
- transform_partial_write_total (counter)
- transform_throttled_ms_total (counter)
- upload_pipeline_fail_total (counter)

### 로그 필드 표준
- jobId
- clientId
- bucket
- objectKey
- allocatedRateBps
- pendingBytes
- errorType

### 완료 기준
- Prometheus에서 조회 가능
- 장애 시 로그+메트릭으로 원인 범위 축소 가능

---

## 4. 구현 순서(실행 플랜)

1. 실패 경로 롤백 + callback idempotent
2. 설정 운영표/README 반영
3. 회귀 테스트 작성
4. 메트릭/로그 추가
5. 벤치마크로 기본값 확정

---

## 5. 리스크 및 대응

1. 리스크: timer 주기 단축 시 CPU 상승
- 대응: pump 하한 10ms, 기본 25ms 유지

2. 리스크: 롤백 중 삭제 실패
- 대응: 본 에러 우선, 삭제 실패는 warn 로그/재시도 대상 분리

3. 리스크: 테스트 flakiness
- 대응: 시간 의존 테스트는 fake timer 또는 넉넉한 허용오차 사용

---

## 6. 최종 산출물 정의

구현 단계에 들어가기 전에 준비되어야 할 산출물

1. 파일별 변경 체크리스트
2. 환경변수 운영 프로파일 표
3. 테스트 케이스 목록 및 기대 결과
4. 메트릭/로그 명세

이 4개가 준비되면 실제 코드 작업은 병렬로 진행 가능하다.
