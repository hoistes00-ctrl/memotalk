'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),P=require('../shared/peer-sync-engine.js');
test('renaming a derived pending room promotes its original ID, but archives and untouched placeholders stay local',()=>{
  const room={id:'room-a',name:'한 단어장',createdAt:0,peerConflict:true},next=P.recoverNamedPendingRoom(room);
  assert.equal(next.id,room.id);assert.equal(next.peerConflict,undefined);assert.equal(next.peerRecoveredRoom,true);
  assert.equal(room.peerConflict,true);assert.equal(Object.keys(P.normalize([{entity:{kind:'room',id:room.id},value:next}])).length,1);
  for(const excluded of [{...room,name:'받은 메모 · 메모방 복원 대기'},{...room,kind:'archive'},{...room,name:''}])assert.deepEqual(P.recoverNamedPendingRoom(excluded),excluded);
});
test('room recovery causally follows deletion and preserves every memo when exchanged',async()=>{
  const id='room-a',group='recovery-test',created=await P.operation(group,'old-device',{entity:{kind:'room',id},value:{id,name:'원래 방',createdAt:1}}),deleted=await P.operation(group,'old-device',{entity:{kind:'room',id},value:null},[created.id]);
  const msg=await P.operation(group,'old-device',{entity:{kind:'msg',rid:id,id:'memo-a'},value:{id:'memo-a',ts:1,text:'보존할 문장',comments:[{id:'comment-a',ts:2,text:'보존할 댓글'}]}});
  const state=P.newState(group,'phone');for(const op of [created,deleted,msg])state.operations[op.id]=op;
  const view=P.project(state);state.baseline=await P.fingerprints(view.records);state.baseHeads=view.heads;
  const recovered=P.recoverNamedPendingRoom({id,name:'한 단어장',createdAt:0,peerConflict:true});
  await P.harvest(state,P.normalize([{entity:{kind:'room',id},value:recovered},{entity:msg.entity,value:msg.value}]));
  const revision=state.operations[state.outbox[0]];assert.deepEqual(revision.parents,[deleted.id]);await P.validate(revision,group);
  const received=P.newState(group,'pc');received.operations=structuredClone(state.operations);const projected=P.project(received);
  assert.equal(projected.records[P.entityKey(revision.entity)].value.name,'한 단어장');assert.deepEqual(projected.records[P.entityKey(msg.entity)].value,msg.value);assert.equal(projected.conflicts.length,0);
});
test('one current readable file is deterministic, keeps comments and photo links, and does not mutate history',()=>{
  const room={entity:{kind:'room',id:'r'},value:{id:'r',name:'기존 방'}},memo={entity:{kind:'msg',rid:'r',id:'m'},value:{id:'m',text:'원문',ts:1,comments:[{id:'c',text:'댓글',ts:2}],images:[{path:P.assetPath('a'.repeat(64),'image/png')}]}};
  const input=Object.fromEntries([room,memo].map(r=>[P.entityKey(r.entity),r])),before=P.canonical(input),a=P.currentReadable(input),b=P.currentReadable(Object.fromEntries(Object.entries(input).reverse())),text=new TextDecoder().decode(a.data);
  assert.equal(a.path,'memotalk-peer-v1/readable/current.md');assert.deepEqual(a,b);assert.ok(text.includes('原文')||text.includes('원문'));assert.ok(text.includes('댓글'));assert.ok(text.includes('../assets/'+'a'.repeat(64)+'.png'));assert.equal(P.canonical(input),before);
});
