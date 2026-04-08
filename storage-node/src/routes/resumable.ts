import { FastifyPluginAsync } from "fastify";
import { PresignedQuery } from "./objects";
import { validatePresignedUrlRequest } from "../services/validation/presignedUrl";
import { HttpError } from "../utils/HttpError";

/**
 * TUS 재개 업로드 라우트
 *
 * POST   /objects/resumable/*  → Presigned URL 검증 후 tus 세션 생성
 *                                응답 Location: /tus/objects/{bucket}/{objectKey}
 * PATCH  /tus/objects/*        → 세션 유효성 검증 후 청크 업로드
 * HEAD   /tus/objects/*        → 세션 유효성 검증 후 업로드 오프셋 조회
 * DELETE /tus/objects/*        → 세션 유효성 검증 후 업로드 취소
 */
const resumable: FastifyPluginAsync = async (fastify): Promise<void> => {
  fastify.addContentTypeParser("*", function (_request, payload, done) {
    done(null, payload);
  });

  /**
   * POST /objects/resumable/*
   * - Presigned URL 검증 → 통과 시 SQLite에 세션 등록
   * - tus가 응답하는 Location 헤더: /tus/objects/{bucket}/{objectKey}
   */
  fastify.post<{ Querystring: PresignedQuery }>(
    "/objects/resumable/*",
    async (req, res) => {
      validatePresignedUrlRequest(req.query, "POST");

      const { bucket, objectKey, exp } = req.query;
      const fileId = `${bucket}/${objectKey}`;
      const expiresAt = parseInt(exp, 10);

      fastify.tusSessionStore.create(fileId, expiresAt);
      fastify.log.info({ fileId, expiresAt }, "[TUS] 세션 등록");

      const originalUrl = new URL(req.raw.url!, process.env.LOCAL_HOST);
      req.raw.url = `/tus/objects${originalUrl.search}`;
      
      fastify.tusServer.handle(req.raw, res.raw);
    },
  );

  /**
   * PATCH / HEAD / DELETE /tus/objects/*
   * - SQLite 세션 조회로 만료·미인가 요청 차단
   */
  fastify.all("/tus/objects/*", (req, res) => {
    const pathname = new URL(req.raw.url!, process.env.LOCAL_HOST).pathname;
    const fileId = pathname.replace(/^\/tus\/objects\//, "");

    if (fileId) {
      const result = fastify.tusSessionStore.validate(fileId);

      if (result === "not_found") {
        fastify.log.warn({ fileId }, "[TUS] 세션 없음 - 미인가 요청");
          throw new HttpError(404, "인가되지 않은 요청입니다. ");
      }

      if (result === "expired") {
        fastify.log.warn({ fileId }, "[TUS] 세션 만료");
          throw new HttpError(410, "업로드 세션이 만료되었습니다");
      }
    }

    fastify.tusServer.handle(req.raw, res.raw);
  });
};

export default resumable;
