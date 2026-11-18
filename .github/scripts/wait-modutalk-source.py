from pathlib import Path
import json,os,subprocess,time

# Backend polling interval in seconds; larger waits longer between status checks.
WAIT_INTERVAL_SECONDS=20
# Backend check limit; larger permits a longer build before failing safely.
WAIT_ATTEMPTS=90
repo=os.environ['GITHUB_REPOSITORY']
path=Path('release-assets/modutalk/manifest.json')
manifest=json.loads(path.read_text(encoding='utf-8'))
def api(endpoint):
    return json.loads(subprocess.check_output(['gh','api','repos/'+repo+'/'+endpoint],text=True))
for attempt in range(WAIT_ATTEMPTS):
    run=api('actions/runs/'+str(manifest['sourceRunId']))
    assert run['head_sha']==manifest['sourceCommit']
    if run['status']=='completed':
        assert run['conclusion']=='success', 'Source verification failed; no release will be published'
        break
    print('Waiting for verified source run: '+run['status'],flush=True)
    time.sleep(WAIT_INTERVAL_SECONDS)
else:raise RuntimeError('Source verification did not finish within the waiting limit')
artifacts=api('actions/runs/'+str(manifest['sourceRunId'])+'/artifacts')['artifacts']
matches=[a for a in artifacts if a['name']=='Modutalk-Windows' and not a['expired']]
assert len(matches)==1
artifact=matches[0]
assert artifact['digest'].startswith('sha256:')
manifest['windowsArtifactId']=artifact['id']
manifest['windowsArtifactSha256']=artifact['digest'].removeprefix('sha256:')
path.write_text(json.dumps(manifest,indent=2)+'\n',encoding='utf-8')
Path('source-run.json').write_text(json.dumps(run),encoding='utf-8')
Path('source-artifact.json').write_text(json.dumps(artifact),encoding='utf-8')
with Path('windows-artifact.zip').open('wb') as output:
    subprocess.run(['gh','api','repos/'+repo+'/actions/artifacts/'+str(artifact['id'])+'/zip'],stdout=output,check=True)
print('Downloaded exact Windows artifact from the successful reviewed source run.')
