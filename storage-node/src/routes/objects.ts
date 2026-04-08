import { FastifyPluginAsync } from "fastify";
import {
  createSuccessResponse,
} from "../services/response/apiResponse";
import { downloadFile, uploadFile } from "../services/objects/objectService";

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
    const { fileStream, contentType } = await downloadFile(request);

    reply.header("Content-Type", contentType);
    return reply.send(fileStream);
  });

  /**
   * PUT /objects/:bucket/:key
   * - 파일 업로드 엔드포인트
   */
  fastify.put<{
    Params: ObjectParams;
    Querystring: PresignedQuery;
  }>("/objects/direct/:bucket/*", async function (request, reply) {
    const fileInfo = await uploadFile(request, fastify.replicationQueue);
    return reply.code(201).send(createSuccessResponse(fileInfo));
  });
};

export default objects;
