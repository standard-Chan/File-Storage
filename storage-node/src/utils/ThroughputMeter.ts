import { Transform } from 'stream'

export interface ThroughputMetrics {
  totalBytes: number
  elapsedMs: number
  avgKBPerSec: number
  avgMBPerSec: number
  chunkCount: number
}

export interface ThroughputMeter {
  stream: Transform
  getMetrics: () => ThroughputMetrics
}

export function createThroughputMeter(): ThroughputMeter {
  let totalBytes = 0
  let chunkCount = 0
  let startTime: bigint | null = null
  let endTime: bigint | null = null

  const stream = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      if (!startTime) startTime = process.hrtime.bigint()
      endTime = process.hrtime.bigint()
      totalBytes += chunk.length
      chunkCount++
      this.push(chunk)
      cb()
    },
  })

  const getMetrics = (): ThroughputMetrics => {
    const elapsedMs =
      startTime && endTime ? Number(endTime - startTime) / 1e6 : 0
    return {
      totalBytes,
      elapsedMs,
      avgKBPerSec: elapsedMs > 0
        ? Math.round((totalBytes / elapsedMs / 1024) * 1000 * 100) / 100
        : 0,
      avgMBPerSec: elapsedMs > 0
        ? Math.round((totalBytes / elapsedMs / 1024 / 1024) * 1000 * 100) / 100
        : 0,
      chunkCount,
    }
  }

  return { stream, getMetrics }
}
