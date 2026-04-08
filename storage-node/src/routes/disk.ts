import { FastifyPluginAsync } from "fastify";
import fs from "fs";
import { NodeIpDetector } from "../utils/NodeIpDetector";
import { DiskUsageResponse } from "../types/DiskUsageResponse";

const diskRoute: FastifyPluginAsync = async (fastify, _opts): Promise<void> => {
  fastify.get<{ Reply: DiskUsageResponse }>(
    "/disk/space",
    async (request, reply) => {
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
    },
  );
};

export default diskRoute;
