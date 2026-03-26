# 업로드 우선순위 스케줄링 Phase 2 설계 완성 문서

## 1. 문서 목적
이 문서는 Phase 2 구현의 최종 설계 기준이다.

목표는 다음과 같다.
- 업로드 대기열을 우선순위 기반으로 운영한다.
- 개별 요청 폴링을 제거하고 이벤트 기반으로 디스패치한다.
- 동시 디스패치 실행을 lock으로 방지한다.
- 상태 전이를 UploadScheduler 단일 지점에서 일관되게 처리한다.

## 2. 설계 의도

### 2.1 왜 이벤트 기반으로 바꾸는가
기존의 주기 polling 방식은 상태 변화가 없어도 반복 실행된다.
이 구조는 대기 작업 수가 많아질수록 불필요한 확인 비용이 늘어난다.

이벤트 기반 구조는 상태가 변할 때만 dispatch를 실행하므로 다음 효과를 가진다.
- 불필요한 반복 실행 감소
- 우선순위 큐 활용도 향상
- 동작 원인 추적 단순화

### 2.2 왜 중앙 디스패처인가
작업 선택 책임을 UploadScheduler 하나로 모으면,
선택 순서와 상태 전이를 한 곳에서 통제할 수 있다.

이로 인해 다음을 보장하기 쉽다.
- 우선순위 일관성
- 슬롯 배정 일관성
- timeout 처리 일관성

### 2.3 왜 lock이 필요한가
enqueue, 완료, 실패, abort 이벤트가 근접하게 들어오면 dispatch가 중첩 호출될 수 있다.
lock 없이 중첩 실행되면 중복 dequeue, 상태 충돌, ticket 중복 처리 위험이 있다.

따라서 isDispatching, dispatchQueued를 사용해 동시 실행을 막고,
실행 중 발생한 이벤트는 1회 재실행으로 흡수한다.

## 3. 핵심 아키텍처

구성 요소:
- PriorityQueue
- UploadScheduler (Singleton)
- AdmissionTicket

역할:
- PriorityQueue: 우선순위 정렬 및 dequeue 제공
- UploadScheduler: enqueue, dispatch, 상태 전이, timeout sweep, ticket 해제
- AdmissionTicket: enqueue 호출자의 대기 Promise를 관리

## 4. 이벤트 트리거
dispatch는 아래 이벤트에서만 호출한다.
1. enqueue
2. jobCompleted
3. jobFailed
4. jobAborted

공통 진입 함수:
- scheduleDispatch

## 5. 동시성 제어

상태 변수:
- isDispatching: 현재 dispatch 실행 여부
- dispatchQueued: 실행 중 추가 이벤트 유입 여부

동작 규칙:
- dispatch 실행 중 추가 호출은 dispatchQueued를 true로만 설정
- 현재 실행 종료 후 dispatchQueued가 true면 즉시 한 번 더 실행
- 동시에 2개 이상의 dispatch가 실행되지 않음

## 6. 우선순위 큐 규칙

정렬 우선순위:
1. score 내림차순
2. enqueuedAt 오름차순
3. fileSize 오름차순

필수 API:
- enqueue
- dequeue
- peek
- isEmpty
- size
- snapshot
- removeByJobId
- reheapify

## 7. UploadScheduler 공개 API

- initialize(config, scorePolicy)
- getInstance()
- start()
- stop()
- enqueue(jobInput): Promise<AdmissionGrant>
- jobCompleted(jobId)
- jobFailed(jobId, reason?)
- jobAborted(jobId, reason?)

네이밍 규칙:
- 상태 변경 메서드는 mark 접두어를 사용하지 않고 job 접두어를 사용한다.

## 8. dispatch 실행 규칙

dispatchOnce 처리 순서:
1. now 계산
2. sweepTimeout 수행
3. refreshQueuedScores 수행
4. available 슬롯 계산
5. while 조건으로 작업 배정

while 조건:
- available > 0
- queue가 비어 있지 않음

작업 배정 시 수행:
- queued -> running 전이
- startedAt 기록
- runningJobs 등록
- waiting ticket resolve 후 제거

## 9. timeout 처리 규칙

원칙:
- timeout 대상은 queued 상태만 처리
- timeout 전이는 UploadScheduler에서만 처리

처리 순서:
1. queue snapshot 순회
2. now - enqueuedAt > queueTimeoutMs 판정
3. removeByJobId
4. 상태를 timed_out으로 전이
5. waiting ticket reject 후 제거

## 10. 상태 전이 정의

허용 전이:
- queued -> running
- running -> completed
- running -> failed
- running -> failed (abort 포함)
- queued -> timed_out
- queued -> cancelled (abort로 queue에서 제거되는 경우)

## 11. 데이터 계약

ScorePolicy 계약:
- calculate(fileSize, enqueuedAt, now) 반환 타입은 PriorityScore

UploadJob.score 갱신:
- queued 상태에서 refreshQueuedScores 시 PriorityScore.score를 반영

## 12. 오류 처리 기준

enqueue 단계:
- 중복 jobId
- fileSize 유효성 실패
- maxQueuedBytes 초과
- queue full

실행 단계:
- timeout 발생 시 대기 Promise reject
- abort/failed 발생 시 관련 대기 Promise reject

## 13. 구현 체크리스트

Scheduler:
- polling tick 제거
- 이벤트 트리거 기반 scheduleDispatch 연결
- dispatch lock 적용
- while 기반 배정 루프 적용
- timeout sweep 통합
- jobCompleted, jobFailed, jobAborted 반영

Queue:
- removeByJobId 구현
- snapshot 구현
- reheapify 구현

Tests:
- 이벤트 트리거 시점 dispatch 검증
- 동시 이벤트에서 중복 dispatch 미발생 검증
- 우선순위 배정 순서 검증
- timeout queued 전용 처리 검증
- abort 처리 검증

## 14. 확인 필요 사항

현재 이벤트 기반 timeout은 dispatch 진입 시점에만 수행된다.
아주 긴 무이벤트 구간에서 timeout 처리 시점이 지연될 수 있다.

선택 가능한 보완안:
1. timeout 전용 one-shot timer 도입
2. 최소 주기의 경량 timeout 스캐너 분리

Phase 2에서는 이벤트 기반 단순화를 우선 적용하고,
실측 지표로 지연이 확인되면 보완안을 적용한다.

## 15. 결론

Phase 2 최종 설계는 중앙 디스패처 + 이벤트 트리거 + lock 기반으로 확정한다.
이 구조는 우선순위 큐의 장점을 유지하면서도 불필요한 polling 비용을 줄인다.
구현과 테스트는 본 문서를 단일 기준으로 진행한다.
