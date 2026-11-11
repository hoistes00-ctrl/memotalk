/* Test-only bridge bootstrap, loaded into separate Windows/Android browser profiles. */
(() => {
  if(!/^https?:$/.test(location.protocol))return;
  const device=location.pathname.includes('/android/')?'android':'windows';
  if(!localStorage.getItem('peer-test-seeded')){
    localStorage.clear();
    localStorage.setItem('memotalk.v1',JSON.stringify({seeded:true,
      rooms:{room1:{id:'room1',name:'공유 테스트',createdAt:1}},
      msgs:{room1:[{id:device==='windows'?'winmemo':'phonememo',ts:1,text:device==='windows'?'윈도우 원문':'휴대폰 원문'}]}}));
    localStorage.setItem('peer-test-seeded','true');
    localStorage.setItem('memotalk.peer.poll','200');
    localStorage.setItem('memotalk.peer.debounce','50');
  }
  const rpc=async(command,args={})=>(await fetch('/native',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({device,command,args})})).json();
  const ready=rpc('reloadContext');
  const request=async(command,args)=>{await ready;return rpc(command,args);};
  if(device==='windows')window.MemoTalkNative={request};
  else window.AndroidMemoTalk={postMessage(payload){
    const {id,command,args,session}=JSON.parse(payload);
    request(command,args).then(r=>window.__memoNativeResolve({id,session,result:r.result,error:r.error}));
  }};
})();
