package com.standard.objectstorage.controlplane.storageNode;

import com.standard.objectstorage.controlplane.storageNode.dto.StorageNodeDiskInfo;
import java.util.Arrays;
import java.util.Comparator;
import java.util.List;
import java.util.Objects;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.TimeUnit;
import java.util.stream.Collectors;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Service;
import org.springframework.web.client.RestTemplate;

/**
 * Storage Node의 디스크 정보 조회 및 관리 전담
 */
@Service
public class StorageNodeDiskService {

    private static final Logger log = LoggerFactory.getLogger(StorageNodeDiskService.class);

    @Value("${storage.node.ips:}")
    private String storageNodeIpsString;

    @Value("${storage.node.port:3000}")
    private Integer storageNodePort;

    @Value("${storage.node.disk-query-timeout-ms:5000}")
    private Long diskQueryTimeoutMs;

    private final RestTemplate restTemplate;

    public StorageNodeDiskService(RestTemplate restTemplate) {
        this.restTemplate = restTemplate;
    }

    /**
     * 업로드를 위한 최적의 노드 선택 1. 모든 노드의 디스크 상태 조회 2. 파일 크기(Bytes)를 수용 가능한 노드 필터링 3. 남은 용량이 가장 큰 노드 반환
     */
    public StorageNodeDiskInfo selectOptimalNodeForUpload(long fileSize) {
        List<StorageNodeDiskInfo> diskInfos = getAllStorageNodesDiskUsage();

        return diskInfos.stream()
            .filter(node -> node.getAvailableSpace() >= fileSize) // 용량 필터링
            .max(Comparator.comparing(StorageNodeDiskInfo::getAvailableSpace)) // 가장 여유로운 노드 선택
            .orElseThrow(() -> {
                log.error("[Storage node] 적절한 Storage Node를 찾을 수 없습니다. (요청 크기: {} Byte)", fileSize);
                return new RuntimeException("가용한 저장 공간이 부족하거나 활성화된 노드가 없습니다.");
            });
    }

    /**
     * 등록된 모든 Storage Node의 디스크 용량 조회
     *
     * @return Storage Node 디스크 정보 리스트
     */
    private List<StorageNodeDiskInfo> getAllStorageNodesDiskUsage() {
        List<String> nodeIpList = this.getValidNodeIps();

        log.info("[Storage node] Querying disk usage from {} storage nodes", nodeIpList.size());

        List<CompletableFuture<StorageNodeDiskInfo>> futures = nodeIpList.stream()
            .map(nodeIp ->
                CompletableFuture.supplyAsync(() -> queryDiskUsageToStorageNode(nodeIp.trim())))
            .toList();

        // 모든 응답 대기
        return futures.stream().map(future -> {
            try {
                return future.orTimeout(diskQueryTimeoutMs, TimeUnit.MILLISECONDS).join();
            } catch (Exception e) {
                log.warn("[Storage node] DISK 사용량 조회 타임아웃", e);
                return null;
            }
        }).filter(Objects::nonNull).collect(Collectors.toList());
    }

    /**
     * Storage Node IP 목록 유효성 검증 - IP가 하나도 설정되지 않았거나, 형식이 잘못된 경우 false 반환
     */
    private List<String> getValidNodeIps() {
        if (storageNodeIpsString == null || storageNodeIpsString.isBlank()) {
            throw new IllegalStateException("Storage Node IP가 설정되지 않았습니다");
        }

        List<String> nodeIps = Arrays.stream(storageNodeIpsString.split(","))
            .map(String::trim)
            .filter(ip -> !ip.isEmpty())
            .toList();

        if (nodeIps.isEmpty()) {
            throw new IllegalStateException("유효한 Storage Node IP가 없습니다");
        }

        return nodeIps;
    }

    /**
     * 단일 Storage Node의 디스크 사용량 조회
     */
    private StorageNodeDiskInfo queryDiskUsageToStorageNode(String nodeIp) {
        try {
            String url = String.format("http://%s:%d/disk/space", nodeIp, storageNodePort);

            StorageNodeDiskInfo diskInfo = restTemplate.getForObject(url,
                StorageNodeDiskInfo.class);

            if (diskInfo != null) {
                log.debug("[Storage node] DISK '{}' IP의, - 사용 가능 DISK 용량: {} MB", nodeIp,
                    diskInfo.getAvailableSpace());
            }

            return diskInfo;
        } catch (Exception e) {
            log.warn("[Storage node] disk 용량을 불러오는데 실패하였습니다 - ip: {}", nodeIp, e);
            return null;
        }
    }
}
