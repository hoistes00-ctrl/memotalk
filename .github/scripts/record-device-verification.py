import json,os,subprocess
repo=os.environ['GITHUB_REPOSITORY']
def gh(*args):
    return json.loads(subprocess.check_output(['gh','api',*args],text=True))
release=gh('repos/'+repo+'/releases/tags/modutalk-v17.3.0')
assert not release['draft'] and not release['prerelease']
assert release['target_commitish']=='93f08d36e97d704cdb4b7bf6da607ea64d78ec2f'
before={a['name']:(a['size'],a.get('digest')) for a in release['assets']}
assert len(before)==6
old='실제 Galaxy Flip5에 17.3.0을 설치한 결과는 아직 확인하지 못했습니다. 이전 17.2.0의 설치 확인과 구별합니다.'
new='2026년 11월 19일, 사용자가 Galaxy Flip5에서도 겹치던 방이 하나로 합쳐지고 양쪽에 따로 있던 메모가 함께 보인다고 확인했습니다. PC 적용과 원본 공유 파일 보존도 별도로 확인했습니다. 휴대폰 확인은 사용자 보고이며, 이번 휴대폰의 파일 해시나 서버 로그를 직접 수집했다고 주장하지 않습니다.'
body=release['body']
if old in body:body=body.replace(old,new)
else:assert new in body
note='\n\nREADME.ko.md와 build-info.json은 배포 당시의 빌드·검증 기록으로 그대로 보존합니다. 위의 2026년 11월 19일 사용자 확인은 배포 후 확인 결과입니다. 설치 파일과 체크섬은 바꾸지 않았습니다.'
if note not in body:body+=note
updated=gh('--method','PATCH','repos/'+repo+'/releases/'+str(release['id']),'-f','body='+body)
assert {a['name']:(a['size'],a.get('digest')) for a in updated['assets']}==before
assert new in updated['body']
print('Recorded user-confirmed phone merge; installer bytes and asset digests unchanged.')
