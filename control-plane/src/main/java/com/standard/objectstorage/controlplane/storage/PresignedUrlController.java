package com.standard.objectstorage.controlplane.storage;

import com.standard.objectstorage.controlplane.storage.dto.PresignedUrlRequest;
import com.standard.objectstorage.controlplane.storage.dto.PresignedUrlResponse;
import com.standard.objectstorage.controlplane.storedObjcet.StoredObjectService;
import jakarta.validation.Valid;
import lombok.RequiredArgsConstructor;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping("/api/storage")
@RequiredArgsConstructor
public class PresignedUrlController {

    private final PresignedUrlService presignedUrlService;
    private final StoredObjectService storedObjectService;

    @PostMapping("/presigned-url")
    public PresignedUrlResponse createPutPresignedUrl(
        @Valid @RequestBody PresignedUrlRequest request) {
        String presignedUrl = presignedUrlService.generateUploadPresignedUrl(request.getBucket(),
            request.getObjectKey(), request.getFileSize());
        return new PresignedUrlResponse(presignedUrl);
    }

    @PostMapping("/presigned-url/get")
    public PresignedUrlResponse createGetPresignedUrl(
        @Valid @RequestBody PresignedUrlRequest request) {
        String presignedUrl = presignedUrlService.generateGetPresignedUrl(request.getBucket(),
            request.getObjectKey(), request.getFileSize());
        return new PresignedUrlResponse(presignedUrl);
    }
}
