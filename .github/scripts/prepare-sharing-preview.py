"""Package only the runtime-tested artifacts from this workflow run."""
import hashlib
import json
import os
from pathlib import Path
import re
import shutil

# 1 MiB is the preview packager default; larger chunks use more memory per file hash.
HASH_CHUNK_BYTES = 1024 * 1024

def digest_file(item):
    digest = hashlib.sha256()
    with item.open('rb') as handle:
        for chunk in iter(lambda: handle.read(HASH_CHUNK_BYTES), b''):
            digest.update(chunk)
    return digest.hexdigest()

version = json.loads(Path('windows/package.json').read_text(encoding='utf-8'))['version']
assert re.fullmatch(r'17\.1\.0-sharing\.\d+', version), 'Unexpected preview version'
source = os.environ['GITHUB_SHA']
assert re.fullmatch(r'[0-9a-f]{40}', source)
assert os.environ['GITHUB_REF'] == 'refs/heads/feature/obsidian-bridge-prototype'
signing = os.environ['PREVIEW_SIGNING']
assert signing in ('owner', 'debug-ephemeral'), 'Missing actual tested APK signing identity'
inputs = Path('release-input')
windows = sorted((inputs / 'windows').rglob('*.exe'))
android = list((inputs / 'android').rglob('*.apk'))
expected = {f'MemoTalk-Setup-{version}-x64.exe', f'MemoTalk-Portable-{version}-x64.exe'}
assert len(windows) == 2 and {p.name for p in windows} == expected
assert len(android) == 1 and android[0].name == 'app-sharingPreview.apk'
output = Path('release-assets')
output.mkdir(exist_ok=False)
for item in windows:
    shutil.copyfile(item, output / item.name)
apk_name = f'MemoTalk-Android-{version}.apk'
shutil.copyfile(android[0], output / apk_name)
assets = []
for item in sorted(output.iterdir()):
    assert item.stat().st_size > 0
    assets.append({'name': item.name, 'bytes': item.stat().st_size,
                   'sha256': digest_file(item)})
run_url = f"https://github.com/{os.environ['GITHUB_REPOSITORY']}/actions/runs/{os.environ['GITHUB_RUN_ID']}"
info = {'version': version, 'sourceCommit': source, 'branch': os.environ['GITHUB_REF_NAME'],
        'validationRun': run_url, 'androidPackage': 'kr.memotalk.app.sharingpreview2',
        'androidSigning': signing, 'windowsUnsigned': True, 'assets': assets,
        'verified': ['Node protocol/storage/connection regression suite on Windows/Linux', 'two-profile browser UI on Windows/Linux',
                     '6 Android JVM tests', '4 actual Android API35 SAF/WebView tests',
                     'actual packaged Windows EXE receives Android changes and publishes reply',
                     'packaged shared source bytes match checkout'],
        'notVerified': ['user phone vendor/Android version', 'actual Obsidian Sync server transport']}
(output / 'build-info.json').write_text(json.dumps(info, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
checksums = []
for item in sorted(output.iterdir()):
    checksums.append(digest_file(item) + '  ' + item.name)
(output / 'SHA256SUMS.txt').write_text('\n'.join(checksums) + '\n', encoding='ascii')
notes = f'''Windows·Android 메모톡 앱 간 양방향 폴더 공유 시험판입니다.

- 두 메모톡 앱의 추가·수정·삭제, 사진·댓글을 공유하며 동시 수정 두 버전은 모두 보존합니다.
- Windows에서 전용 새 폴더에 그룹을 만든 뒤 Android에서 같은 vault의 같은 하위 폴더로 참여하세요.
- Android에서 먼저 빈 폴더에 참여하면 이전 자동 저장을 중지하고 그룹 생성 안내를 표시합니다. 기존 저널 교체 오류를 방지합니다.
- 이번 APK는 메모톡 공유 시험판 2(kr.memotalk.app.sharingpreview2)이며 이전 시험판을 삭제하지 않고 설치할 수 있습니다. 기존 앱에서 JSON 백업을 내보내 새 앱으로 가져오세요.
- 두 기기의 Obsidian에서 **Sync all other types**를 켜고 Obsidian을 실행해 두세요. 앱 종료/절전 중 항상 실시간 전송을 보장하지 않습니다.
- 기존 앱에서 먼저 JSON 백업을 보관하세요. Android는 별도 앱이며 기존 메모가 필요하면 백업을 가져오세요. Windows 포터블도 기존 앱과 내부 저장소를 공유할 수 있으므로 기존 앱을 종료하세요.
- Windows EXE는 서명되지 않았습니다. Android 서명: `{signing}`. `debug-ephemeral`이면 다음 시험 APK의 덮어 설치가 거부될 수 있으므로 삭제 전 반드시 백업하세요.
- Obsidian에서 Markdown을 직접 고친 내용을 가져오는 기능은 포함하지 않습니다.
- 실제 휴대폰과 Obsidian 서버 전송은 별도 확인이 필요합니다.

[설정·충돌 복원 안내](https://github.com/{os.environ['GITHUB_REPOSITORY']}/blob/{source}/docs/DEVICE-SHARING.md) · [통과한 전체 검증]({run_url}) · [PR #2](https://github.com/{os.environ['GITHUB_REPOSITORY']}/pull/2)

Source: `{source}`. main, 기존 정식 릴리스, 다운로드 브랜치는 변경하지 않습니다.
'''
Path('release-notes.md').write_text(notes, encoding='utf-8')
print(json.dumps(info, ensure_ascii=False, indent=2))
