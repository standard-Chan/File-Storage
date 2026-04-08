import { FileInfo } from '../storage/fileStorage'

/**
 * 성공 응답 생성
 */
export function createSuccessResponse(fileInfo: FileInfo) {
  return {
    success: true,
    message: '파일이 성공적으로 업로드되었습니다',
    data: {
      bucket: fileInfo.bucket,
      key: fileInfo.objectKey,
      filename: fileInfo.filename,
      mimetype: fileInfo.mimetype,
      size: fileInfo.size,
      uploadedAt: fileInfo.uploadedAt
    }
  }
}
