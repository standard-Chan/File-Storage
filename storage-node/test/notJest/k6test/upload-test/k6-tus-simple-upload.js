import http from 'k6/http';
import { check } from 'k6';
import encoding from 'k6/encoding';
import { textSummary } from 'https://jslib.k6.io/k6-summary/0.0.1/index.js';

/**
 * k6 TUS 단순 업로드 테스트 (1GB)
 *
 * 시나리오:
 *   1. POST /tus-upload → 업로드 세션 생성, Location 헤더로 파일 URL 수신
 *   2. PATCH 반복       → 100MB 청크 단위로 파일 전송 (총 10 청크)
 *   3. 전송 완료 확인   → 마지막 PATCH 응답의 Upload-Offset == fileSize
 *
 * 사용법:
 *   k6 run k6-tus-simple-upload.js
 *   k6 run --env STORAGE_NODE_URL=http://localhost:3000 k6-tus-simple-upload.js
 *
 * 옵션:
 *   --env STORAGE_NODE_URL: Storage Node URL (기본값: http://localhost:3000)
 *   --env CHUNK_MB:         청크 크기(MB) (기본값: 100)
 */

// ── 환경 설정 ──────────────────────────────────────────────────────────────────
const STORAGE_NODE_URL = __ENV.STORAGE_NODE_URL || 'http://localhost:3000';
const CHUNK_MB         = parseInt(__ENV.CHUNK_MB || '100', 10);
const CHUNK_SIZE       = CHUNK_MB * 1024 * 1024;
const FILE_NAME        = '1GB.bin';

// ── 파일 로딩 (init context: VU 초기화 시 메모리에 적재) ──────────────────────
const FILE_1GB = open('./test-files/1GB.bin', 'b');

// ── k6 옵션 ───────────────────────────────────────────────────────────────────
export const options = {
  scenarios: {
    tus_simple_upload: {
      executor: 'per-vu-iterations',
      vus: 1,
      iterations: 1,
    },
  },

  thresholds: {
    http_req_failed: ['rate<0.01'],
    'http_req_duration{name:tus_create_session}': ['p(95)<3000'],
    'http_req_duration{name:tus_upload_chunk}':   ['p(95)<120000'],
  },

  summaryTrendStats: ['avg', 'min', 'med', 'max', 'p(90)', 'p(95)', 'p(99)'],
};

// ── 메인 시나리오 ─────────────────────────────────────────────────────────────
export default function () {
  const fileSize = FILE_1GB.byteLength;
  const totalChunks = Math.ceil(fileSize / CHUNK_SIZE);

  console.log('═══════════════════════════════════════════════════════');
  console.log('  TUS 단순 업로드 테스트');
  console.log('═══════════════════════════════════════════════════════');
  console.log(`  Storage Node  : ${STORAGE_NODE_URL}`);
  console.log(`  파일 크기     : ${(fileSize / 1024 / 1024 / 1024).toFixed(2)} GB`);
  console.log(`  청크 크기     : ${CHUNK_MB} MB`);
  console.log(`  총 청크 수    : ${totalChunks}`);
  console.log('═══════════════════════════════════════════════════════\n');

  // ── 1단계: 업로드 세션 생성 ────────────────────────────────────────────────
  const b64FileName = encoding.b64encode(FILE_NAME);
  const createRes = http.post(
    `${STORAGE_NODE_URL}/tus-upload`,
    null,
    {
      headers: {
        'Tus-Resumable':   '1.0.0',
        'Upload-Length':   String(fileSize),
        'Upload-Metadata': `filename ${b64FileName}`,
      },
      tags: { name: 'tus_create_session' },
    },
  );

  const sessionOk = check(createRes, {
    '세션 생성 201': (r) => r.status === 201,
    'Location 헤더 존재': (r) => !!r.headers['Location'],
  });

  if (!sessionOk) {
    console.error(`[세션 생성 실패] status=${createRes.status} body=${createRes.body}`);
    return;
  }

  // Location 헤더에서 파일 ID 추출 후 Storage Node URL 로 재조합
  //   (tus-node-server 가 절대 URL 반환 시에도 원하는 노드로 전송하기 위함)
  const location   = createRes.headers['Location'];
  const fileId     = location.split('/').pop();
  const uploadUrl  = `${STORAGE_NODE_URL}/tus-upload/${fileId}`;

  console.log(`[세션 생성 완료] fileId=${fileId}`);
  console.log(`[업로드 URL] ${uploadUrl}\n`);

  // ── 2단계: 청크 업로드 ────────────────────────────────────────────────────
  let offset = 0;

  for (let i = 0; i < totalChunks; i++) {
    const end       = Math.min(offset + CHUNK_SIZE, fileSize);
    const chunk     = FILE_1GB.slice(offset, end);
    const chunkLen  = end - offset;

    const patchRes = http.patch(
      uploadUrl,
      chunk,
      {
        headers: {
          'Tus-Resumable':  '1.0.0',
          'Content-Type':   'application/offset+octet-stream',
          'Upload-Offset':  String(offset),
          'Content-Length': String(chunkLen),
        },
        tags:    { name: 'tus_upload_chunk' },
        timeout: '600s',
      },
    );

    const chunkOk = check(patchRes, {
      [`청크 ${i + 1}/${totalChunks} 204`]: (r) => r.status === 204,
    });

    if (!chunkOk) {
      console.error(
        `[청크 ${i + 1} 실패] status=${patchRes.status} offset=${offset} body=${patchRes.body}`,
      );
      return;
    }

    offset = end;
    const progress = ((offset / fileSize) * 100).toFixed(1);
    console.log(
      `[청크 ${i + 1}/${totalChunks}] ✅ ${(offset / 1024 / 1024).toFixed(0)} MB / ${(fileSize / 1024 / 1024).toFixed(0)} MB (${progress}%)`,
    );
  }

  // ── 완료 확인 ─────────────────────────────────────────────────────────────
  check({ offset, fileSize }, {
    '전체 파일 전송 완료': ({ offset, fileSize }) => offset === fileSize,
  });

  console.log(`\n✅ 업로드 완료: fileId=${fileId}, 총 ${(fileSize / 1024 / 1024 / 1024).toFixed(2)} GB`);
}

// ── handleSummary ─────────────────────────────────────────────────────────────
export function handleSummary(data) {
  return {
    stdout: textSummary(data, { indent: ' ', enableColors: true }),
    'summary-tus-simple.json': JSON.stringify(data, null, 2),
  };
}
