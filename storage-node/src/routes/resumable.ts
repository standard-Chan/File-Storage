import { FastifyPluginAsync } from "fastify";
import { PresignedQuery } from "./objects";
import { validatePresignedUrlRequest } from "../services/validation/presignedUrl";
import { sendErrorResponse } from "../services/response/apiResponse";
import { HttpError } from "../utils/HttpError";

/**
 * TUS 재개 업로드 라우트
 *
 * POST   /objects/resumable/*  → Presigned URL 검증 후 tus 세션 생성
 *                                응답 Location: /files/{id}
 * PATCH  /files/*              → 청크 업로드 (검증 없음)
 * HEAD   /files/*              → 업로드 오프셋 조회
 * DELETE /files/*              → 업로드 취소
 */
const resumable: FastifyPluginAsync = async (fastify): Promise<void> => {
  fastify.addContentTypeParser("*", function (_request, payload, done) {
    done(null, payload);
  });
  /**
   * POST /objects/resumable/*
   * - Presigned URL 검증 (PUT과 동일) → 통과 시 tus로 세션 생성 위임
   * - tus의 path가 /files 이므로, URL을 /files?<query>로 재작성 후 위임
   *   → tus가 응답하는 Location 헤더: /files/{id}
   */
  fastify.post<{ Querystring: PresignedQuery }>(
    "/objects/resumable/*",
    (req, res) => {
      try {
        validatePresignedUrlRequest(req.query, "POST");
      } catch (error) {
        if (error instanceof HttpError) {
          fastify.log.warn(
            { error: error.message, statusCode: error.statusCode },
            "[TUS] Presigned URL 검증 실패",
          );
          return sendErrorResponse(
            res,
            error.statusCode,
            error.message,
            error.data,
          );
        }
        fastify.log.error({ error }, "[TUS] 검증 중 예상치 못한 오류");
        return sendErrorResponse(res, 500, "검증 중 오류가 발생했습니다");
      }

      const originalUrl = new URL(req.raw.url!, "http://localhost");
      req.raw.url = `/tus/objects/${originalUrl.search}`;
      
      fastify.tusServer.handle(req.raw, res.raw);
    },
  );

  /**
   * PATCH / HEAD / DELETE /files/*
   * - 청크 업로드, 오프셋 조회, 업로드 취소
   * - 검증 없이 tus 서버에 위임
   */
  fastify.all("/tus/objects/*", (req, res) => {
    fastify.tusServer.handle(req.raw, res.raw);
  });
};

export default resumable;
