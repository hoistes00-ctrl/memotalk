'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');
const P=require('../shared/peer-sync-engine.js');
const {test}=require('node:test');
test("valid foreign groups are isolated and cached while original history is preserved",async()=>{
 const own=await P.operation('group-a','actor-a',{entity:{kind:'room',id:'room-a'},value:{id:'room-a',name:'PC'}});
 const foreign=await P.operation('group-b','actor-b',{entity:{kind:'room',id:'room-b'},value:{id:'room-b',name:'Phone'}});
 const broken={...foreign,id:'0'.repeat(64)};
 const files=new Map([own,foreign,broken].map(o=>[P.DIRECTORY+'/operations/'+o.id+'.json',new TextEncoder().encode(P.canonical(o))]));
 const readCounts=new Map();
 let state,records=[],presentation;
 const replica=new P.Replica({groupId:'group-a',actor:'actor-a',load:async()=>state,save:async s=>{state=structuredClone(s)},capture:async()=>({token:'t',records,assets:{},presentation}),apply:async(t,r,c,p)=>{records=Object.values(r);presentation=p},transport:{read:async p=>{readCounts.set(p,(readCounts.get(p)||0)+1);return files.get(p)||null},list:async()=>[...files.keys()].map(p=>p.split('/').at(-1)),put:async(p,d)=>files.set(p,d)}});
 let result=await replica.tick();
 assert.deepEqual(result.foreignGroups,{'group-b':1});assert.equal(result.blocked.length,1);assert.equal(result.blocked[0].code,'peer_integrity');assert.equal(result.pending,0);assert.equal(result.revisions,1);assert.equal(records.length,1);assert.equal(records[0].entity.id,'room-a');
 result=await replica.tick();assert.equal(result.applied,false);assert.equal(result.foreignGroups['group-b'],1);assert.equal(readCounts.get(P.DIRECTORY+'/operations/'+foreign.id+'.json'),1);assert.equal(readCounts.get(P.DIRECTORY+'/operations/'+broken.id+'.json'),2);
 // Existing-group join republishes the local snapshot under the existing target ID;
 // the original group bytes remain untouched, while the target's records are merged.
 const prior=new Map(files);let targetState,targetRecords=records,targetPresentation;
 const target=new P.Replica({groupId:'group-b',actor:'actor-a',load:async()=>targetState,save:async s=>{targetState=structuredClone(s)},capture:async()=>({token:'t',records:targetRecords,assets:{},presentation:targetPresentation}),apply:async(t,r,c,p)=>{targetRecords=Object.values(r);targetPresentation=p},transport:{read:async p=>files.get(p)||null,list:async()=>[...files.keys()].map(p=>p.split('/').at(-1)),put:async(p,d)=>{if(files.has(p))assert.deepEqual(files.get(p),d);else files.set(p,d)}}});
 result=await target.tick();assert.equal(targetRecords.length,2);assert.equal(result.conflicts,0);assert.equal(result.foreignGroups['group-a'],1);for(const [p,d]of prior)assert.deepEqual(files.get(p),d);assert.equal(state.groupId,'group-a');assert.equal(targetState.groupId,'group-b');
 console.log('PASS: foreign groups isolated, corrupted foreign history rejected, repeat scan stable, existing-group join preserves both histories and merges two rooms');
});
