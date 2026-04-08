import http from 'k6/http';
import { check, sleep } from 'k6';
import { SharedArray } from 'k6/data';
import { randomItem } from 'https://jslib.k6.io/k6-utils/1.2.0/index.js';
import { textSummary } from 'https://jslib.k6.io/k6-summary/0.0.1/index.js';

/**
 * k6 읽기(GET) 부하 테스트 스크립트
 * 
 * 사용법:
 *   1. 먼저 파일 목록 생성: node generate-file-list.js
 * 
 *   2. 부하 테스트 실행:
 * 
 *      # 랜덤 읽기 (기본값, 실제 워크로드 시뮬레이션, 캐시 효과 포함)
 *      k6 run --vus 100 --duration 1m --out experimental-prometheus-rw=http://localhost:9090/api/v1/write k6-read-test.js
 * 
 *      # 순차 읽기 (캐시 효과 감소)
 *      k6 run --vus 100 --duration 1m --env READ_MODE=sequential --out experimental-prometheus-rw=http://localhost:9090/api/v1/write k6-read-test.js
 * 
 *      # 고유 파일 읽기 (순수 디스크 I/O, 캐시 최소화) ⭐ 추천
 *      k6 run --vus 20 --duration 2m --env READ_MODE=unique --out experimental-prometheus-rw=http://localhost:9090/api/v1/write k6-read-test.js
 * 
 * 옵션:
 *   --vus: 동시 가상 사용자 수 (기본값: 10)
 *   --duration: 테스트 지속 시간 (기본값: 30s)
 *   --env READ_MODE: 읽기 모드 (random|sequential|unique, 기본값: random)
 *   --env BUCKET: 사용할 버킷 이름 (기본값: bucket1)
 *   --env CONTROL_PLANE_URL: Control Plane URL (기본값: http://localhost:8080)
 * 
 * 읽기 모드 설명:
 *   - random: 완전 랜덤 선택 (실제 워크로드, 캐시 효과 포함)
 *   - sequential: 순차적으로 파일 읽기 (캐시 효과 감소)
 *   - unique: 각 요청이 다른 파일 읽기 (순수 디스크 I/O 측정)
 */

// 환경 설정
const CONTROL_PLANE_URL = __ENV.CONTROL_PLANE_URL || 'http://localhost:8080';
const BUCKET = __ENV.BUCKET || 'bucket1';
const READ_MODE = __ENV.READ_MODE || 'unique'; // 'random', 'sequential', 'unique'

// 파일 목록 로드 (모든 VU가 공유)
const fileList = new SharedArray('files', function () {
  try {
    const fileListData = JSON.parse(open('./file-list.json'));
    console.log(`파일 목록 로드 성공: ${fileListData.totalFiles} 파일`);
    return fileListData.files;
  } catch (error) {
    console.error('파일 목록 로드 실패:', error);
    console.error('먼저 "node generate-file-list.js"를 실행하여 파일 목록을 생성하세요.');
    throw error;
  }
});

// k6 테스트 옵션
export const options = {
  // 동시 사용자 수 (CLI에서 --vus로 오버라이드 가능)
  vus: 100,
  
  // 테스트 지속 시간 (CLI에서 --duration으로 오버라이드 가능)
  duration: '1m',
  
  // 스테이지를 사용한 단계적 부하 증가 (옵션)
  // 주석을 해제하여 사용
  // stages: [
  //   { duration: '30s', target: 10 },  // 30초 동안 10 VUs로 증가
  //   { duration: '1m', target: 50 },   // 1분 동안 50 VUs로 증가
  //   { duration: '1m', target: 100 },  // 1분 동안 100 VUs로 증가
  //   { duration: '30s', target: 0 },   // 30초 동안 0으로 감소
  // ],
  
  // 임계값 (성공 기준)
  thresholds: {
    http_req_failed: ['rate<0.1'],        // 실패율 10% 미만
    http_req_duration: ['p(95)<5000'],    // 95% 요청이 5초 이내
    'http_req_duration{name:get_presigned_url}': ['p(95)<1000'],  // Presigned URL 발급 1초 이내
    'http_req_duration{name:download_file}': ['p(95)<10000'],     // 파일 다운로드 10초 이내
  },
  
  // 요약 통계 설정
  summaryTrendStats: ['avg', 'min', 'med', 'max', 'p(90)', 'p(95)', 'p(99)'],
};

/**
 * GET용 Presigned URL 발급
 */
function getPresignedUrlForRead(bucket, objectKey) {
  const payload = JSON.stringify({
    bucket: bucket,
    objectKey: objectKey,
    fileSize: 1234
  });

  const response = http.post(
    `${CONTROL_PLANE_URL}/api/storage/presigned-url/get`,
    payload,
    {
      headers: {
        'Content-Type': 'application/json',
      },
      tags: { name: 'get_presigned_url' },
    }
  );

  check(response, {
    'Presigned URL 발급 성공': (r) => r.status === 200,
    'Presigned URL 응답에 presignedUrl 포함': (r) => {
      try {
        const body = JSON.parse(r.body);
        return body.presignedUrl !== undefined;
      } catch {
        return false;
      }
    },
  });

  if (response.status !== 200) {
    console.error(`Presigned URL 발급 실패: ${response.status} - ${response.body}`);
    return null;
  }

  const data = JSON.parse(response.body);
  return data.presignedUrl;
}

/**
 * 파일 다운로드
 */
function downloadFile(presignedUrl, expectedSize) {
  const response = http.get(
    presignedUrl,
    {
      tags: { 
        name: 'download_file',
        file_size: fileSizeLabel(expectedSize),
      },
      timeout: '60s', // 큰 파일 다운로드를 위한 타임아웃
      responseType: 'binary', // 바이너리 응답 처리
    }
  );

  const downloadSuccess = check(response, {
    '파일 다운로드 성공': (r) => r.status === 200,
    '응답 크기 일치 (Content-Length)': (r) => {
      if (r.status !== 200) return false;
      
      // Content-Length 헤더에서 실제 크기 확인
      const contentLength = r.headers['Content-Length'];
      if (!contentLength) {
        console.warn(`Content-Length 헤더가 없습니다.`);
        return true; // 헤더가 없으면 검증 스킵
      }
      
      const actualSize = parseInt(contentLength, 10);
      const sizeDiff = Math.abs(actualSize - expectedSize);
      const isValid = sizeDiff < 1024; // 1KB 이내 오차 허용
      
      if (!isValid) {
        console.warn(`크기 불일치: 예상=${expectedSize}, 실제=${actualSize}, 차이=${sizeDiff}`);
      }
      
      return isValid;
    },
  });

  if (!downloadSuccess) {
    console.error(`파일 다운로드 실패: ${response.status}`);
  }

  return downloadSuccess;
}

/**
 * 파일 크기 레이블 반환
 */
function fileSizeLabel(size) {
  if (size < 2 * 1024 * 1024) return '1MB';
  if (size < 50 * 1024 * 1024) return '10MB';
  if (size < 500 * 1024 * 1024) return '100MB';
  return '1GB+';
}

/**
 * 읽기 모드에 따라 파일 선택
 */
function selectFile(mode, fileList, vuId, iterationId) {
  switch (mode) {
    case 'sequential':
      // 순차 읽기: 각 VU가 고유한 시작점에서 순차적으로 읽기
      // 캐시 효과를 줄이지만, 완전히 제거하지는 못함
      const seqIndex = ((vuId - 1) + (iterationId * 100)) % fileList.length;
      return fileList[seqIndex];
      
    case 'unique':
      // 고유 읽기: 각 요청이 다른 파일을 읽도록 보장 (캐시 최소화)
      // 전체 요청 수가 파일 수를 초과하면 순환
      const uniqueIndex = ((vuId - 1) * 10000 + iterationId) % fileList.length;
      return fileList[uniqueIndex];
      
    case 'random':
    default:
      // 랜덤 읽기: 실제 워크로드 시뮬레이션 (캐시 효과 포함)
      return randomItem(fileList);
  }
}

/**
 * 메인 테스트 시나리오
 */
export default function () {
  // 파일 목록이 비어있으면 종료
  if (!fileList || fileList.length === 0) {
    console.error('파일 목록이 비어있습니다. 먼저 generate-file-list.js를 실행하세요.');
    return;
  }
  
  const vuId = __VU; // Virtual User ID
  const iterationId = __ITER; // Iteration ID
  
  // 읽기 모드에 따라 파일 선택
  const selectedFile = selectFile(READ_MODE, fileList, vuId, iterationId);
  const objectKey = selectedFile.objectKey;
  const fileSize = selectedFile.size;
  
  console.log(`[VU ${vuId}] 다운로드 시작 (${READ_MODE} 모드): ${fileSizeLabel(fileSize)}, objectKey=${objectKey}`);
  
  // 1. GET용 Presigned URL 발급
  const presignedUrl = getPresignedUrlForRead(BUCKET, objectKey);
  
  if (!presignedUrl) {
    console.error(`[VU ${vuId}] Presigned URL 발급 실패, 다운로드 중단`);
    sleep(1);
    return;
  }
  
  // 2. 파일 다운로드
  const downloadSuccess = downloadFile(presignedUrl, fileSize);
  
  if (downloadSuccess) {
    console.log(`[VU ${vuId}] ✅ 다운로드 성공: ${fileSizeLabel(fileSize)}, ${(fileSize / 1024 / 1024).toFixed(2)} MB`);
  } else {
    console.log(`[VU ${vuId}] ❌ 다운로드 실패: ${objectKey}`);
  }
  // VU당 동시에 최대 1개의 요청만 처리: 응답이 돌아올 때까지 다음 요청을 보내지 않음.
  // sleep 없이 즉시 다음 반복 → VU 수 = 동시 진행 중인 요청 수
}

/**
 * 테스트 시작 시 실행
 */
export function setup() {
  console.log('========================================');
  console.log('📖 k6 읽기(GET) 부하 테스트 시작');
  console.log('========================================');
  console.log(`Control Plane URL: ${CONTROL_PLANE_URL}`);
  console.log(`Target Bucket: ${BUCKET}`);
  console.log(`Read Mode: ${READ_MODE}`);
  console.log(`Virtual Users: ${options.vus}`);
  console.log(`Duration: ${options.duration}`);
  console.log(`테스트 파일 수: ${fileList.length}`);
  
  // 읽기 모드 설명
  console.log('\n📚 읽기 모드 설명:');
  switch (READ_MODE) {
    case 'random':
      console.log('  ✅ RANDOM: 완전 랜덤 선택 (실제 워크로드, 캐시 효과 포함)');
      break;
    case 'sequential':
      console.log('  ✅ SEQUENTIAL: 순차 읽기 (캐시 효과 감소)');
      break;
    case 'unique':
      console.log('  ✅ UNIQUE: 고유 파일 읽기 (순수 디스크 I/O, 캐시 최소화)');
      console.log('      → 각 요청이 다른 파일을 읽어 캐시 영향 최소화');
      break;
  }
  
  // 파일 크기 분포 계산
  const sizeDistribution = {
    '1MB': fileList.filter(f => f.size < 2 * 1024 * 1024).length,
    '10MB': fileList.filter(f => f.size >= 2 * 1024 * 1024 && f.size < 50 * 1024 * 1024).length,
    '100MB': fileList.filter(f => f.size >= 50 * 1024 * 1024 && f.size < 500 * 1024 * 1024).length,
    '1GB+': fileList.filter(f => f.size >= 500 * 1024 * 1024).length,
  };
  
  console.log('\n파일 크기 분포:');
  console.log(`  - 1MB: ${sizeDistribution['1MB']} 파일`);
  console.log(`  - 10MB: ${sizeDistribution['10MB']} 파일`);
  console.log(`  - 100MB: ${sizeDistribution['100MB']} 파일`);
  console.log(`  - 1GB+: ${sizeDistribution['1GB+']} 파일`);
  console.log('========================================\n');
}

/**
 * 테스트 종료 시 실행
 */
export function teardown(data) {
  console.log('\n========================================');
  console.log('✅ k6 읽기(GET) 부하 테스트 완료');
  console.log('========================================');
}

/**
 * 테스트 결과 요약
 */
export function handleSummary(data) {
  // textSummary를 사용하여 상세 통계 출력
  return {
    'stdout': textSummary(data, { indent: ' ', enableColors: true }),
    'summary-read.json': JSON.stringify(data, null, 2),
  };
}
