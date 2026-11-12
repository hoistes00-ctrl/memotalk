/* UI/storage adapter for the immutable device-sharing engine. */
(function(root,factory){
  if(typeof module==='object'&&module.exports)module.exports=factory();
  else root.MemoTalkPeerClient=factory();
})(typeof globalThis==='object'?globalThis:this,function(){
  'use strict';
  // App defaults (no library default). Higher = less frequent scans / slower edit publication.
  const POLL_DEFAULT=3000,DEBOUNCE_DEFAULT=400;
  // Browser timer bounds; higher permits longer waits. Zero schedules the next task.
  const TIMER_MIN=0,TIMER_MAX=2147483647;
  // Number input default increment, in milliseconds; higher makes adjustments coarser.
  const TIMER_STEP=1;
  // Custom display defaults (no library defaults): higher shows longer memo/actor previews.
  const HISTORY_PREVIEW_CHARS=100,ACTOR_PREVIEW_CHARS=8,ROOM_PREVIEW_CHARS=120;
  const DB='memotalk-peer-sync-v1',CONFIG='memotalk.peer.config',ACTOR='memotalk.peer.actor';
  const encoder=new TextEncoder(),decoder=new TextDecoder('utf-8',{fatal:true});
  const clone=value=>structuredClone(value);
  const error=(code,path='')=>Object.assign(new Error(code),{code,relativePath:path});
  const same=(a,b)=>a!==null&&b!==null&&a.length===b.length&&a.every((x,i)=>x===b[i]);
  async function stateStore(groupId,value){
    const db=await new Promise((resolve,reject)=>{
      const request=indexedDB.open(DB,1);
      request.onupgradeneeded=()=>request.result.createObjectStore('groups');
      request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);
      request.onblocked=()=>reject(error('peer_database_busy'));
    });
    try{return await new Promise((resolve,reject)=>{
      const write=value!==undefined,tx=db.transaction('groups',write?'readwrite':'readonly');
      const request=write?tx.objectStore('groups').put(value,groupId):tx.objectStore('groups').get(groupId);
      let result;request.onsuccess=()=>{result=request.result;};
      tx.oncomplete=()=>resolve(result);tx.onerror=tx.onabort=()=>reject(tx.error||error('peer_database'));
    });}finally{db.close();}
  }
  function create(options){
    const P=options.engine||window.MemoTalkPeer;
    const settings={poll:POLL_DEFAULT,debounce:DEBOUNCE_DEFAULT};
    for(const key of Object.keys(settings)){
      const value=localStorage.getItem('memotalk.peer.'+key);
      if(value!==null&&Number.isFinite(Number(value)))settings[key]=Math.max(TIMER_MIN,Math.min(TIMER_MAX,Number(value)));
    }
    const client={active:false,busy:false,root:null,groupId:null,replica:null,timer:null,last:null};
    const getBackend=()=>{
      const backend=options.backend();
      if(backend?.mode!=='local'||!backend.peerSnapshot||!backend.peerCommit)throw error('peer_local_backend_required');
      return backend;
    };
    const load=()=>stateStore(client.groupId);
    const save=value=>stateStore(client.groupId,value);
    const read=path=>options.read(client.root,path);
    const transport={
      async read(path){return read(path);},
      async put(path,data){
        if(path.startsWith(P.DIRECTORY+'/operations/')){
          const note=P.readable(JSON.parse(decoder.decode(data)));
          if(note)await transport.put(note.path,note.data);
        }
        const existing=await read(path);
        if(existing!==null){if(!same(existing,data))throw error('peer_immutable_conflict',path);return;}
        await options.write(client.root,path,data,null);
        if(!same(await read(path),data))throw error('peer_write_verify',path);
      },
      async list(path){
        try{
          const dir=await options.folder(client.root,path.split('/'),false),names=[];
          for await(const item of dir.values())if(item.kind==='file')names.push(item.name);
          return names.sort();
        }catch(e){if(e.name==='NotFoundError')return [];throw e;}
      }
    };
    async function imageToWire(image,assets){
      const data=await options.imageData(image),match=/^data:(image\/(?:png|jpeg|gif|webp|bmp));base64,([\s\S]+)$/.exec(data||'');
      if(!match)throw error('peer_image_format');
      const binary=atob(match[2]),bytes=Uint8Array.from(binary,c=>c.charCodeAt(0)),sha256=await P.hash(bytes);
      const path=P.assetPath(sha256,match[1]);assets[path]=bytes;
      return {sha256,path,mime:match[1],...(image.w?{w:image.w}:{}),...(image.h?{h:image.h}:{})};
    }
    async function capture(){
      const snapshot=getBackend().peerSnapshot(),records=[],assets={};
      for(const room of Object.values(snapshot.data.rooms)){
        if(room.peerConflict)continue;
        records.push({entity:{kind:'room',id:room.id},value:clone(room)});
      }
      for(const [rid,messages]of Object.entries(snapshot.data.msgs))for(const msg of messages){
        if(msg.peerConflict)continue;
        const value=clone(msg);
        if(value.images?.length){value.images=[];for(const image of msg.images)value.images.push(await imageToWire(image,assets));}
        records.push({entity:{kind:'msg',rid,id:msg.id},value});
      }
      return {token:snapshot.token,records,assets,presentation:snapshot.data.peerPresentations?.[client.groupId]};
    }
    async function hydrate(value){
      const next=clone(value);
      if(next.images?.length){
        next.images=[];
        for(const image of value.images){
          const data=await read(image.path);
          if(data===null||await P.hash(data)!==image.sha256)throw error('peer_attachment_pending',image.path);
          let binary='';for(const byte of data)binary+=String.fromCharCode(byte);
          next.images.push({data:'data:'+image.mime+';base64,'+btoa(binary),...(image.w?{w:image.w}:{}),...(image.h?{h:image.h}:{})});
        }
      }
      return next;
    }
    async function apply(token,records,conflicts,presentation){
      if(options.editing())throw error('peer_edit_in_progress');
      const previous=getBackend().peerSnapshot(),rooms={},msgs={};
      // Keep every derived conflict copy, including already-resolved versions.
      for(const room of Object.values(previous.data.rooms))if(room.peerConflict)rooms[room.id]=clone(room);
      for(const [rid,list]of Object.entries(previous.data.msgs)){
        const copies=list.filter(m=>m.peerConflict).map(clone);if(copies.length)msgs[rid]=copies;
      }
      for(const record of Object.values(records)){
        if(record.entity.kind==='room')rooms[record.entity.id]=clone(record.value);
        else (msgs[record.entity.rid]||=[]).push(await hydrate(record.value));
      }
      for(const conflict of conflicts){
        const selected=conflict.variants.find(op=>op.id===conflict.selected);
        if(selected.entity.kind!=='msg')continue;
        const rid=selected.entity.rid,archive=options.archiveRoomId(rid);
        rooms[archive]||={id:archive,kind:'archive',name:'동기화 충돌 보관함',createdAt:Date.now(),peerConflict:true};
        const list=msgs[archive]||=[],known=new Set(list.map(m=>m.id));
        const original=(msgs[rid]||[]).find(m=>m.id===selected.entity.id);
        const refs=[];
        for(const variant of conflict.variants){
          const id='peer_'+variant.id;refs.push({id,createdAt:variant.value?.ts||0});
          if(known.has(id))continue;
          const value=variant.value?await hydrate(variant.value):{text:'[다른 기기에서 삭제한 버전]',images:[],ts:original?.ts||0};
          list.push({...value,id,peerConflict:true,sourceMemoId:selected.entity.id,sourceTs:value.ts,
            ts:value.ts||0,archivedAt:value.edited||value.ts||0,incomingText:original?.text||'',
            incomingImageCount:original?.images?.length||0,imageChanged:P.canonical(value.images||[])!==P.canonical(original?.images||[]),peerRevision:variant.id,peerActor:variant.actor});
        }
        if(original)original.conflicts=[...(original.conflicts||[]).filter(ref=>!String(ref.id).startsWith('peer_')),...refs];
      }
      // Never discard live messages merely because their room deletion arrived first.
      for(const [rid,list]of Object.entries(msgs))if(list.length&&!rooms[rid]){
        rooms[rid]={id:rid,name:'받은 메모 · 메모방 복원 대기',createdAt:0,peerConflict:true};
      }
      for(const room of Object.values(rooms)){
        if(room.kind==='folder'&&room.parentId){
          const seen=new Set([room.id]);let parent=room.parentId;
          while(parent&&rooms[parent]){
            if(seen.has(parent))throw error('peer_folder_cycle',room.id);
            seen.add(parent);parent=rooms[parent].parentId;
          }
        }
        const list=(msgs[room.id]||[]).sort((a,b)=>a.ts-b.ts),last=list.at(-1);
        room.last=last?String(last.text||'').slice(0,ROOM_PREVIEW_CHARS):'';
        room.updatedAt=last?.edited||last?.ts||room.createdAt||0;
      }
      // Recheck editing after asynchronous attachment reads as well as the storage token.
      if(options.editing())throw error('peer_edit_in_progress');
      await getBackend().peerCommit(token,rooms,msgs,client.groupId,presentation);
      options.applied?.();
    }
    function schedule(delay=settings.debounce){
      clearTimeout(client.timer);
      if(client.active)client.timer=setTimeout(()=>run().catch(()=>{}),delay);
    }
    async function run(){
      if(!client.active||client.busy)return;
      if(!options.ready()){schedule(settings.poll);return;}
      client.busy=true;
      const root=client.root;
      const task=async()=>{
        await window.MemoTalkFS?.beginMirror?.(root);
        try{
          const groupBytes=await read(P.GROUP_FILE),group=groupBytes&&JSON.parse(decoder.decode(groupBytes));
          if(group?.id!==client.groupId||group.format!=='memotalk-peer-group'||group.version!==P.VERSION)throw error('peer_group_changed',P.GROUP_FILE);
          const result=await client.replica.tick();client.last=result;
          const waiting=result.pending+(result.blocked?.length||0);
          options.status(waiting?'pending':'saved',`${root.name} · 양방향 주기 처리 · 이력 ${result.revisions||0}개 · 충돌 ${result.conflicts}건${waiting?' · 수신 미완료 '+waiting+'건':''} · 원격 전송 상태는 Obsidian 확인`);
        }finally{await window.MemoTalkFS?.endMirror?.(root);}
      };
      try{
        if(navigator.locks?.request)await navigator.locks.request('memotalk-peer-'+client.groupId,{ifAvailable:true},async lock=>{if(lock)await task();});
        else if(window.MemoTalkFS)await task();
        else throw error('peer_lock_unavailable');
      }catch(e){
        client.lastError={code:e.code||e.message,operation:e.operation||'peer-cycle',relativePath:e.relativePath||'',errno:e.errno,syscall:e.syscall,nativeMessage:e.nativeMessage,message:e.message,at:new Date().toISOString()};
        try{localStorage.setItem('memotalk.fileMirror.lastError',JSON.stringify(client.lastError));}catch(_){}
        const pending=['peer_edit_in_progress','peer_attachment_pending','peer_stale','peer_busy','EBUSY'].includes(client.lastError.code);
        options.status(pending?'pending':'error',`공유 ${pending?'대기':'중단'} · ${client.lastError.code} · ${client.lastError.relativePath}`);
      }finally{client.busy=false;schedule(settings.poll);}
    }
    async function activate(root,group){
      getBackend();
      if(group?.format!=='memotalk-peer-group'||group.version!==P.VERSION||!/^[a-zA-Z0-9_-]{1,256}$/.test(group.id))throw error('peer_group');
      let actor=localStorage.getItem(ACTOR);if(!actor){actor=crypto.randomUUID();localStorage.setItem(ACTOR,actor);}
      client.root=root;client.groupId=group.id;
      client.replica=new P.Replica({groupId:group.id,actor,load,save,capture,apply,transport});
      localStorage.setItem(CONFIG,JSON.stringify({groupId:group.id,enabled:true}));
      await options.remember(root,group.id);client.active=true;
      options.status('pending',root.name+' · 양방향 공유 연결됨');schedule();
    }
    async function connect(createGroup){
      if(client.busy)return options.toast('공유 처리 중입니다. 완료 후 다시 선택하세요.');
      try{
        getBackend();
        if(!await options.ask({title:createGroup?'새 공유 그룹 만들기':'기존 공유 그룹 참여',body:'처음에는 양쪽 메모를 합쳐 표시하고, 이후 추가·수정·삭제를 두 기기에 반영합니다. 충돌 원문과 삭제 전 이력은 보존하며, 앱이 열린 동안 자동 반영합니다. 두 기기에서 Obsidian Sync의 Sync all other types를 켜야 합니다. 휴대폰이나 컴퓨터 중 한 기기에서만 새 그룹을 만드세요. 다른 기기는 Obsidian Sync로 내려온 같은 폴더에 참여합니다. 이미 다른 기기에서 시작했다면 새 그룹을 만들지 말고 참여하세요. 기존 파일은 수정·삭제하지 않습니다.',ok:'폴더 선택'}))return;
        // The native picker changes the selected root even when group validation later fails.
        // Stop legacy writers before opening it; never resume them into an unverified root.
        await options.pauseLegacy?.();
        const root=await window.showDirectoryPicker({mode:'readwrite'});
        if(!await options.permission(root,true))throw error('peer_permission');
        client.root=root;
        const existing=await read(P.GROUP_FILE);
        let group=existing?JSON.parse(decoder.decode(existing)):null;
        if(!group){
          if(!createGroup){
            const folderCheck={selectedFolder:root.name,expectedFileListed:false,sharingDirectoryListed:false};
            try{
              for await(const entry of root.values()){
                if(entry.name===P.GROUP_FILE)folderCheck.expectedFileListed=true;
                if(entry.name===P.DIRECTORY&&entry.kind==='directory')folderCheck.sharingDirectoryListed=true;
              }
              folderCheck.listSucceeded=true;
            }catch(listError){folderCheck.listSucceeded=false;folderCheck.listErrorCode=listError.code||listError.name;}
            throw Object.assign(error(folderCheck.expectedFileListed?'peer_group_read_unavailable':'peer_group_not_downloaded',P.GROUP_FILE),{folderCheck});
          }
          group={format:'memotalk-peer-group',version:P.VERSION,id:crypto.randomUUID()};
          await transport.put(P.GROUP_FILE,encoder.encode(P.canonical(group)));
        }
        await activate(root,group);
      }catch(e){
        if(e.name==='AbortError')return;
        client.lastError={code:e.code||e.message,operation:e.operation||'peer-connect',relativePath:e.relativePath||'',selectedFolder:client.root?.name||'',folderCheck:e.folderCheck,errno:e.errno,syscall:e.syscall,nativeMessage:e.nativeMessage,message:e.message,at:new Date().toISOString()};
        try{localStorage.setItem('memotalk.fileMirror.lastError',JSON.stringify(client.lastError));}catch(_){}
        const message=e.code==='peer_group_not_downloaded'
          ? '공유 그룹 파일이 없어요. 처음 시작한다면 이 기기에서 새 공유 그룹 만들기를 선택하세요. 다른 기기에서 이미 만들었다면 Obsidian Sync로 같은 폴더가 내려올 때까지 기다리세요. 내부 메모와 기존 파일은 유지됩니다.'
          : e.code==='peer_group_read_unavailable'
            ? '그룹 파일이 선택한 폴더 목록에는 있지만 읽을 수 없어요. 공유 오류 진단에서 선택한 폴더와 읽기 상태를 확인하세요. 기존 파일은 유지됩니다.'
            : '공유 연결 실패 · '+(e.code||e.message);
        options.status('error',message);options.toast(message,true);
      }
    }
    async function restore(root){
      let config;try{config=JSON.parse(localStorage.getItem(CONFIG)||'null');}catch(_){}
      if(!config?.enabled)return;
      if(!root){options.status('error','공유 폴더 권한을 다시 연결하세요.');return;}
      try{
        client.root=root;const data=await read(P.GROUP_FILE),group=data&&JSON.parse(decoder.decode(data));
        if(group?.id!==config.groupId)throw error('peer_group_changed');
        await activate(root,group);
      }catch(e){options.status('error','공유 연결 복원 실패 · '+(e.code||e.message));}
    }
    async function disconnect(){
      if(client.busy)return options.toast('공유 처리 후 다시 시도하세요.');
      clearTimeout(client.timer);client.active=false;
      localStorage.removeItem(CONFIG);await options.disconnect();
    }
    function showSettings(){
      const fields=[['poll','공유 폴더 확인 간격'],['debounce','수정 후 공유 대기 시간']];
      const sheet=options.openScrim('<h2>양방향 공유 속도</h2>'+fields.map(([key,label])=>`<p><label>${label} (ms) <input data-peer="${key}" type="number" min="${TIMER_MIN}" max="${TIMER_MAX}" step="${TIMER_STEP}" value="${settings[key]}"></label> <output data-value="${key}">${settings[key]} ms</output> <button data-reset="${key}">↺</button></p>`).join('')+'<p>메모톡이 열린 동안 적용됩니다. 두 기기의 Obsidian도 실행 중이어야 전송됩니다. 종료·절전 상태에서는 전달이 지연될 수 있습니다.</p>');
      const set=(key,value)=>{if(!Number.isFinite(value)||value<TIMER_MIN||value>TIMER_MAX)return;
        settings[key]=value;localStorage.setItem('memotalk.peer.'+key,String(value));sheet.querySelector('[data-value="'+key+'"]').textContent=value+' ms';schedule();};
      sheet.querySelectorAll('[data-peer]').forEach(input=>input.oninput=()=>{if(input.value!=='')set(input.dataset.peer,Number(input.value));});
      sheet.querySelectorAll('[data-reset]').forEach(button=>button.onclick=()=>{const key=button.dataset.reset,value=key==='poll'?POLL_DEFAULT:DEBOUNCE_DEFAULT;sheet.querySelector('[data-peer="'+key+'"]').value=value;set(key,value);localStorage.removeItem('memotalk.peer.'+key);});
    }
    async function showHistory(){
      if(!client.active)return options.toast('공유 폴더를 먼저 연결하세요.');
      const state=await load();if(!state)return options.toast('아직 공유 이력이 없습니다.');
      const view=P.project(state),operations=Object.values(state.operations).sort((a,b)=>a.id.localeCompare(b.id));
      const esc=options.esc;
      const sheet=options.openScrim('<h2>공유 변경 이력 · 두 버전 보존</h2><p>충돌 '+view.conflicts.length+'건. 각 버전은 삭제되지 않습니다. 선택한 내용을 복원하면 새 변경 이력이 만들어집니다.</p>'+operations.map(op=>`<details><summary>${esc(op.entity.kind==='room'?(op.value?.name||'삭제된 메모방'):(op.value?.text||'(사진 또는 삭제)').slice(0,HISTORY_PREVIEW_CHARS))} · ${esc(op.actor===state.actor?'이 기기':'다른 기기 '+op.actor.slice(0,ACTOR_PREVIEW_CHARS))}</summary><pre style="white-space:pre-wrap;overflow-wrap:anywhere">${esc(op.value===null?'삭제한 버전':op.entity.kind==='room'?'이름: '+op.value.name:String(op.value.text||'(텍스트 없음)'))}</pre>${op.value?.comments?.length?'<p>댓글 '+op.value.comments.length+'개</p>':''}${op.value?.images?.length?'<p>사진 '+op.value.images.length+'장</p>':''}<button data-restore="${op.id}">이 버전으로 복원${op.value===null?' (삭제)':''}</button></details>`).join(''));
      sheet.querySelectorAll('[data-restore]').forEach(button=>button.onclick=async()=>{
        const op=state.operations[button.dataset.restore];options.closeSheet();
        if(!await options.ask({title:'이 버전으로 복원할까요?',body:'현재 버전과 기존 이력은 모두 남습니다. 선택한 내용을 새 변경으로 두 기기에 전달합니다.',ok:'복원'}))return;
        try{if(navigator.locks?.request)await navigator.locks.request('memotalk-peer-'+client.groupId,()=>client.replica.resolve(P.entityKey(op.entity),op.id));else await client.replica.resolve(P.entityKey(op.entity),op.id);schedule(TIMER_MIN);}catch(e){options.toast('복원 대기 · '+(e.code||e.message),true);}
      });
    }
    function diagnostics(){
      let record=client.lastError;try{record ||= JSON.parse(localStorage.getItem('memotalk.fileMirror.lastError')||'null');}catch(_){}
      options.openScrim('<h2>공유 오류 진단</h2><p>경로에 개인 정보가 포함될 수 있습니다.</p><pre style="white-space:pre-wrap;overflow-wrap:anywhere">'+options.esc(record?JSON.stringify(record,null,2):'기록된 공유 오류 없음')+'</pre>');
    }
    function menu(){
      const items=client.active?[
        {icon:'save',label:'지금 양방향 공유 확인',run:()=>run()},
        {icon:'edit',label:'공유 확인·반영 간격 조절',run:showSettings},
        {icon:'load',label:'공유 충돌·변경 이력 보기',run:showHistory},
        {icon:'load',label:'공유 오류 진단',run:diagnostics},
        {icon:'close',label:'기기 간 공유 연결 해제 (파일 유지)',run:disconnect}
      ]:[
        {icon:'folder',label:'이 기기에서 새 공유 그룹 만들기',run:()=>connect(true)},
        {icon:'folder',label:'다른 기기의 공유 그룹 참여',run:()=>connect(false)},
        {icon:'load',label:'공유 오류 진단',run:diagnostics},
        {icon:'edit',label:'공유 확인·반영 간격 조절',run:showSettings}
      ];
      options.menu('Windows ↔ Android 양방향 공유',items,'두 기기에서 같은 Obsidian vault 하위 폴더를 선택하세요. 메모톡 앱 사이의 변경을 주고받습니다. 충돌 시 두 원문을 보존합니다. Obsidian에서 Markdown을 직접 수정한 내용의 자동 가져오기는 별도 기능입니다.');
    }
    Object.assign(client,{schedule,run,restore,menu,connect,disconnect,showHistory});
    document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='visible')schedule(TIMER_MIN);});
    return client;
  }
  return {create,stateStore};
});
