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
      delete value.last;delete value.updatedAt;
    }else{
      if(typeof(value.text??'')!=='string'||!Number.isFinite(value.ts))throw fail('peer_message');
      if(value.images!==undefined&&(!Array.isArray(value.images)||value.images.some(im=>!im||!HASH.test(im.sha256)||
          im.path!==assetPath(im.sha256,im.mime))))throw fail('peer_image');
      if(value.comments!==undefined&&(!Array.isArray(value.comments)||value.comments.some(c=>!c||!ID.test(c.id)||typeof c.text!=='string'||!Number.isFinite(c.ts))))throw fail('peer_comments');
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
    return {records,heads,conflicts,pending:[...pending]};
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
    constructor({groupId,actor,load,save,capture,apply,transport}){
      Object.assign(this,{groupId,actor,load,save,capture,apply,transport});this.running=false;
    }
    async tick(){
      if(this.running)throw fail('peer_busy');this.running=true;
      try{
        const loaded=await this.load();
        const state=loaded?structuredClone(loaded):newState(this.groupId,this.actor);
        if(state.groupId!==this.groupId||state.actor!==this.actor)throw fail('peer_identity');
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
        await this.save(state);
        for(const [assetPath,data]of Object.entries(state.assets)){
          await this.transport.put(assetPath,data);delete state.assets[assetPath];
        }
        for(const id of state.outbox){
          await this.transport.put(DIRECTORY+'/operations/'+id+'.json',encoder.encode(canonical(state.operations[id])));
        }
        state.outbox=[];
        // A crash can replay already-published content-addressed files safely. One
        // durable batch receipt avoids rewriting the entire ledger for each memo.
        await this.save(state);
        const blocked=[];
        for(const name of await this.transport.list(DIRECTORY+'/operations')){
          if(!name.endsWith('.json'))continue;
          const match=/^([a-f0-9]{64})\.json$/.exec(name);
          if(match&&state.operations[match[1]])continue;
          const filename=DIRECTORY+'/operations/'+name;
          try{
            const data=await this.transport.read(filename);
            if(!data||data.length>MAX_OPERATION_BYTES)throw fail('peer_partial',filename);
            const op=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(data));
            await validate(op,this.groupId);
            if(state.operations[op.id]&&canonical(state.operations[op.id])!==canonical(op))throw fail('peer_integrity',filename);
            state.operations[op.id]=op;
          }catch(error){
            if(error.code==='EACCES'||error.code==='EPERM'||error.name==='NotAllowedError')throw error;
            blocked.push({path:filename,code:error.code||'peer_partial'});
          }
        }
        const view=project(state);
        await this.save(state);
        // Missing revisions can be delayed by transport. Do not claim complete sync.
        if(view.pending.length)return {pending:view.pending.length,blocked,conflicts:view.conflicts.length,applied:false};
        const desired=await fingerprints(view.records);
        const presentation=await hash(view.heads);
        const needsApply=!sameMap(hashes,desired)||snapshot.presentation!==presentation;
        if(needsApply){
          state.pending={baseline:desired,baseHeads:view.heads,presentation};
          await this.save(state);
          // Adapter must check the capture token and commit all application data atomically.
          await this.apply(snapshot.token,view.records,view.conflicts,presentation);
        }
        state.baseline=desired;state.baseHeads=view.heads;state.pending=null;
        await this.save(state);
        return {pending:0,blocked,conflicts:view.conflicts.length,applied:needsApply,revisions:Object.keys(state.operations).length};
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
  return {VERSION,GROUP_FILE,DIRECTORY,canonical,hash,assetPath,readable,entityKey,normalize,fingerprints,newState,operation,validate,project,harvest,Replica};
});
