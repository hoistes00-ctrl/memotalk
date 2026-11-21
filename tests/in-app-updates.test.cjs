'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const vm=require('node:vm');
const fs=require('node:fs');
const path=require('node:path');
const {createHash,webcrypto}=require('node:crypto');
const root=path.join(__dirname,'..');
const pluginDir='.obsidian/plugins/modutalk-sync-view';
const names=['app.html','styles.css','manifest.json','main.js'];
const prefix='https://github.com/hoistes00-ctrl/memotalk/releases/download/';
const digest=data=>'sha256:'+createHash('sha256').update(data).digest('hex');

function env(options={}){
  const files=new Map(),upgraded=new Set();
  const notices=[],timers=new Map(),storage=new Map(),controls=[];let timerId=0;
  let writeFailure=null;
  for(const name of names)files.set(pluginDir+'/'+name,Buffer.from('old-'+name));
  const adapter={
    async exists(key){return files.has(key)||upgraded.has(key);},
    async mkdir(key){upgraded.add(key);},
    async readBinary(key){if(!files.has(key))throw Error('not found '+key);return Uint8Array.from(files.get(key)).buffer;},
    async writeBinary(key,value){
      if(writeFailure?.key===key&&!writeFailure.failed){writeFailure.failed=true;throw Error('simulated write failure');}
      files.set(key,Buffer.from(value));
    }
  };
  class FakePlugin{
    constructor(){
      this.app={vault:{adapter}};
      this.manifest={id:'modutalk-sync-view',version:'17.5.3',dir:pluginDir};
      this.data={folder:'memo',groupId:'existing-share'};
    }
    async saveData(value){this.data=value;}
  }
  class FakeNotice{constructor(message){notices.push(message);}}
  class FakeSetting{
    constructor(){controls.push(this);this.buttons=[];}setName(value){this.name=value;return this;}setDesc(){return this;}
    addText(fn){const text={inputEl:{},setValue(v){this.value=v;return this;},onChange(fn){this.change=fn;return this;}};fn(text);this.input=text;return this;}
    addButton(fn){const b={setButtonText(){return this;},setTooltip(){return this;},onClick(fn){this.click=fn;return this;}};fn(b);this.buttons.push(b);return this;}
  }
  const mock={Plugin:FakePlugin,ItemView:class{},PluginSettingTab:class{},Setting:FakeSetting,Modal:class{},Notice:FakeNotice,Platform:{isMobileApp:true},normalizePath:s=>s,requestUrl:options.fetcher||(async()=>{throw Error('unexpected request');})};
  const module={exports:{}};
  const source=fs.readFileSync(path.join(root,'obsidian','modutalk-sync-view','main.js'),'utf8');
  vm.runInNewContext(source,{module,require:()=>mock,crypto:webcrypto,Uint8Array,TextEncoder,TextDecoder,ArrayBuffer,Date,Set,Map,JSON,Number,setTimeout:(fn,ms)=>{timers.set(++timerId,{fn,ms});return timerId;},clearTimeout:id=>timers.delete(id),localStorage:{getItem:k=>storage.get(k)??null,setItem:(k,v)=>storage.set(k,v),removeItem:k=>storage.delete(k)}}, {filename:'main.js'});
  return {Plugin:module.exports,files,notices,adapter,timers,storage,controls,setFailure:key=>writeFailure={key,failed:false}};
}
function fixture(version='17.5.4',suffix=1){
  const tag='modutalk-obsidian-v'+version+'-browser.'+suffix;
  const data={
    'app.html':Buffer.from('<!DOCTYPE html><!--MODUTALK_BOOTSTRAP--><html><title>모두톡 '+version+'</title></html>'),
    'styles.css':Buffer.from('.ok{color:red}'),
    'manifest.json':Buffer.from(JSON.stringify({id:'modutalk-sync-view',version,isDesktopOnly:false})),
    'main.js':Buffer.from('module.exports={};'),
  };
  const files=Object.fromEntries(names.map(name=>[name,{name,size:data[name].length,digest:digest(data[name]),browser_download_url:prefix+tag+'/'+name}]));
  return {release:{tag_name:tag,version,build:suffix,html_url:'https://github.com/hoistes00-ctrl/memotalk/releases/tag/'+tag,prerelease:true,draft:false,assets:Object.values(files),files},data};
}
test('only newer hashed and properly scoped plugin releases are eligible',()=>{
  const {Plugin}=env();
  const older=fixture('17.5.2').release;
  const newer=fixture('17.5.4',1).release;
  const latest=fixture('17.5.5',2).release;
  const untrusted=fixture('17.9.0',3).release;untrusted.assets[0].digest='';
  const badUrl=fixture('18.0.0',4).release;badUrl.assets[0].browser_download_url='https://example.com/plugin/main.js';
  const stable={...fixture('19.0.0',5).release,prerelease:false};
  const selected=Plugin.selectPluginUpdate([older,newer,latest,untrusted,badUrl,stable], '17.5.3');
  assert.equal(selected.version,'17.5.5');
  assert.equal(Plugin.selectPluginUpdate([older], '17.5.3'),null);
});
test('downloaded plugin files are checked before installation; corrupt assets are rejected',async()=>{
  const {Plugin}=env();
  const {release,data}=fixture();
  const good=async({url})=>({status:200,arrayBuffer:Uint8Array.from(data[url.split('/').at(-1)]).buffer});
  const fetched=await Plugin.fetchVerifiedPluginFiles(release,good);
  assert.equal(new TextDecoder().decode(fetched['main.js']),'module.exports={};');
  const wrong=async({url})=>({status:200,arrayBuffer:Uint8Array.from(data[url.split('/').at(-1)].map(b=>b^1)).buffer});
  await assert.rejects(()=>Plugin.fetchVerifiedPluginFiles(release,wrong),/update_checksum_/);
});
test('one-click plugin upgrade verifies, makes backup, and preserves all note locations',async()=>{
  const {Plugin,files,notices}=env();
  const plugin=new Plugin(),{release,data}=fixture();
  const old=Object.fromEntries(names.map(name=>[name,files.get(pluginDir+'/'+name).toString()]));
  // RequestUrl is looked up through the tool import; run with a per-test isolated mock.
  const source=fs.readFileSync(path.join(root,'obsidian','modutalk-sync-view','main.js'),'utf8');
  const notices2=[];
  const sandbox={module:{exports:{}},crypto:webcrypto,Uint8Array,TextEncoder,TextDecoder,ArrayBuffer,Date,Set,Map,JSON,Number,setTimeout:()=>0,clearTimeout(){}};
  sandbox.require=()=>({
    Plugin:class{constructor(){this.app=plugin.app;this.manifest=plugin.manifest;this.data=plugin.data;}async saveData(value){this.data=value;}},
    ItemView:class{},PluginSettingTab:class{},Setting:class{},Modal:class{},
    Notice:class{constructor(t){notices2.push(t);}},Platform:{isMobileApp:true},normalizePath:s=>s,
    requestUrl:async({url})=>({status:200,arrayBuffer:Uint8Array.from(data[url.split('/').at(-1)]).buffer})
  });
  vm.runInNewContext(source,sandbox,{filename:'update-main.js'});
  const instance=new sandbox.module.exports();
  await instance.installPluginUpdate(release);
  for(const name of names){
    assert.equal(files.get(pluginDir+'/'+name).toString(),data[name].toString());
    assert.equal(files.get(instance.data.lastUpdateBackup+'/'+name).toString(),old[name]);
  }
  assert.equal(instance.data.groupId,'existing-share');
  assert.equal(instance.data.appliedUpdateTag,release.tag_name);
  assert.ok(notices2.some(x=>String(x).includes('설치 완료')));
  assert.equal(notices.length,0);
});
test('write failure restores all previously installed plugin files',async()=>{
  const {Plugin,files,setFailure}=env();
  const base=new Plugin();
  const {release,data}=fixture('17.5.4',2);
  const originals=Object.fromEntries(names.map(name=>[name,files.get(pluginDir+'/'+name).toString()]));
  setFailure(pluginDir+'/styles.css');
  const source=fs.readFileSync(path.join(root,'obsidian','modutalk-sync-view','main.js'),'utf8');
  const notes=[];
  const sandbox={module:{exports:{}},crypto:webcrypto,Uint8Array,TextEncoder,TextDecoder,ArrayBuffer,Date,Set,Map,JSON,Number,setTimeout:()=>0,clearTimeout(){}};
  sandbox.require=()=>({
    Plugin:class{constructor(){this.app=base.app;this.manifest=base.manifest;this.data=base.data;}async saveData(value){this.data=value;}},
    ItemView:class{},PluginSettingTab:class{},Setting:class{},Modal:class{},
    Notice:class{constructor(t){notes.push(t);}},Platform:{isMobileApp:true},normalizePath:s=>s,
    requestUrl:async({url})=>({status:200,arrayBuffer:Uint8Array.from(data[url.split('/').at(-1)]).buffer})
  });
  vm.runInNewContext(source,sandbox,{filename:'update-main.js'});
  await new sandbox.module.exports().installPluginUpdate(release);
  for(const name of names)assert.equal(files.get(pluginDir+'/'+name).toString(),originals[name]);
  assert.ok(notes.some(x=>String(x).includes('실패')));
});
test('new builds of a known version are eligible, but unknown or already applied builds are not',()=>{
  const {Plugin}=env(),one=fixture('17.5.3',7).release,two=fixture('17.5.3',8).release;
  assert.equal(Plugin.selectPluginUpdate([one,two],'17.5.3'),null);
  assert.equal(Plugin.selectPluginUpdate([one,two],'17.5.3',one.tag_name).build,8);
  assert.equal(Plugin.selectPluginUpdate([one,two],'17.5.3',two.tag_name),null);
  two.assets[0].browser_download_url+='?redirect=untrusted';assert.equal(Plugin.selectPluginUpdate([two],'17.5.2'),null);
});

function upgradeEnv(){const f=fixture(),e=env({fetcher:async({url})=>({status:200,arrayBuffer:Uint8Array.from(f.data[url.split('/').at(-1)]).buffer})});return {...e,...f,plugin:new e.Plugin()};}

test('backup corruption aborts before touching live code and retry never overwrites an older backup',async()=>{
  const e=upgradeEnv(),original=new Map(e.files),write=e.adapter.writeBinary;
  e.adapter.writeBinary=async(k,v)=>write(k,k.includes('/.modutalk-backup-')?Uint8Array.from([0]).buffer:v);
  const failed=await e.plugin.installPluginUpdate(e.release);assert.equal(failed.ok,false);for(const [k,v]of original)assert.deepEqual(e.files.get(k),v);
  e.adapter.writeBinary=write;const ok=await e.plugin.installPluginUpdate(e.release);assert.equal(ok.ok,true);assert.notEqual(ok.backup,failed.backup);assert.equal(e.files.get(failed.backup+'/app.html').length,1);
});

test('a partial live write is restored and a restoration failure is reported honestly',async()=>{
  for(const failRestore of [false,true]){
    const e=upgradeEnv(),write=e.adapter.writeBinary;let failed=false;
    e.adapter.writeBinary=async(k,v)=>{if(k===pluginDir+'/styles.css'){if(!failed){failed=true;await write(k,Uint8Array.from([0]).buffer);throw Error('partial write');}if(failRestore)throw Error('restore denied');}return write(k,v);};
    const r=await e.plugin.installPluginUpdate(e.release);assert.equal(r.ok,false);assert.equal(r.rollbackVerified,!failRestore);
    assert.equal(e.files.get(pluginDir+'/app.html').toString(),'old-app.html');
    if(failRestore){assert.ok(r.restorationFailures.includes('styles.css'));assert.match(e.notices.at(-1),/복원 확인에 실패/);}else assert.equal(e.files.get(pluginDir+'/styles.css').toString(),'old-styles.css');
  }
});

test('failure saving upgrade settings restores code and the exact previous connection settings',async()=>{
  const e=upgradeEnv(),config=Buffer.from(JSON.stringify(e.plugin.data));e.files.set(pluginDir+'/data.json',config);
  e.plugin.saveData=async()=>{e.files.set(pluginDir+'/data.json',Buffer.from('partial'));throw Error('configuration write failed');};
  const r=await e.plugin.installPluginUpdate(e.release);assert.equal(r.ok,false);assert.equal(r.rollbackVerified,true);
  assert.deepEqual(e.files.get(pluginDir+'/data.json'),config);assert.equal(e.plugin.data.groupId,'existing-share');
  for(const name of names)assert.equal(e.files.get(pluginDir+'/'+name).toString(),'old-'+name);
});

test('unfinished editor work stops an upgrade before any network or file modification',async()=>{
  let requests=0;const e=env({fetcher:async()=>{requests++;throw Error('unexpected');}}),p=new e.Plugin();
  p.app.workspace={getLeavesOfType:()=>[{view:{frame:{contentWindow:{__modutalkHostReady:true,document:{querySelector:()=>({value:'unsent draft'})}}}}}]};
  const r=await p.installPluginUpdate(fixture().release);assert.equal(r.ok,false);assert.equal(requests,0);assert.match(r.error,/작성 중/);assert.equal(e.files.size,4);
});

test('the same downloaded update is not offered or installed again before a plugin reload',async()=>{
  const e=upgradeEnv();assert.equal((await e.plugin.installPluginUpdate(e.release)).ok,true);
  const after=new Map(e.files);assert.equal((await e.plugin.installPluginUpdate(e.release)).ok,false);assert.deepEqual(e.files,after);
  assert.equal(e.plugin.installedUpdateVersion().version,'17.5.4');
});

test('timing controls persist, reset and immediately reschedule the currently visible notice',()=>{
  const e=env(),p=new e.Plugin();e.storage.set('other-plugin','keep');p.addUpdateTuning({});assert.equal(e.controls.length,2);
  assert.equal(e.controls[0].input.value,'6');assert.equal(e.controls[1].input.value,'12');
  e.controls[0].input.change('0.5');assert.equal(p.updateTiming('updateIntervalMs',0),1800000);
  const next=new e.Plugin();assert.equal(next.updateTiming('updateIntervalMs',0),1800000);
  p.showUpdateNotice('visible');assert.equal([...e.timers.values()][0].ms,12000);
  e.controls[1].input.change('0');assert.equal(e.timers.size,0);e.controls[1].buttons[0].click();assert.equal([...e.timers.values()][0].ms,12000);
  e.controls[0].buttons[0].click();assert.equal(e.controls[0].input.value,'6');assert.equal(e.storage.get('other-plugin'),'keep');
});

test('hosted title reports the plugin version without changing the standalone app version',()=>{
  const plugin=JSON.parse(fs.readFileSync(path.join(root,'obsidian/modutalk-sync-view/manifest.json'),'utf8'));
  const hosted=fs.readFileSync(path.join(root,'obsidian/modutalk-sync-view/app.html'),'utf8');
  assert.ok(hosted.includes('<title>모두톡 '+plugin.version+'</title>'));
  assert.ok(fs.readFileSync(path.join(root,'shared/index.html'),'utf8').includes('<title>모두톡 17.5.0</title>'));
});

test('native apps advertise the correct stable installer, not the Obsidian prerelease',()=>{
  const source=fs.readFileSync(path.join(root,'shared','index.html'),'utf8');
  const a=source.indexOf('const APP_RELEASE_API='),b=source.indexOf("$('#btn-more').addEventListener",a);
  assert.ok(a>0&&b>a);
  const versionFn=vm.runInNewContext(source.slice(a,b)+';selectAppRelease',{
    document:{title:'모두톡 17.5.0'},window:{},Date,Number,AbortController,JSON
  });
  const stable=(ver,kind)=>({tag_name:'modutalk-v'+ver,draft:false,prerelease:false,assets:[{
    name:kind==='android'?'Modutalk-Android-'+ver+'.apk':'Modutalk-Setup-'+ver+'-x64.exe',
    size:100,browser_download_url:prefix+'modutalk-v'+ver+'/'+(kind==='android'?'Modutalk-Android-'+ver+'.apk':'Modutalk-Setup-'+ver+'-x64.exe')
  }]});
  const opts=[stable('17.5.1','android'),stable('17.5.3','android'),stable('17.5.2','windows')];
  assert.equal(versionFn(opts,'17.5.0','android').version,'17.5.3');
  assert.equal(versionFn(opts,'17.5.0','windows').version,'17.5.2');
  assert.equal(versionFn(opts,'17.5.3','android'),null);
  assert.match(source,/버전 확인 · 업그레이드/);
  assert.match(source,/checkAppUpdates\(\{manual:false\}\)/);
});
