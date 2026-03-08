import http from 'k6/http';
import { check } from 'k6';
import { textSummary } from 'https://jslib.k6.io/k6-summary/0.0.1/index.js';

/**
 * k6 동시 업로드 테스트 — 인원수 설정 가능
 *
 * 사용법:
 *   k6 run --env VUS=3 k6-concurrent-upload-test2.js   # 3명 동시
 *   k6 run --env VUS=5 k6-concurrent-upload-test2.js   # 5명 동시
 *   k6 run --env VUS=10 k6-concurrent-upload-test2.js  # 10명 동시
 *
 * 옵션:
 *   --env VUS: 동시 업로드 인원수 (기본값: 3)
 *   --env BUCKET: 사용할 버킷 이름 (기본값: bucket1)
 *   --env CONTROL_PLANE_URL: Control Plane URL (기본값: http://localhost:8080)
 *   --env STORAGE_NODE_URL: Storage Node URL (기본값: http://localhost:3000)
 */

// ── 환경 설정 ──────────────────────────────────────────────────────────────────
const CONTROL_PLANE_URL = __ENV.CONTROL_PLANE_URL || 'http://localhost:8080';
const STORAGE_NODE_URL  = __ENV.STORAGE_NODE_URL  || 'http://localhost:3000';
const BUCKET            = __ENV.BUCKET            || 'bucket1';
const VUS               = parseInt(__ENV.VUS      || '3');

// ── 파일 로딩 (init context) ───────────────────────────────────────────────────
const FILE_100MB = open('./test-files/100MB.bin', 'b');

// ── k6 옵션: VUS명이 동시에 동일한 startTime으로 시작 ────────────────────────
export const options = {
  scenarios: {
    concurrent_upload: {
      executor: 'per-vu-iterations',
      vus: VUS,
      iterations: 1, // VU당 1회 업로드
      startTime: '0ms',
    },
  },

  thresholds: {
    http_req_failed:                             ['rate<0.05'],
    'http_req_duration{name:get_presigned_url}': ['p(95)<1000'],
    'http_req_duration{name:upload_file}':       ['p(95)<60000'],
  },

  summaryTrendStats: ['avg', 'min', 'med', 'max', 'p(90)', 'p(95)', 'p(99)'],
};

// ── setup: VUS개의 presigned URL 일괄 발급 ───────────────────────────────────
export function setup() {
  console.log('═══════════════════════════════════════════════════════');
  console.log('  k6 동시 업로드 테스트');
  console.log('═══════════════════════════════════════════════════════');
  console.log(`  Control Plane : ${CONTROL_PLANE_URL}`);
  console.log(`  Storage Node  : ${STORAGE_NODE_URL}`);
  console.log(`  Bucket        : ${BUCKET}`);
  console.log(`  동시 인원수   : ${VUS}명`);
  console.log(`  파일 크기     : 100MB`);
  console.log('═══════════════════════════════════════════════════════\n');

  const timestamp = Date.now();
  const urlList = [];

  console.log(`[setup] presigned URL ${VUS}개 발급 시작`);
  for (let i = 0; i < VUS; i++) {
    const label = i + 1;
    const objectKey = `concurrent-test/${timestamp}/user${label}-100MB.bin`;
    const response = http.post(
      `${CONTROL_PLANE_URL}/api/storage/presigned-url`,
      JSON.stringify({ bucket: BUCKET, objectKey }),
      {
        headers: { 'Content-Type': 'application/json' },
        tags: { name: 'get_presigned_url' },
      }
    );

    check(response, {
      [`[user${label}] presigned URL 발급 성공`]: (r) => r.status === 200,
    });

    if (response.status !== 200) {
      console.error(`[user${label}] presigned URL 발급 실패: ${response.status}`);
      urlList.push(null);
      continue;
    }

    const { presignedUrl } = JSON.parse(response.body);
    const url = presignedUrl.replace(/^https?:\/\/[^/]+/, STORAGE_NODE_URL);
    urlList.push({ url, objectKey, label });
    console.log(`  [user${label}] 발급 완료 → ${objectKey}`);
  }

  console.log(`[setup] presigned URL ${VUS}개 발급 완료\n`);
  return urlList;
}

// ── 메인 시나리오: VU별로 동시에 100MB 업로드 ─────────────────────────────────
export default function (data) {
  const vuIndex = __VU - 1; // __VU는 1부터 시작
  const upload = data[vuIndex];

  if (!upload) {
    console.error(`[VU ${__VU}] setup에서 URL을 받지 못함`);
    return;
  }

  console.log(`[user${upload.label}] 업로드 전송 시작 (100MB)`);

  const response = http.put(
    upload.url,
    { file: http.file(FILE_100MB, `user${upload.label}-100MB.bin`, 'application/octet-stream') },
    {
      timeout: '300s',
      tags: { name: 'upload_file', user: `user${upload.label}` },
    }
  );

  const success = check(response, {
    [`[user${upload.label}] 업로드 성공 (200/201)`]: (r) => r.status === 200 || r.status === 201,
  });

  if (success) {
    console.log(`[user${upload.label}] ✅ 업로드 성공`);
  } else {
    console.error(`[user${upload.label}] ❌ 업로드 실패: ${response.status} - ${response.body}`);
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
  const totalMs   = data.state.testRunDurationMs;
  const totalSec  = (totalMs / 1000).toFixed(2);
  const minutes   = Math.floor(totalMs / 60000);
  const seconds   = ((totalMs % 60000) / 1000).toFixed(2);
  const formatted = minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;

  console.log('\n═══════════════════════════════════════════════════════');
  console.log(`  총 작업 소요 시간 : ${formatted} (${totalSec}s)`);
  console.log('═══════════════════════════════════════════════════════\n');

  return {
    stdout: textSummary(data, { indent: ' ', enableColors: true }),
    'summary-concurrent2.json': JSON.stringify(data, null, 2),
  };
}

