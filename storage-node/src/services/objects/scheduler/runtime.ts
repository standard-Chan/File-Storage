import { loadSchedulerConfig } from "./config";
import { SizeAndWaitScorePolicy } from "./scorePolicy/ScorePolicy";
import { UploadScheduler } from "./UploadScheduler";

/**
 * 스케줄러 싱글턴을 지연 초기화하여 반환한다.
 */
export function getOrCreateUploadScheduler(): UploadScheduler {
  try {
    return UploadScheduler.getInstance();
  } catch {
    const config = loadSchedulerConfig();
    const scorePolicy = new SizeAndWaitScorePolicy({
      maxSizePriority: config.maxSizePriority,
      maxWaitBonus: config.maxWaitBonus,
    });

    UploadScheduler.initialize(config, scorePolicy);
    const scheduler = UploadScheduler.getInstance();
    scheduler.start();
    return scheduler;
  }
}
