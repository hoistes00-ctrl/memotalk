'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const {webcrypto}=require('node:crypto');

function fixture({cancel=false,group=null,failWrite=false}={}){
  const events=[],storage=new Map([['memotalk.v1','original backup data']]);
  const engine={VERSION:1,GROUP_FILE:'memotalk-peer-group.json',canonical:JSON.stringify,Replica:class{}};
  const context=vm.createContext({module:{exports:{}},TextEncoder,TextDecoder,structuredClone,crypto:webcrypto,
    localStorage:{getItem:k=>storage.get(k)??null,setItem:(k,v)=>storage.set(k,v)},
    document:{addEventListener(){}},setTimeout:()=>0,clearTimeout(){},
    window:{AndroidMemoTalk:{},async showDirectoryPicker(){events.push('picker');
      if(cancel)throw Object.assign(Error('cancel'),{name:'AbortError'});return {name:'new Android folder'};}}});
  vm.runInContext(fs.readFileSync('shared/peer-sync-client.js','utf8'),context);
  const options={engine,backend:()=>({mode:'local',peerSnapshot(){},peerCommit(){}}),ask:async()=>true,
    pauseLegacy:async()=>{events.push('pause');storage.set('memotalk.fileMirror.auto','false');},
    permission:async()=>true,read:async()=>{events.push('read');return group?new TextEncoder().encode(JSON.stringify(group)):null;},
    write:async(root,path,data)=>{events.push('write');if(failWrite)throw Object.assign(Error('disk full'),{code:'ENOSPC'});assert.equal(group,null);group=JSON.parse(new TextDecoder().decode(data));},remember:async()=>events.push('remember'),
    status:(state,message)=>events.push({state,message}),toast:message=>events.push({toast:message})};
  return {client:context.module.exports.create(options),events,storage};
}
test('Android-first missing group stops legacy autosave before picker and preserves backup',async()=>{
  const f=fixture();await f.client.connect(false);
  assert.deepEqual(f.events.slice(0,3),['pause','picker','read']);
  assert.equal(f.client.active,false);
  assert.equal(f.storage.get('memotalk.fileMirror.auto'),'false');
  assert.equal(f.storage.get('memotalk.v1'),'original backup data');
  const error=JSON.parse(f.storage.get('memotalk.fileMirror.lastError'));
  assert.equal(error.code,'peer_group_not_downloaded');
  assert.equal(error.relativePath,'memotalk-peer-group.json');
  assert.ok(f.events.some(e=>e.message?.includes('이 기기에서 새 공유 그룹')));
});
test('cancelled native picker does not resume legacy writer against possibly changed root',async()=>{
  const f=fixture({cancel:true});await f.client.connect(false);
  assert.equal(f.storage.get('memotalk.fileMirror.auto'),'false');
  assert.equal(f.client.active,false);assert.equal(f.storage.get('memotalk.v1'),'original backup data');
  assert.equal(f.events.some(e=>e.toast),false);
});
test('valid Android join activates only after legacy writer is paused',async()=>{
  const f=fixture({group:{format:'memotalk-peer-group',version:1,id:'existing-group'}});
  await f.client.connect(false);assert.equal(f.client.active,true);
  assert.deepEqual(f.events.slice(0,4),['pause','picker','read','remember']);
});
test('restored Android legacy folder cannot write journal, export or external backup',async()=>{
  const html=fs.readFileSync('shared/index.html','utf8');
  const extract=(start,end)=>html.slice(html.indexOf(start),html.indexOf(end,html.indexOf(start)));
  const context=vm.createContext({window:{AndroidMemoTalk:{}},peerClient:{active:false},
    fileMirror:{handle:{name:'old folder'},timer:1,auto:true},clearTimeout(){},
    fileMirrorStatus(){},toast(){}});
  vm.runInContext(extract('function scheduleFileMirror(){','function enableFileMirrorChangeTracking'),context);
  vm.runInContext(extract('async function runFileMirror(','\npeerClient=window.MemoTalkPeerClient.create'),context);
  vm.runInContext(extract('async function saveExternalVaultCopy(','async function createVaultSnapshot'),context);
  vm.runInContext('scheduleFileMirror()',context);
  await vm.runInContext('runFileMirror(true)',context);
  assert.equal(await vm.runInContext('saveExternalVaultCopy({})',context),false);
});

test('Android can create and verify a group before Windows exists',async()=>{
  const f=fixture();await f.client.connect(true);
  assert.equal(f.client.active,true);assert.ok(f.events.includes('write'));
  assert.equal(f.storage.get('memotalk.v1'),'original backup data');
  assert.ok(JSON.parse(f.storage.get('memotalk.peer.config')).groupId);
});
test('create on an existing group joins without replacing its identity',async()=>{
  const f=fixture({group:{format:'memotalk-peer-group',version:1,id:'keep-original'}});
  await f.client.connect(true);assert.equal(f.client.active,true);
  assert.equal(f.events.includes('write'),false);assert.equal(f.client.groupId,'keep-original');
});
test('failed Android group creation preserves backup and does not activate',async()=>{
  const f=fixture({failWrite:true});await f.client.connect(true);
  assert.equal(f.client.active,false);assert.equal(f.storage.has('memotalk.peer.config'),false);
  assert.equal(f.storage.get('memotalk.v1'),'original backup data');
  assert.equal(JSON.parse(f.storage.get('memotalk.fileMirror.lastError')).code,'ENOSPC');
});
