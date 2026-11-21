'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const {webcrypto}=require('node:crypto');
const html=fs.readFileSync(path.join(__dirname,'..','shared','index.html'),'utf8');

function plan(){
  const start=html.indexOf('async function planManualRoomMerge(');
  const end=html.indexOf('async function openManualRoomMerge(',start);
  assert.ok(start>0&&end>start,'pure room merge planner available');
  return vm.runInNewContext(html.slice(start,end)+';planManualRoomMerge',{
    crypto:webcrypto,TextEncoder,Uint8Array,structuredClone
  });
}
function sort(){
  const start=html.indexOf('/* Sorting is a local presentation preference');
  const end=html.indexOf('/* Desktop room order is a per-device',start);
  assert.ok(start>0&&end>start,'date-only sorting helpers available');
  return vm.runInNewContext(html.slice(start,end)+';({sortRooms:sortedRooms,sortMemos:sortedMemoView,setRoomMode:value=>{roomSortMode=value;},setMemoMode:value=>{memoSortMode=value;}})',{
    S:{rooms:[]},localStorage:{getItem(){return null;}},Number,Object,String,Map
  });
}
const roomA='main-room',roomB='recovery-room';
const memo=(id,ts,text,opts={})=>({id,ts,text,...opts});
test('manual recovery merge preserves originals, images, comments and dates',async()=>{
  const fn=plan();
  const image={data:'data:image/png;base64,AAAA',w:100,h:80};
  const common=memo('target',100,'겹치는 내용',{images:[image],comments:[{id:'c1',text:'댓글',ts:101}]});
  const old=memo('src-common',100,'겹치는 내용',{images:[image],comments:[{id:'c1',text:'댓글',ts:101}]});
  const recovered=memo('src-only',200,'복구된 내용',{images:[image],comments:[{id:'c2',text:'복구 댓글',ts:202}]});
  const target=[common],source=[old,recovered],original=JSON.stringify({target,source});
  const result=await fn(roomA,roomB,target,source);
  assert.equal(result.adds.length,1);
  assert.equal(result.skippedDuplicate,1);
  assert.equal(result.adds[0].ts,200);
  assert.deepEqual(JSON.parse(JSON.stringify(result.adds[0].images)),[image]);
  assert.equal(result.adds[0].comments[0].text,'복구 댓글');
  assert.equal(result.adds[0].manualMergeSource.roomId,roomB);
  assert.equal(result.adds[0].manualMergeSource.messageId,'src-only');
  assert.equal(JSON.stringify({target,source}),original,'planning must not mutate any room');
  assert.ok(result.adds[0].id.startsWith('manual_'));
});
test('retries and distinct edits are idempotent but never overwrite old edits',async()=>{
  const fn=plan();
  const source=[memo('s1',123,'문장 첫 번째 버전')];
  const one=await fn(roomA,roomB,[],source);
  assert.equal(one.adds.length,1);
  const again=await fn(roomA,roomB,[...one.adds],source);
  assert.equal(again.adds.length,0,'no second copy from same source and version');
  const edited=[memo('s1',123,'문장 수정된 버전',{edited:200})];
  const update=await fn(roomA,roomB,[...one.adds],edited);
  assert.equal(update.adds.length,1);
  assert.notEqual(update.adds[0].id,one.adds[0].id);
  assert.equal(one.adds[0].text,'문장 첫 번째 버전','earlier version retained');
  const duplicate=await fn(roomA,roomB,[...one.adds,...update.adds],edited);
  assert.equal(duplicate.adds.length,0);
});
test('intentional identical repeated records within the source preserve multiplicity',async()=>{
  const fn=plan();
  const source=[memo('a',123,'반복'),memo('b',123,'반복'),memo('c',123,'반복')];
  const result=await fn(roomA,roomB,[memo('x',123,'반복')],source);
  assert.equal(result.skippedDuplicate,1);
  assert.equal(result.adds.length,2);
  const repeat=await fn(roomA,roomB,[memo('x',123,'반복'),...result.adds],source);
  assert.equal(repeat.adds.length,0);
});
test('never collapse different comments or image variants',async()=>{
  const fn=plan();
  const target=[memo('x',123,'같은 메모',{comments:[{id:'x',text:'앞쪽 댓글',ts:124}]})];
  const source=[memo('y',123,'같은 메모',{comments:[{id:'y',text:'복구 댓글',ts:124}]})];
  const result=await fn(roomA,roomB,target,source);
  assert.equal(result.adds.length,1,'different comment preserved as a separate version');
});
test('sorting is display-only, stable, and keeps unknown dates last',()=>{
  const f=sort();
  const rooms=[{id:'a',createdAt:100,updatedAt:500},{id:'b',createdAt:200,updatedAt:300},{id:'c',createdAt:0,updatedAt:0}];
  const original=JSON.stringify(rooms);
  // sortRooms uses S; check the pure comparator directly from the same code.
  const start=html.indexOf('/* Sorting is a local presentation preference');
  const end=html.indexOf('/* Desktop room order is a per-device',start);
  const worker=vm.runInNewContext(html.slice(start,end)+';({rooms:sortedRooms,memos:sortedMemoView,setRoom:value=>roomSortMode=value,setMemo:value=>memoSortMode=value})',{
    S:{rooms},localStorage:{getItem(){return null;}}
  });
  worker.setRoom('created-old');
  assert.equal(worker.rooms().map(x=>x.id).join(','),'a,b,c');
  worker.setRoom('created-new');
  assert.equal(worker.rooms().map(x=>x.id).join(','),'b,a,c');
  worker.setRoom('activity');
  assert.equal(worker.rooms().map(x=>x.id).join(','),'a,b,c');
  const memos=[memo('b',200,'두 번째'),memo('c',0,'날짜없음'),memo('a',100,'첫 번째')];
  worker.setMemo('old');
  assert.equal(worker.memos(memos).map(x=>x.id).join(','),'a,b,c');
  worker.setMemo('new');
  assert.equal(worker.memos(memos).map(x=>x.id).join(','),'b,a,c');
  assert.equal(JSON.stringify(rooms),original,'sorting must not write or alter records');
});
test('rejects merging a room with itself or malformed source records',async()=>{
  const fn=plan();
  await assert.rejects(()=>fn(roomA,roomA,[],[]),/merge_same_room/);
  await assert.rejects(()=>fn(roomA,roomB,[],[{text:'missing ID'}]),/merge_invalid_messages/);
});

test('backup rooms are read without restoring state and preserve nested folder labels and full messages',()=>{
  const start=html.indexOf('function backupMergeRooms('),end=html.indexOf('async function openBackupRoomMerge(',start);
  const parse=vm.runInNewContext(html.slice(start,end)+';backupMergeRooms',{structuredClone});
  const data={rooms:{folder:{id:'folder',kind:'folder',name:'백업 분류'},main:{id:'main',name:'기존 방',folderId:'folder'},archive:{id:'archive',kind:'archive'}},msgs:{main:[memo('old',50,'백업만 남은 내용',{images:[{data:'data:image/png;base64,AA=='}],comments:[{id:'c',ts:51,text:'옛 댓글'}]})]}};
  const record={id:'backup1',raw:JSON.stringify(data)},before=JSON.stringify(record),rooms=parse(record);
  assert.equal(rooms.length,1);assert.equal(rooms[0].label,'백업 분류 / 기존 방');assert.equal(rooms[0].sourceId,'backup-room:main');assert.equal(rooms[0].messages[0].comments[0].text,'옛 댓글');
  rooms[0].messages[0].text='test copy';assert.equal(JSON.stringify(record),before);
  assert.throws(()=>parse({raw:'{"rooms":[],"msgs":{}}'}),/backup_invalid/);
});

test('an older imported ID and missing image dimensions cannot make a second copy',async()=>{
  const fn=plan(),source=[memo('original',50,'사진',{images:[{data:'data:image/png;base64,AA=='}]})];
  const earlier={...structuredClone(source[0]),id:'older-planner-id',images:[{...source[0].images[0],w:10,h:10}],manualMergeSource:{roomId:roomB,messageId:'original'}};
  assert.equal((await fn(roomA,roomB,[earlier],source)).adds.length,0);
  const sameRoomBackup=await fn(roomA,'backup-room:'+roomA,[],source);assert.equal(sameRoomBackup.adds.length,1);
});
