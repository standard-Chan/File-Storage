package com.standard.objectstorage.controlplane.storedObjcet.dto;

import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.NotNull;
import lombok.AllArgsConstructor;
import lombok.Data;
import lombok.NoArgsConstructor;

/**
 * Storage Node에서 업로드 완료를 알릴 때 전달하는 DTO
 */
@Data
@NoArgsConstructor
@AllArgsConstructor
public class UploadCompleteRequest {

    @NotBlank(message = "bucket은 필수입니다")
    private String bucket;

    @NotBlank(message = "objectKey는 필수입니다")
    private String objectKey;

    @NotNull(message = "fileSize는 필수입니다")
    private Long fileSize;

    @NotBlank(message = "etag는 필수입니다")
    private String etag;

    @NotBlank(message = "storagePath는 필수입니다")
    private String storagePath;

    @NotBlank(message = "primaryNodeIp는 필수입니다")
    private String primaryNodeIp;
}
