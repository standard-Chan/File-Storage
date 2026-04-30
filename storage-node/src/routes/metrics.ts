import { FastifyPluginAsync } from 'fastify'
import client from 'prom-client'
import { getActiveDiskWrites } from '../services/storage/fileStorage'

// 글로벌 레지스트리 생성
const register = new client.Registry()

// 기본 메트릭 수집 (CPU, 메모리 등)
client.collectDefaultMetrics({ 
  register,
  prefix: 'storage_node_'
})

// 커스텀 메트릭 정의
export const httpRequestDuration = new client.Histogram({
  name: 'storage_node_http_request_duration_seconds',
  help: 'HTTP request duration in seconds',
  labelNames: ['method', 'route', 'status_code'],
  buckets: [0.001, 0.005, 0.01, 0.05, 0.1, 0.5, 1, 5, 10]
})

export const httpRequestTotal = new client.Counter({
  name: 'storage_node_http_requests_total',
  help: 'Total number of HTTP requests',
  labelNames: ['method', 'route', 'status_code']
})

export const fileUploadSize = new client.Histogram({
  name: 'storage_node_file_upload_size_bytes',
  help: 'Size of uploaded files in bytes',
  labelNames: ['bucket'],
  buckets: [1024, 10240, 102400, 1048576, 10485760, 104857600, 1073741824] // 1KB, 10KB, 100KB, 1MB, 10MB, 100MB, 1GB
})

export const fileDownloadSize = new client.Histogram({
  name: 'storage_node_file_download_size_bytes',
  help: 'Size of downloaded files in bytes',
  labelNames: ['bucket'],
  buckets: [1024, 10240, 102400, 1048576, 10485760, 104857600, 1073741824]
})

export const activeConnections = new client.Gauge({
  name: 'storage_node_active_connections',
  help: 'Number of active connections'
})

export const storageCapacity = new client.Gauge({
  name: 'storage_node_capacity_bytes',
  help: 'Total storage capacity in bytes'
})

export const storageUsed = new client.Gauge({
  name: 'storage_node_used_bytes',
  help: 'Used storage in bytes'
})

export const activeDiskWriteOps = new client.Gauge({
  name: 'storage_node_active_disk_write_ops',
  help: 'Number of currently active disk write (pipeline) operations'
})

// 레지스트리에 커스텀 메트릭 등록
register.registerMetric(httpRequestDuration)
register.registerMetric(httpRequestTotal)
register.registerMetric(fileUploadSize)
register.registerMetric(fileDownloadSize)
register.registerMetric(activeConnections)
register.registerMetric(storageCapacity)
register.registerMetric(storageUsed)
register.registerMetric(activeDiskWriteOps)

const metricsRoute: FastifyPluginAsync = async (fastify, opts): Promise<void> => {
  /**
   * GET /metrics
   * - Prometheus scrape용 메트릭을 반환한다.
   */
  fastify.get('/metrics', async (request, reply) => {
    activeDiskWriteOps.set(getActiveDiskWrites())
    reply.header('Content-Type', register.contentType)
    return register.metrics()
  })
}

export default metricsRoute
