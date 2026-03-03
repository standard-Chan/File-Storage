import Database, { Statement } from "better-sqlite3";
import TusFile from "tus-node-server/lib/models/File";
import { IFile } from "tus-node-server";

const QUERIES = {
  GET: `
    SELECT id, upload_length, upload_defer_length, upload_metadata 
    FROM tus_uploads 
    WHERE id = ?
  `,
  SET: `
    INSERT OR REPLACE INTO tus_uploads 
    (id, upload_length, upload_defer_length, upload_metadata) 
    VALUES (?, ?, ?, ?)
  `,
  DELETE: `
    DELETE FROM tus_uploads 
    WHERE id = ?
  `,
} as const;

/**
 * tus-node-server FileStore용 Configstore.
 */
export default class SqliteConfigstore {
  private readonly getStmt: Statement;
  private readonly setStmt: Statement;
  private readonly deleteStmt: Statement;

  constructor(db: InstanceType<typeof Database>) {
    this.getStmt = db.prepare(QUERIES.GET);
    this.setStmt = db.prepare(QUERIES.SET);
    this.deleteStmt = db.prepare(QUERIES.DELETE);
  }

  async get(key: string): Promise<IFile | undefined> {
    const row = this.getStmt.get(key) as TusFile | undefined;
    if (row === undefined) return undefined;

    const file = new TusFile(
      row.id,
      row.upload_length ?? "",
      row.upload_defer_length ?? "",
      row.upload_metadata ?? "",
    );
    return file as IFile;
  }

  async set(key: string, value: IFile): Promise<void> {
    const { upload_length, upload_defer_length, upload_metadata } = value;
    this.setStmt.run(
      key,
      upload_length || null,
      upload_defer_length || null,
      upload_metadata || null,
    );
  }

  async delete(key: string): Promise<boolean> {
    const result = this.deleteStmt.run(key);
    return result.changes > 0;
  }
}
