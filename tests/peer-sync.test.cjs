'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const Peer=require('../shared/peer-sync-engine');
const copy=value=>structuredClone(value);
const room={entity:{kind:'room',id:'room1'},value:{id:'room1',name:'공유 메모'}};
const memo=(id,text)=>({entity:{kind:'msg',rid:'room1',id},value:{id,ts:1,text}});
function fixture(actor,files=new Map(),records=[]){
  const f={actor,files,records:copy(records),revision:0,presentation:null,state:null,conflicts:[],writes:0};
  f.transport={
    async put(path,data){
      const old=files.get(path);if(old&&!Buffer.from(old).equals(Buffer.from(data)))throw Object.assign(Error('immutable'),{code:'ESTALE'});
      files.set(path,copy(data));
    },
    async read(path){return copy(files.get(path)||null);},
    async list(path){return [...files.keys()].filter(p=>p.startsWith(path+'/')).map(p=>p.slice(path.length+1));}
  };
  f.makeReplica=()=>new Peer.Replica({groupId:'group1',actor,
    load:async()=>copy(f.state),save:async state=>{f.state=copy(state);},transport:f.transport,
    capture:async()=>({token:f.revision,records:copy(f.records),presentation:f.presentation}),
    apply:async(token,records,conflicts,presentation)=>{
      if(token!==f.revision)throw Object.assign(Error('stale'),{code:'peer_stale'});
      f.records=Object.values(copy(records));f.conflicts=copy(conflicts);f.presentation=presentation;f.revision++;f.writes++;
    }});
  f.replica=f.makeReplica();
  f.edit=(id,text)=>{const found=f.records.find(x=>x.entity.kind==='msg'&&x.entity.id===id);found.value.text=text;f.revision++;};
  return f;
}
const text=(f,id)=>f.records.find(x=>x.entity.kind==='msg'&&x.entity.id===id)?.value.text;
async function settle(...replicas){for(let i=0;i<3;i++)for(const f of replicas)await f.replica.tick();}

test('Windows and Android join by union and edits flow in both directions without echo',async()=>{
  const files=new Map(),win=fixture('windows',files,[room,memo('a','윈도우')]),android=fixture('android',files,[memo('b','휴대폰')]);
  await settle(win,android);
  assert.equal(text(android,'a'),'윈도우');assert.equal(text(win,'b'),'휴대폰');
  android.edit('a','휴대폰 수정');await settle(android,win);
  assert.equal(text(win,'a'),'휴대폰 수정');assert.equal(win.conflicts.length,0);
  win.edit('a','윈도우 재수정');await settle(win,android);
  assert.equal(text(android,'a'),'윈도우 재수정');
  const revisions=Object.keys(win.state.operations).length;
  await settle(win,android);
  assert.equal(Object.keys(win.state.operations).length,revisions);
});

test('offline concurrent edits converge and preserve both full versions',async()=>{
  const wf=new Map(),af=new Map(),win=fixture('windows',wf,[room,memo('a','원문')]),android=fixture('android',af);
  await win.replica.tick();for(const [p,b]of wf)af.set(p,copy(b));await android.replica.tick();
  win.edit('a','윈도우 오프라인 수정');android.edit('a','안드로이드 오프라인 수정');
  await win.replica.tick();await android.replica.tick();
  for(const [p,b]of af)wf.set(p,copy(b));for(const [p,b]of wf)af.set(p,copy(b));
  await settle(win,android);
  assert.equal(text(win,'a'),text(android,'a'));
  assert.equal(win.conflicts.length,1);assert.equal(android.conflicts.length,1);
  assert.deepEqual(new Set(win.conflicts[0].variants.map(x=>x.value.text)),new Set(['윈도우 오프라인 수정','안드로이드 오프라인 수정']));
  assert.equal(Peer.canonical(win.state.operations),Peer.canonical(android.state.operations));
});

test('choosing a conflict version is a new causal revision, preserving original history',async()=>{
  const files=new Map(),a=fixture('a',files,[room,memo('x','initial')]),b=fixture('b',files);
  await settle(a,b);
  a.edit('x','A');b.edit('x','B');await a.replica.tick();await b.replica.tick();await settle(a,b);
  const conflict=a.conflicts[0],chosen=conflict.variants.find(x=>x.value.text==='B');
  const oldIds=Object.keys(a.state.operations);
  await a.replica.resolve(conflict.key,chosen.id);await settle(a,b);
  assert.equal(text(a,'x'),'B');assert.equal(text(b,'x'),'B');assert.equal(a.conflicts.length,0);
  for(const id of oldIds)assert.ok(a.state.operations[id]);
});

test('sequential deletion uses explicit tombstone; missing files never imply deletion',async()=>{
  const files=new Map(),a=fixture('a',files,[room,memo('x','kept in revisions')]),b=fixture('b',files);
  await settle(a,b);
  const before=[...files];files.clear();await b.replica.tick();assert.equal(text(b,'x'),'kept in revisions');
  for(const [p,v]of before)files.set(p,v);
  a.records=a.records.filter(r=>r.entity.id!=='x');a.revision++;
  await settle(a,b);assert.equal(text(b,'x'),undefined);
  assert.ok(Object.values(b.state.operations).some(op=>op.value?.text==='kept in revisions'));
});

test('concurrent deletion and edit keeps editable content and deletion variant',async()=>{
  const files=new Map(),a=fixture('a',files,[room,memo('x','base')]),b=fixture('b',files);
  await settle(a,b);
  a.records=a.records.filter(r=>r.entity.id!=='x');a.revision++;b.edit('x','surviving edit');
  await settle(a,b);
  assert.equal(text(a,'x'),'surviving edit');assert.equal(a.conflicts.length,1);
  assert.ok(a.conflicts[0].variants.some(op=>op.value===null));
});

test('child delivered before parent is deferred, then applied when parent arrives',async()=>{
  const parent=await Peer.operation('group1','a',memo('x','base'));
  const child=await Peer.operation('group1','a',memo('x','next'),[parent.id]);
  const files=new Map([[Peer.DIRECTORY+'/operations/'+child.id+'.json',new TextEncoder().encode(JSON.stringify(child))]]);
  const b=fixture('b',files);
  const pending=await b.replica.tick();assert.equal(pending.pending,1);assert.equal(b.records.length,0);
  files.set(Peer.DIRECTORY+'/operations/'+parent.id+'.json',new TextEncoder().encode(JSON.stringify(parent)));
  await b.replica.tick();assert.equal(text(b,'x'),'next');
});

test('partial and tampered revisions are blocked, repaired delivery can be retried',async()=>{
  const op=await Peer.operation('group1','a',memo('x','valid'));
  const filename=Peer.DIRECTORY+'/operations/'+op.id+'.json';
  const files=new Map([[filename,new TextEncoder().encode('{partial')]]),b=fixture('b',files);
  assert.equal((await b.replica.tick()).blocked.length,1);assert.equal(text(b,'x'),undefined);
  files.set(filename,new TextEncoder().encode(JSON.stringify({...op,value:{...op.value,text:'tampered'}})));
  assert.equal((await b.replica.tick()).blocked.length,1);assert.equal(text(b,'x'),undefined);
  files.set(filename,new TextEncoder().encode(JSON.stringify(op)));
  await b.replica.tick();assert.equal(text(b,'x'),'valid');
});

test('new edit while applying incoming data is retained as conflict, never overwritten',async()=>{
  const files=new Map(),a=fixture('a',files,[room,memo('x','base')]),b=fixture('b',files);
  await settle(a,b);a.edit('x','from Windows');await a.replica.tick();
  const originalApply=b.replica.apply;
  b.replica.apply=async(...args)=>{b.edit('x','typed on Android');await originalApply(...args);};
  await assert.rejects(b.replica.tick(),{code:'peer_stale'});
  assert.equal(text(b,'x'),'typed on Android');
  b.replica.apply=originalApply;await settle(b,a);
  assert.equal(a.conflicts.length,1);
  assert.deepEqual(new Set(a.conflicts[0].variants.map(op=>op.value.text)),new Set(['from Windows','typed on Android']));
});

test('crash after application commit before ledger commit resumes without echo',async()=>{
  const files=new Map(),a=fixture('a',files,[room,memo('x','base')]),b=fixture('b',files);
  await a.replica.tick();
  const apply=b.replica.apply;b.replica.apply=async(...args)=>{await apply(...args);throw Error('crash after commit');};
  await assert.rejects(b.replica.tick());assert.equal(text(b,'x'),'base');assert.ok(b.state.pending);
  b.replica=b.makeReplica();await settle(a,b);
  assert.equal(b.conflicts.length,0);assert.equal(Object.keys(b.state.operations).length,2);
});

test('quota/application failure leaves old data intact and supports retry',async()=>{
  const files=new Map(),a=fixture('a',files,[room,memo('x','base')]),b=fixture('b',files);
  await a.replica.tick();const apply=b.replica.apply;
  b.replica.apply=async()=>{throw Object.assign(Error('quota'),{code:'quota'});};
  await assert.rejects(b.replica.tick(),{code:'quota'});assert.equal(b.records.length,0);
  b.replica.apply=apply;await settle(a,b);assert.equal(text(b,'x'),'base');assert.equal(b.conflicts.length,0);
});

test('cross-entity parent references and foreign groups are rejected',async()=>{
  const p=await Peer.operation('group1','a',memo('x','x'));
  const c=await Peer.operation('group1','a',memo('y','y'),[p.id]);
  const state=Peer.newState('group1','a');state.operations={[p.id]:p,[c.id]:c};
  assert.throws(()=>Peer.project(state),{code:'peer_parent_entity'});
  await assert.rejects(Peer.validate(p,'other-group'),{code:'peer_operation'});
  for(const id of ['__proto__','constructor','prototype'])assert.throws(()=>Peer.entityKey({kind:'room',id}),{code:'peer_entity'});
});

test('ten thousand causally ordered edits arriving backwards project without recursion',()=>{
  const state=Peer.newState('group1','a'),depth=10000;
  const id=i=>i.toString(16).padStart(64,'0');
  for(let i=depth-1;i>=0;i--)state.operations[id(i)]={id:id(i),entity:{kind:'msg',rid:'r',id:'m'},parents:i?[id(i-1)]:[],value:{id:'m',ts:i,text:'revision '+i}};
  const view=Peer.project(state);assert.equal(view.pending.length,0);assert.equal(view.conflicts.length,0);
  assert.equal(Object.values(view.records)[0].value.text,'revision 9999');
});

test('interruption midway through publishing replays identical revisions without duplicates',async()=>{
  const a=fixture('a',new Map(),[room,memo('m','durable local edit')]);
  const put=a.transport.put;let writes=0;
  a.transport.put=async(...args)=>{if(++writes===2)throw Object.assign(Error('disk full'),{code:'ENOSPC'});return put(...args);};
  await assert.rejects(a.replica.tick(),{code:'ENOSPC'});
  const ids=Object.keys(a.state.operations).sort();assert.equal(a.state.outbox.length,2);
  a.transport.put=put;await a.replica.tick();
  assert.deepEqual(Object.keys(a.state.operations).sort(),ids);assert.equal(a.state.outbox.length,0);
  assert.equal(text(a,'m'),'durable local edit');
});
