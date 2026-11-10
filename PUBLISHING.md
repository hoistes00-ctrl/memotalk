# 공개 배포 체크리스트 (초보자용)

## A. 지금 GitHub에 올려도 되는 파일

`MemoTalk-GitHub-Public-v17.zip`의 압축을 푼 **폴더 안 파일만** 사용하세요. GitHub에 ZIP 자체를 올리는 것보다 저장소 루트에 소스 파일을 업로드하는 것이 적합합니다.

**올리지 말 것:** `메모톡-백업-날짜.json`, 개인 메모 `.md`, `Backups/`, `.memotalk-history/`, 비밀번호, `.env`, `android/local.properties`, `*.keystore`, `*.jks`, APK 및 EXE 임시 빌드 결과.

`.gitignore`는 Git 명령어로 추가할 때 도움을 주지만, **웹 화면에서 드래그해 업로드하는 파일을 자동으로 막아 주지는 않습니다.** 반드시 깨끗한 업로드용 폴더만 선택하세요.

## B. GitHub 저장소 생성 및 첫 업로드

1. GitHub → New repository → Name `MemoTalk` → **Public**.
2. README나 .gitignore 자동 생성은 선택하지 않아도 됩니다. 준비한 파일에 포함되어 있습니다.
3. 저장소가 생기면 `uploading an existing file` 또는 Git 명령어로 **이 패키지 내부 파일만** 업로드합니다.
4. 업로드 전 변경 파일 목록을 다시 확인합니다. `Commit changes`를 누르면 소스가 공개됩니다.
5. **이 단계를 시작하기 전에 반드시 사용자의 업로드 승인을 받습니다.**

## C. 자동 빌드와 공개 릴리스

- `.github/workflows/build-installers.yml`은 Actions 화면에서 수동 실행할 수 있는 테스트용 빌드입니다. **Android 결과물은 디버그 APK이며, 안정적인 업데이트용 공개 배포 파일이 아닙니다.**
- `.github/workflows/publish-release.yml`은 `v17.0.0` 등의 태그를 푸시했을 때 정식 APK/EXE를 빌드하고 GitHub Releases에 올리도록 준비한 워크플로입니다.
- **Android 릴리스 전에 GitHub Actions Secrets에 다음 4가지를 설정해야 합니다.** 이 값은 소스 파일에 넣거나 채팅에 복사하지 않습니다.
  - `MEMOTALK_ANDROID_KEYSTORE_BASE64` — 본인이 만든 서명 keystore 파일의 base64 값
  - `MEMOTALK_ANDROID_KEYSTORE_PASSWORD` — keystore 암호
  - `MEMOTALK_ANDROID_KEY_ALIAS` — 키 별칭
  - `MEMOTALK_ANDROID_KEY_PASSWORD` — 키 암호
- 영구 보관할 정식 서명키는 **본인의 PC에서** 생성해 안전하게 보관하세요. 파일을 잃어버리면 같은 앱을 업데이트할 수 없을 수 있습니다.
- 위 비밀값이 없으면 배포 워크플로는 안전하게 실패하도록 설계되어 있습니다.
- 새 정식 서명키를 사용한 APK는 **기존 로컬 디버그 서명 APK 위에 덮어 설치되지 않을 수 있습니다.** JSON 백업 및 복원 계획을 먼저 검증하세요. 개인 자료가 있다면 앱을 삭제하지 마세요.
- Windows 설치 파일은 코드 서명이 별도로 필요할 수 있으며, 서명하지 않은 파일은 SmartScreen 경고가 발생할 수 있습니다.

## D. 다운로드 페이지

Settings → Pages에서 Branch `main`, `/docs`를 선택하면 다운로드 페이지가 게시될 수 있습니다. 첫 GitHub Release가 없으면 실제 다운로드 링크가 동작하지 않습니다. Android/Windows 자동 감지는 편의 기능이며 다른 기기 수동 선택도 지원합니다.

## E. 첫 공개 전 최종 검사

- 민감정보 및 개인 메모 파일 미포함 확인
- Android 릴리스 서명 키 설정 확인
- GitHub Actions Android/Windows 빌드 성공 확인
- APK/EXE 실기기 설치 및 백업·복원 검사
- 버전 및 업데이트 경로 확인
- LICENSE 채택 여부 결정 (현재 미설정)
