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

def backup_and_folder_checks(page,device):
    if page.locator('#btn-back').is_visible():page.locator('#btn-back').click()
    # Narrow screens keep every action visible in one compact, unclipped row.
    original_size=page.viewport_size
    for width in [320,360,430]:
        page.set_viewport_size({'width':width,'height':880})
        if page.locator('#btn-back').is_visible():page.locator('#btn-back').click()
        toolbar=page.locator('.list-tools').bounding_box()
        assert toolbar['height']<=70
        for selector in ['#btn-new','#btn-new-folder','#btn-select-items','#btn-drag-settings','#move-root']:
            button=page.locator(selector).bounding_box()
            assert button and button['height']>=44 and button['x']>=0 and button['x']+button['width']<=width
        assert page.locator('#list').bounding_box()['y']<230
    page.set_viewport_size(original_size)
    page.locator('#btn-select-items').click()
    assert page.locator('#room-select-bar').is_visible()
    page.locator('#room-select-cancel').click()
    page.locator('#btn-drag-settings').click()
    assert page.locator('#close-controls').is_visible()
    page.locator('#close-controls').click()
    page.locator('#btn-new-folder').click();page.locator('#prompt-field').fill('검증 새 폴더')
    page.locator('#prompt-field').press('Enter')
    page.wait_for_function("Object.values(JSON.parse(localStorage.getItem('memotalk.v1')).rooms).some(r=>r.kind==='folder'&&r.name==='검증 새 폴더')")
    before=page.evaluate("JSON.parse(localStorage.getItem('memotalk.v1'))")
    folder=next(r for r in before['rooms'].values() if r.get('kind')=='folder' and r['name']=='검증 새 폴더')
    edit=page.locator('[data-folder-rename="'+folder['id']+'"]')
    if device=='mobile':edit.tap()
    else:edit.click()
    assert page.locator('#prompt-field').input_value()=='검증 새 폴더'
    page.locator('#prompt-field').fill('검증 이름 변경 완료');page.get_by_role('button',name='이름 저장',exact=True).click()
    page.wait_for_function("Object.values(JSON.parse(localStorage.getItem('memotalk.v1')).rooms).some(r=>r.name==='검증 이름 변경 완료')")
    renamed=page.evaluate("JSON.parse(localStorage.getItem('memotalk.v1'))")
    expected=json.loads(json.dumps(before));expected['rooms'][folder['id']]['name']='검증 이름 변경 완료'
    assert renamed==expected,'renaming changes only the selected folder name'
    historical={'seeded':True,'rooms':{'old-folder':{'id':'old-folder','kind':'folder','name':'백업 분류'},'main-room':{**DATA['rooms']['main-room'],'folderId':'old-folder'}},'msgs':{'main-room':[{'id':'backup-common','ts':100,'text':'공통 메모'},{'id':'backup-only-memo','ts':50,'text':'백업에만 남은 메모','comments':[{'id':'bc','ts':51,'text':'백업 댓글'}],'images':[{'data':SAMPLE_PNG}]}]}}
    # Isolated browser fixture only: seed twenty backups, including the oldest one.
    records=page.evaluate("""async historical=>{
      const db=await new Promise((resolve,reject)=>{const r=indexedDB.open('memotalk-safety-v17',1);r.onupgradeneeded=()=>{for(const n of ['snapshots','trash'])if(!r.result.objectStoreNames.contains(n))r.result.createObjectStore(n,{keyPath:'id'});};r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});
      const raw=JSON.stringify(historical),rows=[{id:'backup-only',createdAt:1,reason:'검증 옛 백업',raw}];
      for(let i=1;i<19;i++)rows.push({id:'old-'+i,createdAt:i+1,reason:'검증 보관본',raw});
      rows.push({id:'auto-recent',createdAt:Date.now(),reason:'자동 백업',raw:localStorage.getItem('memotalk.v1')});
      await new Promise((resolve,reject)=>{const tx=db.transaction('snapshots','readwrite'),s=tx.objectStore('snapshots');s.clear();rows.forEach(r=>s.put(r));tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error);});db.close();return rows;
    }""",historical)
    page.locator('.room[data-id="main-room"]').click()
    if page.locator('#btn-back').is_visible():page.locator('#btn-back').click()
    page.locator('#btn-more').click();page.get_by_role('button',name='자동 백업 관리 · 복원',exact=True).click()
    page.locator('[data-b-merge="backup-only"]').click();page.locator('#backup-merge-target').select_option('main-room')
    page.locator('[data-open-backup-merge]').click()
    page.wait_for_function("document.querySelector('#manual-merge-preview')?.textContent.includes('새로 가져올 메모 1개')")
    assert page.locator('#manual-backup-room').input_value()=='main-room'
    assert '백업 분류 / 소설 아이디어' in page.locator('#manual-backup-room').inner_text()
    page.locator('#manual-merge-commit').click();page.get_by_role('button',name='원본 보존하고 통합',exact=True).click()
    page.wait_for_function("JSON.parse(localStorage.getItem('memotalk.v1')).msgs['main-room'].some(m=>m.text==='백업에만 남은 메모')")
    data=page.evaluate("JSON.parse(localStorage.getItem('memotalk.v1'))")
    copied=next(m for m in data['msgs']['main-room'] if m['text']=='백업에만 남은 메모')
    assert copied['ts']==50 and copied['comments'][0]['text']=='백업 댓글' and copied['images'][0]['data']==SAMPLE_PNG
    assert copied['manualMergeSource']['backupId']=='backup-only'
    assert data['msgs']['recovery-room']==DATA['msgs']['recovery-room']
    after=page.evaluate("""async()=>{const db=await new Promise(r=>{const q=indexedDB.open('memotalk-safety-v17',1);q.onsuccess=()=>r(q.result);});const rows=await new Promise(r=>{const q=db.transaction('snapshots').objectStore('snapshots').getAll();q.onsuccess=()=>r(q.result);});db.close();return rows;}""")
    assert len(after)>=21 and all(record in after for record in records),'a merge never prunes the selected or other original backups'
    page.locator('.room[data-id="main-room"]').click();page.locator('#btn-rmenu').click()
    page.get_by_role('button',name='메모방·백업에서 합치기 · 원본 보존').click();page.locator('#manual-merge-source').select_option('backup:backup-only')
    page.wait_for_function("document.querySelector('#manual-merge-preview')?.textContent.includes('새로 가져올 메모 0개')")
    assert page.locator('#manual-merge-commit').is_disabled();page.locator('#manual-merge-cancel').click()

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
          context=browser.new_context(viewport={'width':width,'height':height},is_mobile=device=='mobile',has_touch=device=='mobile')
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
          page.locator('#room-name').wait_for()
          assert page.locator('#room-name').inner_text()==TARGET_NAME
          page.locator('#input').fill('전송 전 초안 유지')
          page.locator('#btn-rmenu').click()
          page.get_by_role('button',name='메모방·백업에서 합치기 · 원본 보존').click()
          page.locator('#manual-merge-source').select_option('room:recovery-room')
          page.wait_for_function("document.querySelector('#manual-merge-preview').textContent.includes('새로 가져올 메모 1개')")
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
          page.get_by_role('button',name='메모방·백업에서 합치기 · 원본 보존').click()
          page.locator('#manual-merge-source').select_option('room:recovery-room')
          page.wait_for_function("document.querySelector('#manual-merge-preview').textContent.includes('새로 가져올 메모 0개')")
          assert page.locator('#manual-merge-commit').is_disabled()
          page.locator('#manual-merge-cancel').click()
          page.locator('#btn-msg-sort').click()
          page.get_by_role('button',name='작성일 · 최신 순').click()
          rows=page.locator('#msgs .row[data-id]')
          assert rows.count()==2
          assert rows.nth(0).get_attribute('data-id')==added['id']
          if page.locator('#btn-back').is_visible():page.locator('#btn-back').click()
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
          backup_and_folder_checks(page,device)
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
