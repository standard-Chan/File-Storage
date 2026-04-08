import dotenv from "dotenv";
import { join } from "node:path";
import AutoLoad, { AutoloadPluginOptions } from "@fastify/autoload";
import { FastifyPluginAsync, FastifyServerOptions } from "fastify";
import {
  startReplicationWorker,
  stopReplicationWorker,
} from "./services/replication/replicationWorker";
import { NodeIpDetector } from "./utils/NodeIpDetector";
import { HttpError } from "./utils/HttpError";

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

  fastify.setErrorHandler((err, req, reply) => {
    if (err instanceof HttpError) {
      req.log.warn(
        { error: err.message, statusCode: err.statusCode, data: err.data },
        "Request validation failed",
      );

      return reply.status(err.statusCode).send({
        success: false,
        message: err.message,
        ...(err.data ?? {}),
      });
    }

    req.log.error(err);
    return reply.status(500).send({
      success: false,
      message: "서버 내부 오류가 발생했습니다",
    });
  });

  // log
  fastify.log.info(`서버 IP : ${NodeIpDetector.getCurrentNodeIp()}`);
};

export default app;
export { app, options };
