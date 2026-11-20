"""Readability/location regression in isolated Windows and Android app profiles."""
from pathlib import Path
import json,os,shutil,subprocess,tempfile
from playwright.sync_api import sync_playwright

ROOT=Path(__file__).resolve().parents[1]
# Test observation deadline, not an application interaction parameter.
WAIT_MS=30000
# Subpixel font rounding tolerance in screenshot layout assertions.
LAYOUT_EPSILON_PX=1
TITLE='프로젝트 회의 기록과 다음 작업 내용을 함께 정리하는 채팅방'
DATA={'seeded':True,'rooms':{
    'parent':{'id':'parent','kind':'folder','name':'업무'},
    'child':{'id':'child','kind':'folder','name':'공동 프로젝트','parentId':'parent'},
    'room-long':{'id':'room-long','name':TITLE,'folderId':'child','createdAt':1,'tags':['회의기록','해야할일','공동작업']},
    'root-room':{'id':'root-room','name':'최상위에서도 제목이 끝까지 보이는 긴 메모방','createdAt':2},
    'token-room':{'id':'token-room','name':'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_without_spaces','createdAt':3}},
    'msgs':{'room-long':[{'id':'m','ts':1,'text':'위치와 제목 표시용 시험 메모'}]}}

def main():
    env=os.environ.copy()
    for key in ('MEMOTALK_TEST_ROOT','MEMOTALK_TEST_PORT'):env.pop(key,None)
    for key in ('TMPDIR','TEMP','TMP'):env[key]=tempfile.gettempdir()
    server=subprocess.Popen(['node','tests/peer-browser-server.cjs'],cwd=ROOT,env=env,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
    temporary=None
    try:
        info=json.loads(server.stdout.readline());temporary=Path(info['root']).resolve()
        assert temporary.parent==Path(tempfile.gettempdir()).resolve() and temporary.name.startswith('memotalk-two-device-')
        origin='http://127.0.0.1:'+str(info['port'])
        artifact=Path(os.environ.get('MEMOTALK_UI_ARTIFACTS',ROOT/'output/playwright/location-title'))
        artifact.mkdir(parents=True,exist_ok=True)
        with sync_playwright() as p:
            browser=p.chromium.launch(headless=True)
            errors=[]
            for device,width,height in [('windows',1120,800),('android',412,860)]:
                context=browser.new_context(viewport={'width':width,'height':height},color_scheme='light')
                script='''(()=>{
                    if(!localStorage.getItem('location-seeded')){
                        localStorage.setItem('memotalk.v1',JSON.stringify(DATA));
                        localStorage.setItem('memotalk.folderFolded',JSON.stringify({parent:true,child:true}));
                        localStorage.setItem('location-seeded','true');
                    }
                    localStorage.setItem('memotalk.fileMirror.auto','false');
                    localStorage.setItem('memotalk.nativeFolder.linkId','location-only');
                    const device=DEVICE;
                    const rpc=async(command,args={})=>(await fetch('/native',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({device,command,args})})).json();
                    const ready=rpc('reloadContext').then(()=>rpc('pickFolder'));
                    const request=async(command,args={})=>{await ready;return rpc(command,args);};
                    if(device==='windows')window.MemoTalkNative={request};
                    else window.AndroidMemoTalk={postMessage(payload){const {id,command,args,session}=JSON.parse(payload);request(command,args).then(r=>window.__memoNativeResolve({id,session,result:r.result,error:r.error}));}};
                })();'''.replace('DATA',json.dumps(DATA,ensure_ascii=False)).replace('DEVICE',json.dumps(device))
                context.add_init_script(script=script)
                page=context.new_page();page.on('pageerror',lambda error:errors.append(str(error)));page.set_default_timeout(WAIT_MS)
                page.goto(origin+'/'+device+'/#room=room-long')
                if device=='android':
                    page.locator('[data-folder=parent]').click();page.locator('[data-folder=child]').click()
                    page.locator('.room[data-id=room-long]').click()
                page.locator('#room-name').wait_for()
                assert page.locator('#room-name').inner_text()==TITLE
                assert page.locator('#room-location').inner_text()=='전체 / 업무 / 공동 프로젝트'
                original=page.evaluate("localStorage.getItem('memotalk.v1')")
                page.locator('#input').fill('위치를 찾아도 남아 있어야 하는 작성 중 메모')
                page.locator('#btn-room-location').click()
                assert page.locator('[data-app-location]').inner_text()=='전체 / 업무 / 공동 프로젝트 / '+TITLE
                disk=page.locator('[data-disk-location]').inner_text()
                if device=='windows':
                    assert Path(disk)==temporary/'windows'
                    page.get_by_role('button',name='탐색기에서 열기',exact=True).click()
                else:
                    assert disk=='Documents/Obsidian/Test'
                    assert page.locator('[data-document-location]').inner_text()=='primary:Documents/Obsidian/Test'
                    assert page.get_by_role('button',name='탐색기에서 열기',exact=True).count()==0
                page.get_by_role('button',name='목록에서 찾기',exact=True).click()
                page.locator('.room[data-id=room-long]').wait_for(state='visible')
                assert page.locator('#input').input_value()=='위치를 찾아도 남아 있어야 하는 작성 중 메모'
                assert page.evaluate("JSON.parse(localStorage.getItem('memotalk.folderFolded')).parent") is False
                assert page.evaluate("JSON.parse(localStorage.getItem('memotalk.folderFolded')).child") is False
                assert page.locator('.room[data-id=room-long]').evaluate("el=>el.classList.contains('location-target')")
                def whole_titles():
                    return page.locator('.room .rname').evaluate_all('''(els,epsilon)=>els.every(el=>{
                        const style=getComputedStyle(el),box=el.getBoundingClientRect();
                        const parent=el.closest('.room').getBoundingClientRect(),tile=el.closest('.room-entry').getBoundingClientRect();
                        return box.width>0&&style.whiteSpace==='normal'&&el.scrollHeight<=el.clientHeight+epsilon&&el.scrollWidth<=el.clientWidth+epsilon&&box.bottom<=parent.bottom+epsilon&&box.bottom<=tile.bottom+epsilon;
                    })''',LAYOUT_EPSILON_PX)
                assert whole_titles(),'list titles are clipped'
                page.screenshot(path=str(artifact/(device+'-list.png')))
                page.locator('#btn-layout').click();assert whole_titles(),'grid titles are clipped'
                assert page.locator('.room[data-id=room-long] .rname').get_attribute('title')==TITLE
                page.screenshot(path=str(artifact/(device+'-grid.png')))
                page.locator('#btn-drag-settings').click()
                page.locator('#number-titleFont').fill('22.5')
                assert page.locator('#value-titleFont').inner_text()=='22.5 px'
                assert page.locator('.room[data-id=room-long] .rname').evaluate("el=>getComputedStyle(el).fontSize")=='22.5px'
                page.locator('#number-titleLeading').fill('1.6')
                assert page.locator('#value-titleLeading').inner_text()=='1.6 배'
                assert page.locator('.room[data-id=room-long] .rname').evaluate("el=>getComputedStyle(el).lineHeight")=='36px'
                page.locator('#room-title-mode').select_option('two')
                assert page.locator('#value-title-mode').inner_text()=='2줄'
                assert page.locator('.room[data-id=room-long] .rname').evaluate("el=>getComputedStyle(el).webkitLineClamp")=='2'
                page.locator('#close-controls').click();page.reload()
                if device=='android':page.locator('.room[data-id=room-long]').click()
                page.locator('#room-name').wait_for()
                if page.locator('#btn-back').is_visible():page.locator('#btn-back').click()
                elif page.evaluate("document.querySelector('#app').classList.contains('list-collapsed')"):page.locator('#btn-toggle-list').click()
                page.locator('#btn-drag-settings').click()
                assert page.locator('#number-titleFont').input_value()=='22.5'
                assert page.locator('#number-titleLeading').input_value()=='1.6'
                assert page.locator('#room-title-mode').input_value()=='two'
                page.locator('[data-reset=titleFont]').click();page.locator('[data-reset=titleLeading]').click();page.locator('#reset-title-mode').click()
                assert page.locator('#number-titleFont').input_value()=='17'
                assert page.locator('#room-title-mode').input_value()=='full'
                page.locator('#close-controls').click()
                if page.locator('#btn-back').is_visible():page.locator('#btn-back').click()
                elif page.evaluate("document.querySelector('#app').classList.contains('list-collapsed')"):page.locator('#btn-toggle-list').click()
                assert whole_titles()
                page.emulate_media(color_scheme='dark');page.screenshot(path=str(artifact/(device+'-dark.png')))
                assert page.evaluate("localStorage.getItem('memotalk.v1')")==original,'display/location actions modified notes'
                context.close()
            assert not errors,errors
            browser.close()
        print('LOCATION/TITLE PASS: complete list/grid titles, exact native/document paths, safe reveal, ancestor expansion, drafts, live settings/reset/persistence, both screen sizes and unchanged notes.')
    finally:
        server.terminate()
        try:server.wait(timeout=10)
        except subprocess.TimeoutExpired:server.kill();server.wait(timeout=10)
        if temporary:
            assert temporary.parent==Path(tempfile.gettempdir()).resolve() and temporary.name.startswith('memotalk-two-device-')
            shutil.rmtree(temporary)
if __name__=='__main__':main()
