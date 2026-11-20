'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const {spawn} = require('node:child_process');
const {once} = require('node:events');
const {save, verifySnapshot, INDEX, JOURNAL, STATE} = require('../shared/mirror-engine');
const {verifiedWrite} = require('../windows/verified-write');
const bytes = s => new TextEncoder().encode(s);
const digest = data => crypto.createHash('sha256').update(data).digest('hex');

async function fixture(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'memotalk-test-'));
  t.after(() => fs.rm(dir, {recursive:true, force:true}));
  const root = {async *values() { for (const name of await fs.readdir(dir)) yield {name}; }};
  const read = async (_, name) => {
    try { return new Uint8Array(await fs.readFile(path.join(dir, name))); }
    catch(e) {if(e.code==='ENOENT')return null;throw e;}
  };
  const write = async (_, name, data, expected) => {
    const file = path.join(dir, name);
    await fs.mkdir(path.dirname(file), {recursive:true});
    return verifiedWrite(file, Buffer.from(data), expected === null ? null : Buffer.from(expected));
  };
  return {dir, root, read, write, digest, linkId:'test-link', entries:[['room/memos/a.md', bytes('first memo')], ['manifest.json', bytes('manifest')]], transactionId:crypto.randomUUID()};
}

test('Windows real filesystem: Unicode paths, binary attachments, complete index and unchanged save', async t => {
  const f=await fixture(t);
  f.entries.push(['한글 폴더/사진.png',new Uint8Array([0,255,128,0,64])]);
  assert.equal((await save(f)).count,4);
  const index=JSON.parse(Buffer.from(await f.read(null,INDEX)));
  assert.equal(Object.keys(index.files).length,4);
  assert.equal((await save({...f,transactionId:crypto.randomUUID()})).changed,0);
});

for(const failPath of ['room/memos/a.md','manifest.json',INDEX]) {
  test(`interrupted ${failPath}: retains code/path, no success index, safely resumes`,async t=>{
    const f=await fixture(t);
    await assert.rejects(save({...f,write:async(...args)=>{
      if(args[1]===failPath)throw Object.assign(Error('injected disk failure'),{code:'ENOSPC',syscall:'write'});
      return f.write(...args);
    }}),e=>e.code==='ENOSPC'&&e.relativePath===failPath&&e.operation==='write');
    assert.equal(await f.read(null,INDEX),null);
    assert.ok(await f.read(null,JOURNAL));
    assert.equal((await save({...f,transactionId:crypto.randomUUID()})).count,3);
  });
}

test('truncated output never commits index or reports success',async t=>{
  const f=await fixture(t);
  await assert.rejects(save({...f,write:async(...args)=>{
    await f.write(...args);
    if(args[1].endsWith('.md'))await fs.writeFile(path.join(f.dir,args[1]),'truncated');
  }}),e=>e.code==='mirror_verify'&&e.relativePath.endsWith('.md'));
  assert.equal(await f.read(null,INDEX),null);
});

test('external edit or missing tracked file aborts before any writes',async t=>{
  const f=await fixture(t);await save(f);
  await fs.writeFile(path.join(f.dir,'room/memos/a.md'),'external content');
  let writes=0;
  await assert.rejects(save({...f,write:async()=>{writes++;}}),e=>e.code==='mirror_external'&&e.relativePath==='room/memos/a.md');
  assert.equal(writes,0);
  assert.equal(await fs.readFile(path.join(f.dir,'room/memos/a.md'),'utf8'),'external content');
  await fs.rm(path.join(f.dir,'room/memos/a.md'));
  await assert.rejects(save(f),e=>e.code==='mirror_external');
});

test('legacy partial directory including zero-byte file remains untouched',async t=>{
  const f=await fixture(t);
  await fs.mkdir(path.join(f.dir,'room/memos'),{recursive:true});
  await fs.writeFile(path.join(f.dir,'room/memos/a.md'),'');
  await assert.rejects(save(f),e=>e.code==='mirror_notempty');
  assert.equal((await fs.stat(path.join(f.dir,'room/memos/a.md'))).size,0);
  assert.equal(await f.read(null,INDEX),null);
  assert.equal(await f.read(null,JOURNAL),null);
});

test('changed memo has a verified history copy; obsolete files are retained',async t=>{
  const f=await fixture(t);await save(f);
  const tx=crypto.randomUUID();
  await save({...f,transactionId:tx,entries:[['room/memos/a.md',bytes('second memo')]]});
  assert.equal(await fs.readFile(path.join(f.dir,`.memotalk-history/${tx}/room/memos/a.md`),'utf8'),'first memo');
  assert.equal(await fs.readFile(path.join(f.dir,'manifest.json'),'utf8'),'manifest');
  assert.equal(await fs.readFile(path.join(f.dir,'room/memos/a.md'),'utf8'),'second memo');
});

test('failed history backup never replaces existing data',async t=>{
  const f=await fixture(t);await save(f);
  await assert.rejects(save({...f,entries:[['room/memos/a.md',bytes('second memo')]],write:async(...args)=>{
    if(args[1].startsWith('.memotalk-history'))throw Object.assign(Error('locked'),{code:'EACCES'});
    return f.write(...args);
  }}),e=>e.code==='EACCES');
  assert.equal(await fs.readFile(path.join(f.dir,'room/memos/a.md'),'utf8'),'first memo');
});

test('path traversal, Windows case collision and malformed metadata are rejected',async t=>{
  const f=await fixture(t);
  for(const entries of [[['../escape.md',bytes('x')]],[['A.md',bytes('x')],['a.md',bytes('y')]]]){
    await assert.rejects(save({...f,entries}),e=>e.code==='mirror_path');
  }
  await fs.writeFile(path.join(f.dir,INDEX),'{bad json');
  await assert.rejects(save(f),e=>e.code==='mirror_index');
});

test('native stale baseline and concurrent new-file creator are protected',async t=>{
  const f=await fixture(t),target=path.join(f.dir,'file.md');
  await fs.writeFile(target,'external');
  await assert.rejects(verifiedWrite(target,Buffer.from('mine'),null),{code:'ESTALE'});
  await assert.rejects(verifiedWrite(target,Buffer.from('mine'),Buffer.from('old')),{code:'ESTALE'});
  assert.equal(await fs.readFile(target,'utf8'),'external');
});

for(const code of ['EPERM','EACCES','EBUSY','ENOSPC','ENOENT']) {
  test(`native ${code} during commit: original preserved and no zero-byte placeholder`,async t=>{
    const f=await fixture(t),target=path.join(f.dir,'file.md');
    const io={...fs,link:async()=>{throw Object.assign(Error('injected'),{code,syscall:'link'});}};
    await assert.rejects(verifiedWrite(target,Buffer.from('memo'),null,io),e=>e.code===code&&e.operation==='commit');
    await assert.rejects(fs.stat(target),{code:'ENOENT'});
    assert.deepEqual(await fs.readdir(f.dir),[]);
  });
}

test('actual Windows locked destination preserves old data', {skip:process.platform!=='win32'},async t=>{
  const f=await fixture(t),target=path.join(f.dir,'locked.md');
  await fs.writeFile(target,'original');
  // Read/write sharing permits verification but denies rename (no FileShare.Delete).
  const child=spawn('powershell.exe',['-NoProfile','-NonInteractive','-Command',
    "$f=[IO.File]::Open($env:MEMOTALK_TEST_LOCK,[IO.FileMode]::Open,[IO.FileAccess]::ReadWrite,[IO.FileShare]::ReadWrite); [Console]::WriteLine('locked'); [Console]::ReadLine() | Out-Null; $f.Dispose()"],
    {windowsHide:true,env:{...process.env,MEMOTALK_TEST_LOCK:target}});
  const exited=once(child,'exit');
  try {
    const [message]=await once(child.stdout,'data');
    assert.match(message.toString(),/locked/);
    await assert.rejects(verifiedWrite(target,Buffer.from('next'),Buffer.from('original')),e=>{t.diagnostic(`Actual locked file: ${e.code}, ${e.syscall}, ${e.operation}`);return ['EPERM','EACCES','EBUSY'].includes(e.code)&&e.operation==='commit';});
  } finally { child.stdin.end('\n'); await exited; }
  assert.equal(await fs.readFile(target,'utf8'),'original');
});

test('visible sync descriptor verifies without any local dotfiles on receiver',async t=>{
  const f=await fixture(t);await save(f);
  await fs.rm(path.join(f.dir,INDEX));await fs.rm(path.join(f.dir,JOURNAL));
  const result=await verifySnapshot(f);
  assert.equal(result.count,2);
  assert.ok(result.snapshotId);
});

test('receiver rejects out-of-order, truncated and missing sync files without writes',async t=>{
  const f=await fixture(t);await save(f);
  await fs.writeFile(path.join(f.dir,'room/memos/a.md'),'other snapshot');
  await assert.rejects(verifySnapshot(f),e=>e.code==='mirror_remote_pending'&&e.relativePath==='room/memos/a.md');
  await fs.rm(path.join(f.dir,STATE));
  await assert.rejects(verifySnapshot(f),e=>e.code==='mirror_remote_pending'&&e.relativePath===STATE);
});

test('legacy CRC index migrates only when existing bytes match its recorded digest',async t=>{
  const f=await fixture(t),legacyDigest=data=>`legacy:${data.length}`;
  await fs.mkdir(path.join(f.dir,'room/memos'),{recursive:true});
  await fs.writeFile(path.join(f.dir,'room/memos/a.md'),'first memo');
  await fs.writeFile(path.join(f.dir,INDEX),JSON.stringify({format:'memotalk-file-mirror',version:1,linkId:f.linkId,files:{'room/memos/a.md':legacyDigest(bytes('first memo'))}}));
  await save({...f,legacyDigest});
  assert.equal(JSON.parse(await fs.readFile(path.join(f.dir,INDEX),'utf8')).files['room/memos/a.md'],digest(bytes('first memo')));
});

test('uncommitted journal cannot authorize traversal or another link',async t=>{
  const f=await fixture(t);
  await fs.writeFile(path.join(f.dir,JOURNAL),JSON.stringify({format:'memotalk-file-journal',version:1,linkId:'another',before:{},after:{}}));
  await assert.rejects(save(f),e=>e.code==='mirror_other');
  await fs.writeFile(path.join(f.dir,JOURNAL),JSON.stringify({format:'memotalk-file-journal',version:1,linkId:f.linkId,before:{'../escape.md':'hash'},after:{}}));
  await assert.rejects(save(f),e=>e.code==='mirror_index');
});

test('recovery interrupted again after local edits remains resumable',async t=>{
  const f=await fixture(t);
  await assert.rejects(save({...f,write:async(...args)=>{
    if(args[1]==='manifest.json')throw Object.assign(Error('first crash'),{code:'EIO'});
    return f.write(...args);
  }}));
  const updated={...f,transactionId:crypto.randomUUID(),entries:[['room/memos/a.md',bytes('locally edited after crash')],['manifest.json',bytes('new manifest')]]};
  await assert.rejects(save({...updated,write:async(...args)=>{
    await f.write(...args);
    if(args[1]===JOURNAL)throw Object.assign(Error('second crash'),{code:'EIO'});
  }}));
  await save({...updated,transactionId:crypto.randomUUID()});
  assert.equal(await fs.readFile(path.join(f.dir,'room/memos/a.md'),'utf8'),'locally edited after crash');
  assert.equal((await verifySnapshot(updated)).count,2);
});
