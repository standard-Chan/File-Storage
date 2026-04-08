import http from 'k6/http';
import { check } from 'k6';
import encoding from 'k6/encoding';
import { textSummary } from 'https://jslib.k6.io/k6-summary/0.0.1/index.js';

/**
 * k6 TUS 업로드 중단 & 재개 테스트 (1GB)
 *
 * 시나리오:
 *   [setup 단계 — 연결 해제 시뮬레이션]
 *     1. POST /tus-upload   → 세션 생성
 *     2. PATCH × N          → 처음 INTERRUPT_MB 만큼만 전송
 *     3. 전송 중단          → fileId 를 data 로 반환 (연결 해제 시뮬레이션)
 *
 *   [default 단계 — 재개]
 *     4. HEAD /tus-upload/:id → 서버에서 현재 Upload-Offset 조회
 *     5. 오프셋 검증         → 기대값(INTERRUPT_MB) 과 일치하는지 확인
 *     6. PATCH 재개          → 나머지 청크 전송
 *     7. 완료 확인
 *
 * 사용법:
 *   k6 run k6-tus-resume-upload.js
 *   k6 run --env STORAGE_NODE_URL=http://localhost:3000 k6-tus-resume-upload.js
 *   k6 run --env INTERRUPT_MB=300 --env CHUNK_MB=100 k6-tus-resume-upload.js
 *
 * 옵션:
 *   --env STORAGE_NODE_URL : Storage Node URL           (기본값: http://localhost:3000)
 *   --env CHUNK_MB         : 청크 크기(MB)              (기본값: 100)
 *   --env INTERRUPT_MB     : 중단 지점(MB, 청크 단위)   (기본값: 300)
 */

// ── 환경 설정 ──────────────────────────────────────────────────────────────────
const STORAGE_NODE_URL = __ENV.STORAGE_NODE_URL || 'http://localhost:3000';
const CHUNK_MB         = parseInt(__ENV.CHUNK_MB      || '100', 10);
const INTERRUPT_MB     = parseInt(__ENV.INTERRUPT_MB  || '300', 10);
const CHUNK_SIZE       = CHUNK_MB    * 1024 * 1024;
const INTERRUPT_SIZE   = INTERRUPT_MB * 1024 * 1024;
const FILE_NAME        = '1GB.bin';

// ── 파일 로딩 (init context) ───────────────────────────────────────────────────
const FILE_1GB = open('./test-files/1GB.bin', 'b');

// ── k6 옵션 ───────────────────────────────────────────────────────────────────
export const options = {
  scenarios: {
    tus_resume_upload: {
      executor: 'per-vu-iterations',
      vus: 1,
      iterations: 1,
    },
  },

  thresholds: {
    http_req_failed: ['rate<0.01'],
    'http_req_duration{name:tus_create_session}': ['p(95)<3000'],
    'http_req_duration{name:tus_head_offset}':    ['p(95)<3000'],
    'http_req_duration{name:tus_upload_chunk}':   ['p(95)<120000'],
  },

  summaryTrendStats: ['avg', 'min', 'med', 'max', 'p(90)', 'p(95)', 'p(99)'],
};

// ── 내부 유틸: 청크 업로드 함수 ───────────────────────────────────────────────
/**
 * @param {string} uploadUrl   - PATCH 대상 URL
 * @param {number} startOffset - 시작 오프셋 (바이트)
 * @param {number} endOffset   - 종료 오프셋 (바이트, exclusive)
 * @param {string} label       - 로그 레이블 ('사전' | '재개')
 * @returns {number} 마지막으로 전송된 오프셋 (바이트). 실패 시 -1
 */
function uploadChunks(uploadUrl, startOffset, endOffset, label) {
  const fileSize    = FILE_1GB.byteLength;
  const totalChunks = Math.ceil(fileSize / CHUNK_SIZE);
  let offset        = startOffset;
  let chunkIdx      = Math.floor(startOffset / CHUNK_SIZE) + 1;

  while (offset < endOffset) {
    const end      = Math.min(offset + CHUNK_SIZE, endOffset);
    const chunk    = FILE_1GB.slice(offset, end);
    const chunkLen = end - offset;

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

    const ok = check(patchRes, {
      [`[${label}] 청크 ${chunkIdx}/${totalChunks} 204`]: (r) => r.status === 204,
    });

    if (!ok) {
      console.error(
        `[${label}] 청크 ${chunkIdx} 실패 — status=${patchRes.status} offset=${offset} body=${patchRes.body}`,
      );
      return -1;
    }

    offset = end;
    chunkIdx++;
    const progress = ((offset / fileSize) * 100).toFixed(1);
    console.log(
      `  [${label}] 청크 ${chunkIdx - 1}/${totalChunks} ✅ ` +
      `${(offset / 1024 / 1024).toFixed(0)} MB / ${(fileSize / 1024 / 1024).toFixed(0)} MB (${progress}%)`,
    );
  }

  return offset;
}

// ── setup: 세션 생성 + 부분 업로드 후 의도적 중단 ────────────────────────────
export function setup() {
  const fileSize = FILE_1GB.byteLength;

  console.log('═══════════════════════════════════════════════════════');
  console.log('  [setup] TUS 업로드 중단 시뮬레이션');
  console.log('═══════════════════════════════════════════════════════');
  console.log(`  Storage Node  : ${STORAGE_NODE_URL}`);
  console.log(`  파일 크기     : ${(fileSize / 1024 / 1024 / 1024).toFixed(2)} GB`);
  console.log(`  청크 크기     : ${CHUNK_MB} MB`);
  console.log(`  중단 지점     : ${INTERRUPT_MB} MB`);
  console.log('═══════════════════════════════════════════════════════\n');

  // 중단 지점이 파일 크기를 초과하지 않도록 조정 (청크 경계에 맞춤)
  const actualInterrupt = Math.min(
    Math.floor(INTERRUPT_SIZE / CHUNK_SIZE) * CHUNK_SIZE,
    fileSize,
  );

  // 1. 세션 생성
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
    '[setup] 세션 생성 201':    (r) => r.status === 201,
    '[setup] Location 헤더 존재': (r) => !!r.headers['Location'],
  });

  if (!sessionOk) {
    console.error(`[setup] 세션 생성 실패: status=${createRes.status} body=${createRes.body}`);
    return null;
  }

  const location  = createRes.headers['Location'];
  const fileId    = location.split('/').pop();
  const uploadUrl = `${STORAGE_NODE_URL}/tus-upload/${fileId}`;

  console.log(`[setup] 세션 생성 완료 — fileId=${fileId}`);
  console.log(`[setup] ${INTERRUPT_MB} MB 까지 전송 후 의도적 중단\n`);

  // 2. 부분 업로드 (0 → actualInterrupt 까지)
  const reachedOffset = uploadChunks(uploadUrl, 0, actualInterrupt, '사전');

  if (reachedOffset === -1) {
    console.error('[setup] 부분 업로드 중 오류 발생');
    return null;
  }

  console.log(
    `\n[setup] ✋ 연결 해제 시뮬레이션 — ` +
    `${(reachedOffset / 1024 / 1024).toFixed(0)} MB 전송 후 중단`,
  );
  console.log('[setup] fileId 반환 → default 단계에서 재개\n');

  return { fileId, uploadUrl, interruptOffset: reachedOffset, fileSize };
}

// ── 메인 시나리오: 업로드 재개 ────────────────────────────────────────────────
export default function (data) {
  if (!data) {
    console.error('[default] setup 실패로 테스트 중단');
    return;
  }

  const { fileId, uploadUrl, interruptOffset, fileSize } = data;

  console.log('═══════════════════════════════════════════════════════');
  console.log('  [default] TUS 업로드 재개');
  console.log('═══════════════════════════════════════════════════════');
  console.log(`  fileId          : ${fileId}`);
  console.log(`  기대 오프셋     : ${(interruptOffset / 1024 / 1024).toFixed(0)} MB`);
  console.log('═══════════════════════════════════════════════════════\n');

  // 3. HEAD: 서버에 저장된 오프셋 조회
  const headRes = http.request(
    'HEAD',
    uploadUrl,
    null,
    {
      headers: { 'Tus-Resumable': '1.0.0' },
      tags: { name: 'tus_head_offset' },
    },
  );

  const headOk = check(headRes, {
    'HEAD 200': (r) => r.status === 200,
    'Upload-Offset 헤더 존재': (r) => !!r.headers['Upload-Offset'],
  });

  if (!headOk) {
    console.error(`[HEAD 실패] status=${headRes.status} body=${headRes.body}`);
    return;
  }

  const serverOffset = parseInt(headRes.headers['Upload-Offset'], 10);
  console.log(`[HEAD] 서버 오프셋 = ${(serverOffset / 1024 / 1024).toFixed(0)} MB`);

  // 4. 오프셋 일치 검증
  check({ serverOffset, interruptOffset }, {
    '서버 오프셋 == 중단 지점': ({ serverOffset, interruptOffset }) =>
      serverOffset === interruptOffset,
  });

  if (serverOffset !== interruptOffset) {
    console.warn(
      `[경고] 오프셋 불일치: 서버=${serverOffset} 기대=${interruptOffset} — 서버 오프셋 기준으로 재개`,
    );
  }

  // 5. 나머지 업로드 (serverOffset → fileSize)
  console.log(
    `[재개] ${(serverOffset / 1024 / 1024).toFixed(0)} MB → ${(fileSize / 1024 / 1024 / 1024).toFixed(2)} GB 전송 시작\n`,
  );

  const finalOffset = uploadChunks(uploadUrl, serverOffset, fileSize, '재개');

  if (finalOffset === -1) return;

  // 6. 완료 확인
  check({ finalOffset, fileSize }, {
    '전체 파일 전송 완료': ({ finalOffset, fileSize }) => finalOffset === fileSize,
  });

  console.log(`\n✅ 재개 업로드 완료: fileId=${fileId}, 총 ${(fileSize / 1024 / 1024 / 1024).toFixed(2)} GB`);
}

// ── handleSummary ─────────────────────────────────────────────────────────────
export function handleSummary(data) {
  return {
    stdout: textSummary(data, { indent: ' ', enableColors: true }),
    'summary-tus-resume.json': JSON.stringify(data, null, 2),
  };
}
