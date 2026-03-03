import { IncomingMessage } from "node:http";
import { Metadata } from "tus-node-server";


/**
 * bucket/objectKey로 file id 생성
 */
export function namingFunction(req: IncomingMessage): string {
  const raw = (req.headers["upload-metadata"] as string) ?? "";
  const { bucket, objectKey } = Metadata.parse(raw);

  if (!bucket || !objectKey) {
    throw new Error("Upload-Metadata에 bucket과 objectKey가 필요합니다");
  }

  return `${bucket}/${objectKey}`;
}