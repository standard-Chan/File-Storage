/**
 * k6 읽기 부하테스트를 위한 파일 목록 생성 스크립트
 * 
 * 사용법:
 *   node generate-file-list.js
 * 
 * 기능:
 *   - uploads/primary/bucket1/k6-load-test/ 디렉토리를 재귀적으로 스캔
 *   - 모든 파일의 objectKey를 수집
 *   - file-list.json 파일로 저장
 */

const fs = require('fs');
const path = require('path');

// 설정
const BUCKET = 'bucket1';
const BASE_PATH = path.join(__dirname, '..', '..', 'uploads/primary', BUCKET, 'k6-load-test');
const OUTPUT_FILE = path.join(__dirname, 'file-list.json');

/**
 * 디렉토리를 재귀적으로 스캔하여 파일 목록 수집
 */
function scanDirectory(dirPath, baseDir) {
  const files = [];
  
  try {
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    
    for (const entry of entries) {
      const fullPath = path.join(dirPath, entry.name);
      
      if (entry.isDirectory()) {
        // 재귀적으로 서브디렉토리 스캔
        files.push(...scanDirectory(fullPath, baseDir));
      } else if (entry.isFile()) {
        // 파일인 경우 objectKey 생성
        const relativePath = path.relative(baseDir, fullPath);
        // Windows 경로 구분자를 Unix 스타일로 변환
        const relativePathUnix = relativePath.replace(/\\/g, '/');
        // k6-load-test/ 프리픽스 추가
        const objectKey = 'k6-load-test/' + relativePathUnix;
        
        // 파일 정보 수집
        const stats = fs.statSync(fullPath);
        files.push({
          objectKey: objectKey,
          size: stats.size,
          path: relativePathUnix,
        });
      }
    }
  } catch (error) {
    console.error(`디렉토리 스캔 실패: ${dirPath}`, error.message);
  }
  
  return files;
}

/**
 * 메인 실행
 */
function main() {
  console.log('========================================');
  console.log('📁 파일 목록 생성 시작');
  console.log('========================================');
  console.log(`스캔 경로: ${BASE_PATH}`);
  
  // 디렉토리 존재 확인
  if (!fs.existsSync(BASE_PATH)) {
    console.error(`❌ 오류: 디렉토리가 존재하지 않습니다: ${BASE_PATH}`);
    console.error('먼저 쓰기 부하테스트를 실행하여 테스트 파일을 생성하세요.');
    process.exit(1);
  }
  
  // 파일 목록 수집
  console.log('파일 스캔 중...');
  const files = scanDirectory(BASE_PATH, BASE_PATH);
  
  if (files.length === 0) {
    console.error('❌ 오류: 스캔된 파일이 없습니다.');
    console.error('먼저 쓰기 부하테스트를 실행하여 테스트 파일을 생성하세요.');
    process.exit(1);
  }
  
  // 통계 계산
  const totalSize = files.reduce((sum, file) => sum + file.size, 0);
  const sizeRanges = {
    '1MB': files.filter(f => f.size <= 2 * 1024 * 1024).length,
    '10MB': files.filter(f => f.size > 2 * 1024 * 1024 && f.size <= 50 * 1024 * 1024).length,
    '100MB': files.filter(f => f.size > 50 * 1024 * 1024 && f.size <= 500 * 1024 * 1024).length,
    '1GB+': files.filter(f => f.size > 500 * 1024 * 1024).length,
  };
  
  // 결과 객체 생성
  const result = {
    bucket: BUCKET,
    generatedAt: new Date().toISOString(),
    totalFiles: files.length,
    totalSizeBytes: totalSize,
    totalSizeMB: (totalSize / (1024 * 1024)).toFixed(2),
    sizeDistribution: sizeRanges,
    files: files,
  };
  
  // JSON 파일로 저장
  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(result, null, 2));
  
  console.log('\n========================================');
  console.log('✅ 파일 목록 생성 완료');
  console.log('========================================');
  console.log(`총 파일 수: ${files.length}`);
  console.log(`총 용량: ${result.totalSizeMB} MB`);
  console.log('\n파일 크기 분포:');
  console.log(`  - 1MB 이하: ${sizeRanges['1MB']} 파일`);
  console.log(`  - 10MB 이하: ${sizeRanges['10MB']} 파일`);
  console.log(`  - 100MB 이하: ${sizeRanges['100MB']} 파일`);
  console.log(`  - 1GB 이상: ${sizeRanges['1GB+']} 파일`);
  console.log(`\n출력 파일: ${OUTPUT_FILE}`);
  console.log('========================================\n');
  
  console.log('다음 명령으로 읽기 부하테스트를 실행하세요:');
  console.log('  k6 run --vus 100 --duration 1m --out experimental-prometheus-rw=http://localhost:9090/api/v1/write k6-read-test.js');
}

// 실행
main();
