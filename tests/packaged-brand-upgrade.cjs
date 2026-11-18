'use strict';
const fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os'),assert=require('node:assert/strict');
const {spawn}=require('node:child_process'),{once}=require('node:events');
const {connect,debuggerPort,until,wait}=require('./peer-packaged-windows.cjs');
// Test-only shutdown deadline; larger permits slower synthetic test machines.
const SHUTDOWN_MS=10000;
async function launch(executable,profile){
  const port=await debuggerPort(),env={...process.env};delete env.ELECTRON_RUN_AS_NODE;
  const child=spawn(executable,['--user-data-dir='+profile,'--remote-debugging-port='+port,'--disable-gpu'],{windowsHide:true,env});
  let errors='';child.stderr.on('data',x=>{errors+=String(x)});
  const page=await until(async()=>{if(child.exitCode!==null)throw Error(errors);return (await(await fetch('http://127.0.0.1:'+port+'/json/list')).json()).find(x=>x.type==='page'&&x.url.startsWith('memotalk://app/'))});
  return {child,cdp:await connect(page.webSocketDebuggerUrl)};
}
async function close(runtime){
  if(!runtime)return;
  const exited=once(runtime.child,'exit');
  if(runtime.child.exitCode===null){await runtime.cdp.command('Browser.close').catch(()=>{});await Promise.race([exited,wait(SHUTDOWN_MS)]);}
  runtime.cdp.socket.close();
  if(runtime.child.exitCode===null){runtime.child.kill();await Promise.race([exited,wait(SHUTDOWN_MS)]);}
}
(async()=>{
  assert.equal(process.platform,'win32');
  const old=path.resolve(process.argv[2]),current=path.resolve(process.argv[3]);
  await fs.access(old);await fs.access(current);
  const scratch=await fs.mkdtemp(path.join(os.tmpdir(),'modutalk-upgrade-')),profile=path.join(scratch,'profile'),vault=path.join(scratch,'vault');
  await fs.mkdir(profile);await fs.mkdir(vault);
  const settings=JSON.stringify({folder:vault});await fs.writeFile(path.join(profile,'native-folder.json'),settings);
  const fixture={seeded:true,rooms:{brandroom:{id:'brandroom',name:'Upgrade fixture',createdAt:1,updatedAt:1,last:'Retained memo'}},msgs:{brandroom:[{id:'preservedmemo',ts:1,text:'Retained memo',comments:[{id:'preservedcomment',ts:1,text:'Retained comment'}]}]}};
  let runtime;
  try{
    runtime=await launch(old,profile);
    await until(()=>runtime.cdp.evaluate("typeof window.MemoTalkPeer==='object'"));
    await runtime.cdp.evaluate(`localStorage.setItem('memotalk.v1',${JSON.stringify(JSON.stringify(fixture))});localStorage.setItem('memotalk.fileMirror.auto','false');localStorage.removeItem('memotalk.peer.config');location.reload();true`);
    await until(()=>runtime.cdp.evaluate("!!JSON.parse(localStorage.getItem('memotalk.v1')).msgs.brandroom"));
    const before=await runtime.cdp.evaluate("({data:JSON.parse(localStorage.getItem('memotalk.v1')),folder:document.querySelector('#file-sync-state')?.textContent})");
    await close(runtime);runtime=null;
    runtime=await launch(current,profile);
    await until(()=>runtime.cdp.evaluate("typeof window.MemoTalkPeer==='object'"));
    const after=await runtime.cdp.evaluate("({data:JSON.parse(localStorage.getItem('memotalk.v1')),title:document.title,name:document.querySelector('h1')?.textContent})");
    assert.deepEqual(after.data.rooms,before.data.rooms);assert.deepEqual(after.data.msgs,before.data.msgs);
    assert.equal(after.name,'모두톡');assert.equal(after.title,'모두톡 17.2.0');
    assert.equal(await fs.readFile(path.join(profile,'native-folder.json'),'utf8'),settings);
    const result={passed:true,oldToNewProfileRetained:true,roomIdRetained:true,memoIdRetained:true,commentIdAndContentRetained:true,nativeFolderRetained:true,displayName:after.name,title:after.title};
    if(process.argv[4])await fs.writeFile(path.resolve(process.argv[4]),JSON.stringify(result,null,2));
    console.log(JSON.stringify(result));
  }finally{
    await close(runtime);
    assert.equal(path.dirname(path.resolve(scratch)),path.resolve(os.tmpdir()));assert.ok(path.basename(scratch).startsWith('modutalk-upgrade-'));
    await fs.rm(scratch,{recursive:true,force:true,maxRetries:10,retryDelay:100}).catch(()=>{});
  }
})().catch(e=>{console.error(e);process.exitCode=1});
