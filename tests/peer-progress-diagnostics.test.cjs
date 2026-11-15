'use strict';
const assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs'),P=require('../shared/peer-sync-engine.js');
const {test}=require('node:test');
test("progress and native requests expose metadata without retaining tokens",async()=>{
 const op=await P.operation('progress-group','other-actor',{entity:{kind:'room',id:'received-room'},value:{id:'received-room',name:'test'}});
 let state,progress,releaseRead,readStarted;
 const entered=new Promise(resolve=>{readStarted=resolve}),held=new Promise(resolve=>{releaseRead=resolve});
 const replica=new P.Replica({groupId:'progress-group',actor:'local-actor',load:async()=>state,save:async value=>{state=structuredClone(value)},capture:async()=>({token:'t',records:[],assets:{}}),apply:async()=>{},onProgress:value=>{progress=value},transport:{list:async()=>[op.id+'.json'],read:async()=>{readStarted();return held},put:async()=>{throw new Error('unexpected write')}}});
 const tick=replica.tick();await entered;assert.equal(progress.stage,'read-operation');assert.ok(progress.path.endsWith(op.id+'.json'));assert.equal(replica.running,true);assert.equal(progress.total,1);
 releaseRead(new TextEncoder().encode(P.canonical(op)));await tick;assert.equal(progress.stage,'cycle-complete');assert.equal(replica.running,false);
 const observerFailure=new P.Replica({groupId:'empty-group',actor:'local-actor',load:async()=>null,save:async()=>{},capture:async()=>({token:'t',records:[],assets:{}}),apply:async()=>{},onProgress:()=>{throw new Error('diagnostic observer failed')},transport:{list:async()=>[],read:async()=>null,put:async()=>{throw new Error('unexpected write')}}});await observerFailure.tick();
 const messages=[],storage=new Map([['memotalk.nativeFolder.linkId','link']]);
 const sandbox={window:{AndroidMemoTalk:{postMessage:text=>messages.push(JSON.parse(text))}},crypto,Uint32Array,TextEncoder,TextDecoder,Uint8Array,ArrayBuffer,Blob,File,DOMException,Date,atob,btoa,localStorage:{getItem:k=>storage.get(k)??null,setItem:(k,v)=>storage.set(k,v),removeItem:k=>storage.delete(k)}};
 vm.runInNewContext(fs.readFileSync('shared/platform-bridge.js','utf8'),sandbox);const bridge=sandbox.window.MemoTalkFS;
 function reply(result,error){const m=messages.at(-1);sandbox.window.__memoNativeResolve({id:m.id,session:m.session,result,error})}
 const restored=bridge.restore();reply({connected:true,name:'test',folderToken:'DO-NOT-EXPOSE-TOKEN',atomicWrites:true});const {handle}=await restored;
 const stat=handle.getFileHandle('test.json');reply({exists:true,kind:'file'});const file=await stat;
 const read=file.getFile();let diag=bridge.diagnostics();assert.equal(diag.pendingOperations.length,1);assert.equal(diag.pendingOperations[0].command,'read');assert.equal(diag.pendingOperations[0].relativePath,'test.json');assert.ok(!JSON.stringify(diag).includes('DO-NOT-EXPOSE-TOKEN'));assert.equal(messages.filter(m=>m.command==='read').length,1);
 reply(null,{message:'missing',code:'ENOENT'});await assert.rejects(read,e=>e.name==='NotFoundError');assert.equal(bridge.diagnostics().pendingOperations.length,0);
 const countBefore=messages.length;const direct=bridge.readFile(handle,'nested/test.json');assert.equal(messages.length,countBefore+1);assert.equal(messages.at(-1).command,'read');assert.deepEqual(messages.at(-1).args.path,['nested','test.json']);reply({base64:btoa('verified')});assert.equal(new TextDecoder().decode(await direct),'verified');const noTraversal=messages.length;await assert.rejects(bridge.readFile(handle,'../bad'),e=>e.name==='TypeError');assert.equal(messages.length,noTraversal);
 console.log('PASS: stalled read exposes exact phase/path, completing read clears busy, observer failure cannot stop sync, native pending diagnostics omit tokens and clean up on rejection; no retry/publication added');
});
