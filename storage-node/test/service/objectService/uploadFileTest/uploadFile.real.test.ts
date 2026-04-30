import crypto from 'node:crypto';
import path from 'node:path';
import { createReadStream, promises as fs } from 'node:fs';
import { Readable, Transform } from 'node:stream';

import { uploadFile } from '../../../../src/services/objects/objectService';
import * as presignedUrlValidation from '../../../../src/services/validation/presignedUrl';
import * as replicationValidation from '../../../../src/services/validation/replication';
import * as schedulerRuntime from '../../../../src/services/objects/scheduler/runtime';
import * as schedulerConfig from '../../../../src/services/objects/scheduler/config';
import * as fileStorage from '../../../../src/services/storage/fileStorage';

jest.mock('../../../../src/services/validation/presignedUrl', () => ({
  validatePresignedUrlRequest: jest.fn(),
}));

jest.mock('../../../../src/services/validation/replication', () => ({
  validateReplicationBodyStream: jest.fn(),
}));

jest.mock('../../../../src/services/objects/scheduler/runtime', () => ({
  getOrCreateUploadScheduler: jest.fn(),
}));

jest.mock('../../../../src/services/objects/scheduler/config', () => ({
  loadSchedulerConfig: jest.fn(),
}));

jest.mock('../../../../src/services/objects/scheduler/RateControlledTransform', () => ({
  RateControlledTransform: class extends Transform {
    _transform(
      chunk: unknown,
      _encoding: BufferEncoding,
      callback: (error?: Error | null, data?: unknown) => void,
    ) {
      callback(null, chunk);
    }
  },
}));

jest.setTimeout(15 * 60 * 1000);

type RealUploadCase = {
  label: '1MB' | '5MB' | '100MB';
  size: number;
  filePath: string;
};

const REAL_UPLOAD_CASES: RealUploadCase[] = [
  {
    label: '1MB',
    size: 1 * 1024 * 1024,
    filePath: path.join(process.cwd(), 'test', 'test-files', '1MB.bin'),
  },
  {
    label: '5MB',
    size: 5 * 1024 * 1024,
    filePath: path.join(process.cwd(), 'test', 'test-files', '5MB.bin'),
  },
];

function buildRequest(fileCase: RealUploadCase, objectKey: string, body: Readable) {
  return {
    id: `req-${crypto.randomUUID()}`,
    query: {
      bucket: 'bucket1',
      objectKey,
      method: 'PUT',
      exp: String(Math.floor(Date.now() / 1000) + 60 * 10),
      fileSize: String(fileCase.size),
      signature: 'test-signature',
    },
    headers: {
      'content-type': 'application/octet-stream',
    },
    body,
    log: {
      info: jest.fn(),
      error: jest.fn(),
      warn: jest.fn(),
      debug: jest.fn(),
      trace: jest.fn(),
      fatal: jest.fn(),
      child: jest.fn().mockReturnThis(),
    },
  } as never;
}

async function cleanupUploadedFile(bucket: string, objectKey: string) {
  await fs.rm(path.join(process.cwd(), 'uploads', bucket, objectKey), {
    force: true,
  });
  await fs.rm(path.join(process.cwd(), 'uploads', bucket), {
    recursive: true,
    force: true,
  });
}

describe('uploadFile 실제 파일 업로드 테스트', () => {
  const mockScheduler = {
    enqueue: jest.fn().mockResolvedValue(undefined),
    jobCompleted: jest.fn(),
    jobFailed: jest.fn(),
  };
  const mockReplicationQueue = {
    registerReplicationTask: jest.fn(),
  };

  beforeAll(() => {
    process.env.PRESIGNED_URL_SECRET_KEY = process.env.PRESIGNED_URL_SECRET_KEY || 'test-secret-key';

    (schedulerRuntime.getOrCreateUploadScheduler as jest.Mock).mockReturnValue(mockScheduler);
    (schedulerConfig.loadSchedulerConfig as jest.Mock).mockReturnValue({
      tokenBucketCapacityBytes: 1024 * 1024,
      transformBufferLimitBytes: 512 * 1024,
      rateLookupIntervalMs: 100,
      refillPumpIntervalMs: 50,
    });

    const originalSaveStreamToStorage = fileStorage.saveStreamToStorage;
    const originalCollectStreamFileInfo = fileStorage.collectStreamFileInfo;

    jest.spyOn(presignedUrlValidation, 'validatePresignedUrlRequest').mockImplementation(() => undefined);
    jest.spyOn(replicationValidation, 'validateReplicationBodyStream').mockImplementation(() => undefined);
    jest.spyOn(fileStorage, 'saveStreamToStorage').mockImplementation(originalSaveStreamToStorage);
    jest.spyOn(fileStorage, 'collectStreamFileInfo').mockImplementation(originalCollectStreamFileInfo);
  });

  afterEach(() => {
    mockScheduler.enqueue.mockClear();
    mockScheduler.jobCompleted.mockClear();
    mockScheduler.jobFailed.mockClear();
    mockReplicationQueue.registerReplicationTask.mockClear();
  });

  afterAll(() => {
    delete process.env.PRESIGNED_URL_SECRET_KEY;
  });

  for (const fileCase of REAL_UPLOAD_CASES) {
    it(`[실제 업로드] ${fileCase.label} 파일이 실제로 저장되어야 함`, async () => {
      // URL 검증 및 replication 복제, control plane 성공 전송은 제외
      const bucket = 'bucket1';
      const objectKey = `real-upload/${fileCase.label.toLowerCase()}/${Date.now()}-${crypto.randomBytes(4).toString('hex')}.bin`;
      const fileBuffer = await fs.readFile(fileCase.filePath);

      expect(fileBuffer.byteLength).toBe(fileCase.size);

      const request = buildRequest(fileCase, objectKey, createReadStream(fileCase.filePath));
      const fileInfo = await uploadFile(request, mockReplicationQueue as never);

      try {
        expect(mockScheduler.enqueue).toHaveBeenCalled();
        expect(fileStorage.saveStreamToStorage).toHaveBeenCalled();
        expect(mockScheduler.jobCompleted).toHaveBeenCalled();
        expect(fileStorage.collectStreamFileInfo).toHaveBeenCalled();

        expect(fileInfo).toEqual(
          expect.objectContaining({
            bucket,
            objectKey,
            size: fileCase.size,
          }),
        );

        const savedPath = path.join(process.cwd(), 'uploads', bucket, objectKey);
        const savedFile = await fs.readFile(savedPath);
        expect(savedFile.length).toBe(fileCase.size);
        expect(savedFile.equals(fileBuffer)).toBe(true);
      } finally {
        await cleanupUploadedFile(bucket, objectKey);
      }
    });
  }
});
