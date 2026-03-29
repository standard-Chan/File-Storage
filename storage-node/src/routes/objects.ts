import { FastifyPluginAsync } from "fastify";
import {
  sendErrorResponse,
  createSuccessResponse,
} from "../services/response/apiResponse";
import { HttpError } from "../utils/HttpError";
import { downloadFile, uploadFile } from "../services/objects/objectService";
// import { UploadLimiter } from "../services/objects/UploadLimiter";

export interface PresignedQuery {
  bucket: string;
  objectKey: string;
  method: string;
  exp: string;
  fileSize: string;
  signature: string;
}

interface ObjectParams {
  bucket: string;
  "*": string;
}

const objects: FastifyPluginAsync = async (fastify, opts): Promise<void> => {
  // const uploadLimiter = UploadLimiter.getInstance();

  fastify.addContentTypeParser("*", function (_request, payload, done) {
    done(null, payload);
  });

  /**
   * GET /objects/:bucket/:key
   * - 파일 다운로드 엔드포인트
   */
  fastify.get<{
    Params: ObjectParams;
    Querystring: PresignedQuery;
  }>("/objects/direct/:bucket/*", async function (request, reply) {
    try {
      const { fileStream, contentType } = await downloadFile(request);

      reply.header("Content-Type", contentType);
      return reply.send(fileStream);
    } catch (error) {
      if (error instanceof HttpError) {
        fastify.log.warn(
          { error: error.message, statusCode: error.statusCode },
          "Validation failed",
        );
        return sendErrorResponse(
          reply,
          error.statusCode,
          error.message,
          error.data,
        );
      }
      fastify.log.error({ error }, "File download error");
      return sendErrorResponse(
        reply,
        500,
        "파일 다운로드 중 오류가 발생했습니다",
        {
          error: error instanceof Error ? error.message : "알 수 없는 오류",
        },
      );
    }
  });

  /**
   * PUT /objects/:bucket/:key
   * - 파일 업로드 엔드포인트
   */
  fastify.put<{
    Params: ObjectParams;
    Querystring: PresignedQuery;
  }>("/objects/direct/:bucket/*", async function (request, reply) {
    // const fileSize = Number(request.query.fileSize);
    // const acquired = uploadLimiter.tryAcquire(fileSize, request);

    // if (!fileSize || !acquired) {
    //   request.log.warn(`[Upload Limiter] 업로드 요청이 과도하게 발생하였습니다`);
    //   return reply.code(429).send({
    //     message: "현재 과도한 업로드 요청으로 인해 처리할 수 없습니다",
    //   });
    // }

    try {
      const fileInfo = await uploadFile(request, fastify.replicationQueue);
      return reply.code(201).send(createSuccessResponse(fileInfo));
    } catch (error) {
      if (error instanceof HttpError) {
        fastify.log.warn(
          { error: error.message, statusCode: error.statusCode },
          "Validation failed",
        );
        return sendErrorResponse(
          reply,
          error.statusCode,
          error.message,
          error.data,
        );
      }
      fastify.log.error({ error }, "File upload error");
      return sendErrorResponse(
        reply,
        500,
        "파일 업로드 중 오류가 발생했습니다",
        {
          error: error instanceof Error ? error.message : "알 수 없는 오류",
        },
      );
    } 
    // finally {
    //   // uploadLimiter.release(fileSize);
    // }
  });
};

export default objects;
