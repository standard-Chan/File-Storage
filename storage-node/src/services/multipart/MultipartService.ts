import { randomUUID } from "node:crypto";
import { FastifyRequest } from "fastify";
import { HttpError } from "../../utils/HttpError";
import { DEFAULT_CONTENT_TYPE } from "../../constants/contentTypes";
import {
  initMultipartUploadStorage,
  saveMultipartPart,
  removeMultipartUploadStorage,
  listMultipartParts,
  mergeMultipartParts,
} from "../storage/multipartStorage";
import {
  validateBucket,
  validateObjectKey,
  parsePartNumber,
} from "../validation/multipart";
import { validateReplicationBodyStream } from "../validation/replication";
import {
  IMultipartSessionStore,
  MultipartSession,
} from "./sessionStore/SessionStore";
import { InMemoryMultipartSessionStore } from "./sessionStore/MultipartSessionStore";
import {
  InitiateMultipartBody,
  MultipartParams,
  UploadPartParams,
  InitiateMultipartResult,
  UploadPartResult,
  CompleteMultipartResult,
} from "./types";

export type {
  InitiateMultipartBody,
  MultipartParams,
  UploadPartParams,
  InitiateMultipartResult,
  UploadPartResult,
  CompleteMultipartResult,
};

const MULTIPART_TTL_MS = 60 * 60 * 1000;

export class MultipartService {
  private static instance: MultipartService;
  private sessionStore: IMultipartSessionStore;

  private constructor(sessionStore: IMultipartSessionStore) {
    this.sessionStore = sessionStore;
  }

  static getInstance(): MultipartService {
    if (!MultipartService.instance) {
      MultipartService.instance = new MultipartService(
        InMemoryMultipartSessionStore.getInstance(),
      );
    }
    return MultipartService.instance;
  }

  async initiateMultipartUpload(
    request: FastifyRequest<{ Body: InitiateMultipartBody }>,
  ): Promise<InitiateMultipartResult> {
    const payload = (request.body ?? {}) as Partial<InitiateMultipartBody>;
    const { bucket = "", objectKey = "", contentType } = payload;

    await this.sessionStore.sweepExpiredUploads();
    validateBucket(bucket);
    validateObjectKey(objectKey);

    const uploadId = randomUUID();
    const expiresAt = Date.now() + MULTIPART_TTL_MS;
    const session: MultipartSession = {
      uploadId,
      bucket,
      objectKey,
      contentType: contentType ?? DEFAULT_CONTENT_TYPE,
      expiresAt,
      status: "INITIATED",
    };

    await initMultipartUploadStorage(uploadId);
    this.sessionStore.set(uploadId, session);

    request.log.info({ uploadId, bucket, objectKey }, "멀티파트 업로드 시작");

    return {
      uploadId,
      expiresAt: new Date(expiresAt).toISOString(),
      status: session.status,
    };
  }

  async uploadPart(
    request: FastifyRequest<{ Params: UploadPartParams }>,
  ): Promise<UploadPartResult> {
    validateReplicationBodyStream(request.body);

    const { uploadId, partNumber: rawPartNumber } = request.params;
    const stream = request.body;

    const session = this.sessionStore.getActiveSession(uploadId);
    if (session.status === "COMPLETING") {
      request.log.warn({ uploadId }, "파트 업로드 거부: complete 처리 중");
      throw new HttpError(409, "complete 처리 중에는 part 업로드를 할 수 없습니다");
    }

    const partNumber = parsePartNumber(rawPartNumber);
    const { size, etag } = await saveMultipartPart(uploadId, partNumber, stream);

    request.log.info({ uploadId, partNumber, size }, "파트 업로드 완료");

    return { uploadId, partNumber, size, etag };
  }

  async completeMultipartUpload(
    request: FastifyRequest<{ Params: MultipartParams }>,
  ): Promise<CompleteMultipartResult> {
    const { uploadId } = request.params;

    const session = this.sessionStore.getActiveSession(uploadId);
    if (session.status === "COMPLETING") {
      request.log.warn({ uploadId }, "complete 요청 거부: 이미 처리 중");
      throw new HttpError(409, "이미 complete 처리 중입니다");
    }

    session.status = "COMPLETING";

    try {
      const parts = await listMultipartParts(uploadId);
      if (parts.length === 0) {
        throw new HttpError(400, "업로드된 part가 없습니다");
      }

      const fileInfo = await mergeMultipartParts(
        session.bucket,
        session.objectKey,
        parts,
        session.contentType,
      );

      await removeMultipartUploadStorage(uploadId);
      this.sessionStore.delete(uploadId);

      request.log.info({ uploadId, partCount: parts.length }, "멀티파트 파일 업로드 및 병합 완료");

      return {
        fileInfo,
        partCount: parts.length,
      };
    } catch (error) {
      request.log.error({ uploadId, error }, "멀티파트 complete 실패, 상태 롤백");
      session.status = "INITIATED";
      throw error;
    }
  }

  async abortMultipartUpload(
    request: FastifyRequest<{ Params: MultipartParams }>,
  ): Promise<{ uploadId: string }> {
    const { uploadId } = request.params;

    this.sessionStore.getActiveSession(uploadId);

    await removeMultipartUploadStorage(uploadId);
    this.sessionStore.delete(uploadId);

    request.log.info({ uploadId }, "멀티파트 업로드 취소");

    return { uploadId };
  }

  resetForTests(): void {
    this.sessionStore.clear();
  }
}
