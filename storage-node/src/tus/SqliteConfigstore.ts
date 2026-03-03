import Database, { Statement } from "better-sqlite3";
import TusFile from "tus-node-server/lib/models/File";
import { IFile } from "tus-node-server";

/**
 * tus-node-server FileStore용 Configstore.
 */
export default class SqliteConfigstore {
  private readonly getStmt: Statement;
  private readonly setStmt: Statement;
  private readonly deleteStmt: Statement;

  constructor(db: InstanceType<typeof Database>) {
    this.getStmt = db.prepare(
      "SELECT id, upload_length, upload_defer_length, upload_metadata FROM tus_uploads WHERE id = ?",
    );
    this.setStmt = db.prepare(
      "INSERT OR REPLACE INTO tus_uploads (id, upload_length, upload_defer_length, upload_metadata) VALUES (?, ?, ?, ?)",
    );
    this.deleteStmt = db.prepare(
      "DELETE FROM tus_uploads WHERE id = ?",
    );
  }

  async get(key: string): Promise<IFile | undefined> {
    const row = this.getStmt.get(key) as TusFile | undefined;
    if (row === undefined) return undefined;
    // TusFile로 객체를 생성. size는 FileStore.getOffset()이 동적으로 주입하므로 저장 대상이 아님
    const file = new TusFile(
      row.id,
      row.upload_length ?? "",
      row.upload_defer_length ?? "",
      row.upload_metadata ?? "",
    );
    return file as unknown as IFile;
  }

  async set(key: string, value: IFile): Promise<void> {
    this.setStmt.run([
      key,
      value.upload_length || null,
      value.upload_defer_length || null,
      value.upload_metadata || null,
    ]);
  }

  async delete(key: string): Promise<boolean> {
    const result = this.deleteStmt.run(key);
    return result.changes > 0;
  }
}