'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const html=fs.readFileSync('shared/index.html','utf8');
const start=html.indexOf('function roomLocationInfo(room){'),end=html.indexOf('\nfunction revealCurrentRoomInList()',start);
function locate(folders,room){return vm.runInNewContext(html.slice(start,end)+'\nroomLocationInfo', {folderById:id=>folders.find(f=>f.id===id)})(room);}
test('room location follows every parent rather than confusing classification with disk paths',()=>{
  const result=locate([{id:'a',name:'업무'},{id:'b',name:'프로젝트',parentId:'a'}],{name:'회의',folderId:'b'});
  assert.equal(result.text,'전체 / 업무 / 프로젝트');assert.equal(JSON.stringify(result.folderIds),'["a","b"]');assert.equal(result.issue,'');
  assert.equal(locate([],{name:'방'}).text,'전체 / 미분류');
});
test('missing parent and cycles are visible instead of inventing a valid root location',()=>{
  assert.match(locate([],{folderId:'missing'}).text,/불러오기 필요/);
  const result=locate([{id:'a',name:'A',parentId:'b'},{id:'b',name:'B',parentId:'a'}],{folderId:'a'});
  assert.match(result.text,/구조 확인 필요/);assert.equal(result.folderIds.length,2);
});
