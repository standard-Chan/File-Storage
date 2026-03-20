# File-Storage

데이터를 저장하고 다운로드할 수 있는 File Storage를 직접 만드는 프로젝트입니다.

---

## 아키텍처 구조
<img src="docs/imgs/아키텍처 구조.png" width="1000" />

---
# 설계 및 구현 과정 정리

> 이 문서는 스토리지 시스템을 설계하고 구현하는 과정에서의 주요 의사결정과 구현 내용을 정리한 문서입니다. 기능 도입 배경, 설계 과정에서의 고려 사항, 그리고 실제 구현 방식까지의 흐름을 기록하였습니다.


## 1. 데이터 내구성 보장
###  1.1 분산 스토리지 도입
- [내구성 확보를 위한 분산 스토리지 도입](https://velog.io/@standard-chan/%EC%8A%A4%ED%86%A0%EB%A6%AC%EC%A7%80-%EC%84%A4%EA%B3%84-%EB%82%B4%EA%B5%AC%EC%84%B1-99.99..-%EC%95%84%ED%82%A4%ED%85%8D%EC%B2%98-%EC%84%A4%EA%B3%84)

### 1.2 데이터 복제 처리
- [데이터 복제 실패 시, 재시도 자동화 도입](https://velog.io/@standard-chan/storage-2-%EB%8D%B0%EC%9D%B4%ED%84%B0-%EB%B3%B5%EC%A0%9C-%EC%8B%A4%ED%8C%A8-%EC%8B%9C-%EC%9E%AC%EC%8B%9C%EB%8F%84-%EB%A1%9C%EC%A7%81-%EB%8F%84%EC%9E%85)
- [서버 상황에 맞춰 복제 로직 수행](https://velog.io/@standard-chan/storage-3-%EC%84%9C%EB%B2%84-%EC%83%81%ED%99%A9%EC%97%90-%EB%94%B0%EB%A5%B8-%EC%9E%AC%EB%B3%B5%EC%A0%9C-%EC%9A%94%EC%B2%AD-%EC%A0%84%EC%86%A1%ED%95%98%EA%B8%B0)

## 2. 데이터 업로드
- [대용량 파일 업로드 중 실패 시, 업로드 재개 기능 도입](https://velog.io/@standard-chan/storage-4-%EB%8C%80%EC%9A%A9%EB%9F%89-%ED%8C%8C%EC%9D%BC-Resumable-Upload-%EA%B8%B0%EB%8A%A5-%EA%B5%AC%ED%98%84%ED%95%98%EA%B8%B0-277lp3og)
- [업로드 속도 보장하기](https://velog.io/@standard-chan/storage-7-%ED%8C%8C%EC%9D%BC-upload-%EC%86%8D%EB%8F%84-%EB%B3%B4%EC%9E%A5%ED%95%98%EA%B8%B0)

## 3. 안정성 확보
- [부하테스트 및 서버 메모리 최적화를 통한 안정성 확보](https://velog.io/@standard-chan/storage-5-%EB%B6%80%ED%95%98-%ED%85%8C%EC%8A%A4%ED%8A%B8-%EC%A4%91-%EC%84%9C%EB%B2%84%EA%B0%80-%ED%84%B0%EC%A1%8C%EB%8B%A4-%EC%9B%90%EC%9D%B8-%EB%B6%84%EC%84%9D%EA%B3%BC-%ED%95%B4%EA%B2%B0-%EB%B0%8F-%EC%82%BD%EC%A7%88-%EA%B8%B0%EB%A1%9D)

## 4. 기타 잡다한 기록
- [테스트 환경 격리하기 - 로컬에서 VM으로 환경 이전](https://velog.io/@standard-chan/%EB%8F%84%EB%9E%80%EB%8F%84%EB%9E%80-%EC%9D%B4%EC%95%BC%EA%B8%B0-%ED%85%8C%EC%8A%A4%ED%8A%B8-%ED%99%98%EA%B2%BD-%EA%B2%A9%EB%A6%AC%ED%95%98%EA%B8%B0)

---