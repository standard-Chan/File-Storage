import http from 'k6/http';
import { check } from 'k6';
import { textSummary } from 'https://jslib.k6.io/k6-summary/0.0.1/index.js';

/**
 * k6 동시 업로드 순서 테스트 스크립트
 *
 * 시나리오:
 *   - presigned URL 을 ABCDEFGHI 순서로 setup() 에서 미리 발급
 *   - 9개의 VU 가 각각 5ms 간격(startTime)으로 시작 → 이전 업로드 완료 전에 다음 요청 전송
 *   - 실제 서버 도착 순서: A(t=0ms) → B(t=5ms) → C(t=10ms) → D(t=15ms) → E(t=20ms) → F(t=25ms) → G(t=30ms) → H(t=35ms) → I(t=40ms)
 *
 * 사용법:
 *   k6 run k6-concurrent-upload-test.js
 *   k6 run --env BUCKET=my-bucket --env CONTROL_PLANE_URL=http://localhost:8080 k6-concurrent-upload-test.js
 *   k6 run --out experimental-prometheus-rw=http://localhost:9090/api/v1/write k6-concurrent-upload-test.js
 *
 * 옵션:
 *   --env BUCKET: 사용할 버킷 이름 (기본값: bucket1)
 *   --env CONTROL_PLANE_URL: Control Plane URL (기본값: http://localhost:8080)
 *   --env STORAGE_NODE_URL: Storage Node URL (기본값: http://localhost:3000)
 */

// ── 환경 설정 ──────────────────────────────────────────────────────────────────
const CONTROL_PLANE_URL = __ENV.CONTROL_PLANE_URL || 'http://localhost:8080';
const STORAGE_NODE_URL  = __ENV.STORAGE_NODE_URL  || 'http://localhost:3000';
const BUCKET            = __ENV.BUCKET            || 'bucket1';

// ── 파일 로딩 (init context: 모든 VU가 공유) ───────────────────────────────────
const FILE_10MB = open('./test-files/10MB.bin', 'b');
const FILE_1MB  = open('./test-files/1MB.bin',  'b');

// ── 업로드 정의 ───────────────────────────────────────────────────────────────
//   A ~ E : 10MB   F ~ I : 1MB
const UPLOAD_PLAN = [
  { label: 'A', sizeMB: 10 },
  { label: 'B', sizeMB: 10 },
  { label: 'C', sizeMB: 10 },
  { label: 'D', sizeMB: 10 },
  { label: 'E', sizeMB: 10 },
  { label: 'F', sizeMB:  1 },
  { label: 'G', sizeMB:  1 },
  { label: 'H', sizeMB:  1 },
  { label: 'I', sizeMB:  1 },
];

// ── k6 옵션: 9개 시나리오, 각각 5ms 간격으로 시작 ─────────────────────────────
export const options = {
  scenarios: {
    upload_A: { executor: 'per-vu-iterations', vus: 1, iterations: 1, startTime: '0ms',  env: { UPLOAD_LABEL: 'A' } },
    upload_B: { executor: 'per-vu-iterations', vus: 1, iterations: 1, startTime: '5ms',  env: { UPLOAD_LABEL: 'B' } },
    upload_C: { executor: 'per-vu-iterations', vus: 1, iterations: 1, startTime: '10ms', env: { UPLOAD_LABEL: 'C' } },
    upload_D: { executor: 'per-vu-iterations', vus: 1, iterations: 1, startTime: '15ms', env: { UPLOAD_LABEL: 'D' } },
    upload_E: { executor: 'per-vu-iterations', vus: 1, iterations: 1, startTime: '20ms', env: { UPLOAD_LABEL: 'E' } },
    upload_F: { executor: 'per-vu-iterations', vus: 1, iterations: 1, startTime: '25ms', env: { UPLOAD_LABEL: 'F' } },
    upload_G: { executor: 'per-vu-iterations', vus: 1, iterations: 1, startTime: '30ms', env: { UPLOAD_LABEL: 'G' } },
    upload_H: { executor: 'per-vu-iterations', vus: 1, iterations: 1, startTime: '35ms', env: { UPLOAD_LABEL: 'H' } },
    upload_I: { executor: 'per-vu-iterations', vus: 1, iterations: 1, startTime: '40ms', env: { UPLOAD_LABEL: 'I' } },
  },

  thresholds: {
    http_req_failed:                             ['rate<0.05'],
    'http_req_duration{name:get_presigned_url}': ['p(95)<1000'],
    'http_req_duration{name:upload_file}':       ['p(95)<30000'],
  },

  summaryTrendStats: ['avg', 'min', 'med', 'max', 'p(90)', 'p(95)', 'p(99)'],
};

// ── setup: 테스트 시작 전 presigned URL 일괄 발급 ────────────────────────────
export function setup() {
  console.log('═══════════════════════════════════════════════════════');
  console.log('  k6 동시 업로드 순서 테스트');
  console.log('═══════════════════════════════════════════════════════');
  console.log(`  Control Plane : ${CONTROL_PLANE_URL}`);
  console.log(`  Storage Node  : ${STORAGE_NODE_URL}`);
  console.log(`  Bucket        : ${BUCKET}`);
  console.log('  전송 간격     : 5ms');
  console.log('  업로드 계획   :');
  UPLOAD_PLAN.forEach(p => console.log(`    [${p.label}] ${p.sizeMB}MB`));
  console.log('═══════════════════════════════════════════════════════\n');

  const timestamp = Date.now();
  const urlMap = {};

  console.log('[setup] Presigned URL 발급 시작 (ABCDEF 순서)');
  for (const plan of UPLOAD_PLAN) {
    const objectKey = `concurrent-test/${timestamp}/${plan.label}-${plan.sizeMB}MB.bin`;
    const response = http.post(
      `${CONTROL_PLANE_URL}/api/storage/presigned-url`,
      JSON.stringify({ bucket: BUCKET, objectKey }),
      { headers: { 'Content-Type': 'application/json' }, tags: { name: 'get_presigned_url', upload_label: plan.label } }
    );

    check(response, {
      [`[${plan.label}] presigned URL 발급 성공`]: (r) => r.status === 200,
    });

    if (response.status !== 200) {
      console.error(`[${plan.label}] presigned URL 발급 실패: ${response.status}`);
      continue;
    }

    const { presignedUrl } = JSON.parse(response.body);
    urlMap[plan.label] = {
      url: presignedUrl.replace(/^https?:\/\/[^/]+/, STORAGE_NODE_URL),
      sizeMB: plan.sizeMB,
      objectKey,
    };
    console.log(`  [${plan.label}] 발급 완료 → ${objectKey}`);
  }

  console.log('[setup] 모든 presigned URL 발급 완료\n');
  return urlMap;
}

// ── 메인 시나리오: 각 VU는 자신의 label 에 해당하는 업로드 1건만 수행 ──────────
export default function (data) {
  const label = __ENV.UPLOAD_LABEL;
  const upload = data[label];

  if (!upload) {
    console.error(`[${label}] setup 에서 URL을 받지 못함`);
    return;
  }

  const fileData = upload.sizeMB === 10 ? FILE_10MB : FILE_1MB;

  console.log(`[${label}] 업로드 전송 시작: ${upload.sizeMB}MB`);

  const response = http.put(
    upload.url,
    { file: http.file(fileData, `test-${label}-${upload.sizeMB}MB.bin`, 'application/octet-stream') },
    {
      timeout: '300s',
      tags: { name: 'upload_file', upload_label: label, size: `${upload.sizeMB}MB` },
    }
  );

  const success = check(response, {
    [`[${label}] 업로드 성공 (200/201)`]: (r) => r.status === 200 || r.status === 201,
  });

  if (success) {
    console.log(`[${label}] ✅ 업로드 성공`);
  } else {
    console.error(`[${label}] ❌ 업로드 실패: ${response.status} - ${response.body}`);
  }
}

// ── teardown ──────────────────────────────────────────────────────────────────
export function teardown() {
  console.log('\n═══════════════════════════════════════════════════════');
  console.log('  테스트 완료');
  console.log('═══════════════════════════════════════════════════════');
}

// ── handleSummary ─────────────────────────────────────────────────────────────
export function handleSummary(data) {
  return {
    stdout: textSummary(data, { indent: ' ', enableColors: true }),
    'summary-concurrent.json': JSON.stringify(data, null, 2),
  };
}

