'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const P=require('../shared/peer-sync-engine.js');
const copy=structuredClone;
const room=(id,name='공유방',createdAt=100)=>({entity:{kind:'room',id},value:{id,name,createdAt}});
const memo=(rid,id,text,ts=200,extra={})=>({entity:{kind:'msg',rid,id},value:{id,text,ts,...extra}});
const records=list=>Object.fromEntries(list.map(item=>[P.entityKey(item.entity),item]));
const rooms=view=>Object.values(view).filter(r=>r.entity.kind==='room');
const messages=view=>Object.values(view).filter(r=>r.entity.kind==='msg');
const combine=async list=>(await P.coalesceRooms({records:records(list),conflicts:[]})).records;
function fixture(actor,files,initial=[]){
  const f={records:copy(initial),state:null,presentation:null,token:0};
  f.transport={
    async put(path,data){if(files.has(path))assert.deepEqual(files.get(path),data);files.set(path,copy(data));},
    async read(path){return copy(files.get(path)||null);},
    async list(path){return [...files.keys()].filter(k=>k.startsWith(path+'/')).map(k=>k.slice(path.length+1));}
  };
  f.replica=new P.Replica({groupId:'merge-test',actor,transport:f.transport,
    load:async()=>copy(f.state),save:async value=>{f.state=copy(value);},
    capture:async()=>({token:f.token,records:copy(f.records),presentation:f.presentation}),
    apply:async(token,data,conflicts,presentation)=>{assert.equal(token,f.token,'concurrent local edit');f.records=Object.values(copy(data));f.presentation=presentation;f.token++;}
  });
  return f;
}
async function settle(...devices){for(let cycle=0;cycle<4;cycle++)for(const f of devices)await f.replica.tick();}

test('copied rooms unite overlapping memos and preserve additions, comments, images and distinct edits',async()=>{
  const image={sha256:'a'.repeat(64),path:P.assetPath('a'.repeat(64),'image/png'),mime:'image/png'};
  const result=await combine([room('a'),room('b','공유방 (불러옴)'),
    memo('a','x','공통',200,{images:[image],comments:[{id:'c1',ts:210,text:'PC 댓글'}]}),
    memo('b','y','공통',200,{images:[image],comments:[{id:'c2',ts:211,text:'폰 댓글'}]}),
    memo('a','one','PC 추가',300),memo('b','two','폰 추가',400),
    memo('a','edited-a','PC 편집본',500),memo('b','edited-b','폰 편집본',500)]);
  assert.deepEqual(rooms(result).map(r=>r.entity.id),['a']);assert.equal(messages(result).length,5);
  const common=messages(result).find(m=>m.value.text==='공통');
  assert.deepEqual(common.value.images,[image]);assert.equal(common.value.comments.length,2);
  assert.equal(common.value.peerMergeOrigins.length,2);
  assert.deepEqual(rooms(result)[0].value.peerMergedRooms,['b']);
  assert.equal(P.canonical(await combine(Object.values(result))),P.canonical(result),'repeated merge is unchanged');
});

test('title alone, different room birth times, missing times and empty rooms cannot merge',async()=>{
  for(const list of [
    [room('a'),room('b',undefined,101),memo('a','x','같음'),memo('b','y','같음')],
    [room('a'),room('b'),memo('a','x','같음',200),memo('b','y','같음',201)],
    [room('a',undefined,0),room('b',undefined,0),memo('a','x','같음'),memo('b','y','같음')],
    [room('a'),room('b')],
    [room('a','다른 방'),room('b'),memo('a','x','같음'),memo('b','y','같음')]
  ])assert.equal(rooms(await combine(list)).length,2);
});

test('different edits with the same memo birth time still identify room copies and retain both texts',async()=>{
  const data=await combine([room('a'),room('b'),memo('a','same-id','PC 수정'),memo('b','same-id','폰 수정')]);
  assert.equal(rooms(data).length,1);assert.equal(messages(data).length,2);
  assert.equal(new Set(messages(data).map(m=>m.entity.id)).size,2);
  assert.deepEqual(new Set(messages(data).map(m=>m.value.text)),new Set(['PC 수정','폰 수정']));
});

test('intentional repeated equal memos and comments within one source are not erased',async()=>{
  const comments=[{id:'c1',ts:210,text:'반복'},{id:'c2',ts:210,text:'반복'}];
  const data=await combine([room('a'),room('b'),memo('a','x1','반복',200,{comments}),memo('a','x2','반복'),memo('b','y1','반복',200,{comments:[{...comments[0],id:'z'}]})]);
  assert.equal(messages(data).length,2);
  assert.equal(messages(data).find(m=>m.entity.id==='x1').value.comments.length,2);
});

test('projection is independent of arrival and object order',async()=>{
  const source=[room('z'),room('a'),memo('z','m2','공통'),memo('a','m1','공통'),memo('z','n','추가',201)];
  assert.equal(P.canonical(await combine(source)),P.canonical(await combine(source.slice().reverse())));
});

test('Windows and Android converge, retain immutable originals and do not grow on repeated cycles',async()=>{
  const files=new Map(),win=fixture('windows',files,[room('a'),memo('a','x','공통'),memo('a','w','Windows',300)]),phone=fixture('android',files,[room('b'),memo('b','y','공통'),memo('b','p','Android',400)]);
  await settle(win,phone);
  assert.equal(rooms(records(win.records)).length,1);assert.equal(messages(records(win.records)).length,3);
  assert.equal(P.canonical(records(win.records)),P.canonical(records(phone.records)));
  assert.ok(Object.values(win.state.operations).some(op=>op.entity.id==='b'&&op.value?.name==='공유방'));
  assert.ok(Object.values(win.state.operations).some(op=>op.entity.id==='y'&&op.value?.text==='공통'));
  const count=files.size;await settle(phone,win);assert.equal(files.size,count,'no merge echo or repeated identity rewriting');
});

test('late offline additions in an already-merged, absent alias room are redirected without resurrection',async()=>{
  const files=new Map(),win=fixture('windows',files,[room('a'),memo('a','x','共通')]),phone=fixture('android',files,[room('b'),memo('b','y','共通')]);
  await settle(win,phone);
  const late=await P.operation('merge-test','offline-phone',memo('b','late','늦은 추가',700));
  files.set(P.DIRECTORY+'/operations/'+late.id+'.json',new TextEncoder().encode(P.canonical(late)));
  await settle(phone,win);
  assert.equal(rooms(records(win.records)).length,1);
  assert.equal(win.records.find(r=>r.value.text==='늦은 추가').entity.rid,'a');
  const count=files.size;await settle(win,phone);assert.equal(files.size,count);
});

test('interruption while publishing a merge retains original local data and resumes durable outbox',async()=>{
  const files=new Map(),f=fixture('windows',files,[room('a'),room('b'),memo('a','x','공통'),memo('b','y','공통')]);
  const original=f.transport.put;let count=0;
  f.transport.put=async(...args)=>{if(++count===5)throw Error('interrupted');return original(...args);};
  await assert.rejects(f.replica.tick(),/interrupted/);
  assert.equal(rooms(records(f.records)).length,2);assert.ok(f.state.outbox.length);
  f.transport.put=original;await settle(f);
  assert.equal(rooms(records(f.records)).length,1);assert.equal(messages(records(f.records)).length,1);
  for(const [path,bytes]of files){const op=JSON.parse(new TextDecoder().decode(bytes));assert.ok(path.endsWith(op.id+'.json'));await P.validate(op,'merge-test');}
});

test('concurrent variants are both preserved when their room is merged',async()=>{
  const state=P.newState('merge-test','windows');
  const original=await P.operation('merge-test','a',memo('b','m','원본'));
  const ops=[await P.operation('merge-test','a',room('a')),await P.operation('merge-test','b',room('b')),
    await P.operation('merge-test','a',memo('a','x','공통')),
    await P.operation('merge-test','a',memo('b','y','공통')),original,
    await P.operation('merge-test','a',memo('b','m','편집 A'),[original.id]),
    await P.operation('merge-test','b',memo('b','m','편집 B'),[original.id])];
  for(const op of ops)state.operations[op.id]=op;
  const result=(await P.coalesceRooms(P.project(state))).records;
  assert.deepEqual(new Set(messages(result).map(m=>m.value.text)),new Set(['공통','편집 A','편집 B']));
});

test('malformed aliases and provenance fail validation rather than hiding unrelated data',async()=>{
  await assert.rejects(P.operation('merge-test','a',{...room('a'),value:{...room('a').value,peerMergedRooms:['__proto__']}}),{code:'peer_room_merge'});
  await assert.rejects(P.operation('merge-test','a',memo('a','x','memo',200,{peerMergeOrigins:[{rid:'a',id:'prototype'}]})),{code:'peer_memo_merge'});
});

test('failed pre-merge backup prevents any merge publication or local replacement',async()=>{
  const files=new Map(),f=fixture('a',files,[room('a'),room('b'),memo('a','x','공통'),memo('b','y','공통')]);
  f.replica.beforeRoomMerge=async()=>{throw Error('backup failed');};
  await assert.rejects(f.replica.tick(),/backup failed/);
  assert.equal(rooms(records(f.records)).length,2);
  assert.equal(files.size,4);assert.equal(f.state.outbox.length,0);
  assert.ok([...files.values()].every(bytes=>!JSON.parse(new TextDecoder().decode(bytes)).value?.peerMergedRooms));
  f.replica.beforeRoomMerge=async()=>{};await settle(f);
  assert.equal(rooms(records(f.records)).length,1);
});

test('edit typed during merge receive is retained and included on retry',async()=>{
  const files=new Map(),f=fixture('a',files,[room('a'),room('b'),memo('a','x','공통'),memo('b','y','공통')]);
  const original=f.replica.apply;let first=true;
  f.replica.apply=async(...args)=>{if(first){first=false;f.records.push(memo('b','new','받는 중 작성',600));f.token++;}return original(...args);};
  await assert.rejects(f.replica.tick(),/concurrent local edit/);
  assert.ok(f.records.some(r=>r.value.text==='받는 중 작성'));
  await settle(f);assert.equal(rooms(records(f.records)).length,1);
  assert.equal(f.records.find(r=>r.value.text==='받는 중 작성').entity.rid,'a');
});

test('simultaneous offline merges converge with separate additions after file exchange',async()=>{
  const initial=[room('a'),room('b'),memo('a','x','공통'),memo('b','y','공통')];
  const wf=new Map(),pf=new Map(),w=fixture('windows',wf,[...initial,memo('a','w','오프라인 PC',500)]),p=fixture('android',pf,[...initial,memo('b','p','오프라인 폰',600)]);
  await w.replica.tick();await p.replica.tick();
  for(const [k,v]of wf)pf.set(k,copy(v));for(const [k,v]of pf)wf.set(k,copy(v));
  // Use the same transport after reconnection; all original immutable files remain.
  p.transport.read=async path=>copy(wf.get(path)||null);
  p.transport.list=async path=>[...wf.keys()].filter(k=>k.startsWith(path+'/')).map(k=>k.slice(path.length+1));
  p.transport.put=async(path,data)=>{if(wf.has(path))assert.deepEqual(wf.get(path),data);wf.set(path,copy(data));};
  await settle(w,p);
  assert.equal(P.canonical(records(w.records)),P.canonical(records(p.records)));
  assert.deepEqual(new Set(messages(records(w.records)).map(m=>m.value.text)),new Set(['공통','오프라인 PC','오프라인 폰']));
  const count=wf.size;await settle(p,w);assert.equal(wf.size,count);
});

test('receiving a completed remote merge backs up before replacing the local duplicate',async()=>{
  const files=new Map(),a=fixture('a',files,[room('a'),memo('a','x','공통')]),b=fixture('b',files,[room('b'),memo('b','y','공통')]);
  await a.replica.tick();await b.replica.tick();let backups=0;
  a.replica.beforeRoomMerge=async()=>{backups++;throw Error('receiver backup unavailable');};
  await assert.rejects(a.replica.tick(),/receiver backup unavailable/);
  assert.equal(a.records.find(r=>r.entity.kind==='room').value.peerMergedRooms,undefined);
  a.replica.beforeRoomMerge=async()=>{backups++;};await settle(a,b);
  assert.equal(backups,2);assert.equal(rooms(records(a.records)).length,1);
});

test('identical photo bytes deduplicate even when only one copy knows display dimensions',async()=>{
  const image={sha256:'a'.repeat(64),path:P.assetPath('a'.repeat(64),'image/png'),mime:'image/png'};
  const result=await combine([room('a'),room('b'),memo('a','x','사진',200,{images:[image]}),memo('b','y','사진',200,{images:[{...image,w:20,h:30}]})]);
  assert.equal(messages(result).length,1);assert.equal(messages(result)[0].value.images[0].w,20);
});

test('system archive and folder rooms never merge with ordinary conversations',async()=>{
  const f=room('a'),a=room('b'),r=room('c');f.value.kind='folder';a.value.kind='archive';
  const result=await combine([f,a,r,memo('a','x','공통'),memo('b','y','공통'),memo('c','z','공통')]);
  assert.equal(rooms(result).length,3);
});
