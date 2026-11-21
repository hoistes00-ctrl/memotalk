"""Virtual desktop/mobile UI: preview and merge a recovery room, preserve data and sort dates."""
from pathlib import Path
import json,os,subprocess,tempfile,shutil
from playwright.sync_api import sync_playwright

ROOT=Path(__file__).resolve().parents[1]
SOURCE_NAME='소설 아이디어 (복구)'
TARGET_NAME='소설 아이디어'
SAMPLE_PNG='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMBAIDBp1UAAAAASUVORK5CYII='
DATA={'seeded':True,'rooms':{
    'main-room':{'id':'main-room','name':TARGET_NAME,'createdAt':1000,'updatedAt':1000,'pinned':False},
    'recovery-room':{'id':'recovery-room','name':SOURCE_NAME,'createdAt':2000,'updatedAt':2000,'pinned':False}},
    'msgs':{
      'main-room':[{'id':'tcommon','ts':100,'text':'공통 메모'}],
      'recovery-room':[
         {'id':'scommon','ts':100,'text':'공통 메모'},
         {'id':'snew','ts':300,'text':'복구된 메모','comments':[{'id':'c1','ts':310,'text':'복구된 댓글'}],
          'images':[{'data':SAMPLE_PNG}]}]}}

def main():
    env=os.environ.copy()
    for key in ('MEMOTALK_TEST_ROOT','MEMOTALK_TEST_PORT'):env.pop(key,None)
    for key in ('TMPDIR','TMP','TEMP'):env[key]=tempfile.gettempdir()
    server=subprocess.Popen(['node','tests/peer-browser-server.cjs'],cwd=ROOT,env=env,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
    temporary=None
    try:
      info=json.loads(server.stdout.readline());temporary=Path(info['root']).resolve()
      assert temporary.parent==Path(tempfile.gettempdir()).resolve()
      assert temporary.name.startswith('memotalk-two-device-')
      origin='http://127.0.0.1:'+str(info['port'])
      with sync_playwright() as p:
        browser=p.chromium.launch(headless=True,args=['--disable-dev-shm-usage'])
        for device,width,height in [('desktop',1120,800),('mobile',412,860)]:
          context=browser.new_context(viewport={'width':width,'height':height})
          seed='''(()=>{
            if(!localStorage.getItem('manual-merge-fixture')){
              localStorage.setItem('memotalk.v1',JSON.stringify(DATA));
              localStorage.setItem('manual-merge-fixture','1');
            }
            localStorage.setItem('memotalk.fileMirror.auto','false');
          })();'''.replace('DATA',json.dumps(DATA,ensure_ascii=False))
          context.add_init_script(script=seed)
          page=context.new_page();errors=[]
          page.on('pageerror',lambda e: errors.append(str(e)))
          page.set_default_timeout(30000)
          page.goto(origin+'/windows/')
          page.locator('.room[data-id="main-room"]').wait_for()
          original=page.evaluate("JSON.parse(localStorage.getItem('memotalk.v1'))")
          page.locator('.room[data-id="main-room"]').click()
          page.locator('#room-name').get_by_text(TARGET_NAME,exact=True).wait_for()
          page.locator('#input').fill('전송 전 초안 유지')
          page.locator('#btn-rmenu').click()
          page.get_by_role('button',name='다른 메모방 내용 합치기 · 원본 보존').click()
          page.locator('#manual-merge-source').select_option('recovery-room')
          page.locator('#manual-merge-check').click()
          page.locator('#manual-merge-preview').get_by_text('새로 가져올 메모 1개',exact=False).wait_for()
          page.locator('#manual-merge-commit').click()
          page.get_by_role('button',name='원본 보존하고 통합').click()
          page.wait_for_function("""() => {
            const data=JSON.parse(localStorage.getItem('memotalk.v1'));
            return data.msgs['main-room']?.some(m=>m.manualMergeSource?.roomId==='recovery-room');
          }""")
          data=page.evaluate("JSON.parse(localStorage.getItem('memotalk.v1'))")
          assert data['rooms']['recovery-room']==original['rooms']['recovery-room']
          assert data['msgs']['recovery-room']==original['msgs']['recovery-room']
          assert len(data['msgs']['main-room'])==2
          added=next(m for m in data['msgs']['main-room'] if m.get('manualMergeSource'))
          assert added['ts']==300 and added['comments'][0]['text']=='복구된 댓글'
          assert added['images'][0]['data']==SAMPLE_PNG
          assert page.locator('#input').input_value()=='전송 전 초안 유지'
          page.locator('#btn-rmenu').click()
          page.get_by_role('button',name='다른 메모방 내용 합치기 · 원본 보존').click()
          page.locator('#manual-merge-source').select_option('recovery-room')
          page.locator('#manual-merge-check').click()
          page.locator('#manual-merge-preview').get_by_text('새로 가져올 메모 0개',exact=False).wait_for()
          assert page.locator('#manual-merge-commit').is_disabled()
          page.locator('#manual-merge-cancel').click()
          page.locator('#btn-msg-sort').click()
          page.get_by_role('button',name='작성일 · 최신 순').click()
          rows=page.locator('#msgs .row[data-id]')
          assert rows.count()==2
          assert rows.nth(0).get_attribute('data-id')==added['id']
          page.locator('#btn-room-sort').click()
          page.get_by_role('button',name='방 생성일 · 오래된 순').click()
          ordered=page.locator('.room[data-id]')
          assert [ordered.nth(i).get_attribute('data-id') for i in range(ordered.count())]==['main-room','recovery-room']
          after=page.evaluate("JSON.parse(localStorage.getItem('memotalk.v1'))")
          assert after==data,'sorting must not modify persistent memo data'
          page.reload()
          page.locator('.room[data-id="main-room"]').wait_for()
          page.locator('.room[data-id="main-room"]').click()
          assert page.locator('#msgs .row[data-id]').first.get_attribute('data-id')==added['id']
          assert not errors,errors
          context.close()
        browser.close()
      print('ROOM FEATURES BROWSER PASS: real UI preview, backup, merge, repeat protection, photos, comments, draft and date sorting in desktop/mobile virtual viewports.')
    finally:
      server.terminate()
      try:server.wait(timeout=10)
      except subprocess.TimeoutExpired:server.kill();server.wait(timeout=10)
      if temporary:
        assert temporary.parent==Path(tempfile.gettempdir()).resolve()
        assert temporary.name.startswith('memotalk-two-device-')
        shutil.rmtree(temporary)

if __name__=='__main__':main()
