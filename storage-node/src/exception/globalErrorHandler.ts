import { FastifyReply, FastifyRequest } from "fastify";
import { HttpError } from "../utils/HttpError";

export function handleGlobalError(
  err: unknown,
  req: FastifyRequest,
  reply: FastifyReply,
) {
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
}