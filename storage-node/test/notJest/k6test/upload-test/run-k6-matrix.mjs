#!/usr/bin/env node

/**
// node run-k6-matrix.mjs --duration 3m
// node run-k6-matrix.mjs --vus 10, 15, 20, 25, 30, 35, 40, 45 --duration 3m
// node run-k6-matrix.mjs --vus 10 -- duration 10s
// node run-k6-matrix.mjs --duration 10s --pause-between 20s

/home/starp321/upload-test/results/vus-matrix-20260317-101807/aggregate.json
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function parseArgs(argv) {
  const config = {
    vus: [10, 15, 20, 25, 30, 35, 40],
    duration: '1m',
    pauseBetween: '20s',
    script: 'k6-load-test.js',
    outRoot: 'results',
    bucket: process.env.BUCKET || '',
    controlPlaneUrl: process.env.CONTROL_PLANE_URL || '',
    failFast: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];

    if (arg === '--vus' && argv[i + 1]) {
      config.vus = argv[i + 1]
        .split(',')
        .map((v) => Number(v.trim()))
        .filter((v) => Number.isFinite(v) && v > 0);
      i += 1;
      continue;
    }

    if (arg.startsWith('--vus=')) {
      config.vus = arg
        .split('=')[1]
        .split(',')
        .map((v) => Number(v.trim()))
        .filter((v) => Number.isFinite(v) && v > 0);
      continue;
    }

    if (arg === '--duration' && argv[i + 1]) {
      config.duration = argv[i + 1];
      i += 1;
      continue;
    }

    // 실수 방지: "-- duration 10s" 형태도 허용
    if (arg === '--' && argv[i + 1] === 'duration' && argv[i + 2]) {
      config.duration = argv[i + 2];
      i += 2;
      continue;
    }

    if (arg.startsWith('--duration=')) {
      config.duration = arg.split('=')[1];
      continue;
    }

    if (arg === '--pause-between' && argv[i + 1]) {
      config.pauseBetween = argv[i + 1];
      i += 1;
      continue;
    }

    if (arg.startsWith('--pause-between=')) {
      config.pauseBetween = arg.split('=')[1];
      continue;
    }

    if (arg === '--script' && argv[i + 1]) {
      config.script = argv[i + 1];
      i += 1;
      continue;
    }

    if (arg.startsWith('--script=')) {
      config.script = arg.split('=')[1];
      continue;
    }

    if (arg === '--out-dir' && argv[i + 1]) {
      config.outRoot = argv[i + 1];
      i += 1;
      continue;
    }

    if (arg.startsWith('--out-dir=')) {
      config.outRoot = arg.split('=')[1];
      continue;
    }

    if (arg === '--bucket' && argv[i + 1]) {
      config.bucket = argv[i + 1];
      i += 1;
      continue;
    }

    if (arg.startsWith('--bucket=')) {
      config.bucket = arg.split('=')[1];
      continue;
    }

    if (arg === '--control-plane-url' && argv[i + 1]) {
      config.controlPlaneUrl = argv[i + 1];
      i += 1;
      continue;
    }

    if (arg.startsWith('--control-plane-url=')) {
      config.controlPlaneUrl = arg.split('=')[1];
      continue;
    }

    if (arg === '--fail-fast') {
      config.failFast = true;
      continue;
    }
  }

  return config;
}

function parseTimeToMs(value) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Math.max(0, value);
  }

  const input = String(value || '').trim();
  const match = input.match(/^(\d+)(ms|s|m|h)?$/i);
  if (!match) {
    return NaN;
  }

  const amount = Number(match[1]);
  const unit = (match[2] || 'ms').toLowerCase();
  const multiplier = {
    ms: 1,
    s: 1000,
    m: 60 * 1000,
    h: 60 * 60 * 1000,
  }[unit];

  return amount * multiplier;
}

function sleepMs(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return;
  const sharedArray = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(sharedArray, 0, 0, ms);
}

function timestamp() {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
}

function round(value, digits = 2) {
  if (!Number.isFinite(value)) return '';
  return Number(value.toFixed(digits));
}

function readMetricValues(summary, metricName) {
  return summary?.metrics?.[metricName]?.values || {};
}

function parseMetricTags(metricKey) {
  const tagMatch = metricKey.match(/^[^{}]+\{(.+)\}$/);
  if (!tagMatch) return {};

  const tags = {};
  for (const part of tagMatch[1].split(',')) {
    const [rawKey, ...rawValueParts] = part.split(':');
    if (!rawKey || rawValueParts.length === 0) continue;
    const key = rawKey.trim();
    const value = rawValueParts.join(':').trim();
    tags[key] = value;
  }
  return tags;
}

function countMetricTags(metricKey) {
  const tags = parseMetricTags(metricKey);
  return Object.keys(tags).length;
}

function findMetricValuesByTag(summary, metricBaseName, tagKey, tagValue) {
  const metrics = summary?.metrics || {};
  const candidates = Object.keys(metrics)
    .filter((key) => key.startsWith(`${metricBaseName}{`))
    .filter((key) => parseMetricTags(key)[tagKey] === String(tagValue));

  if (candidates.length === 0) return {};

  // 태그 수가 적은(집계 성격이 강한) 메트릭을 우선 선택
  candidates.sort((a, b) => countMetricTags(a) - countMetricTags(b));
  return metrics[candidates[0]]?.values || {};
}

function findUploadMetrics(summary) {
  const metrics = summary?.metrics || {};
  
  // upload_file을 포함하는 모든 http_req_duration 메트릭 찾기
  const uploadMetricKeys = Object.keys(metrics)
    .filter((key) => 
      key.startsWith('http_req_duration{') && 
      key.includes('name:upload_file')
    );

  if (uploadMetricKeys.length === 0) {
    return {};
  }

  // 태그 수가 적은(집계된) 메트릭을 우선으로
  uploadMetricKeys.sort((a, b) => {
    const countA = (a.match(/,/g) || []).length;
    const countB = (b.match(/,/g) || []).length;
    return countA - countB;
  });

  return metrics[uploadMetricKeys[0]]?.values || {};
}

function readThresholdOk(summary, metricName, thresholdName) {
  return summary?.metrics?.[metricName]?.thresholds?.[thresholdName]?.ok;
}

function buildRow(vus, summary, runStatus) {
  const httpReqDuration = readMetricValues(summary, 'http_req_duration');
  const httpReqFailed = readMetricValues(summary, 'http_req_failed');
  const httpReqs = readMetricValues(summary, 'http_reqs');
  const iterationDuration = readMetricValues(summary, 'iteration_duration');
  const iterations = readMetricValues(summary, 'iterations');
  const checks = readMetricValues(summary, 'checks');
  const dataSent = readMetricValues(summary, 'data_sent');
  const dataReceived = readMetricValues(summary, 'data_received');
  const vusGauge = readMetricValues(summary, 'vus');
  const vusMaxGauge = readMetricValues(summary, 'vus_max');
  const uploadMetric = findUploadMetrics(summary);

  const state = summary?.state || {};

  return {
    vus,
    status: runStatus,
    durationMs: round(state.testRunDurationMs, 2),
    httpReqCount: httpReqs.count ?? '',
    httpReqRate: round(httpReqs.rate, 4),
    iterationCount: iterations.count ?? '',
    iterationRate: round(iterations.rate, 4),
    failRate: round(httpReqFailed.rate, 6),
    checksRate: round(checks.rate, 6),
    reqAvgMs: round(httpReqDuration.avg, 2),
    reqP95Ms: round(httpReqDuration['p(95)'], 2),
    reqP99Ms: round(httpReqDuration['p(99)'], 2),
    uploadP90Ms: round(uploadMetric['p(90)'], 2),
    uploadP95Ms: round(uploadMetric['p(95)'], 2),
    uploadP99Ms: round(uploadMetric['p(99)'], 2),
    iterAvgMs: round(iterationDuration.avg, 2),
    iterP95Ms: round(iterationDuration['p(95)'], 2),
    dataSentBytes: dataSent.count ?? '',
    dataReceivedBytes: dataReceived.count ?? '',
    vusCurrent: vusGauge.value ?? '',
    vusMax: vusMaxGauge.value ?? '',
    thresholdReqP95Under5s: readThresholdOk(summary, 'http_req_duration', 'p(95)<5000'),
    thresholdFailRateUnder10pct: readThresholdOk(summary, 'http_req_failed', 'rate<0.1'),
  };
}

function toCsv(rows) {
  const headers = [
    'vus',
    'status',
    'durationMs',
    'httpReqCount',
    'httpReqRate',
    'iterationCount',
    'iterationRate',
    'failRate',
    'checksRate',
    'reqAvgMs',
    'reqP95Ms',
    'reqP99Ms',
    'uploadP90Ms',
    'uploadP95Ms',
    'uploadP99Ms',
    'iterAvgMs',
    'iterP95Ms',
    'dataSentBytes',
    'dataReceivedBytes',
    'vusCurrent',
    'vusMax',
    'thresholdReqP95Under5s',
    'thresholdFailRateUnder10pct',
  ];

  const escape = (value) => {
    if (value === null || value === undefined) return '';
    const str = String(value);
    if (str.includes(',') || str.includes('"') || str.includes('\n')) {
      return `"${str.replaceAll('"', '""')}"`;
    }
    return str;
  };

  const lines = [headers.join(',')];
  for (const row of rows) {
    lines.push(headers.map((h) => escape(row[h])).join(','));
  }
  return `${lines.join('\n')}\n`;
}

function toMarkdown(rows, config, runDirRelative) {
  const lines = [];

  lines.push('# k6 VUs Matrix Result');
  lines.push('');
  lines.push(`- Script: ${config.script}`);
  lines.push(`- Duration: ${config.duration}`);
  lines.push(`- VUs: ${config.vus.join(', ')}`);
  lines.push(`- Result Folder: ${runDirRelative}`);
  lines.push('');
  lines.push('| VUs | Status | fail rate | req avg(ms) | req p95(ms) | upload p90(ms) | upload p95(ms) | upload p99(ms) | req/s | http_reqs |');
  lines.push('| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |');

  for (const row of rows) {
    lines.push(`| ${row.vus} | ${row.status} | ${row.failRate} | ${row.reqAvgMs} | ${row.reqP95Ms} | ${row.uploadP90Ms} | ${row.uploadP95Ms} | ${row.uploadP99Ms} | ${row.httpReqRate} | ${row.httpReqCount} |`);
  }

  lines.push('');
  lines.push('## Thresholds');
  lines.push('');
  lines.push('| VUs | req p95<5s | fail rate<10% |');
  lines.push('| --- | --- | --- |');

  for (const row of rows) {
    lines.push(`| ${row.vus} | ${row.thresholdReqP95Under5s} | ${row.thresholdFailRateUnder10pct} |`);
  }

  lines.push('');
  return `${lines.join('\n')}\n`;
}

function run() {
  const config = parseArgs(process.argv.slice(2));
  const pauseBetweenMs = parseTimeToMs(config.pauseBetween);

  if (!config.vus.length) {
    console.error('오류: --vus 값이 비어 있습니다. 예) --vus 10,15,20');
    process.exit(1);
  }

  if (!Number.isFinite(pauseBetweenMs) || pauseBetweenMs < 0) {
    console.error('오류: --pause-between 값이 올바르지 않습니다. 예) --pause-between 10s');
    process.exit(1);
  }

  const scriptPath = path.resolve(__dirname, config.script);
  if (!fs.existsSync(scriptPath)) {
    console.error(`오류: 테스트 스크립트를 찾을 수 없습니다: ${scriptPath}`);
    process.exit(1);
  }

  const runId = `vus-matrix-${timestamp()}`;
  const runDir = path.resolve(__dirname, config.outRoot, runId);
  fs.mkdirSync(runDir, { recursive: true });

  const rows = [];
  const errors = [];

  console.log('========================================');
  console.log('k6 VUs 매트릭스 테스트 시작');
  console.log('========================================');
  console.log(`Script: ${config.script}`);
  console.log(`Duration: ${config.duration}`);
  console.log(`Pause Between Runs: ${config.pauseBetween}`);
  console.log(`VUs: ${config.vus.join(', ')}`);
  console.log(`Result Dir: ${runDir}`);
  console.log('========================================\n');

  for (let index = 0; index < config.vus.length; index += 1) {
    const vus = config.vus[index];
    console.log(`\n[RUN] VUs=${vus} 테스트 시작`);

    const result = spawnSync(
      'k6',
      ['run', '--vus', String(vus), '--duration', config.duration, config.script],
      {
        cwd: __dirname,
        stdio: 'inherit',
        env: {
          ...process.env,
          ...(config.bucket ? { BUCKET: config.bucket } : {}),
          ...(config.controlPlaneUrl ? { CONTROL_PLANE_URL: config.controlPlaneUrl } : {}),
        },
      }
    );

    const summaryPath = path.resolve(__dirname, 'summary.json');
    const summaryCopyPath = path.resolve(runDir, `summary-vus-${vus}.json`);

    let summary = null;
    if (fs.existsSync(summaryPath)) {
      fs.copyFileSync(summaryPath, summaryCopyPath);
      summary = JSON.parse(fs.readFileSync(summaryCopyPath, 'utf8'));
    }

    const status = result.status === 0 ? 'ok' : 'failed';
    if (!summary) {
      errors.push({ vus, reason: 'summary.json 파일을 찾지 못했습니다.' });
      rows.push({ vus, status, durationMs: '', httpReqCount: '', httpReqRate: '', iterationCount: '', iterationRate: '', failRate: '', checksRate: '', reqAvgMs: '', reqP95Ms: '', reqP99Ms: '', uploadP90Ms: '', uploadP95Ms: '', uploadP99Ms: '', iterAvgMs: '', iterP95Ms: '', dataSentBytes: '', dataReceivedBytes: '', vusCurrent: '', vusMax: '', thresholdReqP95Under5s: '', thresholdFailRateUnder10pct: '' });
    } else {
      rows.push(buildRow(vus, summary, status));
    }

    if (result.status !== 0) {
      const message = `[RUN] VUs=${vus} 실패 (exit code: ${result.status})`;
      console.error(message);
      errors.push({ vus, reason: message });
      if (config.failFast) {
        console.error('fail-fast 옵션으로 테스트를 중단합니다.');
        break;
      }
    } else {
      console.log(`[RUN] VUs=${vus} 완료`);
    }

    const isLastRun = index === config.vus.length - 1;
    if (!isLastRun && pauseBetweenMs > 0) {
      console.log(`[WAIT] 다음 테스트 전 ${config.pauseBetween} 대기`);
      sleepMs(pauseBetweenMs);
    }
  }

  const aggregate = {
    generatedAt: new Date().toISOString(),
    config: {
      script: config.script,
      duration: config.duration,
      pauseBetween: config.pauseBetween,
      vus: config.vus,
      bucket: config.bucket || null,
      controlPlaneUrl: config.controlPlaneUrl || null,
    },
    rows,
    errors,
  };

  const aggregateJsonPath = path.resolve(runDir, 'aggregate.json');
  const aggregateCsvPath = path.resolve(runDir, 'aggregate.csv');
  const aggregateMdPath = path.resolve(runDir, 'aggregate.md');

  fs.writeFileSync(aggregateJsonPath, JSON.stringify(aggregate, null, 2), 'utf8');
  fs.writeFileSync(aggregateCsvPath, toCsv(rows), 'utf8');
  fs.writeFileSync(aggregateMdPath, toMarkdown(rows, config, path.relative(__dirname, runDir) || '.'), 'utf8');

  console.log('\n========================================');
  console.log('k6 VUs 매트릭스 테스트 완료');
  console.log('========================================');
  console.log(`JSON: ${aggregateJsonPath}`);
  console.log(`CSV : ${aggregateCsvPath}`);
  console.log(`MD  : ${aggregateMdPath}`);
  console.log('\n[AGGREGATE RESULT]');
  console.log(JSON.stringify(aggregate, null, 2));
  if (errors.length > 0) {
    console.log(`경고: ${errors.length}개의 실행에서 오류가 발생했습니다.`);
    process.exitCode = 1;
  }
}

run();
