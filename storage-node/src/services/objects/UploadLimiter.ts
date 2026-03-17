import { MB } from "../../constants/sizes";

interface UploadLimiterOptions {
  maxUsage: number;
  baseUnitMb: number;
  maxFileSizeMb: number;
}

export class UploadLimiter {
  private static instance: UploadLimiter;
  private activeUsage: number;
  private readonly maxUsage: number;
  private readonly standardMb: number;

  private constructor(options?: Partial<UploadLimiterOptions>) {
    const maxUsage = options?.maxUsage ?? 100;
    const standardMb = options?.baseUnitMb ?? 5;

    this.maxUsage = maxUsage;
    this.standardMb = standardMb;
    this.activeUsage = 0;
  }

  static getInstance(options?: Partial<UploadLimiterOptions>) {
    if (!UploadLimiter.instance) {
      UploadLimiter.instance = new UploadLimiter(options);
    }
    return UploadLimiter.instance;
  }

  /**
   * fileSize 에 따른 사용 가중치를 반환한다
   * @returns 가중치 반환
   * 1 미만 : 1 반환
   * 1 ~ 기준 :  정수 값 반환
   * n >= 기준(standardMb) : 기준(standardMb) 반환
   */
  private getWeight(fileSize: number): number {
    const fileSizeMb = Math.ceil(fileSize / MB);
    return Math.max(1, Math.min(fileSizeMb, this.standardMb));
  }

  tryAcquire(fileSize: number): boolean {
    const weight = this.getWeight(fileSize);

    if (this.activeUsage + weight > this.maxUsage) {
      return false;
    }

    this.activeUsage += weight;
    return true;
  }

  release(fileSize: number): void {
    const weight = this.getWeight(fileSize);
    this.activeUsage = Math.max(0, this.activeUsage - weight);
  }
}
