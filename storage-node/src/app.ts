import dotenv from "dotenv";
import { join } from "node:path";
import AutoLoad, { AutoloadPluginOptions } from "@fastify/autoload";
import { FastifyPluginAsync, FastifyServerOptions } from "fastify";
import {
  startReplicationWorker,
  stopReplicationWorker,
} from "./services/replication/replicationWorker";

dotenv.config();
export interface AppOptions
  extends FastifyServerOptions, Partial<AutoloadPluginOptions> {}
const options: AppOptions = {
  disableRequestLogging: true,
};

/**
 * Fastify 앱의 메인 함수 (플러그인, Hook, Routes 등록)
 */
const app: FastifyPluginAsync<AppOptions> = async (
  fastify,
  opts,
): Promise<void> => {
  void fastify.register(AutoLoad, {
    dir: join(__dirname, "plugins"),
    options: opts,
  });

  void fastify.register(AutoLoad, {
    dir: join(__dirname, "routes"),
    options: opts,
  });

  // replication retry worker 실행
  fastify.addHook("onReady", function (done) {
    startReplicationWorker(fastify.replicationQueue, fastify.log);
    done();
  });

  fastify.addHook("onClose", function (_instance, done) {
    stopReplicationWorker(fastify.log);
    done();
  });
};

export default app;
export { app, options };
