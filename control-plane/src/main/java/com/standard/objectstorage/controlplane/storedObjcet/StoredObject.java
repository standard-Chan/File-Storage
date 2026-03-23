package com.standard.objectstorage.controlplane.storedObjcet;

import com.standard.objectstorage.controlplane.bucket.Bucket;
import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.EnumType;
import jakarta.persistence.Enumerated;
import jakarta.persistence.FetchType;
import jakarta.persistence.Id;
import jakarta.persistence.JoinColumn;
import jakarta.persistence.ManyToOne;
import jakarta.persistence.PrePersist;
import jakarta.persistence.PreUpdate;
import jakarta.persistence.Table;
import java.time.LocalDateTime;
import java.util.UUID;
import lombok.AccessLevel;
import lombok.AllArgsConstructor;
import lombok.Builder;
import lombok.Getter;
import lombok.NoArgsConstructor;
import lombok.Setter;

@Entity
@Table(name = "TB_OBJECTS")
@Getter
@Setter
@NoArgsConstructor(access = AccessLevel.PROTECTED)
@AllArgsConstructor
@Builder
public class StoredObject {

    @Id
    private UUID id;

    @ManyToOne(fetch = FetchType.LAZY)
    @JoinColumn(name = "bucket_id", nullable = false)
    private Bucket bucket;

    @Column(nullable = false, length = 512, name = "object_key")
    private String objectKey;

    @Column(nullable = false, length = 1024)
    private String storagePath;

    @Column
    private Long size;

    @Column(length = 255)
    private String etag;

    @Column(length = 255, nullable = false)
    private String primaryNodeIp;

    @Column(length = 255)
    private String secondaryNodeIp;

    @Enumerated(EnumType.STRING)
    @Column(nullable = false, length = 20)
    private ObjectStatus status;

    @Column(columnDefinition = "BIGINT DEFAULT 0")
    private Long numberOfDownloads;

    // TODO: Secondary replication 완료 여부 필드 필요. 혹은 ObjectStatus로 상태 표시 (로드밸런싱용)

    @Column(nullable = false, updatable = false)
    private LocalDateTime createdAt;

    @Column(nullable = false)
    private LocalDateTime updatedAt;

    @PrePersist
    public void prePersist() {
        this.id = UUID.randomUUID();
        this.createdAt = LocalDateTime.now();
        this.updatedAt = LocalDateTime.now();
    }

    @PreUpdate
    public void preUpdate() {
        this.updatedAt = LocalDateTime.now();
    }
}