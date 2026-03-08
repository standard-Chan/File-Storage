import fs from "fs";
import path from "path";
import http from "http";
import https from "https";
import { Readable } from "stream";

// 실행 방법 : node upload-test.mjs

// ============================================================
// ✏️  여기서 변수 수정
// ============================================================
const FILE_PATH  = "./test-files/100MB.bin";        // 업로드할 파일 경로
const BUCKET     = "버킷1";                  // 대상 버킷 이름
const OBJECT_KEY = "testfile.bin";          // 단일 업로드 오브젝트 키
const PART_COUNT = 4;                       // multipart 분할 개수
const UPLOAD_URL = "http://localhost:3000"; // 업로드 서버 URL

const BANDWIDTH_BPS = 1000 * 1024 * 1024;    // 대역폭 제한 (bytes/sec) - 현재 5MB/s
const CHUNK_SIZE = 64 * 1024;             // 청크 단위 (64KB)
// ============================================================

// PUT /objects/direct/:bucket/<key>?bucket=...&objectKey=...
function buildUploadUrl(objectKey) {
  const qs = new URLSearchParams({ bucket: BUCKET, objectKey }).toString();
  const pathname = `/objects/direct/${encodeURIComponent(BUCKET)}/${encodeURIComponent(objectKey)}`;
  return `${UPLOAD_URL}${pathname}?${qs}`;
}

// ── 유틸: HTTP 요청 (Promise) ────────────────────────────────
function request(url, options, bodyBuffer) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const lib = parsed.protocol === "https:" ? https : http;
    const req = lib.request(
      { ...options, hostname: parsed.hostname, port: parsed.port, path: parsed.pathname + (parsed.search || "") },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const body = Buffer.concat(chunks).toString();
          resolve({ status: res.statusCode, body });
        });
      }
    );
    req.on("error", reject);
    if (bodyBuffer) req.write(bodyBuffer);
    req.end();
  });
}

// ── 유틸: 속도 제한 스트림 업로드 ────────────────────────────
// bandwidth: 전체 허용 대역폭 (bps), concurrency: 동시 업로드 수
// → 각 스트림에는 bandwidth / concurrency 할당
async function throttledUpload(url, method, headers, buffer, bandwidthPerStream) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const lib = parsed.protocol === "https:" ? https : http;

    const req = lib.request(
      {
        hostname: parsed.hostname,
        port: parsed.port,
        path: parsed.pathname + (parsed.search || ""),
        method,
        headers: { ...headers, "Content-Length": buffer.length },
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString() }));
      }
    );
    req.on("error", reject);

    // 청크 단위로 속도 제한하며 전송
    let offset = 0;
    const bytesPerChunk = CHUNK_SIZE;
    // 청크 하나 보내는 데 걸려야 할 시간 (ms)
    const msPerChunk = (bytesPerChunk / bandwidthPerStream) * 1000;

    function sendNext() {
      if (offset >= buffer.length) {
        req.end();
        return;
      }
      const chunk = buffer.slice(offset, offset + bytesPerChunk);
      offset += chunk.length;
      req.write(chunk);
      setTimeout(sendNext, msPerChunk);
    }
    sendNext();
  });
}

// ── 로그 헬퍼 ────────────────────────────────────────────────
function log(msg) {
  const now = new Date().toISOString().slice(11, 23);
  console.log(`[${now}] ${msg}`);
}

function formatMBs(bytes, ms) {
  return ((bytes / 1024 / 1024) / (ms / 1000)).toFixed(2) + " MB/s";
}

// ── 1. 단일 업로드 ────────────────────────────────────────────
async function singleUpload(fileBuffer) {
  log("────────────────────────────────────────");
  log(`▶ 단일 업로드 시작 → PUT /objects/direct/${BUCKET}/${OBJECT_KEY}`);
  const start = Date.now();

  const res = await throttledUpload(
    buildUploadUrl(OBJECT_KEY),
    "PUT",
    { "Content-Type": "application/octet-stream" },
    fileBuffer,
    BANDWIDTH_BPS  // 대역폭 전부 사용
  );

  const elapsed = Date.now() - start;
  log(`✅ 단일 업로드 완료 | 상태: ${res.status} | 소요: ${elapsed}ms | 속도: ${formatMBs(fileBuffer.length, elapsed)}`);
  if (res.status !== 201) log(`⚠️  응답 body: ${res.body}`);
  return elapsed;
}

// ── 2. Multipart 업로드 (파트별 개별 오브젝트로 동시 업로드) ──
async function multipartUpload(fileBuffer) {
  log("────────────────────────────────────────");
  log(`▶ Multipart 업로드 시작 (${PART_COUNT}개 파트, 동시 업로드)`);

  // 파트 분할
  const partSize = Math.ceil(fileBuffer.length / PART_COUNT);
  const parts = Array.from({ length: PART_COUNT }, (_, i) => {
    const partKey = `${OBJECT_KEY}-part-${i + 1}`; // 각 파트마다 고유 오브젝트 키
    return {
      partNumber: i + 1,
      objectKey: partKey,
      buffer: fileBuffer.slice(i * partSize, (i + 1) * partSize),
    };
  });

  // 각 파트에 할당되는 대역폭 = 전체 / 동시 업로드 수
  const bandwidthPerPart = BANDWIDTH_BPS / PART_COUNT;
  log(`  파트별 대역폭: ${(bandwidthPerPart / 1024).toFixed(1)} KB/s (총 ${(BANDWIDTH_BPS / 1024 / 1024).toFixed(1)} MB/s 공유)`);

  const start = Date.now();

  // 파트 동시 업로드 (서로 다른 objectKey)
  await Promise.all(
    parts.map(async ({ partNumber, objectKey, buffer }) => {
      const t0 = Date.now();
      const res = await throttledUpload(
        buildUploadUrl(objectKey),
        "PUT",
        { "Content-Type": "application/octet-stream" },
        buffer,
        bandwidthPerPart
      );
      const elapsed = Date.now() - t0;
      log(`  파트 ${partNumber} 완료 | key: ${objectKey} | 상태: ${res.status} | ${(buffer.length / 1024).toFixed(0)}KB | ${elapsed}ms`);
      if (res.status !== 201) log(`  ⚠️  응답 body: ${res.body}`);
    })
  );

  const elapsed = Date.now() - start;
  log(`✅ Multipart 업로드 완료 | 소요: ${elapsed}ms | 속도: ${formatMBs(fileBuffer.length, elapsed)}`);
  return elapsed;
}



// ── 메인 ─────────────────────────────────────────────────────
async function main() {
  // 파일 읽기
  if (!fs.existsSync(FILE_PATH)) {
    console.error(`❌ 파일 없음: ${FILE_PATH}`);
    process.exit(1);
  }
  const fileBuffer = fs.readFileSync(FILE_PATH);
  const fileSizeMB = (fileBuffer.length / 1024 / 1024).toFixed(2);

  console.log("========================================");
  console.log("  업로드 대역폭 제한 비교 테스트");
  console.log("========================================");
  console.log(`  파일 크기  : ${fileSizeMB} MB`);
  console.log(`  버킷       : ${BUCKET}`);
  console.log(`  파트 개수  : ${PART_COUNT}개`);
  console.log(`  대역폭 제한: ${(BANDWIDTH_BPS / 1024 / 1024).toFixed(1)} MB/s`);
  console.log(`  업로드 URL : ${UPLOAD_URL}`);
  console.log("========================================\n");

  try {
    const singleMs = await singleUpload(fileBuffer);
    // 서버가 처리할 시간 잠깐 대기
    await new Promise((r) => setTimeout(r, 500));
    const multiMs = await multipartUpload(fileBuffer);

    console.log("\n========================================");
    console.log("  📊 결과 비교");
    console.log("========================================");
    console.log(`  단일 업로드   : ${singleMs}ms  (${formatMBs(fileBuffer.length, singleMs)})`);
    console.log(`  Multipart    : ${multiMs}ms  (${formatMBs(fileBuffer.length, multiMs)})`);
    const diff = Math.abs(singleMs - multiMs);
    const diffPct = ((diff / singleMs) * 100).toFixed(1);
    console.log(`  차이         : ${diff}ms (${diffPct}%)`);
    console.log("========================================");
    console.log(diffPct < 10
      ? "  ✅ 결론: 두 방식의 속도 차이가 거의 없음 (대역폭 제한 환경에서 예상된 결과)"
      : "  ⚠️  결론: 예상보다 차이 있음 - 서버 처리 오버헤드 또는 네트워크 조건 확인 필요"
    );
    console.log("========================================\n");
  } catch (err) {
    console.error("❌ 오류:", err.message);
    process.exit(1);
  }
}

main();
