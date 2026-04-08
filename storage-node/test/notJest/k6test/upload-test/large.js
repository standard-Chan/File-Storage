import http from 'k6/http';
import { check } from 'k6';

// =========================
// 환경 설정
// =========================
const CONTROL_PLANE_URL = __ENV.CONTROL_PLANE_URL || 'http://localhost:8080';
const BUCKET = __ENV.BUCKET || 'bucket1';

// ✅ large 파일만 로드 (500MB)
// 👉 이 파일은 이 프로세스에서 딱 1번만 메모리에 올라감
const LARGE_FILE = open('./test-files/500MB.bin', 'b');

// =========================
// 옵션
// =========================
export const options = {
  vus: 1,
  iterations: 1,
  discardResponseBodies: false,
};

// =========================
// Presigned URL
// =========================
function getPresignedUrl(objectKey, fileSize) {
  const res = http.post(
    `${CONTROL_PLANE_URL}/api/storage/presigned-url`,
    JSON.stringify({
      bucket: BUCKET,
      objectKey,
      fileSize,
    }),
    {
      headers: { 'Content-Type': 'application/json' },
      timeout: '30s',
    }
  );

  check(res, {
    'presigned url ok': (r) => r.status === 200,
  });

  if (res.status !== 200) {
    console.error(`presigned 실패: ${res.status}`);
    return null;
  }

  return JSON.parse(res.body).presignedUrl;
}

// =========================
// 메인 로직
// =========================
export default function () {
  const key = `large/${Date.now()}.bin`;

  console.log('🚀 LARGE FILE UPLOAD START');

  const url = getPresignedUrl(key, LARGE_FILE.byteLength);
  if (!url) return;

  const start = Date.now();

  const res = http.put(url, LARGE_FILE, {
    headers: {
      'Content-Type': 'application/octet-stream',
    },
    timeout: '300s',
  });

  const duration = Date.now() - start;

  check(res, {
    'upload success': (r) => r.status === 200 || r.status === 201,
  });

  console.log(`✅ upload 완료: ${duration} ms (${(duration / 1000).toFixed(2)}s)`);
}