import { FastifyPluginAsync } from 'fastify'

const root: FastifyPluginAsync = async (fastify, opts): Promise<void> => {
  /**
   * GET /
   * - 라우트 동작 여부를 확인한다.
   */
  fastify.get('/', async function (request, reply) {
    return { root: true }
  })
}

export default root
