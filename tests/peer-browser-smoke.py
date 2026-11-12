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
            phone.wait_for_function('S.roomsLoaded && !!fileMirror.handle')
            sharing(phone)
            phone.get_by_role('button', name='Windows ↔ Android 양방향 공유', exact=True).click()
            phone.get_by_role('button', name='다른 기기의 공유 그룹 참여', exact=True).click()
            phone.get_by_role('button', name='폴더 선택', exact=True).click()
            phone.wait_for_function("document.querySelector('#file-sync-state').textContent.includes('Windows에서 먼저')")
            assert phone.evaluate("localStorage.getItem('memotalk.fileMirror.auto')") == 'false'
            assert phone.evaluate("JSON.parse(localStorage.getItem('memotalk.fileMirror.lastError')).relativePath") == 'memotalk-peer-group.json'
            phone.evaluate("async()=>{await backend.updateMsg('room1','phonememo',{text:'휴대폰 원문'});await runFileMirror(true);}")
            phone.reload()
            phone.wait_for_function('S.roomsLoaded')
            assert journal.read_bytes() == original_journal
            assert not (temporary / 'android' / '.memotalk-file-index.json').exists()
            assert phone.evaluate("JSON.parse(localStorage.getItem('memotalk.v1')).msgs.room1[0].text") == '휴대폰 원문'

            sharing(desktop)
            desktop.get_by_role('button', name='Windows ↔ Android 양방향 공유', exact=True).click()
            desktop.get_by_role('button', name='Windows에서 새 공유 그룹 만들기', exact=True).click()
            desktop.get_by_role('button', name='폴더 선택', exact=True).click()
            desktop.wait_for_function("document.querySelector('#file-sync-state').textContent.includes('양방향 주기 처리')")
            sharing(phone)
            phone.get_by_role('button', name='Windows ↔ Android 양방향 공유', exact=True).click()
            phone.get_by_role('button', name='다른 기기의 공유 그룹 참여', exact=True).click()
            phone.get_by_role('button', name='폴더 선택', exact=True).click()
            for page, text in ((desktop, '휴대폰 원문'), (phone, '윈도우 원문')):
                page.wait_for_function("expected => JSON.parse(localStorage.getItem('memotalk.v1')).msgs.room1.some(m=>m.text===expected)", arg=text)
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
            assert not errors, errors
            readable = list(temporary.glob('windows/memotalk-peer-v1/readable/**/*.md'))
            assert readable, 'Readable Markdown revisions must exist'
            print('BROWSER PASS: app union, bidirectional edits, offline conflict copies, restart, photos, resolution, settings and immutable Markdown.')
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
