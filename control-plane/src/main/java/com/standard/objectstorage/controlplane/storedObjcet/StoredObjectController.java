package com.standard.objectstorage.controlplane.storedObjcet;

import com.standard.objectstorage.controlplane.storedObjcet.dto.UploadCompleteRequest;
import jakarta.validation.Valid;
import lombok.RequiredArgsConstructor;
import org.springframework.http.ResponseEntity;
import org.springframework.stereotype.Controller;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RestController;

@RestController
@Controller
@RequiredArgsConstructor
public class StoredObjectController {

    private final StoredObjectService storedObjectService;

    /**
     * 업로드된 파일 정보 저장 API
     *
     * @ 호출 시기 : Storage Node에서 업로드 완료를 알릴 때 사용
     */
    @PostMapping("/upload-complete")
    public ResponseEntity<Void> uploadComplete(@Valid @RequestBody UploadCompleteRequest request) {
        // TODO: 승인된 IP 요청인지 확인하기 위한, IP 검증 로직 필요

        storedObjectService.saveUploadedObject(request);
        return ResponseEntity.ok().build();
    }
}
