import json,os,subprocess,pathlib
repo='hoistes00-ctrl/memotalk'
release_id=453470696
expected=[{"name":"app.html","digest":"sha256:a1caf03dd09269a35da5de7d6de5b496dca42908dffccf9285b0c89820d30091","size":360007},{"name":"main.js","digest":"sha256:37ee48798078c7eb922e3edfb177e19aa6f5fd4e6b542484844813c15dbe38bf","size":33288},{"name":"manifest.json","digest":"sha256:d50662bb942bc446cf9d824305ef4429fc4c70bb9970c2f5b19955689eea7adb","size":323},{"name":"Modutalk-Obsidian-17.5.4-test.1.zip","digest":"sha256:f0e7a59c7183abdc756b368e23e4ee2eb2c62aa1f906ece51375be571340c891","size":116314},{"name":"SHA256SUMS.txt","digest":"sha256:43d086b34370a231861790db2e85eb8620b82ad334eea3473de847518ab17136","size":436},{"name":"styles.css","digest":"sha256:baa6eaa0a202e32d91c3c0f6f07ebd8aceb200bd6acdf93656fa5caa758dc84e","size":1385}]
def api(*args):
 return json.loads(subprocess.check_output(['gh','api',*args],text=True))
def assets(r):return sorted([{'name':a['name'],'digest':a['digest'],'size':a['size']} for a in r['assets']],key=lambda a:a['name'])
before=api('repos/'+repo+'/releases/'+str(release_id))
assert assets(before)==sorted(expected,key=lambda a:a['name'])
payload=pathlib.Path('release-body-payload.json');payload.write_text(json.dumps({'body':pathlib.Path('docs/17.5.4-release-body.ko.md').read_text(encoding='utf-8')}),encoding='utf-8')
api('--method','PATCH','repos/'+repo+'/releases/'+str(release_id),'--input',str(payload))
after=api('repos/'+repo+'/releases/'+str(release_id))
assert assets(after)==assets(before)
assert after['body']==json.loads(payload.read_text(encoding='utf-8'))['body']
print('Release verification notes recorded; all six asset hashes and sizes unchanged.')
