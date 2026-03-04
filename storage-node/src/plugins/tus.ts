import fp from "fastify-plugin";
import { Server as TusServer, EVENTS } from "tus-node-server";
import { join } from "node:path";
import { namingFunction } from "../tus/options";
import { onFileCreated, onUploadComplete } from "../tus/eventHandler";
import CustomFileStore from "../tus/CustomFileStore";
import SqliteConfigstore from "../tus/SqliteConfigstore";
import { TusSessionStore } from "../tus/TusSessionStore";

const TUS_API_ENDPOINT = "/tus/objects";

/**
 * TUS 업로드 플러그인 (uploads/resumable)
 */
export default fp(
  async (fastify) => {
  const uploadBaseDir = join(process.cwd(), "uploads/tus");
  const configstore = new SqliteConfigstore(fastify.db);
  const tusServer = new TusServer({ path: TUS_API_ENDPOINT, namingFunction });
  tusServer.datastore = new CustomFileStore({ directory: uploadBaseDir, configstore });

  tusServer.on(EVENTS.EVENT_FILE_CREATED, onFileCreated(fastify));
  tusServer.on(EVENTS.EVENT_UPLOAD_COMPLETE, onUploadComplete(fastify));

  const tusSessionStore = new TusSessionStore(fastify.db);

  fastify.decorate("tusServer", tusServer);
  fastify.decorate("tusSessionStore", tusSessionStore);
  },
  {
    name: "tus",
    fastify: "5.x",
    dependencies: ["sqlite"],
  },
);
