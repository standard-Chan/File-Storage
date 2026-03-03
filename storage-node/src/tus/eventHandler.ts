import { FastifyInstance } from "fastify";
import { replicateToSecondary } from "../services/replication/replicateToSecondary";
import { classifyReplicationError } from "../services/replication/classifyError";

export function onFileCreated(fastify: FastifyInstance) {
  return (event: { file?: { id: string } }) => {
    fastify.log.info(
      { fileId: event.file?.id },
      "[TUS-RESUMABLE] 업로드 세션 생성",
    );
  };
}

export function onUploadComplete(fastify: FastifyInstance) {
  return async (event: { file?: { id: string } }) => {
    const fileId = event.file?.id as string;
    const [bucket, ...rest] = fileId.split("/");
    const objectKey = rest.join("/");

    fastify.log.info(
      { fileId, bucket, objectKey },
      "[TUS-RESUMABLE] 업로드 완료 - Secondary 복제 시작",
    );

    try {
      await replicateToSecondary(bucket, objectKey, fastify.log);
      fastify.log.info(
        { bucket, objectKey },
        "[TUS-RESUMABLE] Secondary 복제 완료",
      );
    } catch (repError) {
      const errorType = classifyReplicationError(repError);
      const errorMessage =
        repError instanceof Error ? repError.message : "알 수 없는 오류";

      fastify.log.warn(
        { bucket, objectKey, errorType, errorMessage },
        "[TUS-RESUMABLE] Secondary 복제 실패 - replication_queue 등록",
      );

      fastify.replicationQueue.upsertOnFailure(
        bucket,
        objectKey,
        errorType,
        errorMessage,
      );
    }
  };
}