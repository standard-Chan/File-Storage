# 업로드 테스트 스크립트

이 디렉토리에는 Object Storage의 파일 업로드 기능을 테스트하는 스크립트들이 있습니다.

## 파일 구조

- `upload.js`: 단일 파일 업로드 테스트
- `load-test.js`: 동시 업로드 부하 테스트 (Node.js)
- `k6-load-test.js`: k6 부하 테스트 스크립트 ⭐ **추천**
- `k6-tus-resume-upload.js`: k6 TUS 재개 업로드 단독 테스트
- `k6-resumable-comparison.js`: k6 **Restart vs Resume 비교 테스트** ⭐ **Resumable 도입 효과 수치화**
- `run-k6-test.ps1`: k6 테스트 실행 헬퍼 스크립트 (Windows)
- `run-k6-test.sh`: k6 테스트 실행 헬퍼 스크립트 (Linux/macOS)
- `K6_LOAD_TEST.md`: k6 부하 테스트 상세 가이드
- `test-files/`: 부하 테스트용 랜덤 파일 저장 디렉토리 (자동 생성)
- `test-results/`: k6 테스트 결과 저장 디렉토리 (자동 생성)

## 사용 방법

### 1. 단일 파일 업로드 (`upload.js`)

특정 파일을 지정된 버킷과 경로에 업로드합니다.

```bash
# 기본 사용법
./upload.js <파일경로> <버킷명> <객체키>

# 예시
./upload.js sample.jpg bucket1 pictures/sample.jpg
./upload.js ../data/report.pdf documents reports/2024/report.pdf
```

**매개변수:**
- `파일경로`: 업로드할 로컬 파일의 경로
- `버킷명`: 대상 버킷 이름
- `객체키`: 저장될 객체의 경로 및 파일명

### 2. k6 부하 테스트 (`k6-load-test.js`) ⭐ **추천**

k6를 사용한 전문적인 부하 테스트 도구입니다. Presigned URL 발급부터 실제 파일 업로드까지 전체 프로세스를 테스트합니다.

#### k6 설치

**Windows:**
```powershell
winget install k6
# 또는
choco install k6
```

**macOS:**
```bash
brew install k6
```

**Linux:**
```bash
# Debian/Ubuntu
sudo gpg -k
sudo gpg --no-default-keyring --keyring /usr/share/keyrings/k6-archive-keyring.gpg \
  --keyserver hkp://keyserver.ubuntu.com:80 \
  --recv-keys C5AD17C747E3415A3642D57D77C6C491D6AC1D69
echo "deb [signed-by=/usr/share/keyrings/k6-archive-keyring.gpg] https://dl.k6.io/deb stable main" | \
  sudo tee /etc/apt/sources.list.d/k6.list
sudo apt-get update
sudo apt-get install k6
```

#### 빠른 시작

**Windows (PowerShell):**
```powershell
# 가벼운 부하 테스트 (10 VUs, 1분)
.\run-k6-test.ps1 -Scenario light

# 중간 부하 테스트 (50 VUs, 2분)
.\run-k6-test.ps1 -Scenario medium

# 높은 부하 테스트 (100 VUs, 3분)
.\run-k6-test.ps1 -Scenario heavy

# 스트레스 테스트 (200 VUs, 5분)
.\run-k6-test.ps1 -Scenario stress

# 사용자 정의
.\run-k6-test.ps1 -Scenario custom -VUs 150 -Duration 10m
```

**Linux/macOS:**
```bash
# 실행 권한 부여
chmod +x run-k6-test.sh

# 가벼운 부하 테스트
./run-k6-test.sh light

# 중간 부하 테스트
./run-k6-test.sh medium

# 높은 부하 테스트
./run-k6-test.sh heavy

# 사용자 정의
VUS=150 DURATION=10m ./run-k6-test.sh custom
```

#### 직접 k6 명령 실행

```bash
# 기본 실행 (10 VUs, 30초)
k6 run k6-load-test.js

# 동시 사용자 수와 지속 시간 지정
k6 run --vus 50 --duration 1m k6-load-test.js

# 다른 버킷 사용
k6 run --vus 20 --env BUCKET=my-bucket k6-load-test.js

# 결과를 JSON 파일로 저장
k6 run --out json=results.json k6-load-test.js
```

**특징:**
- 1KB, 10KB, 100KB, 1MB, 10MB 파일 크기 랜덤 선택
- Presigned URL 발급부터 파일 업로드까지 전체 시나리오 테스트
- 실시간 메트릭 및 임계값(Threshold) 검증
- 동시 사용자 수(VUs) 유연한 조절
- 단계적 부하 증가 지원 (Ramping)
- 상세한 통계 및 보고서

📘 **상세한 사용법은 [K6_LOAD_TEST.md](./K6_LOAD_TEST.md)를 참고하세요.**

---

### 3. Resumable Upload 도입 효과 비교 테스트 (`k6-resumable-comparison.js`) ⭐

TUS 프로토콜 기반 Resumable 업로드의 도입 효과를 수치로 검증한다.  
**동일한 중단 지점(INTERRUPT_MB)에서 두 가지 복구 전략의 소요 시간을 측정·비교**한다.

| 구분 | 시나리오 A: Restart | 시나리오 B: Resume |
|------|--------------------|--------------------|
| 중단 후 처리 | 기존 세션 폐기, 처음부터 재전송 | 기존 세션 유지, 중단 지점부터 재개 |
| 복구 시 전송량 | 전체 파일 크기 | 파일 크기 − 중단 지점 |
| TUS 사용 여부 | ✗ (일반 재업로드) | ✓ (HEAD → PATCH 재개) |

#### API 흐름 (두 시나리오 공통)

```
[Control Plane]
POST /api/storage/presigned-url
  ← { presignedUrl }

[Storage Node — TUS 세션 생성]
POST {presignedUrl}   (Tus-Resumable, Upload-Length 헤더 포함)
  ← 201 Created, Location: //host/tus/objects//{bucket}/{key}

[Storage Node — 청크 전송]
PATCH {Location URL}  (Upload-Offset, Content-Type: application/offset+octet-stream)
  ← 204 No Content

[Resume 전용: 오프셋 확인]
HEAD {Location URL}   (Tus-Resumable: 1.0.0)
  ← 200, Upload-Offset: {bytes}
```

#### 실행 방법

```bash
# 기본 실행 (1GB 파일, 300MB 지점에서 중단)
k6 run k6-resumable-comparison.js

# 중단 지점·청크 크기 조정
k6 run \
  --env INTERRUPT_MB=300 \
  --env CHUNK_MB=100 \
  --env BUCKET=test_bucket \
  --env CONTROL_PLANE_URL=http://localhost:8080 \
  --env STORAGE_NODE_URL=http://localhost:3000 \
  k6-resumable-comparison.js
```

> **주의**: 두 시나리오는 순차 실행된다.  
> 기본 `startTime`은 `resume_scenario`가 `90m` 후 시작하도록 설정되어 있다.  
> 파일 크기나 네트워크 속도에 따라 `options.scenarios.resume_scenario.startTime` 값을 조정해야 할 수 있다.

#### 출력 예시

```
════════════════════════════════════════════════════════════
  Resumable Upload 도입 효과 비교 리포트
════════════════════════════════════════════════════════════

  [측정 조건]
  · 파일 크기       : 1.00 GB
  · 청크 크기       : 100 MB
  · 중단 지점       : 300 MB
  · 재시작 시 추가  : 1024 MB (전체 재전송)
  · 재개 시 추가    : 724 MB (나머지만 전송)

────────────────────────────────────────────────────────────
  항목                       A: Restart      B: Resume
────────────────────────────────────────────────────────────
  복구 소요 시간 (초)              320.5           231.2
  전체 소요 시간 (초)              417.3           328.0
  총 전송량 (MB)                  1324            1024
────────────────────────────────────────────────────────────

  [도입 효과]
  · 복구 시간 절감    : 89.3 초  (27.9% 단축)
  · 불필요 재전송 제거: 300 MB 절약
  · 전송량 감소율     : 22.7%
```

결과는 `summary-comparison.json` 에도 저장된다.

---

### 4. Node.js 동시 업로드 부하 테스트 (`load-test.js`)

여러 파일을 동시에 업로드하여 시스템 성능을 테스트합니다.

```bash
# 기본 사용법
./load-test.js <동시요청수>

# 예시
./load-test.js 10   # 10개의 파일을 동시 업로드
./load-test.js 50   # 50개의 파일을 동시 업로드
./load-test.js 100  # 100개의 파일을 동시 업로드
```

**특징:**
- 다양한 크기의 테스트 파일 자동 생성 (1KB, 10KB, 100KB, 1MB, 10MB)
- 각 업로드마다 고유한 객체 키 자동 생성
- 실시간 진행률 표시
- 상세한 통계 리포트 제공
  - 성공/실패 비율
  - 응답 시간 통계 (평균, 최소, 최대)
  - 파일 크기별 통계
  - 처리량 (요청/초)

**출력 예시:**
```
📁 테스트 파일 준비 중...

✅ 테스트 파일 생성: test-1kb.bin (1 KB)
✅ 테스트 파일 생성: test-10kb.bin (10 KB)
✅ 테스트 파일 생성: test-100kb.bin (100 KB)
✅ 테스트 파일 생성: test-1mb.bin (1 MB)
✅ 테스트 파일 생성: test-10mb.bin (10 MB)

📤 10개의 동시 업로드 시작...

진행 중... 10/10 (100%)

============================================================
📊 부하 테스트 결과
============================================================

총 요청 수: 10개
성공: 10개 (100.0%)
실패: 0개 (0.0%)

⏱️  응답 시간 통계:
   평균: 245ms
   최소: 123ms
   최대: 456ms

📦 파일 크기별 통계:
   1KB: 2개 업로드, 평균 145ms
   10KB: 3개 업로드, 평균 198ms
   100KB: 2개 업로드, 평균 287ms
   1MB: 2개 업로드, 평균 356ms
   10MB: 1개 업로드, 평균 456ms

🕐 전체 소요 시간: 1.23초
📈 처리량: 8.13 요청/초

============================================================
```

## 요구사항

- Node.js 18 이상
- Control Plane이 `http://localhost:8080`에서 실행 중
- Storage Node가 `http://localhost:3000`에서 실행 중

## 테스트 전 확인사항

1. **서비스 실행 확인**
   ```bash
   # Control Plane 실행
   cd control-plane
   ./gradlew bootRun
   
   # Storage Node 실행
   cd storage-node
   npm run dev
   ```

2. **버킷 생성**
   - Control Plane API 또는 데이터베이스를 통해 테스트용 버킷(예: `bucket1`) 생성

3. **환경 변수 설정**
   - Storage Node의 `PRESIGNED_URL_SECRET_KEY` 설정 확인

## 주의사항

- 부하 테스트 파일은 `test-files/` 디렉토리에 자동 생성되며 재사용됩니다
- 업로드된 테스트 파일은 `bucket1/load-test/` 경로에 저장됩니다
- 너무 많은 동시 요청은 시스템 리소스를 많이 사용할 수 있으니 주의하세요
- 테스트 후 불필요한 파일은 정리하는 것을 권장합니다
