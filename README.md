# MemoTalk / 메모톡

메모톡은 메모방, 댓글, 폴더, 라벨, 첨부 사진, Markdown 파일 저장, 자동 백업과 휴지통을 지원하는 개인 메모 앱입니다.

- **Windows**: Electron 기반 설치형 앱
- **Android**: Java WebView 기반 APK 앱
- **오프라인 저장**: 기기 내부에 저장되며, 기기 간 자동 동기화는 아직 지원하지 않습니다.
- **백업**: JSON 백업 및 Markdown ZIP 내보내기 지원. 앱 내 자동 백업은 앱 삭제나 기기 초기화 시 함께 삭제될 수 있습니다.

## Android 시험용 APK 바로 설치 (Android Studio 불필요)

**[갤럭시용 MemoTalk v17 시험 APK 다운로드](https://github.com/hoistes00-ctrl/memotalk/raw/87ab690c590918e82bb33b7b693d19290c7766a1/MemoTalk-Android-test.apk)**

이 공개 시험판은 GitHub Actions에서 직접 빌드된 APK입니다. Android 휴대폰에서 파일을 다운로드한 후, 다운로드된 APK를 열어 설치를 승인하면 됩니다. 휴대폰에서 '출처를 알 수 없는 앱 설치' 권한 확인이 필요할 수 있습니다.

**중요:** 새 시험판은 앱 식별자가 `kr.memotalk.app.test`이고, 휴대폰에 **‘메모톡 테스트’**로 따로 설치됩니다. 기존 `kr.memotalk.app` 앱을 삭제하지 않고 나란히 사용할 수 있도록 변경했습니다. 두 앱의 데이터는 자동 공유되지 않으므로 기존 메모를 옮길 때는 기존 앱에서 JSON을 백업하고 새 시험판에 가져오세요. 시험판은 임시 디버그 서명으로 제작하며 이후 시험 APK가 같은 서명으로 업데이트된다는 보장은 없습니다. 기존 앱의 백업 파일은 GitHub에 올리지 마세요.

- [APK 파일 및 SHA-256 체크섬 보관 브랜치](https://github.com/hoistes00-ctrl/memotalk/tree/android-downloads)
- [Android 시험판 빌드 이력](https://github.com/hoistes00-ctrl/memotalk/actions/workflows/android-test-apk.yml)

## Windows용 EXE 설치 파일 바로 다운로드 (v17.0.1)

**[Windows 64비트 메모톡 v17.0.1 설치 프로그램 받기](https://github.com/hoistes00-ctrl/memotalk/raw/53cbeabde14a4c547eed1d4ec6cfaba6927248fb/MemoTalk-Windows-Setup.exe)**

별도로 Node.js나 빌드 도구를 설치하지 않아도 되는 Windows 64비트용 Electron 설치 프로그램입니다. 파일 크기는 약 81.8MB입니다. [다운로드 파일의 SHA-256 체크섬](https://github.com/hoistes00-ctrl/memotalk/blob/windows-downloads/SHA256SUMS-Windows.txt)도 확인할 수 있습니다.

**v17.0.1 변경사항:** Windows 목록의 메모방을 마우스로 드래그해 같은 폴더 안에서 위아래 순서를 바꿀 수 있습니다. 변경 순서는 해당 PC의 로컬 설정에 저장됩니다. 기존 폴더 이동과 메모 내용은 그대로 유지합니다.

**안전 안내:** 아직 코드 서명 인증서가 없는 시험판이므로 Windows SmartScreen에서 알 수 없는 게시자 경고가 나타날 수 있습니다. 설치 전 파일 출처를 확인하고, 기존 메모가 있다면 먼저 JSON 백업을 내보내세요. 실제 Windows PC에서의 설치 및 기존 데이터 유지 검증은 아직 완료되지 않았습니다.

- [Windows EXE 자동 빌드 결과](https://github.com/hoistes00-ctrl/memotalk/actions/workflows/windows-installer.yml)
- [다운로드 파일 보관 브랜치](https://github.com/hoistes00-ctrl/memotalk/tree/windows-downloads)

## 정식 다운로드 안내

장기 업데이트를 위한 정식 서명 APK와 Windows EXE는 [Releases](../../releases)에 별도 게시할 예정입니다. 다운로드 페이지는 `docs/index.html`을 GitHub Pages로 활성화하면 사용할 수 있습니다. 정식 서명키 설정과 빌드·설치 검증이 끝나기 전에는 시험판을 정식 APK로 표시하지 않습니다.

## 직접 빌드

Windows: Node.js 22 이상을 설치한 뒤 `build-windows.bat` 실행. 결과는 `windows/dist/`에 저장됩니다.

Android: Android Studio에서 `android/` 프로젝트를 열어 APK를 빌드합니다. 테스트용 디버그 APK와 배포용 정식 서명 APK는 서명이 다릅니다.

## 개인정보 보호

이 저장소에는 **사용자의 실제 메모, 백업 파일, 계정 정보, 로컬 폴더 경로, 비밀번호, API 키, 앱 서명 키**를 포함하지 않습니다. 실제 사용 중 생성된 파일을 업로드하지 마세요.

공개 저장소 업로드 전 [공개 전 점검](PUBLISHING.md)을 반드시 확인하세요.

## 유의사항

- Google Drive와 다른 클라우드 동기화는 아직 제공하지 않습니다.
- Android 및 Windows 실기기 배포 테스트는 별도로 필요합니다.
- 코드 저장소가 공개되어도 앱 내 개인 메모가 자동으로 공개되지는 않지만, **JSON 백업이나 실제 Markdown 폴더를 GitHub에 업로드하면 그대로 공개될 수 있습니다.**
- 별도 오픈소스 라이선스는 아직 선택하지 않았습니다. 저장소가 공개되어도 재사용 권한이 자동으로 부여되는 것은 아닙니다.