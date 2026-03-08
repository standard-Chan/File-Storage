# Resumable Upload API (TUS Protocol)

대용량 파일을 중단 없이 업로드하기 위한 **TUS 1.0.0** 기반의 재개 가능 업로드 API입니다.


시환 선배님 안녕하세요! 이전에 커피챗했던 10기 정석찬입니다!

이전에 클론 코딩으로 고도화해보라는 조언을 받고, 파일 저장소 서비스(S3와 유사한)를 만들면서 고도화를 진행해나가고 있습니다! 선배님 말씀대로 고도화를 하면서, 배우는 점이 많았고, 고도화를 해도해도 끝이 없는 재미? 때문에 더 열심히 하고 있는 것 같습니다. 감사합니다! 😀

다름이 아니라 현재 제가 진행하고 있는 고도화의 방향이 맞는지, 이대로 계속 하면 되는 것인지를 점검받고 싶어서 연락드렸습니다. 혹시 제 이력서의 방향성에 대해서 피드백 및 조언을 해주실 수 있으실까요?


이전에 조언이 덕분에 많이 성장할 수 있었습니다! 읽어주셔서 감사합니다

---

## 흐름 요약

```text
[클라이언트]
     │
     │ 1. Control Plane에 Presigned URL 발급 요청
     │    POST /api/storage/presigned-url
     ▼
[Control Plane]
     │
     │ Presigned URL 반환 (서명 포함)
     ▼
[클라이언트]
     │
     │ 2. Presigned URL로 업로드 세션 생성
     │    POST /objects/resumable/{bucket}/{objectKey}?<presigned-query>
     ▼
[Storage Node]
     │
     │ - Presigned URL 서명 검증
     │ - TUS 세션 생성 후 Location 헤더 반환
     ▼
[클라이언트]
     │
     │ 3. 청크 단위 파일 전송
     │    PATCH /tus/objects/{bucket}/{objectKey}
     ▼
[Storage Node]
     │
     │ - 청크 수신 및 저장
     │ - 업로드 완료 시 메타데이터 삭제 처리
     ▼
[클라이언트]
     │
     │ 4. (선택) 업로드 상태 조회
     │    HEAD /tus/objects/{bucket}/{objectKey}
```

---

## Step 1. Presigned URL 발급

### Request

| 항목   | 내용                              |
|--------|----------------------------------|
| Method | `POST`                           |
| URL    | `/api/storage/presigned-url`     |
| Host   | Control Plane                    |

**Headers**

| 헤더명         | 값                  |
|---------------|---------------------|
| Content-Type  | `application/json`  |

**Body**

| 필드       | 타입     | 필수 | 설명              |
|------------|--------|------|-------------------|
| bucket     | string | ✅   | 버킷 이름          |
| objectKey  | string | ✅   | 저장할 객체 경로   |
| fileSize   | number | ✅   | 파일 크기 (bytes)  |

```json
{
  "bucket": "my-bucket",
  "objectKey": "path/to/file.jpg",
  "fileSize": 1073741826
}
```

### Response

| 필드      | 타입   | 설명                            |
|-----------|--------|-------------------------------|
|           |        |                               |

---

## Step 2. 업로드 세션 생성

Presigned URL로 TUS 업로드 세션을 생성합니다.  
응답의 `Location` 헤더로 이후 청크 전송 경로를 확인합니다.

### Request

| 항목   | 내용                                                              |
|--------|-----------------------------------------------------------------|
| Method | `POST`                                                           |
| URL    | `/objects/resumable/{bucket}/{objectKey}?<presigned-query>`     |
| Host   | Storage Node                                                    |

**Path Parameters**

| 파라미터   | 설명            |
|-----------|----------------|
| bucket    | 버킷 이름       |
| objectKey | 객체 경로       |

**Query Parameters** *(Presigned URL 구성 요소)*

| 파라미터   | 설명                            |
|-----------|---------------------------------|
| bucket    | 버킷 이름                        |
| objectKey | 객체 경로                        |
| method    | 서명에 사용된 HTTP 메서드 (`POST`) |
| exp       | 만료 시각 (Unix timestamp)       |
| fileSize  | 파일 크기 (bytes)                |
| signature | HMAC 서명 값                     |

**Headers**

| 헤더명          | 값                  | 필수 | 설명                  |
|----------------|---------------------|------|----------------------|
| Tus-Resumable  | `1.0.0`             | ✅   | TUS 프로토콜 버전      |
| Upload-Length  | `{fileSize}`        | ✅   | 전체 파일 크기 (bytes) |
| Upload-Metadata| `filename {base64}` | -    | 파일 메타데이터 (base64 인코딩) |
| Content-Length | `0`                 | ✅   |                      |

> **Upload-Metadata 인코딩 예시**  
> `filename` 값은 Base64로 인코딩해야 합니다.  
> 예: `"world.jpg"` → `d29ybGQuanBn`

### Response

| 항목            | 내용                        |
|-----------------|-----------------------------|
| Status Code     |                             |
| Location 헤더   | `/tus/objects/{uploadId}` 형태의 업로드 세션 경로 |

**Headers**

| 헤더명          | 설명                          |
|----------------|------------------------------|
| Location       | 청크 전송에 사용할 업로드 경로  |
| Tus-Resumable  | `1.0.0`                       |

---

## Step 3. 청크 전송

세션 생성 응답의 `Location` 경로로 파일 데이터를 전송합니다.  
한 번에 전체 전송하거나 청크로 나눠 전송할 수 있습니다.

### Request

| 항목   | 내용                                         |
|--------|---------------------------------------------|
| Method | `PATCH`                                     |
| URL    | `/tus/objects/{bucket}/{objectKey}`         |
| Host   | Storage Node                                |

**Headers**

| 헤더명         | 값                                   | 필수 | 설명                                  |
|---------------|--------------------------------------|------|------------------------------------- |
| Content-Type  | `application/offset+octet-stream`    | ✅   | TUS 청크 전송 Content-Type             |
| Tus-Resumable | `1.0.0`                              | ✅   | TUS 프로토콜 버전                       |
| Upload-Offset | `{현재까지 전송된 바이트 수}`           | ✅   | 이어 보내기 시작 위치. 처음 전송은 `0`   |
| Content-Length| `{이번 청크 크기}`                    | ✅   | 이번 요청에서 전송하는 바이트 수          |

**Body**

전송할 파일의 바이너리 데이터 (binary)

### Response

| 항목        | 내용                   |
|-------------|----------------------|
| Status Code |                      |

**Headers**

| 헤더명          | 설명                            |
|----------------|---------------------------------|
| Upload-Offset  | 현재까지 수신된 총 바이트 수      |
| Tus-Resumable  | `1.0.0`                         |

---

## Step 4. 업로드 상태 조회 (선택)

업로드가 중단된 경우 현재 오프셋을 확인하여 이어 보내기에 활용합니다.

### Request

| 항목   | 내용                                         |
|--------|---------------------------------------------|
| Method | `HEAD`                                      |
| URL    | `/tus/objects/{bucket}/{objectKey}`         |
| Host   | Storage Node                                |

**Headers**

| 헤더명         | 값        | 필수 |
|---------------|-----------|------|
| Tus-Resumable | `1.0.0`   | ✅   |

### Response

| 항목        | 내용 |
|-------------|------|
| Status Code |      |

**Headers**

| 헤더명          | 설명                         |
|----------------|------------------------------|
| Upload-Offset  | 현재까지 수신된 총 바이트 수   |
| Upload-Length  | 파일 전체 크기 (bytes)        |
| Tus-Resumable  | `1.0.0`                      |

---

## 에러 응답

| Status Code | 설명                          |
|-------------|-------------------------------|
|             | Presigned URL 서명 불일치     |
|             | Presigned URL 만료            |
|             | 필수 파라미터 누락             |
|             | 서버 내부 오류                 |

---

## 참고

- TUS 프로토콜 공식 문서: https://tus.io/protocols/resumable-upload.html
- `Upload-Metadata` 값은 반드시 **Base64 인코딩** 후 전송해야 합니다.
- `Upload-Offset`이 `Upload-Length`와 같아지면 업로드가 완료됩니다.
- 업로드 완료 후 TUS 메타데이터는 자동으로 삭제됩니다.
