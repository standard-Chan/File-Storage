import { FastifyPluginAsync } from "fastify";
import {
  createSuccessResponse,
} from "../services/response/apiResponse";
import {
  receiveReplication,
  ReplicateQuery,
} from "../services/replication/receiveReplication";

const replications: FastifyPluginAsync = async (fastify, opts): Promise<void> => {
  // multipart 파서가 처리하지 않는 Content-Type(raw binary 등)을 스트림으로 그대로 통과
  fastify.addContentTypeParser(
    "*",
    function (_request, payload, done) {
      done(null, payload);
    },
  );

  /* PUT /internal/replications : 내부 데이터 복제용 */
  fastify.put<{
    Querystring: ReplicateQuery;
  }>("/internal/replications", async function (request, reply) {
    const fileInfo = await receiveReplication(request);

    return reply.code(200).send(createSuccessResponse(fileInfo));
  });
};

export default replications;
