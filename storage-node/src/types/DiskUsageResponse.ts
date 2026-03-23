/**
 * 디스크 사용량 정보 응답 DTO
 */
export interface DiskUsageResponse {
  nodeIp: string;
  totalSpace: number;       // bytes
  usedSpace: number;        // bytes
  availableSpace: number;   // bytes
  usagePercentage: number;  // 0-100
  timestamp: string;        // ISO 8601 format
}
