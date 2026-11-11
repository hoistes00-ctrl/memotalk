'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const html=fs.readFileSync('shared/index.html','utf8');
const source=html.slice(html.indexOf('function makeLocal(){'),html.indexOf('\nfunction makeDb('));
function fixture(){
  const storage=new Map(),queues=new Map();let quota=false;
  const localStorage={getItem:k=>storage.get(k)??null,setItem:(k,v)=>{if(quota)throw Error('quota');storage.set(k,v);}};
  const locks={request:(key,callback)=>{const next=(queues.get(key)||Promise.resolve()).then(callback);queues.set(key,next.catch(()=>{}));return next;}};
  const context=vm.createContext({localStorage,navigator:{locks},addEventListener(){},setTimeout,structuredClone,console});
  const makeLocal=vm.runInContext(source+'\nmakeLocal',context);
  return {storage,a:makeLocal(),b:makeLocal(),quota:value=>{quota=value;},read:()=>JSON.parse(storage.get('memotalk.v1'))};
}
test('separate app windows preserve each other edits and newly received rooms',async()=>{
  const f=fixture();await f.a.setRoom({id:'r',name:'original'});
  await f.b.setMsg('r',{id:'m',ts:1,text:'child window'});
  assert.equal(f.read().rooms.r.name,'original');
  const snapshot=f.a.peerSnapshot();
  await f.a.peerCommit(snapshot.token,{...snapshot.data.rooms,remote:{id:'remote',name:'incoming room'}},snapshot.data.msgs,'group','receipt');
  await f.b.updateMsg('r','m',{text:'edited after receive'});
  assert.equal(f.read().rooms.remote.name,'incoming room');
  assert.equal(f.read().msgs.r[0].text,'edited after receive');
  assert.equal(f.read().peerPresentations.group,'receipt');
});
test('simultaneous window writes are serialized without lost messages',async()=>{
  const f=fixture();await f.a.setRoom({id:'r',name:'shared'});
  await Promise.all([f.a.setMsg('r',{id:'a',ts:1,text:'A'}),f.b.setMsg('r',{id:'b',ts:2,text:'B'})]);
  assert.equal(f.read().msgs.r.length,2);
});
test('peer storage token protects a user edit made during incoming file reads',async()=>{
  const f=fixture();await f.a.setRoom({id:'r',name:'shared'});
  const snapshot=f.a.peerSnapshot();await f.b.setMsg('r',{id:'b',ts:1,text:'user typed'});
  await assert.rejects(f.a.peerCommit(snapshot.token,snapshot.data.rooms,snapshot.data.msgs,'group','receipt'),{code:'peer_stale'});
  assert.equal(f.read().msgs.r[0].text,'user typed');
});
test('quota failure commits neither incoming data nor presentation receipt',async()=>{
  const f=fixture();await f.a.setRoom({id:'r',name:'original'});
  const snapshot=f.a.peerSnapshot();f.quota(true);
  await assert.rejects(f.a.peerCommit(snapshot.token,{r:{id:'r',name:'incoming'}},{},'group','receipt'),{code:'quota'});
  assert.equal(f.read().rooms.r.name,'original');assert.equal(f.read().peerPresentations?.group,undefined);
});
