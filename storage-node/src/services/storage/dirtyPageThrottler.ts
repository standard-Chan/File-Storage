import { promises as fsPromises } from "fs";
import { FastifyBaseLogger } from "fastify";

/**
 * Dirty page 기반 디스크 쓰기 throttle
 *
 * Linux page cache의 dirty page 크기를 모니터링하여
 * threshold를 초과할 시 디스크 writeback을 기다림
 *
 * 문제:
 * - 업로드 속도 > 디스크 쓰기 속도일 때 dirty page 급증
 * - page cache가 메모리를 사용하면서 메모리 부족 발생
 *
 * 해결:
 * - dirty page 값을 주기적으로 폴링 (300ms)
 * - threshold 초과 시 감소할 때까지 대기
 */

/**
 * Dirty page 현재 값 캐싱
 */
interface DirtyPageCache {
  value: number; // bytes
  lastUpdated: number; // timestamp
}

/**
 * 환경변수 설정
 */
const DIRTY_PAGE_LIMIT =
  parseInt(process.env.DIRTY_PAGE_LIMIT_MB || "10", 10) * 1024 * 1024; // MB를 bytes로 변환

const POLL_INTERVAL_MS = parseInt(
  process.env.DIRTY_PAGE_POLL_INTERVAL_MS || "300",
  10,
);

const ENABLE_THROTTLE = process.env.ENABLE_DIRTY_PAGE_THROTTLE !== "false";

const WAIT_POLL_INTERVAL_MS = 50; // throttle 대기 중 poll 주기

let dirtyPageCache: DirtyPageCache = {
  value: 0,
  lastUpdated: 0,
};

/**
 * /proc/meminfo에서 Dirty page 크기 조회
 *
 * @returns dirty page 크기 (bytes 단위)
 */
async function readDirtyPageSize(): Promise<number> {
  try {
    const content = await fsPromises.readFile("/proc/meminfo", "utf-8");
    const lines = content.split("\n");

    for (const line of lines) {
      if (line.startsWith("Dirty:")) {
        const match = line.match(/Dirty:\s+(\d+)\s+kB/);
        if (match) {
          const kbValue = parseInt(match[1], 10);
          return kbValue * 1024; // kB를 bytes로 변환
        }
      }
    }

    throw new Error("Dirty page 정보를 파싱할 수 없음");
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    console.error(`[DirtyPageThrottler] /proc/meminfo 읽기 실패: ${errorMsg}`);
    // 에러 발생 시 매우 큰 값을 반환하여 throttle 비활성화
    // (throttler가 작동하지 않도록)
    return Infinity;
  }
}

/**
 * 캐시된 dirty page 크기 획득 (300ms 주기로 갱신)
 *
 * @returns dirty page 크기 (bytes 단위)
 */
async function getDirtyPageSizeCached(): Promise<number> {
  const now = Date.now();
  const timeSinceLastUpdate = now - dirtyPageCache.lastUpdated;

  if (timeSinceLastUpdate >= POLL_INTERVAL_MS) {
    dirtyPageCache.value = await readDirtyPageSize();
    dirtyPageCache.lastUpdated = now;
  }

  return dirtyPageCache.value;
}

/**
 * Dirty page가 threshold 이상이 될 때까지 대기
 */
async function waitForDirtyPageDecrease(log: FastifyBaseLogger): Promise<void> {
  let attempts = 0;
  const maxAttempts = 60000 / WAIT_POLL_INTERVAL_MS; // 60초 타임아웃

  while (attempts < maxAttempts) {
    const currentDirty = await readDirtyPageSize();

    if (currentDirty < DIRTY_PAGE_LIMIT) {
      const dirtyMB = Math.round(currentDirty / 1024 / 1024);
      const limitMB = Math.round(DIRTY_PAGE_LIMIT / 1024 / 1024);
      log.warn(
        `[DirtyPageThrottler] Dirty page 감소: ${dirtyMB}MB (limit: ${limitMB}MB)`,
      );
      break;
    }

    // 50ms 대기 후 재시도
    await new Promise((resolve) => setTimeout(resolve, WAIT_POLL_INTERVAL_MS));
    attempts++;
  }

  if (attempts >= maxAttempts) {
    log.warn("[DirtyPageThrottler] Dirty page throttle 타임아웃 (60초)");
  }
}

/**
 * Dirty page threshold 체크 및 throttle
 *
 * stream write 전에 호출하여 고속 업로드로 인한
 * dirty page 폭증을 방지
 */
export async function throttleIfNeeded(log: FastifyBaseLogger): Promise<void> {
  if (!ENABLE_THROTTLE) {
    return;
  }

  const currentDirty = await getDirtyPageSizeCached();
  log.warn(`[Dirty] : 현재 Dirty ${currentDirty}, Limit ${DIRTY_PAGE_LIMIT}`);

  if (currentDirty >= DIRTY_PAGE_LIMIT) {
    const dirtyMB = Math.round(currentDirty / 1024 / 1024);
    const limitMB = Math.round(DIRTY_PAGE_LIMIT / 1024 / 1024);

    log.warn(
      `[DirtyPageThrottler] dirty page 초과: ${dirtyMB}MB (limit: ${limitMB}MB), 대기 중...`,
    );

    await waitForDirtyPageDecrease(log);
  }
}

/**
 * 현재 dirty page 크기 조회 (외부 모니터링용)
 *
 * @returns dirty page 크기 (bytes 단위)
 */
export async function getCurrentDirtyPage(): Promise<number> {
  return getDirtyPageSizeCached();
}

/**
 * Dirty page throttle 상태 조회
 */
export function getThrottleConfig(): {
  enabled: boolean;
  limitMB: number;
  pollIntervalMs: number;
} {
  return {
    enabled: ENABLE_THROTTLE,
    limitMB: Math.round(DIRTY_PAGE_LIMIT / 1024 / 1024),
    pollIntervalMs: POLL_INTERVAL_MS,
  };
}
