import http from 'k6/http';
import { sleep, check } from 'k6';
import { randomItem } from 'https://jslib.k6.io/k6-utils/1.2.0/index.js';

// =========================
// 환경 설정
// =========================
const CONTROL_PLANE_URL = __ENV.CONTROL_PLANE_URL || 'http://localhost:8080';
const BUCKET = __ENV.BUCKET || 'bucket1';

// =========================
// 파일 (small만)
// ⚠️ large 절대 포함 금지
// =========================
const FILES = [
  // { label: '1MB', size: 1 * 1024 * 1024, data: open('./test-files/1MB.bin', 'b') },
  { label: '5MB', size: 5 * 1024 * 1024, data: open('./test-files/5MB.bin', 'b') },
  // { label: '10MB', size: 10 * 1024 * 1024, data: open('./test-files/10MB.bin', 'b') },
];

// =========================
// 옵션
// =========================
export const options = {
  vus: 20,
  duration: '5m',
  discardResponseBodies: false,
};

// =========================
// Presigned URL 발급
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
      tags: { name: 'get_presigned_url' },
    }
  );
  const ok = check(res, {
    'presigned status 200': (r) => r.status === 200,
  });

  if (!ok) {
    console.error(`❌ presigned 실패: ${res.status} - ${res.body}`);
    return null;
  }

  try {
    const data = JSON.parse(res.body);
    console.log('✅ presigned 응답:', data);
    return data.presignedUrl;
  } catch (e) {
    console.error(`❌ presigned parsing 실패: ${res.body}`);
    console.error(`에러: ${e.message}`);
    return null;
  }
}

// =========================
// 업로드
// =========================
function uploadFile(url, file) {
  const res = http.put(url, file.data, {
    headers: {
      'Content-Type': 'application/octet-stream',
    },
    timeout: '120s',
    tags: {
      name: 'upload_small_file',
      file_size: file.label,
    },
  });

  check(res, {
    'upload success': (r) => r.status === 200 || r.status === 201,
  });
}

// =========================
// 메인 시나리오
// =========================
export default function () {
  const file = randomItem(FILES);

  const key = `bg/${__VU}/${Date.now()}-${__ITER}.bin`;

  // 1. presigned
  const url = getPresignedUrl(key, file.size);
  if (!url) {
    sleep(1);
    return;
  }

  // 2. upload
  uploadFile(url, file);

  // 3. pacing
  sleep(Math.random() * 2 + 1.5);
}