import { FastifyPluginAsync } from "fastify";
import {
  createSuccessResponse,
} from "../services/response/apiResponse";
import {
  MultipartService,
  InitiateMultipartBody,
  MultipartParams,
  UploadPartParams,
} from "../services/multipart/MultipartService";

const multipartService = MultipartService.getInstance();

const multipart: FastifyPluginAsync = async (fastify): Promise<void> => {
  fastify.addContentTypeParser("*", function (_request, payload, done) {
    done(null, payload);
  });

  /**
   * POST /multipart/initiate
   * - 멀티파트 업로드 세션을 생성한다.
   */
  fastify.post<{ Body: InitiateMultipartBody }>(
    "/multipart/initiate",
    async function (request, reply) {
      const multipartInfo = await multipartService.initiateMultipartUpload(request);

      return reply.code(201).send({
        success: true,
        message: "멀티파트 업로드가 시작되었습니다",
        data: multipartInfo,
      });
    },
  );

  /**
   * PUT /multipart/:uploadId/:partNumber
   * - 개별 part를 업로드한다.
   */
  fastify.put<{ Params: UploadPartParams }>(
    "/multipart/:uploadId/:partNumber",
    async function (request, reply) {
      const partInfo = await multipartService.uploadPart(request);

      return reply.code(200).send({
        success: true,
        message: "part 업로드가 완료되었습니다",
        data: partInfo,
      });
    },
  );

  /**
   * POST /multipart/:uploadId/complete
   * - 업로드된 part들을 병합하고 업로드를 완료한다.
   */
  fastify.post<{ Params: MultipartParams }>(
    "/multipart/:uploadId/complete",
    async function (request, reply) {
      const completed = await multipartService.completeMultipartUpload(request);

      fastify.replicationQueue.registerReplicationTask(
        completed.fileInfo.bucket,
        completed.fileInfo.objectKey,
      );

      const response = createSuccessResponse(completed.fileInfo);
      return reply.code(200).send({
        ...response,
        data: {
          ...response.data,
          partCount: completed.partCount,
        },
      });
    },
  );

  /**
   * DELETE /multipart/:uploadId
   * - 멀티파트 업로드 세션과 임시 파일을 정리한다.
   */
  fastify.delete<{ Params: MultipartParams }>(
    "/multipart/:uploadId",
    async function (request, reply) {
      const uploadId = await multipartService.abortMultipartUpload(request);
      return reply.code(200).send({
        success: true,
        message: "멀티파트 업로드가 취소되었습니다",
        data: uploadId,
      });
    },
  );
};

export default multipart;
