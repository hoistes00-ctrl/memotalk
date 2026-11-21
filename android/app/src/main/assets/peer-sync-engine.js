/* Immutable, content-addressed multi-value registers for device-to-device sync.
   Transport never replaces or deletes a revision; clocks never choose a winner. */
(function(root,factory){
  if(typeof module==='object'&&module.exports)module.exports=factory();
  else root.MemoTalkPeer=factory();
})(typeof globalThis==='object'?globalThis:this,function(){
  'use strict';
  // Protocol version 1; changing this requires a migration, not a UI adjustment.
  const VERSION=1;
  // Defensive protocol limits, independent of polling or interaction timing.
  const MAX_OPERATION_BYTES=4*1024*1024,MAX_PARENTS=1024,MAX_OPERATIONS=100000;
  // Durable receive batch size (backend default). Lower = less restart work, more local writes.
  const RECEIVE_CHECKPOINT_OPERATIONS=32;
  // Backend fairness default: lower = more frequent receives between outgoing writes.
  const PUBLICATION_BATCH_DEFAULT=4;
  const GROUP_FILE='memotalk-peer-group.json',DIRECTORY='memotalk-peer-v1';
  const HASH=/^[a-f0-9]{64}$/;
  const ID=/^[a-zA-Z0-9_-]{1,256}$/;
  const validId=value=>typeof value==='string'&&ID.test(value)&&!['__proto__','constructor','prototype'].includes(value);
  const encoder=new TextEncoder();
  const clone=value=>JSON.parse(JSON.stringify(value));
  function canonical(value){
    if(value===null||typeof value!=='object')return JSON.stringify(value);
    if(Array.isArray(value))return '['+value.map(x=>canonical(x)??'null').join(',')+']';
    return '{'+Object.keys(value).sort().filter(k=>value[k]!==undefined).map(k=>JSON.stringify(k)+':'+canonical(value[k])).join(',')+'}';
  }
  async function hash(value){
    const data=value instanceof Uint8Array?value:encoder.encode(canonical(value));
    return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',data)),b=>b.toString(16).padStart(2,'0')).join('');
  }
  const fail=(code,path='')=>Object.assign(new Error(code),{code,relativePath:path});
  function assetPath(sha256,mime){
    const extension={'image/png':'png','image/jpeg':'jpg','image/gif':'gif','image/webp':'webp','image/bmp':'bmp'}[mime];
    if(!HASH.test(sha256)||!extension)throw fail('peer_image');
    return DIRECTORY+'/assets/'+sha256+'.'+extension;
  }
  function entityKey(entity){
    if(!entity||!['room','msg'].includes(entity.kind)||!validId(entity.id)||entity.kind==='msg'&&!validId(entity.rid))throw fail('peer_entity');
    return canonical(entity.kind==='room'?['room',entity.id]:['msg',entity.rid,entity.id]);
  }
  function normalizedRecord(record){
    const entity=clone(record.entity),key=entityKey(entity),value=clone(record.value);
    if(value===null)return {key,entity,value};
    if(!value||Array.isArray(value)||typeof value!=='object'||value.id!==entity.id)throw fail('peer_value');
    if(entity.kind==='room'){
      if(typeof value.name!=='string'||value.kind&&!['folder','archive'].includes(value.kind))throw fail('peer_room');
      if(value.peerMergedRooms!==undefined&&(!Array.isArray(value.peerMergedRooms)||value.kind||
        value.peerMergedRooms.some(id=>!validId(id)||id===entity.id)||new Set(value.peerMergedRooms).size!==value.peerMergedRooms.length))throw fail('peer_room_merge');
      delete value.last;delete value.updatedAt;
    }else{
      if(typeof(value.text??'')!=='string'||!Number.isFinite(value.ts))throw fail('peer_message');
      if(value.images!==undefined&&(!Array.isArray(value.images)||value.images.some(im=>!im||!HASH.test(im.sha256)||
          im.path!==assetPath(im.sha256,im.mime))))throw fail('peer_image');
      if(value.comments!==undefined&&(!Array.isArray(value.comments)||value.comments.some(c=>!c||!ID.test(c.id)||typeof c.text!=='string'||!Number.isFinite(c.ts))))throw fail('peer_comments');
      if(value.peerMergeOrigins!==undefined&&(!Array.isArray(value.peerMergeOrigins)||!value.peerMergeOrigins.length||
        value.peerMergeOrigins.some(origin=>!origin||!validId(origin.rid)||!validId(origin.id))||
        new Set(value.peerMergeOrigins.map(canonical)).size!==value.peerMergeOrigins.length))throw fail('peer_memo_merge');
      if(Array.isArray(value.conflicts)){
        value.conflicts=value.conflicts.filter(ref=>!String(ref.id).startsWith('peer_'));
        if(!value.conflicts.length)delete value.conflicts;
      }
      delete value.peerConflict;
    }
    return {key,entity,value};
  }
  function normalize(records){
    const out={};
    for(const record of records){
      if(record.value?.peerConflict)continue;
      const item=normalizedRecord(record);
      if(Object.hasOwn(out,item.key))throw fail('peer_duplicate_entity');
      out[item.key]={entity:item.entity,value:item.value};
    }
    return out;
  }
  async function fingerprints(records){
    const out={};for(const [key,item]of Object.entries(records))out[key]=await hash(item.value);return out;
  }
  function newState(groupId,actor){
    if(!ID.test(groupId)||!ID.test(actor))throw fail('peer_identity');
    return {format:'memotalk-peer-state',version:VERSION,groupId,actor,operations:{},baseline:{},baseHeads:{},outbox:[],assets:{},pending:null};
  }
  async function operation(groupId,actor,record,parents=[],salt=crypto.randomUUID()){
    const item=normalizedRecord(record);
    const core={format:'memotalk-peer-operation',version:VERSION,groupId,actor,
      entity:item.entity,parents:[...new Set(parents)].sort(),value:item.value,salt};
    const op={...core,id:await hash(core)};await validate(op,groupId);return op;
  }
  async function validate(op,groupId){
    if(!op||op.format!=='memotalk-peer-operation'||op.version!==VERSION||op.groupId!==groupId||
       !ID.test(op.groupId)||!ID.test(op.actor)||!ID.test(op.salt)||!HASH.test(op.id)||!Array.isArray(op.parents)||
       op.parents.length>MAX_PARENTS||op.parents.some(p=>!HASH.test(p))||new Set(op.parents).size!==op.parents.length)throw fail('peer_operation');
    const item=normalizedRecord(op);
    if(canonical(item.value)!==canonical(op.value))throw fail('peer_noncanonical');
    const {id,...core}=op;
    if(encoder.encode(canonical(op)).length>MAX_OPERATION_BYTES||await hash(core)!==id)throw fail('peer_integrity',id||'');
    return op;
  }
  function project(state){
    const operations=state.operations,ready=new Set(),pending=new Set();
    if(Object.keys(operations).length>MAX_OPERATIONS)throw fail('peer_history_limit');
    // Linear topological traversal: arrival order must not turn a long edit history
    // into repeated scans or recursive stack growth.
    const dependencies=new Map(),children=new Map(),queue=[];
    for(const [id,op]of Object.entries(operations)){
      const key=entityKey(op.entity);dependencies.set(id,op.parents.length);
      for(const parent of op.parents){
        if(operations[parent]&&entityKey(operations[parent].entity)!==key)throw fail('peer_parent_entity',id);
        if(!children.has(parent))children.set(parent,[]);
        children.get(parent).push(id);
      }
      if(!op.parents.length)queue.push(id);
    }
    for(let position=0;position<queue.length;position++){
      const id=queue[position];ready.add(id);
      for(const child of children.get(id)||[]){
        const left=dependencies.get(child)-1;dependencies.set(child,left);if(left===0)queue.push(child);
      }
    }
    for(const id of Object.keys(operations))if(!ready.has(id))pending.add(id);
    const removed=new Set();
    for(const id of ready)for(const parent of operations[id].parents)removed.add(parent);
    const heads={};
    for(const id of ready)if(!removed.has(id)){
      const op=operations[id],key=entityKey(op.entity);
      (heads[key]||=[]).push(id);
    }
    const records={},conflicts=[];
    for(const [key,ids]of Object.entries(heads)){
      ids.sort();const variants=ids.map(id=>operations[id]);
      const active=variants.filter(op=>op.value!==null);
      // Deterministic display only. Every concurrent variant remains in history.
      const selected=(active.length?active:variants).at(-1);
      if(selected.value!==null)records[key]={entity:clone(selected.entity),value:clone(selected.value)};
      const unique=new Set(variants.map(op=>canonical(op.value)));
      if(unique.size>1)conflicts.push({key,heads:[...ids],selected:selected.id,variants:clone(variants)});
    }
    // A restored old snapshot must not erase an established room identity.
    // Alias facts are monotonic across the immutable, causally ready history.
    const roomAliases={};
    for(const id of ready){const op=operations[id];
      if(op.entity.kind==='room'&&op.value?.peerMergedRooms?.length){
        roomAliases[op.entity.id]=[...new Set([...(roomAliases[op.entity.id]||[]),...op.value.peerMergedRooms])].sort();
      }
    }
    return {records,heads,conflicts,pending:[...pending],roomAliases};
  }
  // Zero denotes an unknown creation time. Identity inference requires a known time.
  const UNKNOWN_CREATION_TIME=0;
  const knownTime=value=>Number.isFinite(value)&&value>UNKNOWN_CREATION_TIME;
  const roomTitle=value=>value.normalize('NFC').trim().replace(/\s+/g,' ').replace(/ \(불러옴\)$/,'');
  function mergeOrigins(item){
    return item.value.peerMergeOrigins||[{rid:item.entity.rid,id:item.entity.id}];
  }
  function memoIdentity(value){
    const copy=clone(value);
    for(const key of ['id','comments','edited','peerMergeOrigins','conflicts'])delete copy[key];
    copy.text=copy.text||'';copy.images=copy.images||[];
    for(const image of copy.images){delete image.w;delete image.h;}
    return canonical(copy);
  }
  async function mergeComments(items){
    const byContent=new Map();
    for(const item of items)for(const comment of item.value.comments||[]){
      const value=clone(comment);delete value.id;delete value.edited;
      const key=canonical(value),group=byContent.get(key)||new Map();byContent.set(key,group);
      const source=entityKey(item.entity),list=group.get(source)||new Map();group.set(source,list);
      const previous=list.get(comment.id);
      if(!previous||(Number(comment.edited)||0)>(Number(previous.edited)||0))list.set(comment.id,comment);
    }
    const result=[],used=new Set();
    for(const [key,group]of [...byContent].sort(([a],[b])=>a<b?-1:a>b?1:0)){
      const lists=[...group.values()].map(list=>[...list.values()].sort((a,b)=>a.id<b.id?-1:a.id>b.id?1:0));
      const count=Math.max(...lists.map(list=>list.length));
      for(let index=0;index<count;index++){
        const copies=lists.flatMap(list=>list[index]?[list[index]]:[]).sort((a,b)=>a.id<b.id?-1:a.id>b.id?1:0);
        const value=clone(copies[0]);
        if(used.has(value.id))value.id='merge_'+await hash(['comment',key,index]);
        used.add(value.id);
        const edited=Math.max(...copies.map(c=>Number(c.edited)||0));if(edited)value.edited=edited;
        result.push(value);
      }
    }
    return result.sort((a,b)=>a.ts-b.ts||(a.id<b.id?-1:a.id>b.id?1:0));
  }
  async function coalesceRooms(view){
    const desired={...view.records},rooms=new Map(),messages=new Map(),parents=new Map();
    const conflictsByKey=new Map(view.conflicts.map(conflict=>[conflict.key,conflict]));
    const find=id=>{if(!parents.has(id))parents.set(id,id);let root=id;while(parents.get(root)!==root)root=parents.get(root);while(parents.get(id)!==id){const next=parents.get(id);parents.set(id,root);id=next;}return root;};
    const union=(a,b)=>{a=find(a);b=find(b);if(a!==b)parents.set(a<b?b:a,a<b?a:b);};
    for(const item of Object.values(view.records)){
      if(item.entity.kind==='room'&&!item.value.kind&&!item.value.peerConflict){rooms.set(item.entity.id,item);find(item.entity.id);}
      if(item.entity.kind==='msg'){const list=messages.get(item.entity.rid)||[];list.push(item);messages.set(item.entity.rid,list);}
    }
    // Persisted aliases redirect offline edits, including after an older snapshot
    // is restored or different copies are merged concurrently on two devices.
    const facts=new Map(Object.entries(view.roomAliases||{}).map(([id,aliases])=>[id,new Set(aliases)]));
    for(const [id,item]of rooms){
      const conflict=conflictsByKey.get(entityKey(item.entity)),aliases=facts.get(id)||new Set();facts.set(id,aliases);
      for(const value of [item.value,...(conflict?.variants||[]).filter(op=>op.value!==null).map(op=>op.value)])for(const alias of value.peerMergedRooms||[])aliases.add(alias);
    }
    for(const [id,aliases]of facts){
      const own=view.records[entityKey({kind:'room',id})];
      if(own&&(own.value.kind||own.value.peerConflict))continue;
      for(const alias of aliases){
        const record=view.records[entityKey({kind:'room',id:alias})];
        if(record&&(record.value.kind||record.value.peerConflict))continue;
        union(id,alias);
      }
    }
    const evidence=new Map();
    for(const [id,item]of rooms){
      if(!knownTime(item.value.createdAt)||!roomTitle(item.value.name))continue;
      const key=canonical([roomTitle(item.value.name),item.value.createdAt]);
      const times=evidence.get(key)||new Map();evidence.set(key,times);
      for(const msg of messages.get(id)||[]){
        if(!knownTime(msg.value.ts))continue;
        // Same title, exact room birth time AND a shared memo birth time are
        // required. A title match alone, empty rooms and fuzzy clocks never merge.
        if(times.has(msg.value.ts))union(id,times.get(msg.value.ts));else times.set(msg.value.ts,id);
      }
    }
    const groups=new Map();
    for(const id of parents.keys()){const root=find(id),group=groups.get(root)||[];group.push(id);groups.set(root,group);}
    let mergedRooms=0;
    for(const members of groups.values()){
      if(members.length===1)continue;
      members.sort();const target=members[0];
      const sources=members.filter(id=>rooms.has(id));if(!sources.length)continue;
      if(sources.length===1&&sources[0]===target&&members.every(id=>id===target||!(messages.get(id)||[]).length)&&
        canonical(rooms.get(target).value.peerMergedRooms||[])===canonical(members.filter(id=>id!==target)))continue;
      const primary=rooms.get(target)||rooms.get(sources[0]);
      const room={...clone(primary.value),id:target,peerMergedRooms:members.filter(id=>id!==target)};
      const tags=[...new Set(sources.flatMap(id=>rooms.get(id).value.tags||[]))].sort();
      if(tags.length)room.tags=tags;
      if(sources.some(id=>rooms.get(id).value.pinned))room.pinned=true;
      for(const id of members)delete desired[entityKey({kind:'room',id})];
      desired[entityKey({kind:'room',id:target})]={entity:{kind:'room',id:target},value:room};
      const buckets=new Map();
      for(const item of members.flatMap(id=>messages.get(id)||[])){
        const key=entityKey(item.entity);
        delete desired[key];
        const variants=conflictsByKey.get(key)?.variants.filter(op=>op.value!==null)||[item];
        for(const variant of variants){
          const signature=memoIdentity(variant.value),byRoom=buckets.get(signature)||new Map();buckets.set(signature,byRoom);
          const list=byRoom.get(item.entity.rid)||[];list.push({entity:item.entity,value:variant.value});byRoom.set(item.entity.rid,list);
        }
      }
      const used=new Set();
      for(const [signature,byRoom]of [...buckets].sort(([a],[b])=>a<b?-1:a>b?1:0)){
        // Keep repeated equal messages within each source room. Only copies
        // across rooms collapse; their multiplicity is the maximum, not one.
        const lists=[...byRoom].sort(([a],[b])=>a<b?-1:a>b?1:0).map(([rid,list])=>{
          const byId=new Map();for(const item of list){const same=byId.get(item.entity.id)||[];same.push(item);byId.set(item.entity.id,same);}
          return [...byId].sort(([a],[b])=>a<b?-1:a>b?1:0).map(([,items])=>({rid,items}));
        });
        const count=Math.max(...lists.map(list=>list.length));
        for(let index=0;index<count;index++){
          const items=lists.flatMap(list=>list[index]?.items||[]);
          items.sort((a,b)=>(a.entity.rid===target?0:1)-(b.entity.rid===target?0:1)||(a.entity.id<b.entity.id?-1:a.entity.id>b.entity.id?1:0));
          const chosen=items[0],value=clone(chosen.value);
          if(value.images)for(const [position,image]of value.images.entries()){
            for(const item of items){const other=item.value.images?.[position];
              if(other){if(image.w===undefined&&other.w!==undefined)image.w=other.w;if(image.h===undefined&&other.h!==undefined)image.h=other.h;}
            }
          }
          let id=chosen.entity.id;
          if(used.has(id))id='merge_'+await hash([target,signature,index]);used.add(id);value.id=id;
          const origins=new Map();for(const item of items)for(const origin of mergeOrigins(item))origins.set(canonical(origin),origin);
          value.peerMergeOrigins=[...origins].sort(([a],[b])=>a<b?-1:a>b?1:0).map(([,origin])=>clone(origin));
          const comments=await mergeComments(items);if(comments.length)value.comments=comments;
          const edited=Math.max(...items.map(item=>Number(item.value.edited)||0));if(edited)value.edited=edited;
          const refs=new Map();for(const item of items)for(const ref of item.value.conflicts||[])refs.set(canonical(ref),ref);
          if(refs.size)value.conflicts=[...refs].sort(([a],[b])=>a<b?-1:a>b?1:0).map(([,ref])=>clone(ref));
          const entity={kind:'msg',rid:target,id};desired[entityKey(entity)]={entity,value};
        }
      }
      mergedRooms+=sources.filter(id=>id!==target).length;
    }
    return {records:desired,mergedRooms};
  }
  async function harvest(state,current){
    const hashes=await fingerprints(current);
    const keys=new Set([...Object.keys(state.baseline),...Object.keys(hashes)]);
    for(const key of keys){
      const before=state.baseline[key],after=hashes[key];
      if(before===after)continue;
      const entity=current[key]?.entity||state.operations[(state.baseHeads[key]||[])[0]]?.entity;
      if(!entity)throw fail('peer_missing_baseline',key);
      const op=await operation(state.groupId,state.actor,{entity,value:current[key]?.value??null},state.baseHeads[key]||[]);
      state.operations[op.id]=op;state.outbox.push(op.id);state.baseHeads[key]=[op.id];
      if(after===undefined)delete state.baseline[key];else state.baseline[key]=after;
    }
  }
  function sameMap(a,b){return canonical(a)===canonical(b);}
  class Replica{
    constructor({groupId,actor,load,save,capture,apply,transport,onProgress,beforeRoomMerge,publicationLimit}){
      Object.assign(this,{groupId,actor,load,save,capture,apply,transport,onProgress,beforeRoomMerge});this.publicationLimit=publicationLimit??(()=>PUBLICATION_BATCH_DEFAULT);this.running=false;
    }
    progress(stage,detail={}){
      // Diagnostics must never change whether a revision is committed or published.
      try{this.onProgress?.({stage,...detail,at:new Date().toISOString()});}catch(_){}
    }
    async tick(){
      if(this.running)throw fail('peer_busy');this.running=true;
      try{
        this.progress('load-local-history');
        const loaded=await this.load();
        const state=loaded?structuredClone(loaded):newState(this.groupId,this.actor);
        if(state.groupId!==this.groupId||state.actor!==this.actor)throw fail('peer_identity');
        this.progress('capture-local-notes');
        const snapshot=await this.capture(),current=normalize(snapshot.records);
        const hashes=await fingerprints(current);
        if(state.pending){
          if(sameMap(hashes,state.pending.baseline)&&snapshot.presentation===state.pending.presentation){
            state.baseline=state.pending.baseline;state.baseHeads=state.pending.baseHeads;
          }
          // Otherwise preserve local edits as concurrent with the pending receive.
          state.pending=null;
        }
        await harvest(state,current);
        for(const [assetPath,data]of Object.entries(snapshot.assets||{}))state.assets[assetPath]=data;
        // Commit local edits/outbox before any network/filesystem publication.
        this.progress('save-outbox',{revisions:Object.keys(state.operations).length,outbox:state.outbox.length});
        await this.save(state);
        for(const [assetPath,data]of Object.entries(state.assets)){
          this.progress('publish-attachment',{path:assetPath});
          await this.transport.put(assetPath,data);delete state.assets[assetPath];
        }
        const requested=typeof this.publicationLimit==='function'?this.publicationLimit():this.publicationLimit;
        if(!Number.isInteger(requested)||requested<1||requested>MAX_OPERATIONS)throw fail('peer_publication_limit');
        const outgoing=state.outbox.slice(0,requested),outgoingTotal=state.outbox.length;
        let published=0,publishError=null;
        try{
          for(const id of outgoing){
            this.progress('publish-operation',{path:DIRECTORY+'/operations/'+id+'.json',completed:published,total:outgoingTotal,batchTotal:outgoing.length});
            await this.transport.put(DIRECTORY+'/operations/'+id+'.json',encoder.encode(canonical(state.operations[id])));
            published++;
          }
        }catch(error){publishError=error;}
        // Preserve successful receipts even when a later write fails. A crash before
        // this save safely replays only this bounded batch, not the entire history.
        state.outbox=state.outbox.slice(published);
        this.progress('save-published-checkpoint',{completed:published,remaining:state.outbox.length});
        await this.save(state);
        if(publishError)throw publishError;
        const blocked=[],foreignGroups={};
        // Verified content-addressed foreign revisions are immutable, just like
        // revisions already in state.operations. Keep their group receipt so a
        // preserved old group does not trigger hundreds of SAF reads every tick.
        state.foreignOperations||={};
        this.progress('list-operations');
        const names=await this.transport.list(DIRECTORY+'/operations');
        let examined=0,receivedSinceCheckpoint=0;
        for(const name of names){
          examined++;
          if(!name.endsWith('.json'))continue;
          const match=/^([a-f0-9]{64})\.json$/.exec(name);
          if(match&&state.operations[match[1]])continue;
          const knownGroup=match&&state.foreignOperations[match[1]];
          if(typeof knownGroup==='string'&&knownGroup!==this.groupId){
            foreignGroups[knownGroup]=(foreignGroups[knownGroup]||0)+1;
            continue;
          }
          const filename=DIRECTORY+'/operations/'+name;
          try{
            this.progress('read-operation',{path:filename,examined,total:names.length});
            const data=await this.transport.read(filename);
            if(!data||data.length>MAX_OPERATION_BYTES)throw fail('peer_partial',filename);
            const op=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(data));
            // Validate foreign history before reporting it. Never merge groups implicitly.
            await validate(op,op.groupId);
            if(match&&match[1]!==op.id)throw fail('peer_integrity',filename);
            if(op.groupId!==this.groupId){
              foreignGroups[op.groupId]=(foreignGroups[op.groupId]||0)+1;
              if(match)state.foreignOperations[op.id]=op.groupId;
            }else{
              if(state.operations[op.id]&&canonical(state.operations[op.id])!==canonical(op))throw fail('peer_integrity',filename);
              state.operations[op.id]=op;
            }
            receivedSinceCheckpoint++;
          }catch(error){
            if(error.code==='EACCES'||error.code==='EPERM'||error.name==='NotAllowedError')throw error;
            blocked.push({path:filename,code:error.code||'peer_partial'});
          }
          if(receivedSinceCheckpoint>=RECEIVE_CHECKPOINT_OPERATIONS){
            this.progress('save-received-checkpoint',{examined,total:names.length,revisions:Object.keys(state.operations).length});
            // Persist verified history only. Application notes and the capture baseline
            // remain untouched until the complete projection is ready to commit.
            await this.save(state);receivedSinceCheckpoint=0;
          }
        }
        this.progress('project-history',{revisions:Object.keys(state.operations).length});
        let view=project(state),mergeBackedUp=false;
        // Initial backup publication must not trigger a second unbounded merge send
        // before incoming edits can be applied. Merge after the original queue drains.
        if(!view.pending.length&&!state.outbox.length){
          this.progress('merge-shared-rooms');
          const combined=await coalesceRooms(view),ids=[];
          const keys=new Set([...Object.keys(view.records),...Object.keys(combined.records)]);
          for(const key of [...keys].sort()){
            const before=view.records[key],after=combined.records[key];
            if(canonical(before?.value??null)===canonical(after?.value??null))continue;
            const entity=after?.entity||before.entity;
            const op=await operation(state.groupId,state.actor,{entity,value:after?.value??null},view.heads[key]||[]);
            state.operations[op.id]=op;state.outbox.push(op.id);ids.push(op.id);
          }
          if(ids.length){
            // Retain every original immutable revision. Persist the complete
            // merge before publishing; a crash or failed write replays the outbox.
            this.progress('backup-before-room-merge');
            await this.beforeRoomMerge?.();mergeBackedUp=true;
            await this.save(state);
            for(const id of ids){
              this.progress('publish-room-merge',{path:DIRECTORY+'/operations/'+id+'.json'});
              await this.transport.put(DIRECTORY+'/operations/'+id+'.json',encoder.encode(canonical(state.operations[id])));
            }
            state.outbox=state.outbox.filter(id=>!ids.includes(id));
            await this.save(state);view=project(state);
          }
        }
        await this.save(state);
        // Missing revisions can be delayed by transport. Do not claim complete sync.
        if(view.pending.length)return {pending:view.pending.length,blocked,foreignGroups,conflicts:view.conflicts.length,applied:false,outgoingPending:state.outbox.length,revisions:Object.keys(state.operations).length};
        const desired=await fingerprints(view.records);
        const presentation=await hash(view.heads);
        const needsApply=!sameMap(hashes,desired)||snapshot.presentation!==presentation;
        if(needsApply){
          const currentLocations=new Set(Object.values(current).map(old=>old.entity.kind==='room'?old.entity.id:old.entity.rid));
          const receivingMerge=Object.values(view.records).some(item=>item.entity.kind==='room'&&item.value.peerMergedRooms?.length&&(
            canonical(current[entityKey(item.entity)]?.value.peerMergedRooms||[])!==canonical(item.value.peerMergedRooms)||
            item.value.peerMergedRooms.some(id=>currentLocations.has(id))));
          if(receivingMerge&&!mergeBackedUp){
            this.progress('backup-before-room-merge');await this.beforeRoomMerge?.();
          }
          state.pending={baseline:desired,baseHeads:view.heads,presentation};
          await this.save(state);
          // Adapter must check the capture token and commit all application data atomically.
          this.progress('apply-received-notes',{records:Object.keys(view.records).length});
          await this.apply(snapshot.token,view.records,view.conflicts,presentation);
        }
        state.baseline=desired;state.baseHeads=view.heads;state.pending=null;
        this.progress('save-applied-history');
        await this.save(state);
        this.progress('cycle-complete',{revisions:Object.keys(state.operations).length});
        const mergedRooms=Object.values(view.records).filter(item=>item.entity.kind==='room').reduce((total,item)=>total+(item.value.peerMergedRooms?.length||0),0);
        return {pending:0,blocked,foreignGroups,conflicts:view.conflicts.length,applied:needsApply,revisions:Object.keys(state.operations).length,mergedRooms,outgoingPending:state.outbox.length};
      }finally{this.running=false;}
    }
    async resolve(key,id){
      if(this.running)throw fail('peer_busy');
      this.running=true;
      try{
      const state=await this.load();if(!state)throw fail('peer_resolution');
      const view=project(state),selected=state.operations[id];
      if(!selected||entityKey(selected.entity)!==key)throw fail('peer_resolution');
      const op=await operation(this.groupId,this.actor,selected,view.heads[key]||[]);
      state.operations[op.id]=op;state.outbox.push(op.id);
      await this.save(state);
      }finally{this.running=false;}
    }
  }
  // A custom name on this exact derived placeholder is the user's recovery intent.
  // Conflict archives and untouched placeholders must remain derived local views.
  const PENDING_ROOM_NAME='받은 메모 · 메모방 복원 대기';
  function recoverNamedPendingRoom(room){
    const next=clone(room);
    if(next.peerConflict===true&&!next.kind&&next.createdAt===0&&
      typeof next.name==='string'&&next.name.trim()&&next.name!==PENDING_ROOM_NAME){
      delete next.peerConflict;next.peerRecoveredRoom=true;
    }
    return next;
  }
  function currentReadable(records){
    const items=Object.values(records),rooms=new Map(items.filter(r=>r.entity.kind==='room').map(r=>[r.entity.id,r.value]));
    const groups=new Map();for(const item of items)if(item.entity.kind==='msg'){
      const list=groups.get(item.entity.rid)||[];list.push(item);groups.set(item.entity.rid,list);
    }
    const compare=(a,b)=>a<b?-1:a>b?1:0;
    const sections=['# 모두톡 현재 메모\n\n이 파일은 읽기용입니다. 앱의 현재 선택 내용을 보여 주며, 수정 이력은 operations의 JSON에 보존됩니다.\n'];
    for(const [rid,list]of [...groups].sort(([a],[b])=>compare(a,b))){
      const room=rooms.get(rid);if(room?.kind==='archive'||room?.peerConflict)continue;
      sections.push('\n## '+(room?.name||PENDING_ROOM_NAME).replace(/[\r\n]+/g,' ')+'\n');
      for(const item of list.sort((a,b)=>a.value.ts-b.value.ts||compare(a.entity.id,b.entity.id))){
        const value=item.value;sections.push('\n<!-- memotalk_id: '+item.entity.id+' -->\n\n'+(value.text||''));
        if(value.images?.length)sections.push('\n'+value.images.map(im=>'![](../assets/'+im.path.split('/').at(-1)+')').join('\n'));
        if(value.comments?.length)sections.push('\n'+value.comments.map(c=>'> '+c.text.replace(/\n/g,'\n> ')).join('\n\n'));
        sections.push('\n');
      }
    }
    return {path:DIRECTORY+'/readable/current.md',data:encoder.encode(sections.join('\n'))};
  }
  function readable(op){
    if(op.entity.kind!=='msg'||op.value===null)return null;
    const value=op.value;
    const meta='---\nmemotalk_id: '+JSON.stringify(op.entity.id)+'\nroom_id: '+JSON.stringify(op.entity.rid)+
      '\nmemotalk_revision: '+JSON.stringify(op.id)+'\nmemotalk_device: '+JSON.stringify(op.actor)+'\n---\n\n';
    const comments=(value.comments||[]).map(c=>'> '+c.text.replace(/\n/g,'\n> ')).join('\n\n');
    const images=(value.images||[]).map(im=>'![](../../../assets/'+im.path.split('/').at(-1)+')').join('\n');
    return {path:DIRECTORY+'/readable/'+op.entity.rid+'/'+op.entity.id+'/'+op.id+'.md',
      data:encoder.encode(meta+(value.text||'')+(comments?'\n\n## 댓글\n\n'+comments:'')+(images?'\n\n'+images:'')+'\n')};
  }
  return {VERSION,GROUP_FILE,DIRECTORY,canonical,hash,assetPath,readable,currentReadable,recoverNamedPendingRoom,entityKey,normalize,fingerprints,newState,operation,validate,project,coalesceRooms,harvest,Replica};
});
