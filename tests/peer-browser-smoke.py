"""Synthetic two-profile app integration; no actual notes or vaults are accessed."""
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
WAIT_MS = 30000


def main():
    env = os.environ.copy()
    env.pop('MEMOTALK_TEST_ROOT', None)
    env.pop('MEMOTALK_TEST_PORT', None)
    # Python may choose a writable fallback different from Node's TEMP on Windows.
    # Give the child server the exact verified parent used for cleanup below.
    for key in ('TMPDIR', 'TEMP', 'TMP'):
        env[key] = tempfile.gettempdir()
    server = subprocess.Popen(['node', 'tests/peer-browser-server.cjs'], cwd=ROOT,
                              stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, env=env)
    temporary = None
    try:
        line = server.stdout.readline()
        if not line:
            raise RuntimeError(server.stderr.read())
        info = json.loads(line)
        temporary = Path(info['root']).resolve()
        assert temporary.name.startswith('memotalk-two-device-')
        assert temporary.parent == Path(tempfile.gettempdir()).resolve()
        origin = 'http://127.0.0.1:' + str(info['port'])
        with sync_playwright() as p:
            browser = p.chromium.launch(headless=True, args=['--disable-dev-shm-usage'])
            desktop_context = browser.new_context(viewport={'width': 1120, 'height': 800})
            mobile_context = browser.new_context(viewport={'width': 412, 'height': 860})
            for context in (desktop_context, mobile_context):
                context.route('https://api.github.com/repos/hoistes00-ctrl/memotalk/releases?*', lambda route:route.fulfill(status=200,content_type='application/json',body='[]'))
                context.add_init_script(path=ROOT / 'tests/peer-browser-init.js')
            desktop, phone = desktop_context.new_page(), mobile_context.new_page()
            errors = []
            for page in (desktop, phone):
                page.on('pageerror', lambda e: errors.append(str(e)))
                page.set_default_timeout(WAIT_MS)
            desktop.goto(origin + '/windows/')
            phone.goto(origin + '/android/')

            def sharing(page):
                page.get_by_role('button', name='파일 저장', exact=True).click()

            # Regression: restored legacy Android folder + Android-first join of an empty group.
            # An existing journal must never be replaced, even after backup-import style edits/reload.
            journal = temporary / 'android' / '.memotalk-file-journal.json'
            original_journal = b'{"preserve":"previous incomplete export"}'
            journal.write_bytes(original_journal)
            phone.evaluate("""async()=>{
                await window.showDirectoryPicker();
                await MemoTalkFS.put({linkId:'legacy-regression'});
                localStorage.setItem('memotalk.fileMirror.auto','true');
                localStorage.setItem('memotalk.fileMirror.pending','1');
            }""")
            phone.reload()
            phone.locator('.room[data-id=room1]').wait_for()
            phone.wait_for_function("document.querySelector('#file-sync-state').textContent.includes('연결 복원됨')")
            sharing(phone)
            phone.get_by_role('button', name='Windows ↔ Android 양방향 공유', exact=True).click()
            phone.get_by_role('button', name='다른 기기의 공유 그룹 참여', exact=True).click()
            phone.get_by_role('button', name='폴더 선택', exact=True).click()
            phone.wait_for_function("document.querySelector('#file-sync-state').textContent.includes('이 기기에서 새 공유 그룹')")
            assert phone.evaluate("localStorage.getItem('memotalk.fileMirror.auto')") == 'false'
            assert phone.evaluate("JSON.parse(localStorage.getItem('memotalk.fileMirror.lastError')).relativePath") == 'memotalk-peer-group.json'
            # Error notifications also expire; settings apply live and survive restart.
            phone.locator('.toast').wait_for(state='detached', timeout=5000)
            phone.locator('#btn-drag-settings').click()
            assert phone.locator('#number-toast').input_value() == '2500'
            phone.locator('#number-toast').fill('500')
            phone.locator('#number-toastFade').fill('0')
            assert phone.locator('#value-toast').inner_text() == '500 ms'
            phone.locator('#close-controls').click()
            phone.reload()
            phone.locator('.room[data-id=room1]').wait_for()
            phone.locator('#btn-drag-settings').click()
            assert phone.locator('#number-toast').input_value() == '500'
            assert phone.locator('#number-toastFade').input_value() == '0'
            phone.locator('[data-reset="toast"]').click()
            phone.locator('[data-reset="toastFade"]').click()
            assert phone.locator('#number-toast').input_value() == '2500'
            assert phone.locator('#number-toastFade').input_value() == '250'
            phone.locator('#close-controls').click()
            backup = {'app': 'memotalk', 'version': 2, 'rooms': [
                {'name': '백업 복원 회귀 시험', 'msgs': [{'ts': 1, 'text': '백업 원문 보존'}]}]}
            phone.locator('#file-backup').set_input_files({
                'name': 'synthetic-backup.json', 'mimeType': 'application/json',
                'buffer': json.dumps(backup, ensure_ascii=False).encode('utf-8')})
            phone.get_by_role('button', name='불러오기', exact=True).click()
            phone.wait_for_function("Object.values(JSON.parse(localStorage.getItem('memotalk.v1')).msgs).flat().some(m=>m.text==='백업 원문 보존')")
            phone.reload()
            phone.locator('.room[data-id=room1]').wait_for()
            assert journal.read_bytes() == original_journal
            assert not (temporary / 'android' / '.memotalk-file-index.json').exists()
            assert phone.evaluate("JSON.parse(localStorage.getItem('memotalk.v1')).msgs.room1[0].text") == '휴대폰 원문'
            assert phone.evaluate("Object.values(JSON.parse(localStorage.getItem('memotalk.v1')).msgs).flat().some(m=>m.text==='백업 원문 보존')")

            first, second = (phone, desktop) if os.environ.get('MEMOTALK_FIRST_DEVICE') == 'android' else (desktop, phone)
            sharing(first)
            first.get_by_role('button', name='Windows ↔ Android 양방향 공유', exact=True).click()
            first.get_by_role('button', name='이 기기에서 새 공유 그룹 만들기', exact=True).click()
            first.get_by_role('button', name='폴더 선택', exact=True).click()
            first.wait_for_function("document.querySelector('#file-sync-state').title.includes('양방향 주기 처리')")
            sharing(second)
            second.get_by_role('button', name='Windows ↔ Android 양방향 공유', exact=True).click()
            second.get_by_role('button', name='다른 기기의 공유 그룹 참여', exact=True).click()
            second.get_by_role('button', name='폴더 선택', exact=True).click()
            for page, text in ((desktop, '휴대폰 원문'), (phone, '윈도우 원문')):
                page.wait_for_function("expected => JSON.parse(localStorage.getItem('memotalk.v1')).msgs.room1.some(m=>m.text===expected)", arg=text)
                if page is phone:
                    assert page.locator('#file-sync-state').evaluate('(el)=>el.scrollWidth<=el.clientWidth && el.scrollHeight<=el.clientHeight'), 'Mobile status must not clip its text'
                    sharing(page)
                    page.get_by_role('button', name='공유 오류 진단', exact=True).click()
                    current = json.loads(page.locator('[data-peer-current]').inner_text())
                    previous = json.loads(page.locator('[data-peer-history]').inner_text())
                    assert current['active'] and current['groupId']
                    assert current['currentError'] is None
                    assert current['lastCompletedLocalCycleAt']
                    assert current['capturedAt'] and current['appTitle'].startswith('모두톡 ')
                    assert 'outgoingPending' in current
                    page.locator('[data-peer-refresh]').click()
                    refreshed = json.loads(page.locator('[data-peer-current]').inner_text())
                    assert refreshed['capturedAt'] >= current['capturedAt']
                    assert current['localData']['memos'] >= 2
                    assert previous['code'] == 'peer_group_not_downloaded'
                    page.keyboard.press('Escape')
                    sharing(page)
                    page.get_by_role('button', name='공유 확인·반영 간격 조절', exact=True).click()
                    batch = page.locator('[data-peer="publishBatch"]')
                    assert batch.get_attribute('min') == '1' and batch.get_attribute('max') == '100000'
                    assert batch.input_value() == '4'
                    batch.fill('7')
                    assert page.locator('[data-value="publishBatch"]').inner_text() == '7 개'
                    assert page.evaluate("localStorage.getItem('memotalk.peer.publishBatch')") == '7'
                    page.keyboard.press('Escape')
                    page.reload()
                    page.locator('#btn-file-folder').wait_for()
                    sharing(page)
                    page.get_by_role('button', name='공유 확인·반영 간격 조절', exact=True).click()
                    assert page.locator('[data-peer="publishBatch"]').input_value() == '7'
                    page.locator('[data-reset="publishBatch"]').click()
                    assert page.locator('[data-peer="publishBatch"]').input_value() == '4'
                    assert page.evaluate("localStorage.getItem('memotalk.peer.publishBatch')") is None
                    page.keyboard.press('Escape')
                page.get_by_text('공유 테스트', exact=True).click()

            def edit(page, old, new):
                page.locator('#msgs').get_by_text(old, exact=True).click(button='right')
                page.get_by_role('button', name='수정', exact=True).click()
                page.locator('#input').fill(new)
                page.locator('#btn-send').click()

            edit(desktop, '윈도우 원문', 'Windows edit')
            phone.locator('#msgs').get_by_text('Windows edit', exact=True).wait_for()
            edit(phone, 'Windows edit', 'Android edit')
            desktop.locator('#msgs').get_by_text('Android edit', exact=True).wait_for()
            desktop.request.post(origin + '/control', data={'device': 'android', 'online': False})
            for page, text in ((desktop, 'Windows offline'), (phone, 'Android offline')):
                edit(page, 'Android edit', text)
                page.wait_for_function("""async expected=>{
                    const group=JSON.parse(localStorage.getItem('memotalk.peer.config')).groupId;
                    const state=await MemoTalkPeerClient.stateStore(group);
                    return state.outbox.length===0&&Object.values(state.operations).some(op=>op.value?.text===expected);
                }""", arg=text)
            desktop.request.post(origin + '/control', data={'device': 'android', 'online': True})
            both_copies = """() => {
                const copies=Object.values(JSON.parse(localStorage.getItem('memotalk.v1')).msgs).flat().filter(m=>m.peerConflict);
                return copies.some(m=>m.text==='Windows offline')&&copies.some(m=>m.text==='Android offline');
            }"""
            for page in (desktop, phone):
                page.wait_for_function(both_copies)
                page.reload()
                page.get_by_text('공유 테스트', exact=True).click()
                page.wait_for_function(both_copies)

            image = desktop.evaluate("""() => {
                const canvas=document.createElement('canvas');canvas.width=2;canvas.height=2;
                canvas.getContext('2d').fillRect(0,0,2,2);return canvas.toDataURL('image/png');
            }""")
            import base64
            desktop.locator('#file-img').set_input_files({'name': 'synthetic.png', 'mimeType': 'image/png',
                                                        'buffer': base64.b64decode(image.split(',')[1])})
            desktop.locator('#pending img').wait_for()
            desktop.locator('#input').fill('Photo roundtrip')
            desktop.locator('#btn-send').click()
            phone.wait_for_function("JSON.parse(localStorage.getItem('memotalk.v1')).msgs.room1.some(m=>m.text==='Photo roundtrip'&&m.images?.[0]?.data?.startsWith('data:image/'))")

            sharing(desktop)
            desktop.get_by_role('button', name='공유 충돌·변경 이력 보기', exact=True).click()
            version = desktop.locator('details').filter(has_text='Windows offline')
            version.locator('summary').click()
            version.get_by_role('button', name='이 버전으로 복원', exact=True).click()
            desktop.get_by_role('button', name='복원', exact=True).click()
            for page in (desktop, phone):
                page.wait_for_function("JSON.parse(localStorage.getItem('memotalk.v1')).msgs.room1.find(m=>m.id==='winmemo').text==='Windows offline'")
                assert page.evaluate("Object.values(JSON.parse(localStorage.getItem('memotalk.v1')).msgs).flat().some(m=>m.peerConflict&&m.text==='Android offline')")

            sharing(desktop)
            desktop.get_by_role('button', name='공유 확인·반영 간격 조절', exact=True).click()
            interval = desktop.locator('[data-peer=poll]')
            interval.fill('450')
            assert desktop.locator('[data-value=poll]').inner_text() == '450 ms'
            desktop.keyboard.press('Escape')
            desktop.reload()
            desktop.locator('.room[data-id=room1]').wait_for()
            sharing(desktop)
            desktop.get_by_role('button', name='공유 확인·반영 간격 조절', exact=True).click()
            assert desktop.locator('[data-peer=poll]').input_value() == '450'
            desktop.locator('[data-reset=poll]').click()
            assert desktop.locator('[data-peer=poll]').input_value() == '3000'
            desktop.keyboard.press('Escape')

            # Actual backup imports generate different room/memo/comment IDs.
            # Their shared birth times identify copies, while different edits survive.
            merge_name = '같은 방 병합 시험'
            common = {'id': 'original-common', 'ts': 6100, 'text': '겹치는 원문',
                      'images': [{'data': image}],
                      'comments': [{'id': 'original-comment', 'ts': 6110, 'text': '공통 댓글'}]}
            def import_copy(page, memos):
                backup = {'app': 'memotalk', 'version': 3, 'rooms': [
                    {'id': 'original-room', 'name': merge_name, 'createdAt': 6000, 'msgs': memos}]}
                page.locator('#file-backup').set_input_files({
                    'name': 'copied-room.json', 'mimeType': 'application/json',
                    'buffer': json.dumps(backup, ensure_ascii=False).encode('utf-8')})
                page.get_by_role('button', name='불러오기', exact=True).click()

            import_copy(desktop, [common, {'id': 'w-add', 'ts': 6200, 'text': 'PC에만 추가'},
                                  {'id': 'edited', 'ts': 6400, 'text': 'PC에서 고친 내용'}])
            for page in (desktop, phone):
                page.wait_for_function('name=>Object.values(JSON.parse(localStorage.getItem("memotalk.v1")).rooms).some(r=>r.name===name)', arg=merge_name)
                if page.locator('#btn-back').is_visible():
                    page.locator('#btn-back').click()
                page.locator('.room').filter(has_text=merge_name).click()
                page.locator('#input').fill('합쳐도 남겨둘 작성 중 내용')
            desktop.locator('#file-img').set_input_files({'name': 'pending.png', 'mimeType': 'image/png',
                                                        'buffer': base64.b64decode(image.split(',')[1])})
            desktop.locator('#pending img').wait_for()
            phone_common = json.loads(json.dumps(common))
            phone_common['comments'].append({'id': 'phone-comment', 'ts': 6120, 'text': '폰 추가 댓글'})
            import_copy(phone, [phone_common, {'id': 'p-add', 'ts': 6300, 'text': '폰에만 추가'},
                               {'id': 'edited', 'ts': 6400, 'text': '폰에서 고친 내용'}])
            merged_check = '''name=>{
                const d=JSON.parse(localStorage.getItem('memotalk.v1'));
                const rs=Object.values(d.rooms).filter(r=>r.name===name);
                if(rs.length!==1||!rs[0].peerMergedRooms?.length)return false;
                const ms=d.msgs[rs[0].id]||[],common=ms.find(m=>m.text==='겹치는 원문');
                return ms.length===5&&common?.comments?.length===2&&common.images?.[0]?.data?.startsWith('data:image/')&&
                    ['PC에만 추가','폰에만 추가','PC에서 고친 내용','폰에서 고친 내용'].every(text=>ms.some(m=>m.text===text));
            }'''
            for page in (desktop, phone):
                page.wait_for_function(merged_check, arg=merge_name)
                assert page.locator('#input').input_value() == '합쳐도 남겨둘 작성 중 내용'
                page.locator('#msgs').get_by_text('PC에만 추가', exact=True).wait_for()
                page.locator('#msgs').get_by_text('폰에만 추가', exact=True).wait_for()
            desktop.locator('#pending img').wait_for()
            # Reimport exactly the same copy: room and memo counts must stay stable.
            import_copy(phone, [phone_common, {'id': 'p-add', 'ts': 6300, 'text': '폰에만 추가'},
                               {'id': 'edited', 'ts': 6400, 'text': '폰에서 고친 내용'}])
            for page in (desktop, phone):
                page.wait_for_function(merged_check, arg=merge_name)
                assert page.evaluate('''async()=>{
                    const db=await new Promise((resolve,reject)=>{const r=indexedDB.open('memotalk-safety-v17');r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});
                    try{return await new Promise((resolve,reject)=>{const r=db.transaction('snapshots').objectStore('snapshots').getAll();r.onsuccess=()=>resolve(r.result.some(s=>s.reason==='공유방 합치기 전 안전 백업'));r.onerror=()=>reject(r.error);});}finally{db.close();}
                }''')
            assert not errors, errors
            readable = list(temporary.glob('windows/memotalk-peer-v1/readable/**/*.md'))
            assert readable, 'Readable Markdown revisions must exist'
            print('BROWSER PASS: app union, bidirectional edits, offline conflict copies, restart, photos, resolution, settings, copied-room union, preserved drafts/photos, repeated backup imports, safety backups and immutable Markdown.')
            browser.close()
    finally:
        server.terminate()
        try:
            server.wait(timeout=10)
        except subprocess.TimeoutExpired:
            server.kill()
            server.wait(timeout=10)
        if temporary:
            assert temporary.parent == Path(tempfile.gettempdir()).resolve()
            assert temporary.name.startswith('memotalk-two-device-')
            shutil.rmtree(temporary)


if __name__ == '__main__':
    main()
