/* Synthetic data only. Inject before the UI loads; never used by production. */
(() => {
  const tree=new Map([['',{kind:'directory'}]]);
  const fixture=window.__mirrorFixture={tree,failPath:null,connected:false};
  const enc=data=>btoa(Array.from(data,b=>String.fromCharCode(b)).join(''));
  window.MemoTalkNative={async request(command,args={}){
    const key=(args.path||[]).join('/');
    try{
      let result;
      if(command==='hasFolder')result={connected:fixture.connected,name:'Synthetic vault',folderToken:'test-token'};
      else if(command==='pickFolder'){fixture.connected=true;result={connected:true,name:'Synthetic vault',folderToken:'test-token'};}
      else if(command==='disconnect'){fixture.connected=false;result=true;}
      else if(command==='beginMirror')result={leaseId:'test-lease'};
      else if(command==='endMirror')result=true;
      else if(command==='stat')result=tree.has(key)?{exists:true,kind:tree.get(key).kind}:{exists:false};
      else if(command==='mkdir'){
        if(!tree.has(key))tree.set(key,{kind:'directory'});
        result={exists:true,kind:tree.get(key).kind};
      }
      else if(command==='list')result=[...tree].filter(([p])=>p&&p.split('/').slice(0,-1).join('/')===key)
        .map(([p,item])=>({name:p.split('/').pop(),kind:item.kind}));
      else if(command==='read'){
        if(!tree.has(key))throw Object.assign(Error('missing'),{code:'ENOENT'});
        result={base64:enc(tree.get(key).data)};
      }
      else if(command==='write'){
        if(fixture.failPath===key)throw Object.assign(Error('synthetic lock'),{code:'EPERM',syscall:'rename',operation:'commit'});
        const current=tree.has(key)?enc(tree.get(key).data):null;
        if(current!==args.expectedBase64)throw Object.assign(Error('changed'),{code:'ESTALE'});
        tree.set(key,{kind:'file',data:Uint8Array.from(atob(args.base64),c=>c.charCodeAt(0))});result=true;
      }
      else if(command==='download')result=true;
      else throw Error('Unexpected fixture command: '+command);
      return {ok:true,result};
    }catch(error){return {ok:false,error:{message:error.message,code:error.code,syscall:error.syscall,operation:error.operation||command,relativePath:key}};}
  }};
})();
