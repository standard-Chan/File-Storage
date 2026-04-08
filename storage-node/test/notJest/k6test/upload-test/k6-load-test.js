import http from 'k6/http';
import { check, sleep } from 'k6';
import { SharedArray } from 'k6/data';
import { Trend } from 'k6/metrics';
import { randomItem } from 'https://jslib.k6.io/k6-utils/1.2.0/index.js';
import { textSummary } from 'https://jslib.k6.io/k6-summary/0.0.1/index.js';

/**
 * k6 부하 테스트 스크립트
 * 
 * 사용법:
 *  --vus = 인원수
 *  --duration 지속 시간
 *  --out experimental-prometheus-rw=http://localhost:9090/api/v1/write : 프로메테우스로 전달 
 *   k6 run --vus 35 --duration 3m k6-load-test.js
 * k6 run --vus 1 --duration 10s k6-load-test.js
 *   k6 run --vus 100 --duration 1m --out experimental-prometheus-rw=http://localhost:9090/api/v1/write k6-load-test.js
 *   k6 run --vus 100 --duration 2m --env BUCKET=my-bucket k6-load-test.js
 * k6 run --vus 1000 --duration 10s --out experimental-prometheus-rw=http://localhost:9090/api/v1/write k6-load-test.js
 * 
 * 옵션:
 *   --vus: 동시 가상 사용자 수 (기본값: 10)
 *   --duration: 테스트 지속 시간 (기본값: 30s)
 *   --env BUCKET: 사용할 버킷 이름 (기본값: bucket1)
 *   --env CONTROL_PLANE_URL: Control Plane URL (기본값: http://localhost:8080)
 */

// 환경 설정
const CONTROL_PLANE_URL = __ENV.CONTROL_PLANE_URL || 'http://localhost:8080';
const BUCKET = __ENV.BUCKET || 'bucket1';

// 파일 크기 정의 및 파일 로드 (바이트)
// init context에서 로드되어 모든 VU가 공유 (메모리 효율적)
const FILE_SIZES = [
  { label: '1MB', size: 1 * 1024 * 1024, data: open('./test-files/1MB.bin', 'b') },
  { label: '5MB', size: 5 * 1024 * 1024, data: open('./test-files/5MB.bin', 'b') },
  { label: '10MB', size: 10 * 1024 * 1024, data: open('./test-files/10MB.bin', 'b') },
  { label: '50MB', size: 50 * 1024 * 1024, data: open('./test-files/50MB.bin', 'b') },
  { label: '100MB', size: 100 * 1024 * 1024, data: open('./test-files/100MB.bin', 'b') },
  { label: '500MB', size: 500 * 1024 * 1024, data: open('./test-files/500MB.bin', 'b') },
  { label: '1GB', size: 1 * 1024 * 1024 * 1024, data: open('./test-files/1GB.bin', 'b') },
];

const uploadFileDuration = new Trend('upload_file_duration', true);

const perSizeDurationThresholds = FILE_SIZES.reduce((acc, file) => {
  acc[`upload_file_duration{file_size:${file.label}}`] = ['p(95)<60000'];
  return acc;
}, {});

// k6 테스트 옵션
export const options = {
  // 동시 사용자 수 (CLI에서 --vus로 오버라이드 가능)
  vus: 100,

  // 테스트 지속 시간 (CLI에서 --duration으로 오버라이드 가능)
  duration: '1m',

  // 스테이지를 사용한 단계적 부하 증가 (옵션)
  // 주석을 해제하여 사용
  // stages: [
  //   { duration: '30s', target: 10 },  // 30초 동안 10 VUs로 증가
  //   { duration: '1m', target: 50 },   // 1분 동안 50 VUs로 증가
  //   { duration: '1m', target: 100 },  // 1분 동안 100 VUs로 증가
  //   { duration: '30s', target: 0 },   // 30초 동안 0으로 감소
  // ],

  // 임계값 (성공 기준)
  thresholds: {
    'http_req_duration{name:upload_file}': ['p(90)<30000', 'p(95)<30000', 'p(99)<60000'],
    ...perSizeDurationThresholds,
  },

  // 요약 통계 설정
  summaryTrendStats: ['avg', 'min', 'med', 'max', 'p(90)', 'p(95)', 'p(99)'],
};

/**
 * Presigned URL 발급
 */
function getPresignedUrl(bucket, objectKey, fileSize) {
  const payload = JSON.stringify({
    bucket: bucket,
    objectKey: objectKey,
    fileSize: fileSize,
  });

  const response = http.post(
    `${CONTROL_PLANE_URL}/api/storage/presigned-url`,
    payload,
    {
      headers: {
        'Content-Type': 'application/json',
      },
      tags: { name: 'get_presigned_url' },
    }
  );

  check(response, {
    'Presigned URL 발급 성공': (r) => r.status === 200,
    'Presigned URL 응답에 presignedUrl 포함': (r) => {
      try {
        const body = JSON.parse(r.body);
        return body.presignedUrl !== undefined;
      } catch {
        return false;
      }
    },
  });

  if (response.status !== 200) {
    console.error(`Presigned URL 발급 실패: ${response.status} - ${response.body}`);
    return null;
  }

  const data = JSON.parse(response.body);
  return data.presignedUrl;
}

/**
 * 파일 업로드
 */
function uploadFile(presignedUrl, fileData, _fileName, fileSize) {
  const sizeLabel = fileSizeLabel(fileSize);
  const response = http.put(
    presignedUrl,
    fileData,
    {
      headers: {
        'Content-Type': 'application/octet-stream',
      },
      tags: {
        name: 'upload_file',
        file_size: sizeLabel,
      },
      timeout: '300s', // 큰 파일 업로드를 위한 타임아웃
    }
  );

  const uploadSuccess = check(response, {
    '파일 업로드 성공': (r) => r.status === 200 || r.status === 201,
  });

  // 성공한 요청만 메트릭에 기록
  if (uploadSuccess) {
    uploadFileDuration.add(response.timings.duration, { file_size: sizeLabel });
  }

  if (!uploadSuccess) {
    console.error(`파일 업로드 실패: ${response.status} - ${response.body}`);
  }

  return uploadSuccess;
}

/**
 * 파일 크기 레이블 반환
 */
function fileSizeLabel(size) {
  const fileSize = FILE_SIZES.find(f => f.size === size);
  return fileSize ? fileSize.label : `${size}B`;
}

/**
 * 메인 테스트 시나리오
 */
export default function () {
  // 랜덤으로 파일 크기 선택
  const selectedFile = randomItem(FILE_SIZES);

  // 고유한 objectKey 생성
  const timestamp = Date.now();
  const random = Math.random().toString(36).substring(7);
  const vuId = __VU; // Virtual User ID
  const iterationId = __ITER; // Iteration ID
  const objectKey = `k6-load-test/vu${vuId}/${timestamp}-iter${iterationId}-${random}.bin`;

  console.log(`[VU ${vuId}] 업로드 시작: ${selectedFile.label}, key=${objectKey}`);

  // 1. Presigned URL 발급
  const presignedUrl = getPresignedUrl(BUCKET, objectKey, selectedFile.size);

  if (!presignedUrl) {
    console.error(`[VU ${vuId}] Presigned URL 발급 실패, 업로드 중단`);
    sleep(1);
    return;
  }

  // 2. 미리 로드된 파일 데이터 사용
  const fileData = selectedFile.data;
  const fileName = `test-${selectedFile.label.toLowerCase()}-${random}.bin`;

  // 3. 파일 업로드
  const uploadSuccess = uploadFile(presignedUrl, fileData, fileName, selectedFile.size);

  if (uploadSuccess) {
    console.log(`[VU ${vuId}] ✅ 업로드 성공: ${selectedFile.label}`);
  } else {
    console.log(`[VU ${vuId}] ❌ 업로드 실패: ${selectedFile.label}`);
  }

  // 다음 반복 전 잠시 대기 (선택사항)
  sleep(Math.random() * 2 + 1); // 1~3초 랜덤 대기
}

/**
 * 테스트 시작 시 실행
 */
export function setup() {
  console.log('========================================');
  console.log('🚀 k6 부하 테스트 시작');
  console.log('========================================');
  console.log(`Control Plane URL: ${CONTROL_PLANE_URL}`);
  console.log(`Target Bucket: ${BUCKET}`);
  console.log(`Virtual Users: ${options.vus}`);
  console.log(`Duration: ${options.duration}`);
  console.log('Test Files:');
  FILE_SIZES.forEach(f => console.log(`  - ${f.label}: ${f.size} bytes`));
  console.log('========================================\n');
}

/**
 * 테스트 종료 시 실행
 */
export function teardown(data) {
  console.log('\n========================================');
  console.log('✅ k6 부하 테스트 완료');
  console.log('========================================');
}

export function handleSummary(data) {
  const perFileSummaryLines = ['\n===== 파일 크기별 upload_file_duration ====='];

  FILE_SIZES.forEach((file) => {
    const metric = data.metrics[`upload_file_duration{file_size:${file.label}}`];
    const p95 = metric?.values?.['p(95)'];
    const avg = metric?.values?.avg;
    const count = metric?.values?.count;

    if (p95 === undefined) {
      perFileSummaryLines.push(`- ${file.label}: 데이터 없음`);
      return;
    }

    perFileSummaryLines.push(
      `- ${file.label}: p(95)=${p95.toFixed(2)}ms, avg=${avg.toFixed(2)}ms, count=${Math.round(count)}`
    );
  });

  return {
    'stdout': `${textSummary(data, { indent: ' ', enableColors: true })}${perFileSummaryLines.join('\n')}\n`,
    'summary.json': JSON.stringify(data, null, 2),
  };
}