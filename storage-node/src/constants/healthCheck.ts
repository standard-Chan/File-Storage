// ─── Health 상태 ─────────────────────────────────────────────────────────────

export const HEALTH_STATUS_OK = 'ok' as const;
export const HEALTH_STATUS_ERROR = 'error' as const;

export type HealthStatus = typeof HEALTH_STATUS_OK | typeof HEALTH_STATUS_ERROR;

// ─── API 경로 ─────────────────────────────────────────────────────────────────

export const HEALTH_CHECK_PATH = '/health'; 