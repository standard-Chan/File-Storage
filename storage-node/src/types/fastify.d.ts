import { MySQLPromisePool } from "@fastify/mysql";
import type { Database } from "better-sqlite3";
import type { ReplicationQueueRepository } from "../repository/replicationQueue";
import type { Server as TusServer } from "tus-node-server";

declare module "fastify" {
  interface FastifyInstance {
    mysql: MySQLPromisePool;
    /** better-sqlite3 Database 인스턴스 (raw access 필요 시 사용) */
    db: InstanceType<typeof Database>;
    /** replication_queue 테이블 전용 typed 쿼리 함수 집합 */
    replicationQueue: ReplicationQueueRepository;
    /** TUS 프로토콜 서버 (resume upload) */
    tusServer: TusServer;
  }
}