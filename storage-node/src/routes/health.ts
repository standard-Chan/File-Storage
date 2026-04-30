import { FastifyPluginAsync } from 'fastify'
import { HEALTH_CHECK_PATH, HEALTH_STATUS_OK } from '../constants/healthCheck'

const health: FastifyPluginAsync = async (fastify, opts): Promise<void> => {
  /**
   * GET /health
   * - 노드 상태와 기본 메타데이터를 반환한다.
   */
  fastify.get(HEALTH_CHECK_PATH, async function (request, reply) {
    return {
      status: HEALTH_STATUS_OK,
      timestamp: new Date().toISOString(),
      role: process.env.ROLE ?? 'unknown',
    }
  })
}

export default health
