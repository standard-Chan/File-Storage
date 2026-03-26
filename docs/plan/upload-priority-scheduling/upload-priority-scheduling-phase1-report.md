# 업로드 우선순위 스케줄링 Phase 1 구현 보고서

## 1) 이번 단계 구현 범위

요청하신 1단계 항목만 먼저 구현했다.

- 타입 정의
- config(env 파싱 + 유효성 검증)
- ScorePolicy(교체 가능한 class 구조)

구현 파일:

- [storage-node/src/services/objects/scheduler/types.ts](../../storage-node/src/services/objects/scheduler/types.ts)
- [storage-node/src/services/objects/scheduler/config.ts](../../storage-node/src/services/objects/scheduler/config.ts)
- [storage-node/src/services/objects/scheduler/ScorePolicy.ts](../../storage-node/src/services/objects/scheduler/ScorePolicy.ts)

---

## 2) >> 질문 답변

## Q1. 우선순위 큐 정렬 기준은?

맞다. 기본 정렬 기준은 저용량 + 대기시간이다.

- score = sizePriority + waitBonus
- sizePriority: 파일이 작을수록 높음
- waitBonus: queued 대기시간이 길수록 증가

tie-breaker 권장:

1. score 내림차순
2. enqueuedAt 오름차순(먼저 들어온 작업 우선)
3. fileSize 오름차순

---

## Q2. queue timeout 처리 시 전체 스캔 비효율 문제는?

지적이 맞다. 다만 현재 목표 큐 크기(50~100 수준)에서는 주기적 선형 스캔도 충분히 실용적이다.

권장 방식:

- 초기 구현: 주기 스캔(O(n))
- 추후 최적화 필요 시: 만료 시각 min-heap 또는 time wheel 도입

즉, 지금은 단순하게 구현하고, 지표로 병목이 보일 때 최적화하는 전략이 타당하다.

---

## Q3. 큐는 싱글톤 1개여야 한다는 요구

동의한다. 이번 단계는 queue 구현 전 단계라 아직 Scheduler 인스턴스를 만들지 않았고,
다음 단계(Queue + Dispatch)에서 전역 1개 인스턴스로 고정할 예정이다.

권장 방식:

- UploadScheduler.getInstance() 제공
- 라우트는 직접 new 하지 않고 singleton 참조

---

## Q4. ScorePolicy는 바뀔 수 있으니 갈아끼우는 구조가 좋은가?

맞다. 그래서 함수 고정형이 아니라 전략 인터페이스 + 클래스 구조로 구현했다.

- ScorePolicy 인터페이스
- SizeAndWaitScorePolicy 기본 구현체

이 구조면 이후 정책을 교체해도 scheduler 본체 수정이 최소화된다.

---

## Q5. 왜 업로드 함수 내부에서 replication/notify까지 처리하나?

좋은 지적이다. 관심사 분리 관점에서 보면 분리하는 것이 더 좋다.

권장 방향:

- 업로드 저장 함수: 스트림 저장과 파일 정보 반환만 담당
- 상위 오케스트레이션 계층(route/application service): replication enqueue, control-plane notify 담당

이번 Phase 1은 타입/정책 단계라 해당 분리는 아직 적용하지 않았고,
Phase 5 라우트 통합 시점에 구조적으로 분리하는 방식으로 진행하는 것이 안전하다.

---

## 3) 구현 상세

## 3.1 types.ts

추가 타입:

- JobState
- UploadJob
- SchedulerConfig
- ScoreBreakdown

의도:

- scheduler 경계에서 필요한 데이터 형태를 고정
- 점수 계산 결과(score, sizePriority, waitBonus)를 명시적으로 전달 가능

## 3.2 config.ts

추가 내용:

- loadSchedulerConfig(env)
- 기본값(DEFAULTS)
- 양수/0이상 정수 파서
- 조합 유효성 검증

핵심 검증:

- globalIngressLimitBps >= minRatePerJobBps
- maxRunningJobs x minRatePerJobBps <= globalIngressLimitBps

의도:

- token 0 금지 정책과 물리 상한 간 모순을 시작 단계에서 차단

## 3.3 ScorePolicy.ts

추가 내용:

- ScorePolicy 인터페이스
- SizeAndWaitScorePolicy 기본 구현

정책:

- score = sizePriority + waitBonus
- waitBonus는 waitBonusWindowMs 기준으로 누적, maxWaitBonus로 상한 제한

의도:

- 정책 변경 가능성을 열어둔 채 초기 정책은 단순하게 유지

---

## 4) 최종 구현 파일

| 파일 경로 | 역할 | 상태 |
|----------|------|------|
| [storage-node/src/services/objects/scheduler/types.ts](../../storage-node/src/services/objects/scheduler/types.ts) | 타입 정의 (JobState, UploadJob, SchedulerConfig, PriorityScoreInQueue) | ✅ 완료 |
| [storage-node/src/services/objects/scheduler/config.ts](../../storage-node/src/services/objects/scheduler/config.ts) | 환경변수 파싱 + 조합 검증 | ✅ 완료 |
| [storage-node/src/services/objects/scheduler/ScorePolicy.ts](../../storage-node/src/services/objects/scheduler/ScorePolicy.ts) | 우선순위 정책 인터페이스 + 구현 | ✅ 완료 |
| [storage-node/src/utils/envParser.ts](../../storage-node/src/utils/envParser.ts) | 환경변수 파싱 유틸리티 (범용) | ✅ 완료 |

---

## 5) 검증 결과

### 타입 안정성
- types.ts: ✓ No errors
- config.ts: ✓ No errors (경로 수정 후)
- ScorePolicy.ts: ✓ No errors  
- envParser.ts: ✓ No errors

### import 경로 확인
- config.ts → types.ts: `./types` ✓
- config.ts → envParser.ts: `../../../utils/envParser` ✓
- ScorePolicy.ts → types.ts: `./types` ✓

---

## 6) 다음 단계 제안

다음 구현 단위는 Queue + Dispatch가 적합하다.

- PriorityQueue 구현
- queue timeout loop 구현
- UploadScheduler singleton 구현
- enqueue/waitForRunSlot/markRunning 상태 전이 구현

---

## 추가 요구사항

>> 네이밍 수정
현재 ScorePolicy는 스케쥴링에서도 사용되는지, 큐에서만 쓰는건지 명확하게 안보인다. 큐에서만 사용하는 정책인지 확인할 수 있도록 네이밍을 수정해라.

>> 구현 중 수정해야하는 부분
현재 config.ts에 있는 함수들 중에, parsePositiveInt 와같은 범용성 높은 함수들은 src/utils/ 로 빼서 사용하자.


>> 앞으로 구현 및 설계 시 요청사항
md 설계 및 구현 설명 문서에, 코드나 메서드를 설명하는 주석도 같이 달아라. 특히 필드 중에 이름만으로 무엇을 나타내는지 알기 어려운 필드가 많다. 

>> 구현  참고
ScorePolicy.ts 에서 ScoreBreakdown을 PriorityScoreInQueue로 네이밍 변경했다. 앞으로 calculate를 사용할때에는 해당 타입으로 사용하도록 한다.