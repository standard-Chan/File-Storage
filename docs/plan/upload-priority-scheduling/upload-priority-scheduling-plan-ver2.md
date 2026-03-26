# 업로드 우선순위 스케줄링 설계안 ver2

## 0) 문서 목적

이 문서는 기존 문서를 덮어쓰지 않고, 작성해주신 `>>` 질문/방향성을 반영해 보완한 설계안이다.

핵심 합의:

- 실행 중 속도 재할당을 중심으로 설계
- park(완전 일시정지) 정책은 현재 단계에서 사용하지 않음
- 어떤 작업도 토큰 0으로 만들지 않음(최소 전송률 보장)

---

## 1) 왜 시작 순서 제어가 여전히 필요한가

질문 요지: 실행 중 속도 제어가 가능하면 시작 순서 제어는 의미가 작은 것 아닌가?

결론: 시작 순서 제어는 여전히 필요하다. 목적은 단순 우선순위뿐 아니라 안정성 보호다.

시작 순서 제어가 필요한 이유:

1. 활성 스트림 수 상한
- 너무 많은 요청을 동시에 실행 상태로 만들면 소켓, FD, 버퍼 메모리 사용량이 급증한다.

2. 디스크/파일시스템 압력 완화
- 실행 중 작업 수가 과도하면 쓰기 경쟁이 커져 전체 처리량이 오히려 떨어질 수 있다.

3. 이벤트 루프 안정성
- 실행 중 업로드 객체가 과도하면 제어 루프 오버헤드도 커진다.

4. 초기 우선권 보장
- 속도 재할당은 "시작 후"에만 작동한다. 시작 자체를 너무 늦게 하면 작은 파일의 체감 이득이 줄어든다.

정리하면, 시작 제어는 "과도한 동시 실행 방지"와 "초기 지연 최소화"를 위한 안전장치다.

>> 의문점
걱정되는 부분이 있는데, 사용자가 업로드 요청을 했지만, 무한정 대기하게 되는 것도 있지 않겠는가?

---

## 2) transform 대기와 TCP 흐름 제어 동작

질문 요지: 예산 소진 시 pause되어 request stream 전송이 막히고 TCP 흐름 제어가 걸리는가?

결론: 맞다. 구현은 보통 다음처럼 동작한다.

1. RateControlledTransform이 chunk를 받음
2. 현재 토큰이 충분하면 즉시 downstream으로 전달
3. 토큰이 부족하면 chunk 전달을 지연(내부 대기 큐에 보관)
4. 지연 중에는 upstream에서 더 이상 빠르게 소비하지 못함
5. 결과적으로 Node 스트림 backpressure가 발생
6. TCP recv window가 줄어들며 클라이언트 송신 속도도 자연스럽게 낮아짐

주의:

- 메모리 폭증 방지를 위해 transform 내부 대기 버퍼 상한이 필요하다.
- 상한 초과 시 추가 읽기를 지연시키는 방식으로 운영한다.

---

## 3) 여기서 rate의 정확한 의미

질문 요지: rate를 낮춘다는 게 token bucket의 token을 낮춘다는 뜻인가?

결론: 정확히는 "토큰 재충전 속도(refill rate)"를 낮추는 것이다.

- rate = 초당 충전되는 토큰 수(bytes/sec)
- 버킷 크기(capacity)는 순간 버스트 허용량
- refill rate를 낮추면 평균 처리속도가 내려간다

즉, 고우선순위 유입 시:

- 저우선순위 job의 refill rate 하향
- 고우선순위 job의 refill rate 상향

으로 자원을 재배분한다.

>> 의문
그러면 token bucket 알고리즘으로 속도를 제어한다는 것이, token의 할당량을 조절하는 것이 아니라, 토큰의 충전 속도를 조절하는 건가?
둘다 유사한 말이긴 하나, 전자는 최대 할당량을 100, 200 으로 제한하는 것을 말하고, 후자는 1초에 100씩 채워지냐, 2초에 걸쳐 100씩 채워지냐를 말한다

---

## 4) park 미사용, 토큰 0 금지 정책 반영

요청 반영 사항:

- park 정책 제거
- token 0 금지

정책:

1. 모든 실행 job에 최소 전송률 보장
- minRatePerJob > 0

2. 고우선순위 유입 시에도 저우선순위는 감속만 수행
- pause/park 없음

3. starvation 방지
- 대기 중 점수 증가(aging)
- 실행 중 최소 rate 보장으로 완전 정체 방지

권장 초기값 예시:

- globalIngressLimit: 노드 기준 업로드 총 한도
- minRatePerJob: 128KB/s 또는 256KB/s
- reallocationIntervalMs: 100~250ms


>> 의문 
대기 중 점수 증가는 뭘 말하는 것인가? stream 시작 전에 큐에서 대기하는 경우를 말하는 것인가?
현재 token 0이 금지되었으므로, starvation은 자동으로 방지될 것이라고 생각한다. 
따라서 대기 중 점수 증가? 가 반드시 필요한가 의문이다.
아니면 이 이 수치는 오랫동안 속도가 낮은 상태가 유지되었을 때, 우선순위를 높이기 위한 값인가? 그렇다면 타당하다.

---

## 5) latencyClassBonus(실시간성 요청) 의미

질문 요지: 실시간성 요청이 무엇인가?

의미:

- 사용자 체감 지연에 민감한 요청 클래스
- 예: 웹 UI에서 즉시 미리보기/첨부가 필요한 소파일

하지만 현재 시스템에서 요청 클래스 구분이 없다면,

- 초기 버전에서는 latencyClassBonus를 0으로 두고
- score = sizePriority + waitBonus

로 단순화하는 것이 안전하다.

추후 확장:

- presigned 발급 시 `trafficClass=interactive|bulk` 같은 힌트 전달
- interactive에만 소량 가산점 부여

>> 의문
현재 업로드의 경우에는 요청 클래스 구분이 없다. 따라서 latencyClassBonus를 없애도 괜찮다.


---

## 6) 가드레일 항목별 역할 요약

- maxQueuedJobs
: 큐에 들어갈 수 있는 작업 개수 상한. 메모리/핸들 폭증 방지.

- maxQueuedBytes
: 큐에 쌓인 총 파일 크기 상한. 대용량 작업 다수 유입 시 위험 제어.

- maxRunningJobs
: 동시에 실행 상태로 둘 작업 수 상한. 디스크/이벤트루프 과부하 방지.

- perClientMaxConcurrent
: 클라이언트 단위 동시 업로드 상한. 특정 클라이언트 독점 방지.

- queueTimeoutMs
: 큐 대기 최대 시간. 너무 오래 기다린 요청을 실패 처리해 소켓/리소스 회수.

>> 질문
여기에서 큐는 task 시작하는 데에만 영향을 끼치는 것을 말하지?


---

## 7) 처리 흐름 설계

## 7.1 정상 흐름

1. PUT 요청 도착
2. Presigned 검증 및 입력 검증
3. UploadJob 생성(fileSize, priorityScore, enqueuedAt)
4. 큐 적재
5. 실행 슬롯 여유가 있으면 Dispatch
6. request -> RateControlledTransform -> file write 파이프라인 구성
7. 컨트롤 루프가 주기적으로 각 job의 refill rate 갱신
8. 업로드 완료 시 후처리(파일 메타, replication queue, control plane notify)
9. 완료 응답

## 7.2 고우선순위 요청 유입 흐름(핵심)

상황:
- low 우선순위 3개가 이미 실행 중
- 새로운 high 우선순위 업로드 도착

흐름:

1. high 작업 큐 진입
2. 다음 reallocation tick에서 점수 재계산
3. low 작업들의 refill rate를 단계적으로 하향
4. high 작업의 refill rate 상향
5. low 작업도 minRatePerJob 이상으로 계속 진행
6. high 작업이 빠르게 완료
7. 완료 후 전체 rate를 재균형

결과:

- 연결 끊김 없이 우선순위 반영
- high 응답 시간 개선
- low는 느려지지만 정지하지 않음

## 7.3 상태 전이(park 없는 모델)

- queued
- running
- completed
- failed
- timed_out

전이 규칙:

- queued -> running: 실행 슬롯과 정책 조건 충족
- running -> completed: 파일 저장 및 후처리 성공
- running -> failed: I/O 오류, 클라이언트 중단 등
- queued -> timed_out: queueTimeoutMs 초과

---

## 8) 추천 스코어 및 배분 공식

초기 스코어(간단형):

score = sizePriority + waitBonus

- sizePriority: 파일이 작을수록 큰 값
- waitBonus: 대기시간에 비례해 증가

배분:

allocatedRate(job) = max(minRatePerJob, globalIngressLimit x share(job))

share(job)는 score를 정규화해 계산한다.

주의:

- 모든 job의 allocatedRate 합이 globalIngressLimit을 초과하지 않도록 보정 필요
- minRatePerJob 총합이 global 한도를 넘으면 maxRunningJobs를 낮춰야 한다

---

## 9) 단계별 도입안 (현재 방향 반영)

Phase 1

- 시작 제어 + 실행 중 감속 도입
- park 없음, token 0 없음
- score 단순형(size + wait)
- 운영 지표 수집

Phase 2

- 클라이언트 공정성(per-client fairness) 추가
- 자동 튜닝(지표 기반 global/minRate 조절)
- 과부하 시 큐 상한 정책 정교화

>> 질문
클라이언트 공정성은 뭐지?

Phase 3

- 대용량을 resumable 경로로 유도
- 큐 영속화(재시작 복원)
- SLA 클래스 도입(interactive vs bulk)

>> 질문
우선은 resumable 생각하지 말고 진행하기
큐 영속화는 굳이 할 필요는 없다. 왜냐하면 어차피 아직 하나도 업로드 안되어있는 데이터니까, 서버가 꺼졌을 때 다시 업로드하면 되거든
SLA 클래스는 뭐지?


---

## 10) 보완하면 좋은 점 (지금은 미적용)

항목: 완전 정지 후 재개(park/resume) 선점

지금 미적용이 좋은 이유:

1. 복잡도 절감
- direct 업로드에서 완전 정지는 타임아웃/호환성 이슈가 크다.

2. 위험 축소
- 중간 정지 시 클라이언트/프록시 별 동작 편차가 커서 장애 가능성이 높다.

3. 단계적 검증 가능
- 감속 기반 모델만으로도 대부분의 UX 개선 효과를 먼저 얻을 수 있다.

향후 도입 가치:

- 대용량 혼잡 상황에서 더 강한 응답성 확보
- 단, resumable 프로토콜 중심으로만 제한적으로 도입하는 것이 바람직하다.

---

## 11) 한 줄 결론

이번 버전의 현실적인 목표는 "완전 정지 없는 동적 감속/가속 스케줄링"이다. 이 방식은 Node.js 제약 안에서 구현 가능하며, 작은 파일 우대와 전체 안정성을 동시에 달성하기 좋은 출발점이다.
