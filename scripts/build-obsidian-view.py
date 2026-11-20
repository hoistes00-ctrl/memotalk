"""Bundle the reviewed shared UI offline; never copy a user's profile or vault."""
from pathlib import Path
import sys,re,zipfile,json
ROOT=Path(__file__).resolve().parents[1]
source=(ROOT/'shared/index.html').read_text(encoding='utf-8')
source=source.replace('<head>','<head>\n<!--MODUTALK_BOOTSTRAP-->',1)
source=re.sub(r'<link[^>]+href="https://fonts\.[^"]+"[^>]*>\s*','',source)
for name in ['platform-bridge.js','mirror-engine.js','peer-sync-engine.js','peer-sync-client.js']:
    code=(ROOT/'shared'/name).read_text(encoding='utf-8')
    escaped=re.sub(r'</script',r'<\\/script',code,flags=re.I)
    source=source.replace('<script src="'+name+'"></script>','<script>if(window.__modutalkHostReady){\n'+escaped+'\n}</script>')
# The application's final inline script is also gated if storage isolation fails.
needle='<script>\n(() => {'
if needle not in source:raise RuntimeError('Shared app entry point changed; inspect before bundling')
source=source.replace(needle,'<script>\nif(window.__modutalkHostReady){\n(() => {',1)
source=source.replace('boot();\n})();\n</script>','boot();\n})();\n}\n</script>',1)
assert '<script src=' not in source and '<!--MODUTALK_BOOTSTRAP-->' in source
target=ROOT/'obsidian/modutalk-sync-view/app.html'
if '--check' in sys.argv:
    assert target.read_text(encoding='utf-8')==source,'Regenerate the hosted UI from shared sources'
else:target.write_text(source,encoding='utf-8',newline='\n')
print('Verified offline Obsidian view bundle.' if '--check' in sys.argv else 'Built offline Obsidian view bundle.')
if '--zip' in sys.argv:
    output=Path(sys.argv[sys.argv.index('--zip')+1]);output.parent.mkdir(parents=True,exist_ok=True)
    manifest=json.loads((target.parent/'manifest.json').read_text(encoding='utf-8'))
    assert manifest['version']==json.loads((ROOT/'app-info.json').read_text(encoding='utf-8'))['version']
    with zipfile.ZipFile(output,'w',compression=zipfile.ZIP_DEFLATED) as archive:
        for name in ['main.js','manifest.json','styles.css','app.html']:
            entry=zipfile.ZipInfo('modutalk-sync-view/'+name,date_time=(1980,1,1,0,0,0));entry.compress_type=zipfile.ZIP_DEFLATED;entry.external_attr=0o100644<<16
            archive.writestr(entry,(target.parent/name).read_text(encoding='utf-8').encode('utf-8'))
    print('Packaged plugin code only; no device settings, keys or notes.')
