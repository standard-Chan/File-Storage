import { FastifyPluginAsync } from "fastify";
import fs from "fs";
import { NodeIpDetector } from "../utils/NodeIpDetector";
import { DiskUsageResponse } from "../types/DiskUsageResponse";
import { sendErrorResponse } from "../services/response/apiResponse";

const diskRoute: FastifyPluginAsync = async (fastify, _opts): Promise<void> => {
  fastify.get<{ Reply: DiskUsageResponse }>(
    "/disk/space",
    async (request, reply) => {
      try {
        const uploadPath = "uploads"; // 명확하게 지정

        const stats = fs.statfsSync(uploadPath);

        const total = stats.blocks * stats.bsize;
        const free = stats.bfree * stats.bsize;
        const available = stats.bavail * stats.bsize;
        const used = total - free;

        const response: DiskUsageResponse = {
          nodeIp: NodeIpDetector.getCurrentNodeIp(),
          totalSpace: total,
          usedSpace: used,
          availableSpace: available,
          usagePercentage: (used / total) * 100,
          timestamp: new Date().toISOString(),
        };

        request.log.debug(
          {
            nodeIp: response.nodeIp,
            availableSpaceGB: response.availableSpace / (1024 * 1024 * 1024),
          },
          "Disk usage check completed",
        );

        return reply.code(200).send(response);
      } catch (error) {
        request.log.error({ error }, "Failed to retrieve disk usage");
        return sendErrorResponse(
          reply,
          500,
          "node의 DISK 사용량을 조회할 수 없습니다.",
          {
            error: error instanceof Error ? error.message : "알 수 없는 오류",
          },
        );
      }
    },
  );
};

export default diskRoute;
