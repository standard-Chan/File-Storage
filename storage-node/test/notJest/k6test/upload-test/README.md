# 업로드 테스트 스크립트

이 디렉토리에는 Object Storage의 파일 업로드 기능을 테스트하는 스크립트들이 있습니다.

## 파일 구조

- `upload.js`: 단일 파일 업로드 테스트
- `load-test.js`: 동시 업로드 부하 테스트 (Node.js)
- `k6-load-test.js`: k6 부하 테스트 스크립트 ⭐ **추천**
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

#### VUs 매트릭스 자동 실행 (10,15,20,25,30,35,40)

여러 VUs 케이스를 한 번에 실행하고 결과를 자동 집계합니다.

```bash
# 기본 실행 (VUs: 10,15,20,25,30,35,40 / duration: 1m)
node run-k6-matrix.mjs

# duration 변경
node run-k6-matrix.mjs --duration 3m

# VUs 목록 커스텀
node run-k6-matrix.mjs --vus 10,20,30,40

# 버킷/Control Plane URL 지정
node run-k6-matrix.mjs --bucket bucket1 --control-plane-url http://localhost:8080
```

실행 결과는 `results/vus-matrix-YYYYMMDD-HHMMSS/`에 저장됩니다.

- `summary-vus-XX.json`: 각 VUs 실행별 원본 summary
- `aggregate.json`: 전체 집계 데이터(JSON)
- `aggregate.csv`: 엑셀/시트 확인용 CSV
- `aggregate.md`: 사람이 읽기 쉬운 요약 표

**특징:**
- 1KB, 10KB, 100KB, 1MB, 10MB 파일 크기 랜덤 선택
- Presigned URL 발급부터 파일 업로드까지 전체 시나리오 테스트
- 실시간 메트릭 및 임계값(Threshold) 검증
- 동시 사용자 수(VUs) 유연한 조절
- 단계적 부하 증가 지원 (Ramping)
- 상세한 통계 및 보고서

📘 **상세한 사용법은 [K6_LOAD_TEST.md](./K6_LOAD_TEST.md)를 참고하세요.**

### 3. Node.js 동시 업로드 부하 테스트 (`load-test.js`)

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
