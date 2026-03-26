요청사항은 내가 >> 표시를 붙여서 작성할게. 이 문서는 그대로 두고, 새로운 문서로 작성해.

# 업로드 우선순위 스케줄링 재정리

## 1) 먼저, 이전 문서 의도 재정리

이전 문서의 중심은 시작 시점 제어였다.

- 요청을 즉시 거절하지 않고 큐에 넣는다
- 실행 시작 순서를 우선순위로 정한다
- 작은 파일을 먼저 시작시켜 체감 지연을 줄인다

즉, 이전 제안은 시작 제어 위주였고, 실행 중인 업로드의 속도를 동적으로 재할당하는 모델까지는 깊게 다루지 못했다.

요청하신 내용은 더 강한 목표다.

- 새 고우선순위 업로드가 들어오면
- 이미 실행 중인 저우선순위 업로드를 느리게 하거나 잠시 대기시키고
- 고우선순위 업로드에 자원을 더 배분하고 싶다

이 목표는 Node.js에서도 가능하다. 다만 강제 중단 선점이 아니라 협력형 선점에 가깝다.

---

## 2) 핵심 결론

가능하다. 방법은 다음과 같다.

- 실행 시작 순서 제어 + 실행 중 속도 제어를 동시에 적용
- 스트림 백프레셔를 이용해 저우선순위 업로드를 자연스럽게 감속
- 주기적으로 대역폭 점유율을 재계산해 고우선순위로 재할당

중요 포인트:

- 스레드 선점은 불가
- 대신 스트림 읽기 속도를 통제해 사실상 선점 효과를 만든다

>> 의문사항
어차피 실행 중인 속도로 업로드를 제어하기때문에, 시작순서는 크게 의미가 없다고 생각해.
너가 시작 순서까지 제어하려는 의도는 뭐야? - 지나치게 많은 요청을 처리하지 못하도록 하려는 거야?

---

## 3) 구현 모델: 2단 스케줄링

## 3.1 1단계 Admission and Dispatch

- 역할: 어떤 업로드를 지금 시작할지 결정
- 방식: 우선순위 큐 + 대기시간 보정
- 결과: 작은 파일 또는 오래 기다린 작업이 먼저 실행

## 3.2 2단계 Runtime Rate Allocation

- 역할: 이미 실행 중인 업로드 간 속도 배분
- 방식: 100ms~250ms 주기 컨트롤 루프에서 각 작업의 초당 허용 바이트를 재산정
- 결과: 새 고우선순위 작업 진입 시 기존 저우선순위 작업 속도를 자동 하향

이 2단계를 같이 써야 요청하신 동작이 나온다.

---

## 4) 실행 중 제어를 위한 실제 기법

## 4.1 업로드 파이프라인에 제어 스트림 삽입

현재 직접 업로드 경로인 [storage-node/src/routes/objects.ts](../../storage-node/src/routes/objects.ts) 와
[storage-node/src/services/objects/objectService.ts](../../storage-node/src/services/objects/objectService.ts) 사이에서,
request body와 파일 write stream 사이에 속도 제어용 transform stream을 둔다.

구성 예시:

- request stream
- rate controlled transform
- file write stream

이 transform은 토큰 버킷 방식으로 동작한다.

- scheduler가 각 job에 초당 예산 bytesPerSecond를 할당
- transform은 현재 예산만큼만 통과시키고 나머지는 대기
- 읽기가 지연되면 TCP 백프레셔로 클라이언트 송신도 느려진다

>> 궁금한 점
transform이 현재 예산 만큼만 통과시키고, 나머지는 대기한다고 되어있는데, 예산 만큼 통과 되면, 일정 시간동안 pause 시켜서,
readStream 혹은 request Stream 이 데이터를 넘기지 못하도록 하는건가? -> 이를 통해 TCP 흐름 제어 발동시키고?

## 4.2 협력형 선점

새 고우선순위 작업이 들어오면 다음을 수행한다.

1. 저우선순위 실행 작업들의 rate를 즉시 낮춘다
2. 고우선순위 작업의 rate를 즉시 높인다
3. 필요 시 일부 저우선순위를 최소 속도로 유지한다

이 방식은 연결을 끊지 않고도 사실상 선점 효과를 낸다.

>> 궁금한 점
 여기서 rate는 token bucket에서 token 을 낮춘다는 건가?

---

## 5) 완전 정지형 선점까지 원할 때 

진행 중 업로드를 완전히 멈추고 나중에 이어가려면 체크포인트 기반 재개 프로토콜이 필요하다.

이 프로젝트에는 이미 재개 업로드 경로가 존재한다.

- [storage-node/src/routes/resumable.ts](../../storage-node/src/routes/resumable.ts)
- [storage-node/src/plugins/tus.ts](../../storage-node/src/plugins/tus.ts)

따라서 전략을 두 갈래로 잡을 수 있다.

1. Direct upload: 감속 중심 협력형 선점
2. Resumable upload: 청크 경계에서 일시중지 후 고우선순위 먼저 처리

운영 관점에서는 두 경로를 병행하고, 대용량은 resumable로 유도하는 것이 가장 안전하다.

>> 방향성 설정
아예 멈추는 경우는 아직 고려하지 않는 것으로 진행한다.
plan 문서의 마지막에 보완하면 좋을 점으로 추가해줘. 이게 왜 좋은지도 포함해서.

---

## 6) 구체적인 스케줄링 규칙 제안

## 6.1 우선순위 점수

점수는 높을수록 유리하게 둔다.

score = sizePriority + waitBonus + latencyClassBonus

- sizePriority: 파일이 작을수록 높음
- waitBonus: 오래 기다릴수록 증가
- latencyClassBonus: 실시간성 요청이면 추가 가점

>> 질문
실시간성 요청은 뭘 말하는거지?

## 6.2 실행 중 대역폭 배분

globalIngressLimit 안에서 비율 배분.

allocatedRate(job) = globalIngressLimit x normalizedShare(job)

normalizedShare는 우선순위 점수로 계산한다.

다만 starvation 방지를 위해 최소 속도는 항상 보장한다.

- minRatePerJob 설정
- 저우선순위라도 완전 0으로 오래 유지하지 않음

>> 방향성
멈춤이 발생하지는 않도록 한다. 즉, token을 0으로 설정하지는 않도록 해.

## 6.3 새 고우선순위 도착 시 정책

- 정책 A: 저우선순위 모두 감속
- 정책 B: 가장 낮은 우선순위 1개를 park 상태로 전환

park는 direct upload에서는 길게 쓰면 타임아웃 위험이 있으므로 짧은 시간 퀀텀 단위로만 사용한다.

>> 방향성
park는 사용하지 않는다. 저우선순위의 감속으로 진행한다.

---

## 7) 시스템 안정성 가드레일

요청하신 목표를 지키되 운영 안정성을 위해 아래 상한은 반드시 필요하다.

- maxQueuedJobs
- maxQueuedBytes
- maxRunningJobs
- perClientMaxConcurrent
- queueTimeoutMs

무제한 수락은 이론상 가능해 보여도 실제로는 소켓, 메모리, 타임아웃에서 무너질 수 있다.

>> 질문
위 요소 각각이 어떤 역할을 하는 건지 간략하게 설명하기.

---

## 8) 단계별 구현안

## Phase 1: 시작 제어 + 실행 중 감속

- UploadScheduler 도입
- 우선순위 큐 + aging
- rate controlled transform 도입
- 100ms 주기 rate reallocation

## Phase 2: 강한 선점 효과

- 저우선순위 park and resume 퀀텀 적용
- 클라이언트별 공정성 추가
- 메트릭 기반 자동 튜닝

## Phase 3: 대용량 최적화

- 대용량은 resumable 경로로 강제 또는 유도
- 청크 경계 선점 스케줄러 적용
- 큐 영속화

---

## 9) 검증 지표

- queue_length_total
- queue_wait_ms_p50 p95 p99
- running_jobs_by_priority
- ingress_rate_bytes_per_sec_by_priority
- time_to_first_byte_written_by_priority
- small_file_completion_ms_p95
- large_file_completion_ms_p95

성공 기준:

- 작은 파일 p95 완료시간이 기존 대비 개선
- 큰 파일 실패율 증가 없음
- 전체 처리량 급락 없음

---

## 10) 최종 정리

요청하신 방향은 시작 제어만으로는 부족하고, 실행 중 속도 재할당이 핵심이다.

Node.js에서도 다음 방식으로 충분히 구현 가능하다.

- 백프레셔 기반 협력형 선점
- 우선순위 기반 동적 rate allocation
- resumable 경로에서 청크 경계 정지 and 재개

즉, 완전한 CPU 선점과 동일하지는 않지만, 업로드 UX 관점에서는 원하는 효과에 매우 근접하게 만들 수 있다.
