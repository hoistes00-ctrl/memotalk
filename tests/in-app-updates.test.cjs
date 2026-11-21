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

function env(){
  const files=new Map(),upgraded=new Set();
  const notices=[];
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
  const mock={Plugin:FakePlugin,ItemView:class{},PluginSettingTab:class{},Setting:class{},Modal:class{},Notice:FakeNotice,Platform:{isMobileApp:true},normalizePath:s=>s,requestUrl:async()=>{throw Error('unexpected request');}};
  const module={exports:{}};
  const source=fs.readFileSync(path.join(root,'obsidian','modutalk-sync-view','main.js'),'utf8');
  vm.runInNewContext(source,{module,require:()=>mock,crypto:webcrypto,Uint8Array,TextEncoder,TextDecoder,ArrayBuffer,Date,Set,Map,JSON,Number}, {filename:'main.js'});
  return {Plugin:module.exports,files,notices,adapter,setFailure:key=>writeFailure={key,failed:false}};
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
  const sandbox={module:{exports:{}},crypto:webcrypto,Uint8Array,TextEncoder,TextDecoder,ArrayBuffer,Date,Set,Map,JSON,Number};
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
    assert.equal(files.get(pluginDir+'/.modutalk-backup-17.5.3/'+name).toString(),old[name]);
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
  const sandbox={module:{exports:{}},crypto:webcrypto,Uint8Array,TextEncoder,TextDecoder,ArrayBuffer,Date,Set,Map,JSON,Number};
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