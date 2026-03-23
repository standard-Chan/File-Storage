package com.standard.objectstorage.controlplane.storageNode.dto;

import com.fasterxml.jackson.annotation.JsonProperty;
import lombok.AllArgsConstructor;
import lombok.Data;
import lombok.NoArgsConstructor;

/**
 * Storage Node의 디스크 정보
 */
@Data
@NoArgsConstructor
@AllArgsConstructor
public class StorageNodeDiskInfo {

    @JsonProperty("nodeIp")
    private String nodeIp;

    @JsonProperty("totalSpace")
    private Long totalSpace;

    @JsonProperty("usedSpace")
    private Long usedSpace;

    @JsonProperty("availableSpace")
    private Long availableSpace;

    @JsonProperty("usagePercentage")
    private Double usagePercentage;

    @JsonProperty("timestamp")
    private String timestamp;
}
