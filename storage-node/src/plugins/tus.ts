import fp from "fastify-plugin";
import { Server as TusServer, EVENTS } from "tus-node-server";
import { join } from "node:path";
import { BucketFileStore } from "../tus/BucketFileStore";
import { namingFunction } from "../tus/options";
import { onFileCreated, onUploadComplete } from "../tus/eventHandler";

/**
 * TUS 업로드 플러그인 (uploads/resumable)
 */
export default fp(async (fastify) => {
  const uploadBaseDir = join(process.cwd(), "uploads");
  const tusServer = new TusServer({ path: "/uploads/resumable", namingFunction });
  tusServer.datastore = new BucketFileStore(uploadBaseDir);

  tusServer.on(EVENTS.EVENT_FILE_CREATED, onFileCreated(fastify));
  tusServer.on(EVENTS.EVENT_UPLOAD_COMPLETE, onUploadComplete(fastify));

  fastify.decorate("resumableTusServer", tusServer);
});
