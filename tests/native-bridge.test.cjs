'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const vm = require('node:vm');
const path = require('node:path');
const os = require('node:os');
const {createRequire} = require('node:module');

async function mainFixture(t) {
  const dir=await fsp.mkdtemp(path.join(os.tmpdir(),'memotalk-native-'));
  t.after(()=>fsp.rm(dir,{recursive:true,force:true}));
  const realRequire=createRequire(path.resolve('windows/main.js'));
  const electron={app:{whenReady:()=>({then(){}}),on(){},getPath:()=>dir},protocol:{registerSchemesAsPrivileged(){}},
    dialog:{showOpenDialog:async()=>({filePaths:[dir],canceled:false})}};
  const context=vm.createContext({require:name=>name==='electron'?electron:realRequire(name),Buffer,process,console,module:{exports:{}}});
  vm.runInContext(fs.readFileSync('windows/main.js','utf8')+'\nmodule.exports={perform};',context);
  const perform=context.module.exports.perform,owner={id:'owner'},other={id:'other'};
  const status=await perform('pickFolder',{},owner);
  return {dir,perform,owner,other,folderToken:status.folderToken};
}

test('native folder token prevents old window writing into newly chosen folder',async t=>{
  const f=await mainFixture(t);
  await f.perform('pickFolder',{},f.owner);
  await assert.rejects(f.perform('write',{folderToken:f.folderToken,path:['a.md'],base64:'eA==',expectedBase64:null},f.owner),{code:'ESTALE'});
  await assert.rejects(fsp.stat(path.join(f.dir,'a.md')),{code:'ENOENT'});
});

test('native mirror lease excludes another window and folder changes',async t=>{
  const f=await mainFixture(t),args={folderToken:f.folderToken};
  const lease=await f.perform('beginMirror',args,f.owner);
  await assert.rejects(f.perform('beginMirror',args,f.other),{code:'EBUSY'});
  await assert.rejects(f.perform('pickFolder',{},f.other),{code:'EBUSY'});
  await assert.rejects(f.perform('stat',{...args,path:[]},f.other),{code:'EBUSY'});
  await assert.rejects(f.perform('endMirror',{...args,leaseId:'wrong'},f.owner),{code:'EBUSY'});
  await f.perform('endMirror',{...args,...lease},f.owner);
  assert.ok(await f.perform('beginMirror',args,f.other));
});

test('native write retains real filesystem errno, syscall and stage; rejects traversal',async t=>{
  const f=await mainFixture(t),args={folderToken:f.folderToken};
  await assert.rejects(f.perform('write',{...args,path:['missing','memo.md'],base64:'eA==',expectedBase64:null},f.owner),
    e=>e.code==='ENOENT'&&e.syscall==='open'&&e.operation==='create-temp'&&Boolean(e.path));
  await assert.rejects(f.perform('write',{...args,path:['..','escape.md'],base64:'eA==',expectedBase64:null},f.owner));
});

function bridge(request) {
  const store=new Map();
  const context=vm.createContext({window:{MemoTalkNative:{request}},localStorage:{getItem:k=>store.get(k)||null,setItem:(k,v)=>store.set(k,v),removeItem:k=>store.delete(k)},
    Uint8Array,TextEncoder,TextDecoder,ArrayBuffer,Blob,File,DOMException,btoa,atob,console,crypto:require('node:crypto').webcrypto});
  vm.runInContext(fs.readFileSync('shared/platform-bridge.js','utf8'),context);
  return context.window;
}

test('bridge round-trip preserves diagnostic fields across serialized errors',async()=>{
  const w=bridge(async command=>{
    if(command==='pickFolder')return {ok:true,result:{connected:true,name:'test',folderToken:'token'}};
    return {ok:false,error:{message:'sharing violation',code:'EPERM',errno:-4048,syscall:'rename',operation:'commit',relativePath:'room/memo.md',path:'temporary',dest:'destination'}};
  });
  const root=await w.showDirectoryPicker();
  await assert.rejects(root.getFileHandle('memo.md'),e=>e.code==='EPERM'&&e.errno===-4048&&e.operation==='commit'&&e.relativePath==='room/memo.md'&&e.dest==='destination');
});

test('bridge ENOENT maps to NotFoundError; new Windows handle never touches disk',async()=>{
  const commands=[];
  const w=bridge(async (command,args)=>{
    commands.push(command);
    if(command==='pickFolder')return {ok:true,result:{connected:true,name:'test',folderToken:'token'}};
    assert.equal(args.folderToken,'token');
    if(command==='stat')return {ok:true,result:{exists:false}};
    if(command==='read')return {ok:false,error:{message:'missing',code:'ENOENT',relativePath:'memo.md'}};
    if(command==='write'){assert.equal(args.expectedBase64,null);return {ok:true,result:true};}
    throw Error(command);
  });
  const root=await w.showDirectoryPicker(),file=await root.getFileHandle('memo.md',{create:true});
  await assert.rejects(file.getFile(),e=>e.name==='NotFoundError'&&e.code==='ENOENT');
  const writer=await file.createWritable({expectedBytes:null});await writer.write('hello');await writer.close();
  assert.ok(!commands.includes('touch'));
});
