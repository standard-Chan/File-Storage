package com.standard.objectstorage.controlplane.storedObjcet;

import com.standard.objectstorage.controlplane.bucket.Bucket;
import com.standard.objectstorage.controlplane.bucket.BucketRepository;
import com.standard.objectstorage.controlplane.storage.dto.UploadCompleteRequest;
import jakarta.persistence.EntityNotFoundException;
import java.util.UUID;
import lombok.RequiredArgsConstructor;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;

/**
 * 저장된 Object record 관리 서비스 - 업로드 완료된 파일 정보 저장 - 다운로드 횟수 증가
 */
@Service
@RequiredArgsConstructor
public class StoredObjectService {

    private static final Logger log = LoggerFactory.getLogger(StoredObjectService.class);

    private final StoredObjectRepository storedObjectRepository;
    private final BucketRepository bucketRepository;

    /**
     * 업로드 완료된 Object 정보를 저장
     */
    public void saveUploadedObject(UploadCompleteRequest request) {
        log.info("Saving uploaded object - bucket: {}, objectKey: {}, primaryNodeIp: {}",
            request.getBucket(), request.getObjectKey(), request.getPrimaryNodeIp());

        Bucket bucket = bucketRepository.findByName(request.getBucket())
            .orElseThrow(() -> new EntityNotFoundException(
                "Bucket not found: " + request.getBucket()));

        StoredObject storedObject = StoredObject.builder()
            .bucket(bucket)
            .objectKey(request.getObjectKey())
            .size(request.getFileSize())
            .etag(request.getEtag())
            .storagePath(request.getStoragePath())
            .primaryNodeIp(request.getPrimaryNodeIp())
            .status(ObjectStatus.COMPLETE)
            .numberOfDownloads(0L)
            .build();

        storedObjectRepository.save(storedObject);
        log.info("Successfully saved object - id: {}", storedObject.getId());
    }

    /**
     * 다운로드 횟수 증가
     *
     * @param objectId ObjectID
     */
    public void incrementDownloadCount(UUID objectId) {
        log.debug("Incrementing download count - objectId: {}", objectId);

        // TODO: 동시성 처리 (현재는 race condition 가능성 존재)
        StoredObject obj = storedObjectRepository.findById(objectId)
            .orElseThrow(() -> new EntityNotFoundException("Object not found: " + objectId));

        long currentCount = obj.getNumberOfDownloads() == null ? 0L : obj.getNumberOfDownloads();
        obj.setNumberOfDownloads(currentCount + 1);
        storedObjectRepository.save(obj);
    }

    /**
     * Object 정보 조회
     *
     * @param bucketName Bucket 이름
     * @param objectKey  Object Key
     * @return StoredObject
     */
    public StoredObject getObject(String bucketName, String objectKey) {
        return storedObjectRepository.findByBucketNameAndObjectKey(bucketName, objectKey)
            .orElseThrow(() -> new EntityNotFoundException(
                "Object not found: " + bucketName + "/" + objectKey));
    }
}
