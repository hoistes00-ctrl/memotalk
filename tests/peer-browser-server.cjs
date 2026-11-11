'use strict';
// Synthetic browser integration harness. No real vaults or user profiles are read.
const http=require('node:http');
const fs=require('node:fs/promises');
const path=require('node:path');
const os=require('node:os');
const {verifiedWrite}=require('../windows/verified-write');
const MAX_BODY=64*1024*1024;
async function start(){
  const root=process.env.MEMOTALK_TEST_ROOT||await fs.mkdtemp(path.join(os.tmpdir(),'memotalk-two-device-'));
  if(!path.resolve(root).startsWith(path.join(path.resolve(os.tmpdir()),'memotalk-two-device-')))throw Error('Only synthetic test directories are allowed');
  const devices={windows:{connected:false,online:true,lease:null,generation:0},android:{connected:false,online:true,lease:null,generation:0}};
  for(const name of Object.keys(devices)){await fs.mkdir(path.join(root,name),{recursive:true});try{await fs.access(path.join(root,name,'memotalk-peer-group.json'));devices[name].connected=true;}catch(_){}}
  async function filesAt(dir,prefix=''){
    const files=[];
    for(const item of await fs.readdir(path.join(dir,prefix),{withFileTypes:true})){
      if(item.name.startsWith('.'))continue;
      const rel=prefix?prefix+'/'+item.name:item.name;
      if(item.isDirectory())files.push(...await filesAt(dir,rel));else files.push(rel);
    }
    return files;
  }
  async function sync(){
    if(!devices.windows.online||!devices.android.online)return;
    for(const [from,to]of [['windows','android'],['android','windows']])for(const name of await filesAt(path.join(root,from))){
      const dest=path.join(root,to,name);try{await fs.stat(dest);continue;}catch(e){if(e.code!=='ENOENT')throw e;}
      await fs.mkdir(path.dirname(dest),{recursive:true});
      try{await verifiedWrite(dest,await fs.readFile(path.join(root,from,name)),null);}catch(e){if(!['EEXIST','ESTALE'].includes(e.code))throw e;}
    }
  }
  async function native(device,command,args){
    const d=devices[device];if(!d)throw Error('bad device');
    const status=()=>({connected:d.connected,name:'Synthetic '+device+' vault',folderToken:device+'-token-'+d.generation,atomicWrites:true});
    if(command==='reloadContext'){d.generation++;d.lease=null;return true;}
    if(command==='hasFolder')return status();
    if(command==='pickFolder'){d.connected=true;return status();}
    if(command==='disconnect'){d.connected=false;return true;}
    if(args.folderToken!==device+'-token-'+d.generation)throw Object.assign(Error('stale folder'),{code:'ESTALE'});
    if(command==='beginMirror'){if(d.lease)throw Object.assign(Error('busy'),{code:'EBUSY'});d.lease=device+'-lease';return {leaseId:d.lease};}
    if(d.lease&&args.leaseId!==d.lease)throw Object.assign(Error('busy'),{code:'EBUSY'});
    if(command==='endMirror'){d.lease=null;return true;}
    const parts=args.path||[];
    if(!Array.isArray(parts)||parts.some(p=>typeof p!=='string'||!p||p==='..'||p==='.'||/[\\/\0]/.test(p)))throw Error('bad path');
    const target=path.join(root,device,...parts);
    await sync();
    if(command==='stat'){
      try{const s=await fs.stat(target);return {exists:true,kind:s.isDirectory()?'directory':'file'};}catch(e){if(e.code==='ENOENT')return {exists:false};throw e;}
    }
    if(command==='mkdir'){await fs.mkdir(target,{recursive:false}).catch(e=>{if(e.code!=='EEXIST')throw e;});return {exists:true,kind:'directory'};}
    if(command==='list')return (await fs.readdir(target,{withFileTypes:true})).map(x=>({name:x.name,kind:x.isDirectory()?'directory':'file'}));
    if(command==='read')return {base64:(await fs.readFile(target)).toString('base64')};
    if(command==='write'){
      await verifiedWrite(target,Buffer.from(args.base64,'base64'),args.expectedBase64===null?null:Buffer.from(args.expectedBase64,'base64'));
      await sync();return true;
    }
    throw Error('unexpected command '+command);
  }
  let queue=Promise.resolve();
  const server=http.createServer(async(req,res)=>{
    const json=value=>{res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify(value));};
    try{
      const url=new URL(req.url,'http://localhost');
      if(req.method==='POST'){
        const chunks=[];let size=0;for await(const chunk of req){size+=chunk.length;if(size>MAX_BODY)throw Error('too large');chunks.push(chunk);}
        const body=JSON.parse(Buffer.concat(chunks).toString());
        if(url.pathname==='/control'){
          if(body.device)devices[body.device].online=body.online;
          await sync();return json({ok:true,devices});
        }
        if(url.pathname==='/native'){
          const work=queue.catch(()=>{}).then(async()=>{
            try{return {ok:true,result:await native(body.device,body.command,body.args||{})};}
            catch(e){return {ok:false,error:{message:e.message,code:e.code||'EIO',operation:e.operation||body.command,relativePath:(body.args?.path||[]).join('/'),syscall:e.syscall}};}
          });queue=work;return json(await work);
        }
      }
      const name=url.pathname.endsWith('/')?'index.html':url.pathname.split('/').at(-1);
      const allowed=['index.html','platform-bridge.js','mirror-engine.js','peer-sync-engine.js','peer-sync-client.js'];
      if(!allowed.includes(name)){res.writeHead(404);return res.end('Not found');}
      const data=await fs.readFile(path.join(__dirname,'..','shared',name));
      res.writeHead(200,{'content-type':name.endsWith('.js')?'application/javascript':'text/html; charset=utf-8'});res.end(data);
    }catch(e){res.writeHead(500);res.end(e.message);}
  });
  await new Promise(resolve=>server.listen(Number(process.env.MEMOTALK_TEST_PORT||0),'127.0.0.1',resolve));
  return {server,root,port:server.address().port};
}
if(require.main===module)start().then(({port,root})=>console.log(JSON.stringify({port,root}))).catch(e=>{console.error(e);process.exitCode=1;});
module.exports={start};
