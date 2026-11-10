import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const shared = fs.readFileSync('shared/index.html','utf8');
const android = fs.readFileSync('android/app/src/main/assets/index.html','utf8');
const desktop = fs.readFileSync('windows/main.js','utf8');
assert.equal(shared,android,'Android and desktop must use the same user interface source');

const start=shared.lastIndexOf('<script>');
const end=shared.lastIndexOf('</script>');
assert.ok(start>=0 && end>start,'Inline UI script is present');
new vm.Script(shared.slice(start+8,end),{filename:'shared/index.html (inline)'});
new vm.Script(desktop,{filename:'windows/main.js'});

for(const expected of ['id="btn-toggle-list"','id="btn-popout"','id="btn-trash-shortcut"','data-copy-unit','data-copy-selected','window.MemoTalkNative.request(\'openRoomWindow\''])
  assert.ok(shared.includes(expected),expected+' must be present');

assert.match(desktop,/memoWindows=new Set/);
assert.match(desktop,/memoWindows\.has\(owner\)/);
assert.match(desktop,/resizable:true/);
assert.match(shared,/function showVaultTrash\(/);

const splitAt=shared.indexOf('function memoSentenceUnits(text){');
const splitEnd=shared.indexOf('\nfunction selectMemoSentences(',splitAt);
assert.ok(splitAt>=0 && splitEnd>splitAt,'Sentence splitting function is present');
const sentences=vm.runInNewContext(shared.slice(splitAt,splitEnd)+'\nmemoSentenceUnits');
assert.deepEqual(Array.from(sentences('첫 문장. 둘째 문장!\n셋째 문장?')),['첫 문장.','둘째 문장!','셋째 문장?']);
assert.deepEqual(Array.from(sentences('안녕하세요')),['안녕하세요']);
console.log('MemoTalk UI, multi-window, trash and sentence-copy source checks passed.');
