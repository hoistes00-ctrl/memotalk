'use strict';
// Launch only the freshly built app, with isolated profile + synthetic Android revisions.
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const os=require('node:os');
const net=require('node:net');
const {spawn}=require('node:child_process');
const {once}=require('node:events');
const P=require('../shared/peer-sync-engine');
// Integration test deadlines; higher permits slower disposable CI machines.
const START_TIMEOUT_MS=45000,REQUEST_TIMEOUT_MS=15000,POLL_MS=150,EXIT_TIMEOUT_MS=10000;
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(check,timeout=START_TIMEOUT_MS){
  const end=Date.now()+timeout;let last;
  while(Date.now()<end){try{const result=await check();if(result)return result;}catch(error){last=error;}await wait(POLL_MS);}
  throw last||Error('Timed out waiting for packaged Windows application');
}
async function debuggerPort(){
  const server=net.createServer();server.listen(0,'127.0.0.1');await once(server,'listening');
  const port=server.address().port;await new Promise(resolve=>server.close(resolve));return port;
}
async function connect(url){
  const socket=new WebSocket(url),pending=new Map(),exceptions=[];let next=0;
  socket.addEventListener('message',event=>{
    const value=JSON.parse(String(event.data));
    if(value.method==='Runtime.exceptionThrown')exceptions.push(value.params.exceptionDetails);
    const request=pending.get(value.id);if(!request)return;
    clearTimeout(request.timer);pending.delete(value.id);
    value.error?request.reject(Error(JSON.stringify(value.error))):request.resolve(value.result);
  });
  await once(socket,'open');
  const command=(method,params={})=>new Promise((resolve,reject)=>{
    const id=++next,timer=setTimeout(()=>{pending.delete(id);reject(Error('CDP request timeout: '+method));},REQUEST_TIMEOUT_MS);
    pending.set(id,{resolve,reject,timer});socket.send(JSON.stringify({id,method,params}));
  });
  const evaluate=async expression=>{
    const result=await command('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});
    if(result.exceptionDetails)throw Error(JSON.stringify(result.exceptionDetails));
    return result.result?.value;
  };
  await command('Runtime.enable');return {socket,evaluate,exceptions};
}
async function main(){
  assert.equal(process.platform,'win32','This smoke test exercises the packaged Windows executable');
  const input=path.resolve(process.argv[2]||'android-return');
  const scratch=await fs.mkdtemp(path.join(os.tmpdir(),'memotalk-packaged-peer-'));
  const profile=path.join(scratch,'profile'),vault=path.join(scratch,'vault'),operations=path.join(vault,P.DIRECTORY,'operations');
  await fs.mkdir(profile);await fs.mkdir(operations,{recursive:true});
  const group={format:'memotalk-peer-group',version:1,id:'cross-platform-integration'};
  await fs.writeFile(path.join(vault,P.GROUP_FILE),JSON.stringify(group));
  for(const name of await fs.readdir(input))if(/^[a-f0-9]{64}\.json$/.test(name))await fs.copyFile(path.join(input,name),path.join(operations,name));
  await fs.writeFile(path.join(profile,'native-folder.json'),JSON.stringify({folder:vault}));
  const port=await debuggerPort(),executable=path.resolve(process.argv[3]||'windows/dist/win-unpacked/MemoTalk.exe');
  await fs.access(executable);
  const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;
  const child=spawn(executable,['--user-data-dir='+profile,'--remote-debugging-port='+port,'--disable-gpu'],{windowsHide:true,env});
  let stderr='',connection;child.stderr.on('data',data=>{stderr+=data.toString();});
  const exited=once(child,'exit');
  try{
    const target=await until(async()=>{
      if(child.exitCode!==null)throw Error('Packaged app exited: '+stderr);
      const list=await(await fetch('http://127.0.0.1:'+port+'/json/list')).json();
      return list.find(tab=>tab.type==='page'&&tab.url.startsWith('memotalk://app/index.html'));
    });
    connection=await connect(target.webSocketDebuggerUrl);
    await until(()=>connection.evaluate("typeof window.MemoTalkPeer==='object'&&typeof window.MemoTalkFS==='object'"));
    const status=await connection.evaluate("window.MemoTalkNative.request('hasFolder')");
    assert.equal(status.ok,true);assert.equal(status.result.connected,true,'Native settings must come from isolated test profile');
    await connection.evaluate(`
      localStorage.setItem('memotalk.v1',JSON.stringify({seeded:true,rooms:{},msgs:{}}));
      localStorage.setItem('memotalk.nativeFolder.linkId',${JSON.stringify(group.id)});
      localStorage.setItem('memotalk.peer.config',JSON.stringify({enabled:true,groupId:${JSON.stringify(group.id)}}));
      localStorage.setItem('memotalk.peer.poll','200');localStorage.setItem('memotalk.peer.debounce','50');
      location.reload();true;
    `);
    await until(()=>connection.evaluate("Object.values(JSON.parse(localStorage.getItem('memotalk.v1')).msgs).flat().some(m=>m.text==='Android real WebView reply')"));
    assert.equal(await connection.evaluate("Object.values(JSON.parse(localStorage.getItem('memotalk.v1')).msgs).flat().some(m=>m.text==='Windows fixture edit')"),true);
    await connection.evaluate("document.querySelector('.room[data-id=pairedroom]').click();document.querySelector('#input').value='Windows packaged reply';document.querySelector('#input').dispatchEvent(new Event('input',{bubbles:true}));document.querySelector('#btn-send').click();true;");
    const outgoing=await until(async()=>{
      for(const name of await fs.readdir(operations)){
        if(!/^[a-f0-9]{64}\.json$/.test(name))continue;
        const op=JSON.parse(await fs.readFile(path.join(operations,name),'utf8'));
        if(op.value?.text==='Windows packaged reply'){await P.validate(op,group.id);return op;}
      }
      return false;
    });
    assert.ok(outgoing.actor!=='windows-fixture','Reply must be written by actual packaged app');
    assert.equal(connection.exceptions.length,0,JSON.stringify(connection.exceptions));
    console.log('PACKAGED WINDOWS PASS: actual Electron app/IPC received real Android revisions and published a valid reply using isolated data.');
  }catch(error){console.error(stderr.slice(-6000));throw error;}
  finally{
    connection?.socket.close();if(child.exitCode===null)child.kill();
    await Promise.race([exited,wait(EXIT_TIMEOUT_MS)]);
    assert.ok(path.resolve(scratch).startsWith(path.resolve(os.tmpdir())+path.sep));
    await fs.rm(scratch,{recursive:true,force:true,maxRetries:20,retryDelay:100}).catch(error=>console.warn('Synthetic profile cleanup deferred:',error.code));
  }
}
main().catch(error=>{console.error(error);process.exitCode=1;});
