import Database, { Statement } from "better-sqlite3";

interface UploadRow {
  expires_at: string | null;
}

const QUERIES = {
  // tus가 아직 행을 만들기 전에 선점 삽입; 이미 있으면 expires_at만 갱신
  UPSERT_SESSION: `
    INSERT INTO tus_uploads (id, expires_at)
    VALUES (?, ?)
    ON CONFLICT(id) DO UPDATE SET
      expires_at = excluded.expires_at
  `,
  GET_EXPIRES: `
    SELECT expires_at
    FROM tus_uploads
    WHERE id = ?
  `,
  // 행 자체는 tus가 관리하므로 expires_at만 NULL로 초기화
  CLEAR_EXPIRES: `
    UPDATE tus_uploads SET expires_at = NULL WHERE id = ?
  `,
} as const;

/** Unix timestamp(초)를 SQLite DATETIME 형식으로 변환 */
function toDatetime(unixSec: number): string {
  return new Date(unixSec * 1000).toISOString().replace("T", " ").slice(0, 19);
}

/**
 * TUS 업로드 세션 저장소.
 * tus_uploads 테이블의 expires_at 컬럼을 통해 세션 만료·인가를 검증한다.
 *
 * - 세션(expires_at) 없음 → 인가되지 않은 요청 (404)
 * - 세션 만료 → exp 초과 (410 Gone)
 */
export class TusSessionStore {
  private readonly upsertSessionStmt: Statement;
  private readonly getExpiresStmt: Statement;
  private readonly clearExpiresStmt: Statement;

  constructor(db: InstanceType<typeof Database>) {
    this.upsertSessionStmt = db.prepare(QUERIES.UPSERT_SESSION);
    this.getExpiresStmt = db.prepare(QUERIES.GET_EXPIRES);
    this.clearExpiresStmt = db.prepare(QUERIES.CLEAR_EXPIRES);
  }

  /**
   * 세션 등록.
   * tus가 행을 생성하기 전에 호출해도 충돌 없이 upsert된다.
   * @param fileId   tus namingFunction이 반환하는 ID (bucket/objectKey)
   * @param expiresAt Presigned URL의 exp 값 (Unix timestamp, 초 단위)
   */
  create(fileId: string, expiresAt: number): void {
    const expiresDatetime = toDatetime(expiresAt);
    this.upsertSessionStmt.run(fileId, expiresDatetime);
  }

  /**
   * 세션 유효성 검사.
   * @returns "ok" | "not_found" | "expired"
   */
  validate(fileId: string): "ok" | "not_found" | "expired" {
    const row = this.getExpiresStmt.get(fileId) as UploadRow | undefined;
    if (!row || row.expires_at === null) return "not_found";

    const expiresMs = new Date(row.expires_at + "Z").getTime();
    if (Date.now() > expiresMs) return "expired";

    return "ok";
  }

  /**
   * 세션 무효화 (업로드 완료 또는 취소 시 호출).
   * 행 자체는 tus가 담당하므로 expires_at만 NULL로 초기화한다.
   */
  delete(fileId: string): void {
    this.clearExpiresStmt.run(fileId);
  }
}
