import http from 'k6/http';
import { check } from 'k6';
import { Trend, Counter } from 'k6/metrics';
import encoding from 'k6/encoding';
import { randomBytes } from 'k6/crypto';
import { textSummary } from 'https://jslib.k6.io/k6-summary/0.0.1/index.js';

/**
 * k6 Resumable Upload 도입 효과 비교 테스트
 *
 * 목적:
 *   업로드 중단 후 '처음부터 재전송(Restart)'과 'TUS 재개(Resume)' 두 방식의
 *   복구 소요 시간을 동일 조건에서 측정해 도입 효과를 수치화한다.
 *
 * 시나리오 A — Restart (재시작):
 *   1. Presigned URL 발급  → TUS 세션 생성
 *   2. 0 ~ INTERRUPT_MB 전송 후 연결 해제
 *   3. 새 objectKey 로 Presigned URL 재발급 → 새 TUS 세션 생성
 *   4. 0 ~ 파일 끝까지 처음부터 전송 (전체 재전송)
 *
 * 시나리오 B — Resume (재개):
 *   1. Presigned URL 발급 → TUS 세션 생성
 *   2. 0 ~ INTERRUPT_MB 전송 후 연결 해제
 *   3. HEAD 요청으로 서버 오프셋 확인
 *   4. INTERRUPT_MB ~ 파일 끝까지 이어서 전송 (나머지만 전송)
 *
 * 사용법:
 *   k6 run k6-resumable-comparison.js                          # A + B 순차 실행 (기본)
 *   k6 run --env SCENARIO=restart k6-resumable-comparison.js   # 시나리오 A만 실행
 *   k6 run --env SCENARIO=resume  k6-resumable-comparison.js   # 시나리오 B만 실행
 *   k6 run --env SCENARIO=both    k6-resumable-comparison.js   # A + B 순차 실행
 *
 * 주요 옵션:
 *   --env SCENARIO          : 실행할 시나리오 (restart | resume | both) (기본값: both)
 *   --env CONTROL_PLANE_URL : Control Plane URL                         (기본값: http://localhost:8080)
 *   --env STORAGE_NODE_URL  : Storage Node URL                          (기본값: http://localhost:3000)
 *   --env FILE_SIZE_MB      : 가상 파일 크기(MB)                        (기본값: 1024)
 *   --env CHUNK_MB          : 청크 크기(MB)                             (기본값: 5)
 *   --env INTERRUPT_MB      : 중단 지점(MB, 청크 배수 권장)             (기본값: 300)
 *   --env BUCKET            : 버킷 이름                                 (기본값: test_bucket)
 *
 * 💡 파일을 메모리에 올리지 않는 이유:
 *   k6 의 open() 은 init context 에서 파일 전체를 ArrayBuffer 로 메모리에 올립니다.
 *   스트리밍 API 가 없으므로 대신 청크 전송 시마다 randomBytes() 로 데이터를 생성합니다.
 *   성능 비교 테스트에서는 실제 파일 내용이 아닌 전송 크기/시간만 측정하므로 동등합니다.
 */

// ── 환경 설정 ──────────────────────────────────────────────────────────────────
const SCENARIO          = (__ENV.SCENARIO || 'both').toLowerCase(); // 'restart' | 'resume' | 'both'
const CONTROL_PLANE_URL = __ENV.CONTROL_PLANE_URL || 'http://localhost:8080';
const STORAGE_NODE_URL  = __ENV.STORAGE_NODE_URL  || 'http://localhost:3000';
const CHUNK_MB          = parseInt(__ENV.CHUNK_MB     || '5', 10);
const INTERRUPT_MB      = parseInt(__ENV.INTERRUPT_MB || '500', 10);
const BUCKET            = __ENV.BUCKET            || 'test_bucket';

// FILE_SIZE_MB: 가상 파일 크기. open() 없이 randomBytes() 로 청크를 생성하므로
// 실제 파일이 존재하지 않아도 되며, 메모리/디스크를 미리 차지하지 않습니다.
const FILE_SIZE_MB   = parseInt(__ENV.FILE_SIZE_MB || '1024', 10);
const FILE_SIZE_BYTES = FILE_SIZE_MB * 1024 * 1024;
const FILE_NAME      = `virtual-${FILE_SIZE_MB}MB.bin`;

const CHUNK_SIZE     = CHUNK_MB * 1024 * 1024;
const INTERRUPT_SIZE = INTERRUPT_MB * 1024 * 1024;

// ── 커스텀 지표 ────────────────────────────────────────────────────────────────
// 복구 소요 시간: 연결 해제 후 → 전송 완료까지
const recoveryTimeRestart = new Trend('recovery_time_restart_ms', false);
const recoveryTimeResume  = new Trend('recovery_time_resume_ms', false);

// 전체 소요 시간: TUS 세션 생성 ~ 최종 전송 완료
const totalTimeRestart    = new Trend('total_time_restart_ms',   false);
const totalTimeResume     = new Trend('total_time_resume_ms',    false);

// 전송 바이트 수
const bytesTransferredRestart = new Counter('bytes_transferred_restart');
const bytesTransferredResume  = new Counter('bytes_transferred_resume');

// ── k6 옵션 ───────────────────────────────────────────────────────────────────
const runRestart = SCENARIO === 'restart' || SCENARIO === 'both';
const runResume  = SCENARIO === 'resume'  || SCENARIO === 'both';

export const options = {
  scenarios: {
    // 시나리오 A: 재시작 업로드
    //   --env SCENARIO=restart 또는 both 일 때만 포함
    ...(runRestart ? {
      restart_scenario: {
        executor:   'per-vu-iterations',
        vus:        1,
        iterations: 1,
        exec:       'restartScenario',
        startTime:  '0s',
      },
    } : {}),
    // 시나리오 B: TUS 재개 업로드
    //   --env SCENARIO=resume  → 즉시 시작 (0s)
    //   --env SCENARIO=both    → restart 완료 대기 후 시작 (90m)
    ...(runResume ? {
      resume_scenario: {
        executor:   'per-vu-iterations',
        vus:        1,
        iterations: 1,
        exec:       'resumeScenario',
        startTime:  SCENARIO === 'resume' ? '0s' : '90m',
      },
    } : {}),
  },
  thresholds: {
    http_req_failed:                               ['rate<0.01'],
    'http_req_duration{name:presigned_url}':       ['p(95)<5000'],
    'http_req_duration{name:tus_create_session}':  ['p(95)<5000'],
    'http_req_duration{name:tus_head_offset}':     ['p(95)<3000'],
    'http_req_duration{name:tus_upload_chunk}':    ['p(95)<300000'],
  },
  summaryTrendStats: ['avg', 'min', 'med', 'max', 'p(90)', 'p(95)'],
};

// ── 공통 유틸 ──────────────────────────────────────────────────────────────────

/**
 * Control Plane 에서 Resumable 업로드용 Presigned URL 발급
 * @param {string} objectKey
 * @param {number} fileSize
 * @returns {string|null} presignedUrl
 */
function getPresignedUrl(objectKey, fileSize) {
  const res = http.post(
    `${CONTROL_PLANE_URL}/api/storage/presigned-url`,
    JSON.stringify({ bucket: BUCKET, objectKey, fileSize }),
    {
      headers: { 'Content-Type': 'application/json' },
      tags:    { name: 'presigned_url' },
      timeout: '30s',
    },
  );

  const ok = check(res, {
    'Presigned URL 200': (r) => r.status === 200,
  });
  if (!ok) {
    console.error(`[Presigned URL 실패] status=${res.status} body=${res.body}`);
    return null;
  }

  try {
    const body = JSON.parse(res.body);
    // 호스트 부분을 STORAGE_NODE_URL 로 교체 (Docker 환경 대응)
    return body.presignedUrl.replace(/^https?:\/\/[^/]+/, STORAGE_NODE_URL);
  } catch (e) {
    console.error(`[Presigned URL 파싱 실패] ${e}`);
    return null;
  }
}

/**
 * Presigned URL 로 TUS 세션 생성 → 업로드 URL 반환
 * @param {string} presignedUrl
 * @param {number} fileSize
 * @returns {string|null} uploadUrl (PATCH 대상)
 */
function createTusSession(presignedUrl, fileSize) {
  const b64Name = encoding.b64encode(FILE_NAME);

  const res = http.post(
    presignedUrl,
    null,
    {
      headers: {
        'Tus-Resumable':   '1.0.0',
        'Upload-Length':   String(fileSize),
        'Upload-Metadata': `filename ${b64Name}`,
        'Content-Length':  '0',
      },
      tags:    { name: 'tus_create_session' },
      timeout: '30s',
    },
  );

  const ok = check(res, {
    'TUS 세션 생성 201':      (r) => r.status === 201,
    'Location 헤더 존재':     (r) => !!r.headers['Location'],
  });
  if (!ok) {
    console.error(`[TUS 세션 생성 실패] status=${res.status} body=${res.body}`);
    return null;
  }

  const location = res.headers['Location'];
  // protocol-relative URL (//host/path) → http://host/path 로 정규화 후 호스트 교체
  const normalized = location.startsWith('//')
    ? `http:${location}`
    : location;
  return normalized.replace(/^https?:\/\/[^/]+/, STORAGE_NODE_URL);
}

/**
 * TUS PATCH 청크 업로드
 * @param {string} uploadUrl
 * @param {number} startOffset
 * @param {number} endOffset
 * @param {string} label       - 로그 구분 레이블
 * @returns {{ finalOffset: number, bytesTransferred: number }} 실패 시 finalOffset = -1
 */
function uploadChunks(uploadUrl, startOffset, endOffset, label) {
  const fileSize    = FILE_SIZE_BYTES;
  const totalChunks = Math.ceil(fileSize / CHUNK_SIZE);
  let offset        = startOffset;
  let chunkIdx      = Math.floor(startOffset / CHUNK_SIZE) + 1;
  let bytesTransferred = 0;

  while (offset < endOffset) {
    const end      = Math.min(offset + CHUNK_SIZE, endOffset);
    const chunkLen = end - offset;
    // 파일을 메모리에 올리지 않고 청크 크기만큼 랜덤 데이터를 즉시 생성합니다.
    const chunk    = randomBytes(chunkLen);

    const res = http.patch(
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

    const ok = check(res, {
      [`[${label}] 청크 ${chunkIdx}/${totalChunks} 204`]: (r) => r.status === 204,
    });

    if (!ok) {
      console.error(
        `[${label}] 청크 ${chunkIdx} 실패 — status=${res.status} offset=${offset} body=${res.body}`,
      );
      return { finalOffset: -1, bytesTransferred };
    }

    bytesTransferred += chunkLen;
    offset = end;
    chunkIdx++;
    const pct = ((offset / endOffset) * 100).toFixed(1);
    console.log(
      `  [${label}] 청크 ${chunkIdx - 1}/${totalChunks} ✅ ` +
      `${(offset / 1024 / 1024).toFixed(0)} MB / ${(endOffset / 1024 / 1024).toFixed(0)} MB (${pct}%)`,
    );
  }

  return { finalOffset: offset, bytesTransferred };
}

// ── 시나리오 A: Restart (재시작 업로드) ──────────────────────────────────────
export function restartScenario() {
  const fileSize = FILE_SIZE_BYTES;
  const interruptOffset = Math.min(
    Math.floor(INTERRUPT_SIZE / CHUNK_SIZE) * CHUNK_SIZE,
    fileSize,
  );

  console.log('\n╔══════════════════════════════════════════════════════════╗');
  console.log('║  시나리오 A: Restart (재시작 업로드)                     ║');
  console.log('╠══════════════════════════════════════════════════════════╣');
  console.log(`║  파일 크기     : ${(fileSize / 1024 / 1024).toFixed(0)} MB`);
  console.log(`║  청크 크기     : ${CHUNK_MB} MB`);
  console.log(`║  중단 지점     : ${INTERRUPT_MB} MB`);
  console.log(`║  재시작 시 전송: ${(fileSize / 1024 / 1024).toFixed(0)} MB (전체)`);
  console.log('╚══════════════════════════════════════════════════════════╝\n');

  const ts = Date.now();
  const objectKeyA = `compare-test/restart/vu${__VU}-${ts}/test.bin`;

  const totalStart = Date.now();

  // ── Phase 1: 초기 부분 전송 ────────────────────────────────────────────────
  console.log(`[A-1] Presigned URL 발급 (objectKey: ${objectKeyA})`);
  const presignedUrlA = getPresignedUrl(objectKeyA, fileSize);
  if (!presignedUrlA) return;

  console.log('[A-2] TUS 세션 생성');
  const uploadUrlA = createTusSession(presignedUrlA, fileSize);
  if (!uploadUrlA) return;

  console.log(`[A-3] ${INTERRUPT_MB} MB 까지 전송 후 연결 해제 시뮬레이션\n`);
  const { finalOffset: interruptedAt, bytesTransferred: phase1Bytes } =
    uploadChunks(uploadUrlA, 0, interruptOffset, 'A-초기전송');

  if (interruptedAt === -1) return;

  console.log(`\n[A] ✋ 연결 해제 — ${(interruptedAt / 1024 / 1024).toFixed(0)} MB 전송 후 중단`);
  console.log('[A] ▶ 기존 세션 폐기, 처음부터 재전송 시작\n');

  // ── Phase 2: 새 세션으로 처음부터 재전송 (Recovery 측정 시작) ─────────────
  const objectKeyA2      = `compare-test/restart/vu${__VU}-${ts}/test-retry.bin`;
  const recoveryStart    = Date.now();

  console.log(`[A-4] 새 Presigned URL 발급 (objectKey: ${objectKeyA2})`);
  const presignedUrlA2 = getPresignedUrl(objectKeyA2, fileSize);
  if (!presignedUrlA2) return;

  console.log('[A-5] 새 TUS 세션 생성');
  const uploadUrlA2 = createTusSession(presignedUrlA2, fileSize);
  if (!uploadUrlA2) return;

  console.log(`[A-6] 전체 파일 (${(fileSize / 1024 / 1024).toFixed(0)} MB) 처음부터 재전송\n`);
  const { finalOffset: finalA, bytesTransferred: phase2Bytes } =
    uploadChunks(uploadUrlA2, 0, fileSize, 'A-재시작전송');

  if (finalA === -1) return;

  const recoveryEnd = Date.now();
  const totalEnd    = Date.now();

  // ── 지표 기록 ──────────────────────────────────────────────────────────────
  const recoveryMs = recoveryEnd - recoveryStart;
  const totalMs    = totalEnd - totalStart;
  const totalBytes = phase1Bytes + phase2Bytes;

  recoveryTimeRestart.add(recoveryMs);
  totalTimeRestart.add(totalMs);
  bytesTransferredRestart.add(totalBytes);

  check({ finalA, fileSize }, {
    '[A] 처음부터 재전송 완료': ({ finalA, fileSize }) => finalA === fileSize,
  });

  console.log('\n╔══════════════════════════════════════════════════════════╗');
  console.log('║  [A] Restart 완료                                        ║');
  console.log('╠══════════════════════════════════════════════════════════╣');
  console.log(`║  복구 소요 시간  : ${(recoveryMs / 1000).toFixed(1)} 초`);
  console.log(`║  전체 소요 시간  : ${(totalMs / 1000).toFixed(1)} 초`);
  console.log(`║  총 전송 데이터  : ${(totalBytes / 1024 / 1024).toFixed(0)} MB`);
  console.log(`║  낭비 데이터     : ${(interruptedAt / 1024 / 1024).toFixed(0)} MB (중단 전 전송분)`);
  console.log('╚══════════════════════════════════════════════════════════╝\n');
}

// ── 시나리오 B: Resume (TUS 재개 업로드) ─────────────────────────────────────
export function resumeScenario() {
  const fileSize = FILE_SIZE_BYTES;
  const interruptOffset = Math.min(
    Math.floor(INTERRUPT_SIZE / CHUNK_SIZE) * CHUNK_SIZE,
    fileSize,
  );

  console.log('\n╔══════════════════════════════════════════════════════════╗');
  console.log('║  시나리오 B: Resume (TUS 재개 업로드)                    ║');
  console.log('╠══════════════════════════════════════════════════════════╣');
  console.log(`║  파일 크기     : ${(fileSize / 1024 / 1024).toFixed(0)} MB`);
  console.log(`║  청크 크기     : ${CHUNK_MB} MB`);
  console.log(`║  중단 지점     : ${INTERRUPT_MB} MB`);
  console.log(`║  재개 시 전송  : ${((fileSize - interruptOffset) / 1024 / 1024).toFixed(0)} MB (나머지만)`);
  console.log('╚══════════════════════════════════════════════════════════╝\n');

  const ts = Date.now();
  const objectKeyB = `compare-test/resume/vu${__VU}-${ts}/test.bin`;

  const totalStart = Date.now();

  // ── Phase 1: 초기 부분 전송 ────────────────────────────────────────────────
  console.log(`[B-1] Presigned URL 발급 (objectKey: ${objectKeyB})`);
  const presignedUrlB = getPresignedUrl(objectKeyB, fileSize);
  if (!presignedUrlB) return;

  console.log('[B-2] TUS 세션 생성');
  const uploadUrlB = createTusSession(presignedUrlB, fileSize);
  if (!uploadUrlB) return;

  console.log(`[B-3] ${INTERRUPT_MB} MB 까지 전송 후 연결 해제 시뮬레이션\n`);
  const { finalOffset: interruptedAt, bytesTransferred: phase1Bytes } =
    uploadChunks(uploadUrlB, 0, interruptOffset, 'B-초기전송');

  if (interruptedAt === -1) return;

  console.log(`\n[B] ✋ 연결 해제 — ${(interruptedAt / 1024 / 1024).toFixed(0)} MB 전송 후 중단`);
  console.log('[B] ▶ 기존 세션 유지, TUS HEAD 로 오프셋 확인 후 재개\n');

  // ── Phase 2: HEAD 확인 후 재개 (Recovery 측정 시작) ───────────────────────
  const recoveryStart = Date.now();

  const headRes = http.request(
    'HEAD',
    uploadUrlB,
    null,
    {
      headers: { 'Tus-Resumable': '1.0.0' },
      tags:    { name: 'tus_head_offset' },
      timeout: '10s',
    },
  );

  const headOk = check(headRes, {
    '[B] HEAD 200':            (r) => r.status === 200,
    '[B] Upload-Offset 존재':  (r) => !!r.headers['Upload-Offset'],
  });

  if (!headOk) {
    console.error(`[B] HEAD 실패 — status=${headRes.status} body=${headRes.body}`);
    return;
  }

  const serverOffset = parseInt(headRes.headers['Upload-Offset'], 10);
  console.log(`[B] HEAD 확인 — 서버 오프셋: ${(serverOffset / 1024 / 1024).toFixed(0)} MB`);

  check({ serverOffset, interruptedAt }, {
    '[B] 서버 오프셋 == 중단 지점': ({ serverOffset, interruptedAt }) =>
      serverOffset === interruptedAt,
  });

  if (serverOffset !== interruptedAt) {
    console.warn(
      `[B] 오프셋 불일치: 서버=${serverOffset} 기대=${interruptedAt} — 서버 오프셋 기준으로 재개`,
    );
  }

  console.log(
    `\n[B-4] ${(serverOffset / 1024 / 1024).toFixed(0)} MB 부터 나머지 ` +
    `${((fileSize - serverOffset) / 1024 / 1024).toFixed(0)} MB 재개 전송\n`,
  );
  const { finalOffset: finalB, bytesTransferred: phase2Bytes } =
    uploadChunks(uploadUrlB, serverOffset, fileSize, 'B-재개전송');

  if (finalB === -1) return;

  const recoveryEnd = Date.now();
  const totalEnd    = Date.now();

  // ── 지표 기록 ──────────────────────────────────────────────────────────────
  const recoveryMs = recoveryEnd - recoveryStart;
  const totalMs    = totalEnd - totalStart;
  const totalBytes = phase1Bytes + phase2Bytes;

  recoveryTimeResume.add(recoveryMs);
  totalTimeResume.add(totalMs);
  bytesTransferredResume.add(totalBytes);

  check({ finalB, fileSize }, {
    '[B] TUS 재개 업로드 완료': ({ finalB, fileSize }) => finalB === fileSize,
  });

  console.log('\n╔══════════════════════════════════════════════════════════╗');
  console.log('║  [B] Resume 완료                                         ║');
  console.log('╠══════════════════════════════════════════════════════════╣');
  console.log(`║  복구 소요 시간  : ${(recoveryMs / 1000).toFixed(1)} 초`);
  console.log(`║  전체 소요 시간  : ${(totalMs / 1000).toFixed(1)} 초`);
  console.log(`║  총 전송 데이터  : ${(totalBytes / 1024 / 1024).toFixed(0)} MB`);
  console.log('╚══════════════════════════════════════════════════════════╝\n');
}

// ── handleSummary: 비교 리포트 ─────────────────────────────────────────────────
export function handleSummary(data) {
  const metrics = data.metrics || {};

  // 타임스탬프별로 단일 측정값이므로 avg = 해당 값
  const restartRecovery = metrics['recovery_time_restart_ms']?.values?.avg  ?? 0;
  const resumeRecovery  = metrics['recovery_time_resume_ms']?.values?.avg   ?? 0;
  const restartTotal    = metrics['total_time_restart_ms']?.values?.avg     ?? 0;
  const resumeTotal     = metrics['total_time_resume_ms']?.values?.avg      ?? 0;

  const restartBytes    = metrics['bytes_transferred_restart']?.values?.count ?? 0;
  const resumeBytes     = metrics['bytes_transferred_resume']?.values?.count  ?? 0;

  const savedMs         = restartRecovery - resumeRecovery;
  const savedPct        = restartRecovery > 0
    ? ((savedMs / restartRecovery) * 100).toFixed(1)
    : 'N/A';
  const wastedMB        = (INTERRUPT_SIZE) / 1024 / 1024;

  const sep  = '═'.repeat(60);
  const sep2 = '─'.repeat(60);

  const report = [
    '',
    sep,
    '  Resumable Upload 도입 효과 비교 리포트',
    sep,
    '',
    '  [측정 조건]',
    `  · 파일 크기       : ${FILE_SIZE_MB} MB`,
    `  · 청크 크기       : ${CHUNK_MB} MB`,
    `  · 중단 지점       : ${INTERRUPT_MB} MB`,
    `  · 재시작 시 추가  : ${FILE_SIZE_MB} MB (전체 재전송)`,
    `  · 재개 시 추가    : ${((FILE_SIZE_BYTES - INTERRUPT_SIZE) / 1024 / 1024).toFixed(0)} MB (나머지만 전송)`,
    '',
    sep2,
    `  ${'항목'.padEnd(22)} ${'A: Restart'.padStart(14)} ${'B: Resume'.padStart(14)}`,
    sep2,
    `  ${'복구 소요 시간 (초)'.padEnd(20)} ${(restartRecovery / 1000).toFixed(1).padStart(14)} ${(resumeRecovery / 1000).toFixed(1).padStart(14)}`,
    `  ${'전체 소요 시간 (초)'.padEnd(20)} ${(restartTotal / 1000).toFixed(1).padStart(14)} ${(resumeTotal / 1000).toFixed(1).padStart(14)}`,
    `  ${'총 전송량 (MB)'.padEnd(20)} ${(restartBytes / 1024 / 1024).toFixed(0).padStart(14)} ${(resumeBytes / 1024 / 1024).toFixed(0).padStart(14)}`,
    sep2,
    '',
    '  [도입 효과]',
    `  · 복구 시간 절감    : ${(savedMs / 1000).toFixed(1)} 초  (${savedPct}% 단축)`,
    `  · 불필요 재전송 제거: ${wastedMB.toFixed(0)} MB 절약`,
    `  · 전송량 감소율     : ${restartBytes > 0 ? (((restartBytes - resumeBytes) / restartBytes) * 100).toFixed(1) : 'N/A'}%`,
    '',
    sep,
    '',
  ].join('\n');

  return {
    stdout: textSummary(data, { indent: ' ', enableColors: true }) + report,
    'summary-comparison.json': JSON.stringify(
      {
        config: {
          fileSizeMB:    FILE_SIZE_MB,
          chunkMB:       CHUNK_MB,
          interruptMB:   INTERRUPT_MB,
        },
        results: {
          restart: {
            recoveryTime_ms: restartRecovery,
            totalTime_ms:    restartTotal,
            bytesTransferred_MB: restartBytes / 1024 / 1024,
          },
          resume: {
            recoveryTime_ms: resumeRecovery,
            totalTime_ms:    resumeTotal,
            bytesTransferred_MB: resumeBytes / 1024 / 1024,
          },
        },
        savings: {
          recoveryTime_saved_ms:  savedMs,
          recoveryTime_saved_pct: savedPct,
          dataTransfer_saved_MB:  (restartBytes - resumeBytes) / 1024 / 1024,
        },
      },
      null,
      2,
    ),
  };
}
