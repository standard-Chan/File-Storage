import fp from "fastify-plugin";
import Database from "better-sqlite3";
import { FastifyPluginCallback } from "fastify";
import { CREATE_REPLICATION_QUEUE_TABLE, CREATE_TUS_UPLOADS_TABLE } from "../db/schema";
import {
  createReplicationQueueRepository,
  ReplicationQueueRepository,
} from "../repository/replicationQueue";

const DB_PATH = process.env.SQLITE_DB_PATH ?? "./uploads/replication.db";
const BUSY_TIMEOUT_MS = 5_000;
const DB_TABLE_INIT = process.env.DB_TABLE_INIT ?? false;

const sqlitePlugin: FastifyPluginCallback = (fastify, _opts, done) => {
  let db: InstanceType<typeof Database>;

  try {
    db = new Database(DB_PATH);
  } catch (err) {
    // DB 파일 오픈 자체가 실패하면 서버 부팅을 중단합니다.
    done(
      err instanceof Error
        ? err
        : new Error(`SQLite open failed: ${String(err)}`),
    );
    return;
  }

  db.pragma("journal_mode = DELETE");
  db.pragma("synchronous = FULL");
  db.pragma(`busy_timeout = ${BUSY_TIMEOUT_MS}`);
  db.pragma("temp_store = FILE");

  if (DB_TABLE_INIT) {
    db.exec(CREATE_REPLICATION_QUEUE_TABLE);
    db.exec(CREATE_TUS_UPLOADS_TABLE);
  }

  const replicationQueue: ReplicationQueueRepository =
    createReplicationQueueRepository(db);

  fastify.decorate("db", db);
  fastify.decorate("replicationQueue", replicationQueue);

  // 서버 종료시, connection 제거
  fastify.addHook("onClose", (_instance, done) => {
    try {
      if (db.open) {
        db.close();
        fastify.log.info("[sqlite] connection closed");
      }
      done();
    } catch (err) {
      done(
        err instanceof Error
          ? err
          : new Error(`SQLite close failed: ${String(err)}`),
      );
    }
  });

  fastify.log.info(`[sqlite] opened: ${DB_PATH}`);
  done();
};

export default fp(sqlitePlugin, {
  name: "sqlite",
  fastify: "5.x",
});
