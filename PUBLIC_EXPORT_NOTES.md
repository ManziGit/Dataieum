# 공개 사본 변경 내역

운영 컨테이너에서 추출한 원본은 별도로 보관했습니다. 공개 사본에서 아래 항목만 정리했습니다.

- `operations/backup_mac.py`, `operations/release.py`: 실제 SSH 접속 대상과 키 경로를 필수 환경변수 `DATAIEUM_SSH_TARGET`, `DATAIEUM_SSH_KEY`로 분리. 원격 작업 전에 설정해야 하며, 누락 시 오류를 반환합니다.
- `discovery_harness/ontology_asset_models.json`: 검토 근거에 남아 있는 개인 PC 작업 경로를 프로젝트 상대경로로 변경. 원래 파일명·날짜·검토 내용은 유지했습니다. 해당 검토 입력 파일 전체가 이 사본에 포함되는 것은 아닙니다.
- `THIRD_PARTY_NOTICES.md`: 빌드 결과물에 포함된 React·React DOM·Scheduler의 버전과 MIT 고지 추가.
- `README.md`, `.gitignore`, 이 문서와 `SOURCE_MANIFEST.json`: 공개 범위·제약·파일 검증을 위한 안내 추가.
- `docs/images/`: README에 쓴 운영 화면 두 장. 대회 발표자료에 실린 화면을 그대로 옮겼습니다.

`SOURCE_MANIFEST.json`은 추출 원본과 공개 파일의 SHA-256을 각각 기록합니다. 기존 Git 이력, 개발 날짜 및 버전 식별자를 다시 작성하지 않았습니다. 운영 서비스·원래 프로젝트에는 이 공개 사본의 정리 내용을 적용하지 않았습니다.

## 개발 저장소에서 보완한 파일

운영 컨테이너에는 실행 코드와 빌드 결과만 들어 있어서, 이미지를 만드는 정의, 프론트엔드 소스, 테스트, 서버 타이머가 빠져 있었습니다. 이 파일들은 비공개 개발 저장소 `ManziGit/wanted`에서 가져왔고, 파일마다 원래 경로·리비전·SHA-256을 `SOURCE_MANIFEST.json`에 `source_repository`, `source_revision`, `source_path`로 남겼습니다.

기준 리비전은 `59d8f49`입니다. 이 리비전의 프론트엔드 소스를 빌드하면 `frontend/`의 JS·CSS 번들, `index.html`, `.vite/manifest.json`과 바이트 단위로 같은 결과가 나옵니다. 이후 커밋(10월 16일)은 보조 도메인 브랜딩 제거와 배포 파이프라인 변경이라 이 사본의 시점과 맞지 않아 반영하지 않았습니다.

- `frontend-src/`: React·TypeScript 소스와 테스트. 개발 저장소의 경로는 `frontend/`이지만, 이 사본에서는 그 자리를 운영 빌드 결과가 쓰고 있어 디렉터리 이름만 바꿨습니다.
- `Dockerfile`, `.dockerignore`: atlas·vector·refresh·luna 이미지 정의. `COPY` 경로와 허용 목록만 이 저장소 구조(`backend/` 접두사 없음, 프론트엔드 소스는 `frontend-src/`)에 맞췄습니다. 이 저장소의 `requirements.txt`에는 numpy·faiss-cpu가 이미 들어 있어 atlas 단계에서도 설치됩니다.
- `operations/dataieum-refresh.service`·`.timer`: 매시간 임베딩 Batch를 정산하고, 하루에 출처 8곳씩 돌아가며 수집하는 갱신 작업.
- `operations/dataieum-maintenance.service`·`.timer`: 매일 04:00(KST) 발행과 중단된 유지보수 복구.
- `operations/tests/`의 테스트 11개. 두 파일만 고쳤습니다.
  - `test_branding.py`: 불러오는 모듈 경로를 `discovery_harness/branding.py`로 변경.
  - `test_dataset_compare.py`: 이 사본의 `http_api.py`는 요청을 처리하기 전에 harness 상태를 확인하므로, 테스트용 harness에 `healthy=True`를 추가.
- 앞서 같은 저장소에서 `operations/refresh-sources.json`과 갱신·색인 테스트 6개를 가져왔고, vector 이미지에만 있던 numpy·faiss-cpu를 `requirements.txt`에 더했습니다.

다음은 가져오지 않았습니다.

- `vector_index.py`, `vector_tools.py`, `hybrid_search.py` 등 양쪽에 있는 백엔드 코드: 이 사본(운영 컨테이너)이 더 최신입니다. 개발 저장소 버전에는 시계열 자료 묶기, 인증 만료 복구, 협력 메일 같은 운영 기능이 없습니다.
- `.github/workflows/release.yml`: 실제 서버에 배포하는 워크플로라 공개 저장소에서 실행되면 안 됩니다. 이 워크플로가 돌리던 테스트는 위 파일들로 모두 옮겼습니다.
- 개발 저장소의 `operations/backup_mac.py`, `operations/release.py`, `operations/ci_release.py`: 실제 서버 주소·키 파일명이 들어 있거나 비공개 이미지 저장소를 전제로 합니다. 이 사본은 접속 정보를 환경변수로 분리한 버전을 유지합니다.
