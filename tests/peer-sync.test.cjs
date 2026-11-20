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
  const ids=Object.keys(a.state.operations).sort();assert.equal(a.state.outbox.length,1,'successful publication receipt survives a later failure');
  a.transport.put=put;await a.replica.tick();
  assert.deepEqual(Object.keys(a.state.operations).sort(),ids);assert.equal(a.state.outbox.length,0);
  assert.equal(text(a,'m'),'durable local edit');
});


test('interrupted first receive resumes durable verified batches without importing a backup',async()=>{
  const files=new Map(),source=fixture('source',files,[room,...Array.from({length:80},(_,i)=>memo('checkpoint'+i,'preserved '+i))]);
  source.replica.publicationLimit=100000;await source.replica.tick();
  const phone=fixture('phone',files,[]),read=phone.transport.read;let reads=0;
  phone.transport.read=async path=>{if(++reads===41)throw Object.assign(Error('revoked'),{code:'EACCES'});return read(path);};
  await assert.rejects(phone.replica.tick(),{code:'EACCES'});
  const durable=Object.keys(phone.state.operations).length;
  assert.ok(durable>0&&durable<81,'validated receive batch must survive interruption');
  assert.deepEqual(phone.records,[],'a partial receive must not replace application notes');
  assert.deepEqual(phone.state.baseline,{},'checkpoint is not an applied baseline');
  phone.transport.read=async path=>{reads++;return read(path);};reads=0;
  phone.replica=phone.makeReplica();await phone.replica.tick();
  assert.equal(reads,81-durable,'restart must skip all durable verified records');
  assert.equal(phone.records.length,81);assert.equal(text(phone,'checkpoint79'),'preserved 79');
  const originalReads=reads;await phone.replica.tick();assert.equal(reads,originalReads,'completed history is not reread');
});

test('receive checkpoint failure stops before applying and is not hidden as a bad remote file',async()=>{
  const files=new Map(),source=fixture('source',files,[room,...Array.from({length:40},(_,i)=>memo('save'+i,'data'))]);
  source.replica.publicationLimit=100000;await source.replica.tick();const phone=fixture('phone',files,[]);
  phone.replica.save=async state=>{if(Object.keys(state.operations).length)throw Object.assign(Error('disk full'),{code:'ENOSPC'});phone.state=copy(state);};
  await assert.rejects(phone.replica.tick(),{code:'ENOSPC'});assert.equal(phone.writes,0);assert.deepEqual(phone.records,[]);
});


test('177 outgoing revisions do not starve incoming edits between bounded send batches',async()=>{
  const files=new Map(),serverRoom={entity:{kind:'room',id:'server-room'},value:{id:'server-room',name:'받은 방'}};
  const remote={entity:{kind:'msg',rid:'server-room',id:'server-note'},value:{id:'server-note',text:'remote first',ts:1}};
  const server=fixture('server',files,[serverRoom,remote]);await server.replica.tick();
  const phone=fixture('phone',files,[room,...Array.from({length:176},(_,i)=>memo('bulk'+i,'local '+i))]);
  const result=await phone.replica.tick();
  assert.equal(result.outgoingPending,173);assert.equal(phone.state.outbox.length,173);
  assert.equal(text(phone,'server-note'),'remote first','receive must run before all 177 outgoing records finish');
  server.edit('server-note','remote while sending');await server.replica.tick();await phone.replica.tick();
  assert.equal(text(phone,'server-note'),'remote while sending');assert.ok(phone.state.outbox.length>0);
  for(let i=0;i<100&&phone.state.outbox.length;i++)await phone.replica.tick();
  assert.equal(phone.state.outbox.length,0);await server.replica.tick();
  assert.equal(text(server,'bulk175'),'local 175');assert.equal(text(phone,'bulk0'),'local 0');
});

test('partial outgoing failure saves successful receipts and restart skips that prefix',async()=>{
  const phone=fixture('phone',new Map(),[room,...Array.from({length:176},(_,i)=>memo('bulk'+i,'local '+i))]);
  const put=phone.transport.put;let attempts=0;
  phone.transport.put=async(...args)=>{if(++attempts===3)throw Object.assign(Error('failed write'),{code:'EIO'});return put(...args);};
  await assert.rejects(phone.replica.tick(),{code:'EIO'});assert.equal(phone.state.outbox.length,175);
  const confirmed=new Set(phone.files.keys()),allIds=Object.keys(phone.state.operations).sort();let replayed=0;
  phone.transport.put=async(p,b)=>{if(confirmed.has(p))replayed++;return put(p,b);};phone.replica=phone.makeReplica();
  await phone.replica.tick();assert.equal(replayed,0);assert.equal(phone.state.outbox.length,171);
  assert.deepEqual(Object.keys(phone.state.operations).sort(),allIds);assert.equal(text(phone,'bulk175'),'local 175');
});

test('publication limit changes at the next cycle and rejects invalid counts',async()=>{
  const phone=fixture('phone',new Map(),[room,...Array.from({length:12},(_,i)=>memo('tune'+i,'local'))]);
  let limit=1;phone.replica.publicationLimit=()=>limit;
  assert.equal((await phone.replica.tick()).outgoingPending,12);
  limit=5;assert.equal((await phone.replica.tick()).outgoingPending,7);
  limit=0;await assert.rejects(phone.replica.tick(),{code:'peer_publication_limit'});
  assert.equal(phone.state.outbox.length,7);limit=100000;assert.equal((await phone.replica.tick()).outgoingPending,0);
});
