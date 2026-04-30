import path from 'path'
import fs from 'fs'
import { promises as fsPromises } from 'fs'
import { Readable } from 'stream'
import { pipeline } from 'stream/promises'
import { generateETag, collectStreamFileInfo, FileInfo } from './fileStorage'

const UPLOAD_BASE_DIR = process.env.UPLOAD_BASE_DIR ?? 'uploads'
const MULTIPART_ROOT_DIR = path.join(process.cwd(), UPLOAD_BASE_DIR, '.multipart')

export interface MultipartPartMeta {
  partNumber: number
  path: string
  size: number
  etag: string
}

export function getMultipartUploadDir(uploadId: string): string {
  return path.join(MULTIPART_ROOT_DIR, uploadId)
}

export function getMultipartPartsDir(uploadId: string): string {
  return path.join(getMultipartUploadDir(uploadId), 'parts')
}

export async function initMultipartUploadStorage(uploadId: string): Promise<void> {
  await fsPromises.mkdir(getMultipartPartsDir(uploadId), { recursive: true })
}

export async function saveMultipartPart(
  uploadId: string,
  partNumber: number,
  stream: Readable,
): Promise<MultipartPartMeta> {
  const partPath = path.join(getMultipartPartsDir(uploadId), `${partNumber}.part`)
  const tempPath = `${partPath}.tmp-${Date.now()}`

  await fsPromises.mkdir(path.dirname(partPath), { recursive: true })

  try {
    await pipeline(stream, fs.createWriteStream(tempPath))
    await fsPromises.rename(tempPath, partPath)
  } catch (error) {
    await fsPromises.rm(tempPath, { force: true })
    throw error
  }

  const stat = await fsPromises.stat(partPath)
  const etag = await generateETag(partPath)

  return { partNumber, path: partPath, size: stat.size, etag }
}

export async function removeMultipartUploadStorage(uploadId: string): Promise<void> {
  await fsPromises.rm(getMultipartUploadDir(uploadId), { recursive: true, force: true })
}

export async function listMultipartParts(uploadId: string): Promise<MultipartPartMeta[]> {
  const partsDir = getMultipartPartsDir(uploadId)
  let entries: fs.Dirent[]

  try {
    entries = await fsPromises.readdir(partsDir, { withFileTypes: true })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return []
    }
    throw error
  }

  const partFiles = entries
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .map((filename) => {
      const match = /^(\d+)\.part$/.exec(filename)
      if (!match) return null
      return {
        partNumber: Number.parseInt(match[1], 10),
        partPath: path.join(partsDir, filename),
      }
    })
    .filter((value): value is { partNumber: number; partPath: string } => value !== null)
    .sort((a, b) => a.partNumber - b.partNumber)

  const metaList: MultipartPartMeta[] = []
  for (const part of partFiles) {
    const stat = await fsPromises.stat(part.partPath)
    const etag = await generateETag(part.partPath)
    metaList.push({ partNumber: part.partNumber, path: part.partPath, size: stat.size, etag })
  }

  return metaList
}

export async function mergeMultipartParts(
  bucket: string,
  objectKey: string,
  parts: MultipartPartMeta[],
  contentType: string,
): Promise<FileInfo> {
  const finalPath = path.join(process.cwd(), UPLOAD_BASE_DIR, bucket, objectKey)
  const tempFinalPath = `${finalPath}.multipart-tmp-${Date.now()}`

  await fsPromises.mkdir(path.dirname(finalPath), { recursive: true })
  await fsPromises.writeFile(tempFinalPath, '')

  for (const part of parts) {
    await pipeline(
      fs.createReadStream(part.path),
      fs.createWriteStream(tempFinalPath, { flags: 'a' }),
    )
  }

  await fsPromises.rename(tempFinalPath, finalPath)
  return collectStreamFileInfo(bucket, objectKey, finalPath, contentType)
}
