# 업로드 우선순위 스케줄링 Phase 3 설계 문서 Ver3 (변경점만)

## 1. 문서 범위
이 문서는 기존 Phase3 Ver2 대비 변경되는 내용만 기록한다.
기존에 확정된 항목(전체 흐름, 기본 분배 개념, 테스트 큰 틀)은 반복하지 않는다.

---

## 2. 변경사항 요약

1. Reallocation loop 의 rate 반영 코드를 메서드로 추출한다.
2. 잔여 보정(residue) 로직은 기본 비활성화하고, 옵션으로 켜는 구조로 변경한다.
3. rate 변동 제한은 B안(활성화)으로 확정한다.
4. jobId 라벨 메트릭은 B안(미사용, 집계 지표만)으로 확정한다.
5. allocation 실패 정책은 A안(fail-open)으로 확정한다.

---

## 3. 상세 변경 설계

### 3.1 Reallocation loop 코드 명확화

변경 의도:
- runningJobs.get(jobId)로 가져온 객체가 원본인지 복사본인지 코드를 읽는 사람 입장에서 헷갈리지 않도록, 의도 중심 메서드로 추출한다.

변경 전(의사코드):
- loop 내부에서 직접 조회 후 필드 대입

변경 후(의사코드):
```ts
for (const [jobId, rate] of result.byJobId) {
  this.updateRunningJobAllocatedRate(jobId, rate)
}

private updateRunningJobAllocatedRate(jobId: string, rate: number): void {
  const runningJob = this.runningJobs.get(jobId)
  if (!runningJob) return

  runningJob.allocatedRateBps = rate
}
```

구현 위치:
- 파일: storage-node/src/services/objects/scheduler/UploadScheduler.ts
- 클래스: UploadScheduler
- 메서드:
  - dispatch reallocation 적용 지점 내부 loop에서 호출
  - private updateRunningJobAllocatedRate(jobId, rate) 신규 추가

---

### 3.2 residue 보정 로직 토글화

변경 의도:
- residue 보정은 정확도 향상 이점이 있으나, 연산 비용 증가 요소가 될 수 있다.
- 운영 관측(CPU/지연)을 보고 켜고 끄기 가능해야 한다.

설계 변경:
- 기본값: OFF
- 옵션값으로 ON 가능
- OFF일 때는 floor 결과만 적용하고 즉시 반환

설정 추가:
- env: UPLOAD_SCHEDULER_ENABLE_RESIDUE_REBALANCE
- 타입: boolean
- 기본값: false

의사코드:
```ts
if (!config.enableResidueRebalance) {
  return {
    byJobId: map,
    totalAllocatedBps: used,
  }
}

// ON일 때만 residue 보정 수행
applyResidueRebalance(...)
return {
  byJobId: map,
  totalAllocatedBps: globalIngressLimitBps,
}
```

구현 위치:
- 파일: storage-node/src/services/objects/scheduler/config.ts
  - env 파싱 추가
- 파일: storage-node/src/services/objects/scheduler/types.ts
  - SchedulerConfig에 enableResidueRebalance 필드 추가
- 파일: storage-node/src/services/objects/scheduler/RateAllocator.ts (Phase3 신규)
  - allocate 내부 분기 처리
  - private applyResidueRebalance(...) 분리

---

### 3.3 rate 변동 제한 B안 확정 (활성화)

결정:
- 매 tick rate가 급격히 바뀌지 않도록 변동 제한을 기본 활성화한다.

적용 방식:
- 이전 tick rate 기준으로 step up/down 제한
- 계산식:
  - next = clamp(target, prev - maxStepDownBps, prev + maxStepUpBps)

설정 추가:
- UPLOAD_SCHEDULER_RATE_STEP_UP_BPS
- UPLOAD_SCHEDULER_RATE_STEP_DOWN_BPS

권장 기본값(초기안):
- step up: 256KB/s
- step down: 512KB/s

구현 위치:
- 파일: storage-node/src/services/objects/scheduler/types.ts
  - SchedulerConfig에 rateStepUpBps, rateStepDownBps 추가
- 파일: storage-node/src/services/objects/scheduler/config.ts
  - env 파싱/검증 추가
- 파일: storage-node/src/services/objects/scheduler/RateAllocator.ts
  - private applyRateStepLimit(jobId, previousRate, targetRate, config)

---

### 3.4 메트릭 정책 10.2 확정

결정:
- jobId 라벨 메트릭은 사용하지 않는다.
- 집계 지표만 노출한다.

유지 지표:
- scheduler_running_jobs
- scheduler_total_allocated_bps
- scheduler_reallocation_duration_ms
- scheduler_reallocation_error_total

제외 지표:
- scheduler_job_allocated_rate_bps{jobId}

구현 위치:
- 파일: storage-node/src/routes/metrics.ts 또는 scheduler 메트릭 수집 모듈(도입 시)
- 파일: storage-node/src/services/objects/scheduler/SchedulerMetrics.ts (Phase6 예정)

---

### 3.5 실패 정책 10.3 확정

결정:
- allocation 예외 시 fail-open 유지
- 즉, 직전 할당값을 유지하고 다음 tick에서 재시도

동작:
1. allocator 예외 발생
2. runningJobs의 allocatedRateBps를 변경하지 않음
3. error 카운터 증가
4. warning 로그 남김
5. 다음 tick 정상 재시도

구현 위치:
- 파일: storage-node/src/services/objects/scheduler/UploadScheduler.ts
  - reallocation loop try/catch에서 적용
- 파일: storage-node/src/services/objects/scheduler/RateAllocator.ts
  - 예외는 throw, 복구는 Scheduler에서 담당

---

## 4. 메서드/함수 등록 위치 요약

1. UploadScheduler
- 파일: storage-node/src/services/objects/scheduler/UploadScheduler.ts
- 추가/변경 예정:
  - startReallocationLoop()
  - stopReallocationLoop()
  - private runReallocationTick()
  - private applyAllocationResult(result)
  - private updateRunningJobAllocatedRate(jobId, rate)

2. RateAllocator (신규)
- 파일: storage-node/src/services/objects/scheduler/RateAllocator.ts
- 추가 예정:
  - allocate(input)
  - private allocateBaseAndWeighted(input)
  - private applyRateStepLimit(...)
  - private applyResidueRebalance(...)  // residue 옵션 ON일 때만

3. Config / Types
- 파일: storage-node/src/services/objects/scheduler/types.ts
  - SchedulerConfig 필드 추가
    - enableResidueRebalance
    - rateStepUpBps
    - rateStepDownBps
- 파일: storage-node/src/services/objects/scheduler/config.ts
  - 신규 env 파싱 및 검증

4. Metrics
- 파일: storage-node/src/services/objects/scheduler/SchedulerMetrics.ts (향후)
  - jobId 라벨 제외한 집계 지표만 유지

---

## 5. 구현 체크리스트 (변경분만)

- [ ] UploadScheduler에 updateRunningJobAllocatedRate 메서드 추출
- [ ] RateAllocator 신규 생성
- [ ] residue 보정 토글 옵션 추가 (기본 OFF)
- [ ] rate step 제한 로직 기본 ON
- [ ] fail-open 복구 정책 반영
- [ ] jobId 라벨 메트릭 제거/미도입 명시

---

## 6. 질문 및 누락 확인 항목

아래는 구현 전에 확인이 필요한 질문이다.

1. rate step 제한 기본값
- 현재 초기안은 up 256KB/s, down 512KB/s로 제안했다.
- 이 값을 그대로 고정할지, 환경별(로컬/운영)로 다르게 둘지 확인 필요.

2. residue OFF 시 총합 처리
- residue OFF면 totalAllocatedBps가 globalIngressLimitBps보다 작아질 수 있다.
- 이 상태를 허용할지(단순/안정), 최소한 일부 상위 score에만 추가 분배할지(효율) 결정 필요.

3. fail-open 지속 시간
- allocator가 연속 실패할 때 몇 회부터 경고를 error 레벨로 올릴지 기준이 필요하다.
- 예: 10회 연속 실패 시 알람 이벤트 발생.

4. reallocation tick 주기
- 기존 권장 100~250ms 중 기본값을 몇 ms로 시작할지 확정 필요.

5. step 제한과 minRate 충돌 우선순위
- step 제한 적용 시에도 minRate는 반드시 강제해야 한다.
- 우선순위를 minRate > stepLimit으로 확정해도 되는지 확인 필요.

---
## 요구사항

>> 1. 
up, down 값은 config에서 설정할 수 있도록 하고, 기본 값을 초기안 그대로 256 KB/s, 512 KB/s로 진행
>> 2. 
우선은 ON으로 진행하고, 추후 OFF로 끌 수 있도록 유지보수가 용이한 구조로 만들기
>> 3. 
10회로 진행해.

>> 4. 
환경변수로 받도록 설정하고, 과도한 CPU 사용을 막기 위해 기본값은 250ms로 설정해.

>> 5. 
우선순위를 minRate가 적용되도록 설정해.


---
# 추가 질의 사항

>> 현재 로직의 비효율성 

현재 매 tick마다 모든 job에 초기 rate를 할당하고, step을 조정하며, bounded 처리를하는 로직인것 같아.

매 tick마다 job에 초기 rate를 할당하게 된다면, 동일한 처리가 매 tick마다 발생할 것 같은데, 비효율적일 것 같아. 그래서 처음에 작업이 들어올 때에만 그렇게 할당 하고, 현재 상태에서 조정하는 방향으로 가는건 어떨까?

현재 진행 방식과 이 중복된 로직을 개선할 방법. ver4 md 문서로 정리해봐.
만약 내 생각이 틀렸다면 그것도 정리해서 말해주고.
