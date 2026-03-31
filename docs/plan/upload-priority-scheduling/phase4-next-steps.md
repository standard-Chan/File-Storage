# Phase4 이후 다음 작업 정리

## 목표
현재 Phase4(부분 전송 + 동적 rate 반영) 구현을 운영 가능한 수준으로 안정화하고, Phase5/6로 확장한다.

---

## 1. 최우선 (P0) - 안정화

### 1) 업로드 경로 예외/정리 보강
- 항목
  - upload pipeline 실패 시 임시 파일 정리(rollback) 확인
  - transform destroy 시 pending callback 정리 검증
  - scheduler enqueue 실패 시 에러 응답 코드/메시지 표준화
- 완료 기준
  - 실패 시 orphan 파일이 남지 않는다.
  - 실패 케이스에서 job 상태가 running으로 고정되지 않는다.

### 2) 설정값 운영 프로파일 분리
- 항목
  - 환경별 권장값 정의(dev/staging/prod)
  - 기본값 문서화
- 권장 기본값
  - UPLOAD_SCHEDULER_REALLOCATION_INTERVAL_MS=250
  - UPLOAD_SCHEDULER_RATE_LOOKUP_INTERVAL_MS=250
  - UPLOAD_SCHEDULER_REFILL_PUMP_INTERVAL_MS=25
  - UPLOAD_SCHEDULER_TOKEN_BUCKET_CAPACITY_BYTES=524288
- 완료 기준
  - README 또는 운영 문서에 환경변수 표가 추가된다.
  - 값 변경 후 재기동 시 정상 반영된다.

### 3) 회귀 테스트 추가
- 항목
  - 단일 업로드 성공/실패
  - 동시 업로드 10/50에서 FIFO 보장
  - rate up/down 전환 시 bytesOut 증가 추세 검증
- 완료 기준
  - 테스트 스위트에서 핵심 시나리오 100% 통과

---

## 2. 고우선 (P1) - 성능/관측

### 4) 성능 벤치마크 시나리오 실행
- 항목
  - pump interval: 10/25/40ms 비교
  - lookup interval: 250/125ms 비교
  - 동시 업로드: 10/50/100
- 측정 지표
  - CPU 사용률, 평균 처리량(MB/s), p95 지연, partialWriteCount, totalThrottledMs
- 완료 기준
  - 운영 기본값 선정 근거 수치가 문서화된다.

### 5) 메트릭 노출 (Phase6 선반영)
- 항목
  - scheduler_running_jobs
  - scheduler_total_allocated_bps
  - transform_partial_write_total
  - transform_throttled_ms_total
- 완료 기준
  - Prometheus scrape에서 지표 확인 가능
  - 부하 시 지표가 유의미하게 변화

---

## 3. 중간 우선 (P2) - 기능 확장

### 6) Phase5 라우트 통합 범위 확장
- 항목
  - multipart 경로에도 동일 transform 정책 적용 검토
  - objectService 업로드 타입별 공통 파이프라인 추출
- 완료 기준
  - direct/multipart 간 rate control 동작 일관성 확보

### 7) 운영 안전장치
- 항목
  - rateLookup 실패 누적 로깅 기준 추가
  - 장기 throttle 감지 알람 임계값 추가
- 완료 기준
  - 장애 징후를 로그/메트릭에서 조기 탐지 가능

---

## 4. 바로 실행할 추천 순서

1. P0-1 예외/정리 보강
2. P0-3 회귀 테스트 작성
3. P1-4 벤치마크 실행 후 기본값 확정
4. P1-5 메트릭 노출
5. P2-6 multipart 통합

---

## 5. 체크리스트

- [ ] 실패 시 파일/상태 롤백 검증 완료
- [ ] 환경변수 운영표 작성 완료
- [ ] 회귀 테스트 추가 및 통과
- [ ] interval 벤치마크 결과 문서화
- [ ] Prometheus 메트릭 추가
- [ ] direct/multipart 동작 일관화
