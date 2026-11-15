'use strict';
const assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs');
const P=require('../shared/peer-sync-engine.js');
const databases=new Map(),storage=new Map();
const indexedDB={open(name){const request={};queueMicrotask(()=>{if(!databases.has(name)){databases.set(name,new Map());request.result={createObjectStore(){}};request.onupgradeneeded?.()}const values=databases.get(name);request.result={close(){},transaction(){const tx={objectStore(){return {get(k){return action(()=>values.get(k))},put(v,k){return action(()=>{values.set(k,structuredClone(v));return k})}}}};function action(fn){const req={};queueMicrotask(()=>{req.result=fn();req.onsuccess?.();queueMicrotask(()=>tx.oncomplete?.())});return req}return tx}};request.onsuccess?.()});return request}};
const {test}=require('node:test');
test("joining an existing group validates and backs up both histories",async()=>{
 const own=await P.operation('group-a','actor-a',{entity:{kind:'room',id:'room-a'},value:{id:'room-a',name:'PC'}}),foreign=await P.operation('group-b','actor-b',{entity:{kind:'room',id:'room-b'},value:{id:'room-b',name:'Phone'}});
 const enc=new TextEncoder(),files=new Map([[P.GROUP_FILE,enc.encode(P.canonical({format:'memotalk-peer-group',version:1,id:'group-a'}))],...[own,foreign].map(o=>[P.DIRECTORY+'/operations/'+o.id+'.json',enc.encode(P.canonical(o))])]);
 storage.set('memotalk.peer.config',JSON.stringify({enabled:true,groupId:'group-a'}));storage.set('memotalk.peer.actor','actor-a');
 const sandbox={module:{exports:{}},TextEncoder,TextDecoder,structuredClone,crypto,Uint8Array,ArrayBuffer,Blob,DOMException,indexedDB,console,navigator:{},document:{addEventListener(){}},window:{MemoTalkFS:{}},localStorage:{getItem:k=>storage.get(k)??null,setItem:(k,v)=>storage.set(k,v)},setTimeout:()=>null,clearTimeout(){}};
 vm.runInNewContext(fs.readFileSync('shared/peer-sync-client.js','utf8'),sandbox);const C=sandbox.module.exports;
 let data={rooms:{'room-a':{id:'room-a',name:'PC'}},msgs:{}},token=0;
 const backend={mode:'local',peerSnapshot:()=>({token,data:structuredClone(data)}),peerCommit:async(t,rooms,msgs,g,p)=>{assert.equal(t,token);data={rooms,msgs,peerPresentations:{[g]:p}};token++}};
 const client=C.create({engine:P,backend:()=>backend,ready:()=>true,editing:()=>false,status(){},remember:async()=>{},read:async(root,p)=>files.get(p)||null,write:async(root,p,v,expected)=>{if(expected)assert.deepEqual(files.get(p),expected);files.set(p,v)},folder:async(root,parts)=>({async *values(){for(const path of files.keys())if(path.startsWith(parts.join('/')+'/'))yield {kind:'file',name:path.split('/').at(-1)}}}),archiveRoomId:r=>r});
 await client.restore({name:'test'});await client.run();assert.equal(client.last.revisions,2);assert.equal(client.last.foreignGroups['group-b'],1);
 const before=new Map(files); await assert.rejects(()=>client.joinExistingGroup('missing-group'),e=>e.code==='peer_existing_group_missing'); assert.equal(client.groupId,'group-a'); assert.deepEqual(files.get(P.GROUP_FILE),before.get(P.GROUP_FILE)); const result=await client.joinExistingGroup('group-b');assert.equal(result.currentError,null);assert.equal(client.groupId,'group-b');assert.equal(Object.keys(data.rooms).length,2);assert.equal(client.last.revisions,2);assert.equal(client.last.blocked.length,0);assert.equal(client.last.foreignGroups['group-a'],2);assert.ok(await C.stateStore(result.backupKey));assert.equal((await C.stateStore('group-a')).groupId,'group-a');for(const [p,v]of before)if(p!==P.GROUP_FILE)assert.deepEqual(files.get(p),v);
 console.log('PASS: client existing-group join validates target, backs up local state, preserves source ledger and files, merges PC and phone, updates group config');
});
