'use strict';
const fs=require('node:fs/promises');
const path=require('node:path');
const assert=require('node:assert/strict');
const os=require('node:os');
const P=require('../shared/peer-sync-engine');
const {verifiedWrite}=require('../windows/verified-write');
async function main(){
  const source=path.resolve(process.argv[2]||'android-return');
  const state=P.newState('cross-platform-integration','windows-return-verifier');
  const scratch=await fs.mkdtemp(path.join(os.tmpdir(),'memotalk-android-return-'));
  try{
    for(const name of await fs.readdir(source)){
      if(!/^[a-f0-9]{64}\.json$/.test(name))continue;
      const bytes=await fs.readFile(path.join(source,name));
      const op=JSON.parse(bytes.toString('utf8'));await P.validate(op,state.groupId);
      await verifiedWrite(path.join(scratch,name),bytes,null);
      state.operations[op.id]=op;
    }
    const view=P.project(state);assert.equal(view.pending.length,0,'All parent revisions must be present');
    const messages=Object.values(view.records).filter(record=>record.entity.kind==='msg').map(record=>record.value.text);
    assert.ok(messages.includes('Android real WebView reply'),'Real Android UI reply must be readable by Windows engine');
    assert.ok(messages.includes('Windows fixture edit'),'Windows edit must survive Android receive/publication');
    assert.ok(messages.includes('Android initial'),'Android initial data must be preserved on first union');
    console.log('Verified actual Android SAF/WebView reply and Windows-origin revisions through Windows filesystem writer and protocol.');
  }finally{
    assert.ok(path.resolve(scratch).startsWith(path.resolve(os.tmpdir())+path.sep));
    await fs.rm(scratch,{recursive:true,force:true});
  }
}
main().catch(error=>{console.error(error);process.exitCode=1;});
