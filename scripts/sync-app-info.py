"""Keep visible Modutalk branding/version in sync while preserving storage identity."""
from pathlib import Path
import json,re,sys

ROOT=Path(__file__).resolve().parent.parent
INFO=json.loads((ROOT/'app-info.json').read_text(encoding='utf-8'))
CHECK='--check' in sys.argv
WINDOWS_INFO={**INFO,'version':INFO.get('windowsVersion',INFO['version'])}
assert re.fullmatch(r'\d+\.\d+\.\d+',WINDOWS_INFO['version'])
assert INFO['displayName']=='모두톡'
assert re.fullmatch(r'\d+\.\d+\.\d+',INFO['version'])
assert INFO['androidApplicationId']=='kr.memotalk.app.sharingpreview5.syncfix'
assert INFO['windowsAppId']=='kr.memotalk.desktop' and INFO['windowsProfile']=='memotalk-desktop'

def write(path,text):
    file=ROOT/path
    old=file.read_text(encoding='utf-8') if file.exists() else None
    if CHECK:
        assert old==text, 'Outdated app branding/version: '+path+'; run python scripts/sync-app-info.py'
    elif old!=text or file.read_bytes()!=text.encode('utf-8'):
        file.parent.mkdir(parents=True,exist_ok=True)
        file.write_text(text,encoding='utf-8',newline='\n')

package=json.loads((ROOT/'windows/package.json').read_text(encoding='utf-8'))
package['version']=WINDOWS_INFO['version']
package['description']=INFO['displayName']+' - Windows 설치형 메모 앱'
package['build']['productName']=INFO['displayName']
package['build']['nsis']['shortcutName']=INFO['displayName']
package['build']['nsis']['artifactName']='Modutalk-Setup-${version}-${arch}.${ext}'
package['build']['artifactName']='Modutalk-${version}-${os}-${arch}.${ext}'
package['build']['portable']['artifactName']='Modutalk-Portable-${version}-${arch}.${ext}'
if 'app-info.json' not in package['build']['files']:package['build']['files'].append('app-info.json')
package['scripts'].update({'prestart':'python ../scripts/sync-app-info.py --check','predist:win':'python ../scripts/sync-app-info.py --check','predist:portable':'python ../scripts/sync-app-info.py --check'})
write('windows/package.json',json.dumps(package,ensure_ascii=False,indent=2)+'\n')
write('windows/app-info.json',json.dumps(WINDOWS_INFO,ensure_ascii=False,indent=2)+'\n')
downloads={'displayName':INFO['displayName'],'version':INFO['version'],'repository':'hoistes00-ctrl/memotalk','tag':'modutalk-v'+INFO['version'],'files':{'windows':'Modutalk-Setup-'+INFO['version']+'-x64.exe','android':'Modutalk-Android-'+INFO['version']+'.apk','portable':'Modutalk-Portable-'+INFO['version']+'-x64.exe'}}
downloads['files']['obsidian']='Modutalk-Obsidian-'+INFO['version']+'.zip'
downloads['platforms']={kind:{'version':WINDOWS_INFO['version'],'tag':'modutalk-v'+WINDOWS_INFO['version']} for kind in ['windows','portable']}
downloads['files']['windows']='Modutalk-Setup-'+WINDOWS_INFO['version']+'-x64.exe'
downloads['files']['portable']='Modutalk-Portable-'+WINDOWS_INFO['version']+'-x64.exe'
write('docs/downloads.json',json.dumps(downloads,ensure_ascii=False,indent=2)+'\n')
plugin_manifest=ROOT/'obsidian/modutalk-sync-view/manifest.json'
if plugin_manifest.exists():
    manifest=json.loads(plugin_manifest.read_text(encoding='utf-8'))
    # The Obsidian-only UI plugin may have a newer patch while the installed
    # Windows/Android apps safely retain their existing version and signing ID.
    current=tuple(map(int,INFO['version'].split('.')))
    plugin=tuple(map(int,manifest['version'].split('.')))
    plugin_only_patch=plugin[:2]==current[:2] and plugin[2]>current[2]
    if not plugin_only_patch:manifest['version']=INFO['version']
    write('obsidian/modutalk-sync-view/manifest.json',json.dumps(manifest,ensure_ascii=False,indent=2)+'\n')
write('docs/index.html',(ROOT/'docs/modutalk-download.html').read_text(encoding='utf-8'))
landing=(ROOT/'index.html').read_text(encoding='utf-8').replace('메모톡',INFO['displayName'])
write('index.html',landing)
lock=ROOT/'windows/package-lock.json'
if lock.exists():
    value=json.loads(lock.read_text(encoding='utf-8'));value['version']=WINDOWS_INFO['version'];value['packages']['']['version']=WINDOWS_INFO['version']
    write('windows/package-lock.json',json.dumps(value,ensure_ascii=False,indent=2)+'\n')
source=(ROOT/'shared/index.html').read_text(encoding='utf-8').replace('메모톡',INFO['displayName'])
source=re.sub(r'<title>.*?</title>','<title>'+INFO['displayName']+' '+INFO['version']+'</title>',source,count=1)
write('shared/index.html',source)
for name in ['index.html','mirror-engine.js','platform-bridge.js','peer-sync-engine.js','peer-sync-client.js']:
    write('android/app/src/main/assets/'+name,(ROOT/'shared'/name).read_text(encoding='utf-8'))
print(('Checked' if CHECK else 'Synchronized')+' Modutalk '+INFO['version']+'; existing app IDs and profile preserved.')
