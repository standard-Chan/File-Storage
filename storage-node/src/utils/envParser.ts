/**
 * 양의 정수만 허용하는 환경변수 파서
 *
 * @param value 환경변수 문자열 (e.g., "100", "20485760")
 * @param fallback 파싱 실패 또는 undefined 시 반환할 기본값
 * @returns 파싱된 양의 정수
 */
export function parsePositiveInt(value: string | undefined, fallback: number): number {
  if (!value) {
    return fallback;
  }

  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`유효하지 않은 양의 정수 환경변수 값: ${value}`);
  }

  return parsed;
}

/**
 * 0 이상의 정수만 허용하는 환경변수 파서
 *
 * @param value 환경변수 문자열 (e.g., "0", "20", "100")
 * @param fallback 파싱 실패 또는 undefined 시 반환할 기본값
 * @returns 파싱된 0 이상의 정수
 *
 */
export function parseNonNegativeInt(value: string | undefined, fallback: number): number {
  if (!value) {
    return fallback;
  }

  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`유효하지 않은 0 이상 정수 환경변수 값: ${value}`);
  }

  return parsed;
}
