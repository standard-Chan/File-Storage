package com.standard.objectstorage.controlplane.storage;

import com.standard.objectstorage.controlplane.storageNode.StorageNodeDiskService;
import com.standard.objectstorage.controlplane.storageNode.dto.StorageNodeDiskInfo;
import com.standard.objectstorage.controlplane.storedObjcet.StoredObject;
import com.standard.objectstorage.controlplane.storedObjcet.StoredObjectService;
import com.standard.objectstorage.controlplane.utils.CryptoUtils;
import java.nio.charset.StandardCharsets;
import java.time.Instant;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Service;
import org.springframework.web.util.UriUtils;

@Service
public class PresignedUrlService {

    private static final Logger log = LoggerFactory.getLogger(PresignedUrlService.class);
    private static final String DIRECT_PATH = "objects/direct";

    @Value("${SECRET_KEY}")
    private String SECRET_KEY;

    private final StorageNodeDiskService storageNodeDiskService;
    private final StoredObjectService storedObjectService;

    public PresignedUrlService(StorageNodeDiskService storageNodeDiskService,
        StoredObjectService storedObjectService) {
        this.storageNodeDiskService = storageNodeDiskService;
        this.storedObjectService = storedObjectService;
    }

    /**
     * Upload Presigned URL 생성 - 모든 storage node 중 가장 용량이 여유로운 disk 선택 ->  해당 노드로 Upload Presigned
     * URL 생성
     */
    public String generateUploadPresignedUrl(String bucket, String objectKey, long fileSize) {
        log.info("Upload Presigned URL 생성 요청 - bucket: {}, objectKey: {}, fileSize: {}", bucket,
            objectKey, fileSize);

        StorageNodeDiskInfo selectedNode = storageNodeDiskService.selectOptimalNodeForUpload(
            fileSize);

        log.info("Selected storage node - ip: {}, availableSpace: {} Bytes",
            selectedNode.getNodeIp(), selectedNode.getAvailableSpace());

        return generatePresignedUrl(DIRECT_PATH, bucket, objectKey, fileSize, "PUT",
            selectedNode.getNodeIp());
    }

    /**
     * Download Presigned URL 생성
     */
    public String generateGetPresignedUrl(String bucket, String objectKey, long fileSize) {
        log.info("GET Presigned URL 생성 요청 - bucket: {}, objectKey: {}", bucket, objectKey);

        StoredObject storedObject = storedObjectService.getObject(bucket, objectKey);

        // 2. numberOfDownloads +1 (자주 다운되는 데이터는 별도 캐시를 두기 위한 용도의 필드)
        // TODO: 동시성 처리 필요
        storedObjectService.incrementDownloadCount(storedObject.getId());

        return generatePresignedUrl(DIRECT_PATH, bucket, objectKey, fileSize, "GET",
            storedObject.getPrimaryNodeIp());
    }

    /**
     * Presigned URL 생성
     */
    private String generatePresignedUrl(String basePath, String bucket, String objectKey,
        long fileSize, String method, String nodeIp) {

        try {
            long expiresAt = Instant.now().plusSeconds(60 * 15).getEpochSecond();
            String signature = generateSignature(bucket, objectKey, method, expiresAt, fileSize);
            String encodedBucket = UriUtils.encodePathSegment(bucket, StandardCharsets.UTF_8);
            String encodedObjectKey = UriUtils.encodePath(objectKey, StandardCharsets.UTF_8);

            return String.format(
                "http://%s/%s/%s/%s?bucket=%s&objectKey=%s&method=%s&exp=%d&fileSize=%d&signature=%s",
                nodeIp, basePath, encodedBucket, encodedObjectKey, bucket, objectKey, method,
                expiresAt, fileSize, signature);

        } catch (Exception e) {
            log.error("Presigned URL 생성 실패", e);
            throw new RuntimeException("Presigned URL 생성에 실패하였습니다", e);
        }
    }

    /**
     * Presigned URL에 대한 서명 생성
     */
    private String generateSignature(String bucket, String objectKey, String method, long exp,
        long fileSize) throws Exception {
        String canonicalString = String.format(
            "bucket=%s&objectKey=%s&method=%s&exp=%d&fileSize=%d", bucket, objectKey, method, exp,
            fileSize);
        return CryptoUtils.hmacSha256Base64Url(canonicalString, SECRET_KEY);
    }
}