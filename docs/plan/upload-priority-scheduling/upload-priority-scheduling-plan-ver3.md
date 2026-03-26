# 업로드 우선순위 스케줄링 설계안 ver3

## 0) 문서 목적

이 문서는 ver2의 `>>` 질문에 답변하고, 실제 업로드 요청이 들어왔을 때의 처리 플로우를 예시 기반으로 구체화한 버전이다.

현재 확정 방향:

- 실행 중 속도 재할당 중심
- park(완전 정지) 미사용
- token 0 금지(모든 running job은 최소 전송률 보장)
- 우선은 direct upload 기준으로 설계

---

## 1) ver2의 `>>` 질문 답변

## Q1. 시작 순서 제어가 꼭 필요한가? 무한 대기 위험은?

답변:

시작 순서 제어는 필요하다. 이유는 두 가지다.

1. 안정성 보호
- 실행 중 업로드 수가 무한히 늘어나면 소켓, 메모리, 이벤트루프 부하가 급격히 증가한다.
- 따라서 running 개수 상한은 반드시 필요하다.

2. 초기 지연 제어
- 속도 재할당은 running 상태에서만 작동한다.
- 시작 자체가 너무 늦으면 소파일 우대 효과가 약해진다.

무한 대기 방지책:

- queueTimeoutMs: 큐에서 최대 대기시간 초과 시 실패 처리
- waitBonus(aging): 오래 기다린 작업 점수 증가
- maxQueuedJobs/maxQueuedBytes: 큐 상한으로 시스템 붕괴 방지

결론: 시작 제어는 단순 우선순위가 아니라, 안정성과 대기시간 상한 보장을 위한 장치다.

---

## Q2. transform 대기 시 실제로 TCP 흐름 제어가 걸리는가?

답변:

맞다. 구조는 다음과 같다.

- transform이 토큰 부족으로 chunk 전달을 지연
- upstream(request stream) 소비가 느려짐
- Node 스트림 backpressure 발생
- OS TCP 수신 버퍼가 빠르게 비워지지 않아 recv window가 축소
- 클라이언트 송신 속도가 자연스럽게 줄어듦

즉, pause를 직접 크게 호출하지 않아도, 소비 지연 자체가 TCP 흐름 제어를 유도한다.

---

## Q3. token 할당량 조절 vs 충전 속도 조절 중 무엇이 핵심인가?

답변:

핵심은 충전 속도(refill rate) 조절이다.

- capacity(버킷 크기): 순간 버스트 허용량
- refill rate: 평균 처리속도(bytes/sec)

우선순위 재배분은 주로 refill rate를 조정해 수행한다.

- 고우선순위: refill rate 상향
- 저우선순위: refill rate 하향

capacity는 보통 고정하거나 제한적으로만 조정한다.

---

## Q4. 대기 중 점수 증가(aging)가 꼭 필요한가?

답변:

질문처럼 token 0 금지면 running starvation은 크게 완화된다.
하지만 queued starvation은 별개다.

- token 0 금지는 running 상태 보호
- aging은 queued 상태 보호

즉, aging은 stream 시작 전 큐 대기 작업을 위한 보정이 핵심이다.

추가로, 필요하다면 running 상태에서도 장시간 저속 작업에 미세 가산점을 줄 수 있다.
단, 초기 버전에서는 queued aging만 적용해도 충분하다.

---

## Q5. latencyClassBonus는 제거해도 되는가?

답변:

현재 요청 클래스 구분이 없다면 제거해도 된다.

초기 점수식 권장:

score = sizePriority + waitBonus

추후에만 확장:

- interactive/bulk 같은 트래픽 클래스가 생기면 bonus 추가

---

## Q6. 여기서 큐는 task 시작에만 영향 주는가?

답변:

네. 기본적으로 큐는 queued -> running 전이에만 관여한다.

- 큐 정책: 어떤 작업을 언제 시작할지 결정
- 런타임 정책: running 작업들의 속도를 어떻게 나눌지 결정

둘은 분리된 책임을 가진다.

---

## Q7. 클라이언트 공정성은 무엇인가?

답변:

특정 클라이언트가 전체 대역폭을 독점하지 못하게 하는 정책이다.

예시:

- 클라이언트 A가 동시에 20개 업로드
- 클라이언트 B가 1개 업로드

공정성 정책이 없으면 A가 대부분 자원을 점유할 수 있다.

간단한 적용 방법:

- perClientMaxConcurrent 설정
- 클라이언트별 최소/최대 share 캡 적용

초기 버전에서는 perClientMaxConcurrent만으로도 효과가 크다.

---

## Q8. Phase 3 항목 중 resumable/큐 영속화/SLA 클래스는 지금 필요한가?

답변:

현재 단계에서는 제외해도 된다.

- resumable: 지금 범위 밖이면 제외
- 큐 영속화: 서버 재시작 시 재업로드 허용 전략이면 우선순위 낮음
- SLA 클래스: 트래픽 클래스 운영이 아직 없으면 보류

SLA 클래스 의미만 정리:

- 요청별 목표 품질(지연/처리시간) 등급
- 예: 빠른 응답형(interactive), 대용량 벌크형(bulk)

현재는 단순 정책으로 시작하고, 지표 확보 후 도입 여부를 판단하는 것이 맞다.

---

## 2) 실제 업로드 예시 기반 처리 플로우

가정:

- globalIngressLimit = 20MB/s
- maxRunningJobs = 3
- minRatePerJob = 1MB/s
- reallocation interval = 200ms
- 점수식: score = sizePriority + waitBonus

작업:

- Job A: 500MB (large, low)
- Job B: 300MB (large, low)
- Job C: 50MB (medium)
- Job D: 5MB (small, high) - 나중에 도착

## 2.1 타임라인 예시

T0

1. A, B, C 요청 도착
2. 검증 후 queued 진입
3. maxRunningJobs=3 이므로 A, B, C running 시작
4. 초기 rate 배분(예시)
- A: 6MB/s
- B: 6MB/s
- C: 8MB/s

T1 (약 1초 후)

1. D(5MB) 요청 도착
2. D는 queued 진입
3. 다음 200ms tick에서 점수 재계산
4. D 점수가 가장 높아 running 승격 필요

여기서 시작 제어가 동작:

- 현재 running 3개라 즉시 4개를 돌리지 않음
- 가장 불리한 running 하나를 완전 정지하지 않고 감속 상태로 유지하면서,
  승격 전략에 따라 실행 슬롯 재조정

실무 구현 선택지(park 없음 정책 반영):

- 방법 A: maxRunningJobs를 4로 일시 확장하지 않고, 완료 임박 작업(C)을 우선 종료 대기 후 D 시작
- 방법 B: maxRunningJobs를 4로 허용하되 전체 rate를 재분배

현재 방향에 맞는 추천은 방법 B다.

>> 방향
B 방법으로 진행한다.
하지만 maxRunningJobs는 동적으로 바뀌는 값으로 하지 않고, 실제 한계지점으로 설정한다. 실제 서버가 100개 요청까지만 받을 수 있다면,
100을 maxRunning Jobs으로 설정하고, 이 값 이상의 요청이 들어오면 대기하거나, 타임아웃으로 거절시킨다.
현재 설계와 틀어지거나, 나에게 궁금한 점이 있으면 물어봐라.

T1+200ms

1. D를 running으로 시작
2. rate 재배분(예시)
- A: 4MB/s
- B: 4MB/s
- C: 4MB/s
- D: 8MB/s
3. 모든 작업은 minRatePerJob 이상 유지

T2 (수초 이내)

1. D(5MB)가 빠르게 완료
2. D 종료 후 남은 3개에 재배분
- A: 6MB/s
- B: 6MB/s
- C: 8MB/s

T3

1. C 완료
2. A/B는 높은 rate로 마무리

결과:

- D의 응답시간 크게 단축
- A/B/C는 느려졌지만 정지하지 않고 진행
- 전체 연결 안정성 유지

>> 방향성
위에 '방향' 에 작성안 요소 제외하고는, 나머지 방향성은 맞다.

---

## 2.2 요청 1건 내부 파이프라인(Direct Upload)

1. PUT 수신
2. Presigned 검증
3. UploadJob 생성 및 큐 등록
4. running 승격 시 파일 저장 파이프라인 연결
- request stream -> RateControlledTransform -> fs write stream
5. 컨트롤 루프가 주기적으로 refill rate 갱신
6. 업로드 완료
7. 메타 수집 및 replication queue 등록
8. control-plane 업로드 완료 통보
9. 응답 반환

---

## 3) 현재 범위 기준 최종 권장안

1. 점수식 단순화
- score = sizePriority + waitBonus

2. 정책 단순화
- park 없음
- token 0 없음
- direct upload만 고려

3. 안정성 필수값
- maxQueuedJobs
- maxQueuedBytes
- maxRunningJobs
- queueTimeoutMs

4. 선택값(초기엔 선택)
- perClientMaxConcurrent


---

## 4) 마지막으로, 추가 고려하면 좋은 부분

아래는 지금 당장 구현하지 않아도 되지만, 초기에 결정해두면 운영이 쉬워진다.

1. 큐 대기 응답 전략
- 동기 연결 유지인지, 202 비동기 수락인지 명확히 결정 필요
- 동기 방식이면 프록시/클라이언트 timeout 정합성 확인 필수

2. 고우선순위 오남용 방지
- 파일 크기만으로 우선순위를 매기면 악용 가능성은 낮지만,
  향후 클래스 도입 시 인증된 주체만 고우선순위를 사용하도록 제한 필요

3. 메트릭 최소 셋
- queue length, queue wait p95, priority별 처리율, 실패율
- 개선 여부를 수치로 확인해야 정책 튜닝이 가능

4. 실패/중단 처리 일관성
- 클라이언트 연결 중단 시 자원 해제 타이밍
- 부분 파일 정리 정책(즉시 삭제 vs 배치 정리)

5. 운영 파라미터 변경 방법
- env 재배포 방식인지, 런타임 조정 API를 둘지 결정
- 초기에는 env 기반 고정값으로 시작해도 충분

>> 방향성
1. 동기적으로 해야한다.
2. 우선 생각하지 마라. 나중에 보완해야할점에만 넣어둬라.
3. 이건 맞다. 메트릭 셋이 필요하다.
4. 즉시 삭제라고 생각해라.
5. env로


---

## 5) 한 줄 결론

현재 요구사항 기준 최적 출발점은 시작 제어 + 실행 중 refill rate 재할당이며, 작은 파일을 빠르게 끝내면서도 큰 파일을 멈추지 않는 균형형 모델이다.
