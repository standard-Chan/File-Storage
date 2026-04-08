/**
 * Multipart Upload 테스트 스크립트
 *
 * 사용법:
 *   node multipart-upload-test.mjs [파일명] [파트크기MB] [동시세션수]
 *
 * 예시:
 *   node multipart-upload-test.mjs                     # 대화형 파일 선택
 *   node multipart-upload-test.mjs 100MB.bin           # 기본: 파트 5MB, 동시 4
 *   node multipart-upload-test.mjs 1GB.bin 50          # 파트 50MB, 동시 4
 *   node multipart-upload-test.mjs 1GB.bin 50 8        # 파트 50MB, 동시 8
 */

import fs from "node:fs";
import { promises as fsPromises } from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ─── 설정 ──────────────────────────────────────────────────────────────────
const STORAGE_NODE_URL = process.env.STORAGE_NODE_URL ?? "http://standard-storage.duckdns.org:3000";
const BUCKET = process.env.BUCKET ?? "multipart-test-bucket";
const TEST_FILES_DIR = path.join(__dirname, "test-files");
const DEFAULT_PART_SIZE_MB = 5;
const DEFAULT_CONCURRENCY = 4;

// ─── 사용 가능한 테스트 파일 목록 ─────────────────────────────────────────
const AVAILABLE_FILES = [
  { name: "10KB.bin",    size: 10 * 1024 },
  { name: "100KB.bin",   size: 100 * 1024 },
  { name: "1MB.bin",     size: 1 * 1024 * 1024 },
  { name: "5MB.bin",     size: 5 * 1024 * 1024 },
  { name: "10MB.bin",    size: 10 * 1024 * 1024 },
  { name: "50MB.bin",    size: 50 * 1024 * 1024 },
  { name: "100MB.bin",   size: 100 * 1024 * 1024 },
  { name: "500MB.bin",   size: 500 * 1024 * 1024 },
  { name: "1GB.bin",     size: 1024 * 1024 * 1024 },
].filter((f) => fs.existsSync(path.join(TEST_FILES_DIR, f.name)));

// ─── 유틸 ──────────────────────────────────────────────────────────────────
function formatBytes(bytes) {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(2)} MB`;
  if (bytes >= 1024)      return `${(bytes / 1024).toFixed(2)} KB`;
  return `${bytes} B`;
}

function formatMs(ms) {
  if (ms >= 60_000) return `${(ms / 60_000).toFixed(2)}분`;
  if (ms >= 1_000)  return `${(ms / 1_000).toFixed(3)}초`;
  return `${ms.toFixed(1)}ms`;
}

function throughput(bytes, ms) {
  const bps = (bytes / ms) * 1000;
  return `${formatBytes(bps)}/s`;
}

function ask(rl, question) {
  return new Promise((resolve) => rl.question(question, resolve));
}

// ─── 파일 선택 ─────────────────────────────────────────────────────────────
async function selectFile(argFilename) {
  if (argFilename) {
    const found = AVAILABLE_FILES.find((f) => f.name === argFilename);
    if (!found) {
      console.error(`❌ 파일을 찾을 수 없습니다: ${argFilename}`);
      console.error(`   사용 가능한 파일: ${AVAILABLE_FILES.map((f) => f.name).join(", ")}`);
      process.exit(1);
    }
    return found;
  }

  if (AVAILABLE_FILES.length === 0) {
    console.error("❌ test-files 디렉토리에 사용 가능한 파일이 없습니다.");
    process.exit(1);
  }

  console.log("\n사용 가능한 테스트 파일:");
  AVAILABLE_FILES.forEach((f, i) => {
    console.log(`  [${i + 1}] ${f.name.padEnd(14)} (${formatBytes(f.size)})`);
  });

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await ask(rl, `\n파일 번호를 선택하세요 [1-${AVAILABLE_FILES.length}]: `);
  rl.close();

  const idx = parseInt(answer, 10) - 1;
  if (isNaN(idx) || idx < 0 || idx >= AVAILABLE_FILES.length) {
    console.error("❌ 잘못된 선택입니다.");
    process.exit(1);
  }
  return AVAILABLE_FILES[idx];
}

// ─── API 호출 ──────────────────────────────────────────────────────────────
async function initiateUpload(bucket, objectKey) {
  const res = await fetch(`${STORAGE_NODE_URL}/multipart/initiate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ bucket, objectKey, contentType: "application/octet-stream" }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`initiate 실패 (${res.status}): ${text}`);
  }
  const json = await res.json();
  return json.data.uploadId;
}

async function uploadPart(uploadId, partNumber, buffer) {
  const res = await fetch(`${STORAGE_NODE_URL}/multipart/${uploadId}/${partNumber}`, {
    method: "PUT",
    headers: { "Content-Type": "application/octet-stream" },
    body: buffer,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`part ${partNumber} 업로드 실패 (${res.status}): ${text}`);
  }
  return res.json();
}

async function completeUpload(uploadId) {
  const res = await fetch(`${STORAGE_NODE_URL}/multipart/${uploadId}/complete`, {
    method: "POST",
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`complete 실패 (${res.status}): ${text}`);
  }
  return res.json();
}

async function abortUpload(uploadId) {
  await fetch(`${STORAGE_NODE_URL}/multipart/${uploadId}`, { method: "DELETE" });
}

// ─── 파트 분할 ─────────────────────────────────────────────────────────────
function splitIntoChunks(filePath, partSizeBytes) {
  const fileSize = fs.statSync(filePath).size;
  const chunks = [];
  let offset = 0;
  let partNumber = 1;

  while (offset < fileSize) {
    const end = Math.min(offset + partSizeBytes, fileSize);
    chunks.push({ partNumber, offset, length: end - offset });
    offset = end;
    partNumber++;
  }
  return { chunks, fileSize };
}

/**
 * 파일의 특정 위치에서 비동기로 청크를 읽습니다.
 * fh.read(buf, 0, length, position) 은 position을 명시하므로
 * 여러 워커가 같은 핸들을 동시에 사용해도 안전합니다.
 */
async function readFileChunk(fh, offset, length) {
  const buf = Buffer.allocUnsafe(length);
  await fh.read(buf, 0, length, offset);
  return buf;
}

/**
 * 동시 세션 수를 제한하며 비동기 작업을 병렬 실행하는 풀
 * @param {Array} tasks - () => Promise 형태의 함수 배열
 * @param {number} concurrency - 동시 실행 수
 */
async function runWithConcurrency(tasks, concurrency) {
  const results = new Array(tasks.length);
  let nextIdx = 0;

  async function worker() {
    while (nextIdx < tasks.length) {
      const idx = nextIdx++;
      results[idx] = await tasks[idx]();
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, tasks.length) }, worker);
  await Promise.all(workers);
  return results;
}

// ─── 메인 ──────────────────────────────────────────────────────────────────
async function main() {
  const argFilename = process.argv[2];
  const argPartSizeMB = parseFloat(process.argv[3]) || DEFAULT_PART_SIZE_MB;
  const argConcurrency = parseInt(process.argv[4], 10) || DEFAULT_CONCURRENCY;
  const partSizeBytes = Math.floor(argPartSizeMB * 1024 * 1024);
  const concurrency = Math.max(1, argConcurrency);

  const selected = await selectFile(argFilename);
  const filePath = path.join(TEST_FILES_DIR, selected.name);
  const objectKey = `multipart-test/${Date.now()}-${selected.name}`;

  const { chunks, fileSize } = splitIntoChunks(filePath, partSizeBytes);

  console.log("\n========================================");
  console.log("  Multipart Upload 테스트");
  console.log("========================================");
  console.log(`  파일      : ${selected.name} (${formatBytes(fileSize)})`);
  console.log(`  파트 크기 : ${formatBytes(partSizeBytes)}`);
  console.log(`  파트 수   : ${chunks.length}개`);
  console.log(`  동시 세션 : ${concurrency}개`);
  console.log(`  버킷      : ${BUCKET}`);
  console.log(`  객체 키   : ${objectKey}`);
  console.log(`  서버 URL  : ${STORAGE_NODE_URL}`);
  console.log("========================================\n");

  const timings = { initiate: 0, parts: [], complete: 0 };
  let uploadId;

  // ── 1. Initiate ──────────────────────────────────────────────────────────
  process.stdout.write("[1/3] initiate 요청 중...");
  const t0 = performance.now();
  uploadId = await initiateUpload(BUCKET, objectKey);
  timings.initiate = performance.now() - t0;
  console.log(` 완료 (${formatMs(timings.initiate)})  uploadId: ${uploadId}`);

  // ── 2. Upload Parts (병렬) ──────────────────────────────────────────────
  console.log(`\n[2/3] 파트 업로드 (${chunks.length}개, 동시 ${concurrency}개)`);

  // 파일 핸들을 한 번만 열어 모든 워커가 공유 (position 지정 read는 concurrent-safe)
  const fh = await fsPromises.open(filePath, "r");

  // 진행 상태 출력용 배열 초기화
  const wallOrigin = performance.now();
  const partStatus = chunks.map((c) => ({
    partNumber: c.partNumber,
    length: c.length,
    state: "대기",   // 대기 | 업로드중 | 완료
    elapsed: 0,
    startOffset: 0,  // wall time 기준 시작 오프셋 (타임라인용)
    endOffset: 0,
  }));

  function renderProgress() {
    const done   = partStatus.filter((p) => p.state === "완료").length;
    const active = partStatus.filter((p) => p.state === "업로드중");
    const pct    = Math.floor((done / chunks.length) * 100);
    const bar    = "█".repeat(Math.floor(pct / 5)) + "░".repeat(20 - Math.floor(pct / 5));
    const activeNums = active.map((p) => p.partNumber).join(",");
    process.stdout.write(
      `\r  [${bar}] ${pct}%  완료 ${done}/${chunks.length}  업로드중: [${activeNums}]  `,
    );
  }

  const wallStart = performance.now();
  const tasks = chunks.map((chunk) => async () => {
    const status = partStatus[chunk.partNumber - 1];
    status.state = "업로드중";
    status.startOffset = performance.now() - wallOrigin;
    renderProgress();

    const buf = await readFileChunk(fh, chunk.offset, chunk.length);
    const t1 = performance.now();
    await uploadPart(uploadId, chunk.partNumber, buf);
    const elapsed = performance.now() - t1;

    status.state = "완료";
    status.elapsed = elapsed;
    status.endOffset = performance.now() - wallOrigin;
    timings.parts.push(elapsed);
    renderProgress();
  });

  try {
    await runWithConcurrency(tasks, concurrency);
  } finally {
    await fh.close();
  }
  const totalUploadMs = performance.now() - wallStart;
  console.log(); // renderProgress 줄 마무리

  // 파트별 병렬 타임라인 출력
  console.log("\n  [파트 타임라인] (숫자=ms, 각 행이 하나의 파트)");
  const timelineWidth = 60;
  const maxEnd = Math.max(...partStatus.map((p) => p.endOffset));
  for (const p of partStatus) {
    const startCol = Math.floor((p.startOffset / maxEnd) * timelineWidth);
    const endCol   = Math.floor((p.endOffset   / maxEnd) * timelineWidth);
    const bar = " ".repeat(startCol) + "█".repeat(Math.max(1, endCol - startCol));
    console.log(
      `  part ${String(p.partNumber).padStart(3)}: |${bar.padEnd(timelineWidth)}| ` +
      `${formatMs(p.startOffset).padStart(8)} ~ ${formatMs(p.endOffset).padStart(8)}  (${formatMs(p.elapsed)})`
    );
  }

  // ── 3. Complete ───────────────────────────────────────────────────────────
  process.stdout.write("\n[3/3] complete 요청 중...");
  const t2 = performance.now();
  const result = await completeUpload(uploadId);
  timings.complete = performance.now() - t2;
  console.log(` 완료 (${formatMs(timings.complete)})`);

  // ── 결과 요약 ─────────────────────────────────────────────────────────────
  // totalMs는 벽시계 기준 (병렬이므로 파트 누적합이 아닌 wall time 사용)
  const totalMs = timings.initiate + totalUploadMs + timings.complete;
  const sumPartMs = timings.parts.reduce((a, b) => a + b, 0);
  const avgPartMs = sumPartMs / chunks.length;
  const minPartMs = Math.min(...timings.parts);
  const maxPartMs = Math.max(...timings.parts);

  console.log("\n========================================");
  console.log("  결과 요약");
  console.log("========================================");
  console.log(`  파일 크기        : ${formatBytes(fileSize)}`);
  console.log(`  최종 파일 크기   : ${formatBytes(result.data?.size ?? 0)}`);
  console.log(`  파트 크기        : ${formatBytes(partSizeBytes)}`);
  console.log(`  파트 수          : ${chunks.length}개`);
  console.log(`  동시 세션        : ${concurrency}개`);
  console.log("  ─────────────────────────────────────");
  console.log(`  initiate         : ${formatMs(timings.initiate)}`);
  console.log(`  파트 업로드 (wall): ${formatMs(totalUploadMs)}`);
  console.log(`    평균 (per part): ${formatMs(avgPartMs)}`);
  console.log(`    최소           : ${formatMs(minPartMs)}`);
  console.log(`    최대           : ${formatMs(maxPartMs)}`);
  console.log(`  complete         : ${formatMs(timings.complete)}`);
  console.log("  ─────────────────────────────────────");
  console.log(`  전체 시간 (wall) : ${formatMs(totalMs)}`);
  console.log(`  평균 처리량      : ${throughput(fileSize, totalMs)}`);
  console.log("========================================\n");
}

main().catch(async (err) => {
  console.error("\n❌ 오류 발생:", err.message);
  process.exit(1);
});
