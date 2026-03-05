import { FastifyPluginAsync } from 'fastify'
import { HEALTH_CHECK_PATH, HEALTH_STATUS_OK } from '../constants/healthCheck'

const health: FastifyPluginAsync = async (fastify, opts): Promise<void> => {
  fastify.get(HEALTH_CHECK_PATH, async function (request, reply) {
    return {
      status: HEALTH_STATUS_OK,
      timestamp: new Date().toISOString(),
      role: process.env.ROLE ?? 'unknown',
    }
  })
}

export default health
