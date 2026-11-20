# 모두톡

Windows·Android를 **모두톡 17.4.1**이라는 같은 이름과 버전으로 제공합니다. 메모방·댓글·폴더·라벨·첨부·백업과 Obsidian 공유 폴더 기반 양방향 변경 이력을 지원합니다.

## 다운로드

[모두톡 17.4.1 릴리스](https://github.com/hoistes00-ctrl/memotalk/releases/tag/modutalk-v17.4.1)에서 Windows 설치형·무설치형과 Android APK, 체크섬을 제공합니다. [통합 안내 페이지 소스](docs/modutalk-download.html)도 같은 버전 정보로 구성됩니다. 과거 릴리스는 이력으로 보존하며 현재 통합 버전과 구분합니다.

현재 수정판은 기존 앱 ID·서명·Windows 프로필을 유지하는 업데이트입니다. 이름 변경을 위해 원본 앱·공유 그룹·메모를 삭제하거나 초기화하지 마세요. 별도 구형 앱의 데이터는 자동으로 합쳐지지 않습니다. [통합 및 데이터 호환 안내](docs/MODUTALK-UNIFICATION.md)를 확인하세요.

## 개발·검증

이름과 버전의 원본은 `app-info.json`입니다. `python scripts/sync-app-info.py`로 사본을 맞추고 `python scripts/sync-app-info.py --check`로 확인합니다. Android Gradle도 같은 파일을 읽습니다.

Windows는 `windows`에서 `npm install`, `npm run dist:win`, `npm run dist:portable`로 빌드합니다. Android는 Gradle 8.9와 JDK 17 이상에서 `gradle -p android testSharingPreviewUnitTest assembleSharingPreview`로 현재 통합 패키지를 만듭니다. 기존 수정판 업데이트에는 기존 서명 키를 유지해야 합니다. [서명 안내](SIGNING.md)를 참고하세요. 개인 키와 사용자 백업은 저장소에 넣지 않습니다.

숨겨진 저장 키·프로토콜·일부 내부 클래스의 memotalk 명칭은 원본 데이터와의 호환을 위해 유지합니다. 사용자가 보는 이름과 배포 버전은 모두톡으로 통일합니다. [동기화 방식](docs/DEVICE-SHARING.md), [복구 범위](docs/SYNC-RECOVERY.md)를 참고하세요.

같은 공유 방의 복사본은 제목·방 생성 시각·공통 메모 작성 시각을 함께 확인해 자동 통합합니다. 겹치는 메모는 한 번만 표시하며 추가 메모·댓글·사진과 다른 편집본은 보존합니다. [자동 방 통합 기준과 보존 범위](docs/ROOM-MERGE.md)를 확인하세요.

17.4.1은 목록 제목의 전체 표시·글자 크기·줄 간격을 조절하고 앱 분류 위치와 실제 저장 위치를 구분해 보여줍니다. [제목과 위치 안내](docs/LOCATION-AND-TITLES.md)를 확인하세요.
