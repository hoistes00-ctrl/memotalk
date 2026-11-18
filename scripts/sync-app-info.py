"""Keep visible Modutalk branding/version in sync while preserving storage identity."""
from pathlib import Path
import json,re,sys

ROOT=Path(__file__).resolve().parent.parent
INFO=json.loads((ROOT/'app-info.json').read_text(encoding='utf-8'))
CHECK='--check' in sys.argv
assert INFO['displayName']=='모두톡'
assert re.fullmatch(r'\d+\.\d+\.\d+',INFO['version'])
assert INFO['androidApplicationId']=='kr.memotalk.app.sharingpreview5.syncfix'
assert INFO['windowsAppId']=='kr.memotalk.desktop' and INFO['windowsProfile']=='memotalk-desktop'

def write(path,text):
    file=ROOT/path
    old=file.read_text(encoding='utf-8') if file.exists() else None
    if CHECK:
        assert old==text, 'Outdated app branding/version: '+path+'; run python scripts/sync-app-info.py'
    elif old!=text:
        file.parent.mkdir(parents=True,exist_ok=True)
        file.write_text(text,encoding='utf-8')

package=json.loads((ROOT/'windows/package.json').read_text(encoding='utf-8'))
package['version']=INFO['version']
package['description']=INFO['displayName']+' - Windows 설치형 메모 앱'
package['build']['productName']=INFO['displayName']
package['build']['nsis']['shortcutName']=INFO['displayName']
package['build']['nsis']['artifactName']='Modutalk-Setup-${version}-${arch}.${ext}'
package['build']['artifactName']='Modutalk-${version}-${os}-${arch}.${ext}'
package['build']['portable']['artifactName']='Modutalk-Portable-${version}-${arch}.${ext}'
if 'app-info.json' not in package['build']['files']:package['build']['files'].append('app-info.json')
package['scripts'].update({'prestart':'python ../scripts/sync-app-info.py --check','predist:win':'python ../scripts/sync-app-info.py --check','predist:portable':'python ../scripts/sync-app-info.py --check'})
write('windows/package.json',json.dumps(package,ensure_ascii=False,indent=2)+'\n')
write('windows/app-info.json',json.dumps(INFO,ensure_ascii=False,indent=2)+'\n')
downloads={'displayName':INFO['displayName'],'version':INFO['version'],'repository':'hoistes00-ctrl/memotalk','tag':'modutalk-v'+INFO['version'],'files':{'windows':'Modutalk-Setup-'+INFO['version']+'-x64.exe','android':'Modutalk-Android-'+INFO['version']+'.apk','portable':'Modutalk-Portable-'+INFO['version']+'-x64.exe'}}
write('docs/downloads.json',json.dumps(downloads,ensure_ascii=False,indent=2)+'\n')
write('docs/index.html',(ROOT/'docs/modutalk-download.html').read_text(encoding='utf-8'))
landing=(ROOT/'index.html').read_text(encoding='utf-8').replace('메모톡',INFO['displayName'])
write('index.html',landing)
lock=ROOT/'windows/package-lock.json'
if lock.exists():
    value=json.loads(lock.read_text(encoding='utf-8'));value['version']=INFO['version'];value['packages']['']['version']=INFO['version']
    write('windows/package-lock.json',json.dumps(value,ensure_ascii=False,indent=2)+'\n')
source=(ROOT/'shared/index.html').read_text(encoding='utf-8').replace('메모톡',INFO['displayName'])
source=re.sub(r'<title>.*?</title>','<title>'+INFO['displayName']+' '+INFO['version']+'</title>',source,count=1)
write('shared/index.html',source)
for name in ['index.html','mirror-engine.js','platform-bridge.js','peer-sync-engine.js','peer-sync-client.js']:
    write('android/app/src/main/assets/'+name,(ROOT/'shared'/name).read_text(encoding='utf-8'))
print(('Checked' if CHECK else 'Synchronized')+' Modutalk '+INFO['version']+'; existing app IDs and profile preserved.')
