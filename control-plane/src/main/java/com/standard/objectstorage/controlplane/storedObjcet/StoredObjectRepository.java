package com.standard.objectstorage.controlplane.storedObjcet;

import java.util.Optional;
import java.util.UUID;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;
import org.springframework.stereotype.Repository;

@Repository
public interface StoredObjectRepository extends JpaRepository<StoredObject, UUID> {

    @Query("SELECT so FROM StoredObject so JOIN so.bucket b WHERE b.name = :bucketName AND so.objectKey = :objectKey")
    Optional<StoredObject> findByBucketNameAndObjectKey(
        @Param("bucketName") String bucketName,
        @Param("objectKey") String objectKey
    );
}
