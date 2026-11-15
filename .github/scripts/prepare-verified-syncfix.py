"""Promote exact verified artifacts; never build a differently signed phone APK."""
from pathlib import Path
import hashlib,json,os,shutil,subprocess,sys,zipfile

# Backend hashing buffer: larger uses more memory, without changing published bytes.
HASH_CHUNK_BYTES=1024*1024
INPUT=Path('release-assets/syncfix')
OUTPUT=Path('verified-downloads')
MANIFEST=json.loads((INPUT/'manifest.json').read_text(encoding='utf-8'))
REPO=os.environ['GITHUB_REPOSITORY']

def digest(file):
    h=hashlib.sha256()
    with file.open('rb') as f:
        for data in iter(lambda:f.read(HASH_CHUNK_BYTES),b''):h.update(data)
    return h.hexdigest()

def gh(*args,capture=True):
    r=subprocess.run(['gh',*args],check=True,capture_output=capture,text=True)
    return r.stdout.strip() if capture else ''

def prepare():
    run=json.loads(Path('source-run.json').read_text())
    artifact=json.loads(Path('source-artifact.json').read_text())
    assert run['head_sha']==MANIFEST['sourceCommit'] and run['conclusion']=='success'
    assert run['id']==MANIFEST['sourceRunId']
    assert artifact['id']==MANIFEST['windowsArtifactId'] and not artifact['expired']
    assert artifact['workflow_run']['head_sha']==MANIFEST['sourceCommit']
    assert artifact['digest']=='sha256:'+MANIFEST['windowsArtifactSha256']
    assert digest(Path('windows-artifact.zip'))==MANIFEST['windowsArtifactSha256']
    OUTPUT.mkdir(exist_ok=False)
    with zipfile.ZipFile('windows-artifact.zip') as z:
        selected=[n for n in z.namelist() if Path(n).name==MANIFEST['windowsFile']]
        assert len(selected)==1
        with z.open(selected[0]) as src,(OUTPUT/MANIFEST['windowsFile']).open('wb') as dst:
            shutil.copyfileobj(src,dst,HASH_CHUNK_BYTES)
    apk=INPUT/MANIFEST['androidFile']
    assert digest(apk)==MANIFEST['androidSha256']
    tools=Path(os.environ['ANDROID_HOME'])/'build-tools/35.0.0'
    cert=subprocess.check_output([str(tools/'apksigner'),'verify','--print-certs',str(apk)],text=True)
    assert 'Signer #1 certificate SHA-256 digest: '+MANIFEST['androidCertificateSha256'] in cert
    badging=subprocess.check_output([str(tools/'aapt'),'dump','badging',str(apk)],text=True)
    assert "name='"+MANIFEST['androidPackage']+"'" in badging.splitlines()[0]
    assert "versionCode='"+str(MANIFEST['androidVersionCode'])+"'" in badging.splitlines()[0]
    assert "versionName='"+MANIFEST['androidVersion']+"'" in badging.splitlines()[0]
    with zipfile.ZipFile(apk) as z:
        for name in ['index.html','mirror-engine.js','peer-sync-engine.js','peer-sync-client.js','platform-bridge.js']:
            packaged=z.read('assets/'+name).decode('utf-8').replace('\r\n','\n')
            source=(Path('shared')/name).read_text(encoding='utf-8')
            assert packaged==source, 'APK asset differs from reviewed source: '+name
    shutil.copyfile(apk,OUTPUT/apk.name)
    shutil.copyfile(INPUT/'release-notes.ko.md',OUTPUT/'README.ko.md')
    binaries=[{'name':p.name,'bytes':p.stat().st_size,'sha256':digest(p)} for p in sorted(OUTPUT.iterdir()) if p.suffix in ('.exe','.apk')]
    info={**MANIFEST,'windowsOrigin':'successful installed-Windows roundtrip CI artifact','sourceRunAttempt':run['run_attempt'],'sourceRunUrl':run['html_url'],'androidOrigin':'exact locally installed and full-restart device-tested APK; not re-signed in CI','publicationRun':os.environ['GITHUB_RUN_ID'],'binaries':binaries}
    (OUTPUT/'build-info.json').write_text(json.dumps(info,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
    sums=''.join(digest(p)+'  '+p.name+'\n' for p in sorted(OUTPUT.iterdir()))
    (OUTPUT/'SHA256SUMS.txt').write_text(sums,encoding='ascii')
    print('Verified successful source run, immutable Windows artifact digest, installed APK hash, certificate, app ID and shared source.')

def publish():
    tag=MANIFEST['tag']
    endpoint='repos/'+REPO+'/releases/tags/'+tag
    prior=subprocess.run(['gh','api',endpoint],capture_output=True,text=True)
    if prior.returncode==0:
        release=json.loads(prior.stdout)
        assert release['target_commitish']==MANIFEST['sourceCommit'] and release['prerelease']
        draft=release['draft']
    else:
        # Abort on authentication/server errors, rather than treating them as an absent tag.
        assert '404' in prior.stderr
        gh('release','create',tag,'--repo',REPO,'--target',MANIFEST['sourceCommit'],'--title','메모톡 동기화 수정판 — Windows syncfix.1 / Android syncfix.2','--notes-file',str(INPUT/'release-notes.ko.md'),'--draft','--prerelease','--latest=false')
        draft=True
    files=sorted(p for p in OUTPUT.iterdir() if p.is_file())
    if draft:
        gh('release','upload',tag,*[str(p) for p in files],'--repo',REPO,'--clobber')
    release=json.loads(gh('api',endpoint))
    expected={p.name:p for p in files}
    assert {a['name'] for a in release['assets']}==set(expected)
    for asset in release['assets']:
        local=expected[asset['name']]
        assert asset['size']==local.stat().st_size
        if asset.get('digest'):assert asset['digest']=='sha256:'+digest(local)
    verify=Path('verified-remote-downloads');verify.mkdir(exist_ok=False)
    gh('release','download',tag,'--repo',REPO,'--dir',str(verify))
    for name,local in expected.items():assert digest(verify/name)==digest(local)
    if draft:gh('release','edit',tag,'--repo',REPO,'--draft=false','--prerelease','--latest=false')
    release=json.loads(gh('api',endpoint))
    assert not release['draft'] and release['prerelease']
    print('Published verified downloads: '+release['html_url'])

if __name__=='__main__':
    {'prepare':prepare,'publish':publish}[sys.argv[1]]()
