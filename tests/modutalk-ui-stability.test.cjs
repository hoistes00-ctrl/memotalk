'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const pluginDir=path.join(__dirname,'..','obsidian','modutalk-sync-view');

test('mobile chrome is scoped to active, ready Modutalk view and restored on exit', async()=>{
  const src=fs.readFileSync(path.join(pluginDir,'main.js'),'utf8');
  const classes=new Set();
  const document={body:{classList:{
    toggle(name,on){if(on)classes.add(name);else classes.delete(name);},
    remove(name){classes.delete(name);}
  }}};
  const workspace={activeLeaf:null,on(){return {};},getLeavesOfType(){return [];}};
  let factory;
  class FakePlugin{
    constructor(){this.app={workspace};this.manifest={dir:pluginDir};}
    async loadData(){return {folder:'',groupId:null};}
    registerView(type,fn){factory=fn;}
    registerEvent(){}
    addRibbonIcon(){}
    addCommand(){}
    registerObsidianProtocolHandler(){}
    addSettingTab(){}
  }
  class FakeItemView{constructor(leaf){this.app=leaf.app;}}
  const exports={};
  const stub={Plugin:FakePlugin,ItemView:FakeItemView,PluginSettingTab:class{},Setting:class{},Modal:class{},Notice:class{},Platform:{isMobileApp:true},normalizePath:x=>x};
  const sandbox={require:()=>stub,module:{exports},document,window:{},crypto:{},setTimeout:()=>0,clearTimeout(){}};
  vm.runInNewContext(src,sandbox,{filename:'main.js'});
  const plugin=new sandbox.module.exports();
  await plugin.onload();
  const view=factory({app:plugin.app});
  workspace.activeLeaf={view};
  plugin.refreshImmersive();
  assert.equal(classes.has('modutalk-immersive'),false,'not yet ready');
  view.ready=true;
  plugin.refreshImmersive();
  assert.equal(classes.has('modutalk-immersive'),true,'active view hides chrome');
  view.showObsidianChrome=true;
  plugin.refreshImmersive();
  assert.equal(classes.has('modutalk-immersive'),false,'user restores menus');
  view.showObsidianChrome=false;
  plugin.refreshImmersive();
  assert.equal(classes.has('modutalk-immersive'),true);
  workspace.activeLeaf={view:{}};
  plugin.refreshImmersive();
  assert.equal(classes.has('modutalk-immersive'),false,'other note restores menus');
  workspace.activeLeaf={view};
  plugin.refreshImmersive();
  assert.equal(classes.has('modutalk-immersive'),true);
  plugin.onunload();
  assert.equal(classes.has('modutalk-immersive'),false,'plugin unload restores menus');
});

test('only hosted UI compresses status messages; detailed diagnostics remain',()=>{
  const html=fs.readFileSync(path.join(pluginDir,'app.html'),'utf8');
  const start=html.indexOf('function fileMirrorStatus(status,message){');
  const end=html.indexOf('\nconst fileMirrorSupported=',start);
  assert.ok(start>=0&&end>start,'status function found');
  const code=html.slice(start,end);
  const bar={dataset:{}},label={textContent:'',title:''},button={disabled:false};
  const elements={'#file-sync-bar':bar,'#file-sync-state':label,'#btn-file-folder':button};
  const fileMirror={busy:false};
  const makeStatus=(window)=>vm.runInNewContext(code+';fileMirrorStatus',{fileMirror,window,$:name=>elements[name]});
  const hosted=makeStatus({MemoTalkHostCapabilities:{}});
  hosted('pending','공유 기록 1 / 1053');
  hosted('pending','공유 기록 1052 / 1053');
  hosted('saved','주기 완료');
  assert.equal(label.textContent,'공유 폴더 연결됨');
  assert.equal(fileMirror.message,'주기 완료','underlying diagnostics still get exact text');
  hosted('error','전송 실패');
  assert.equal(label.textContent,'공유 확인 필요');
  hosted('off','연결 해제');
  assert.equal(label.textContent,'파일 폴더 미연결');
  makeStatus({})('pending','공유 기록 500 / 1053');
  assert.equal(label.textContent,'공유 기록 500 / 1053','non-hosted UI unchanged');
  const desktop=makeStatus({MemoTalkNative:{}});
  desktop('pending','공유 기록 1 / 1053');const stable=label.textContent;
  desktop('saved','주기 완료 · 이력 1134개');assert.equal(label.textContent,stable);
  assert.equal(stable,'공유 폴더 연결됨');assert.equal(fileMirror.message,'주기 완료 · 이력 1134개');
  desktop('error','읽기 실패');assert.equal(label.textContent,'공유 확인 필요');
});

test('style rules target mobile Modutalk immersion, not all Obsidian notes',()=>{
  const css=fs.readFileSync(path.join(pluginDir,'styles.css'),'utf8');
  assert.match(css,/body\.modutalk-immersive \.mobile-navbar/);
  assert.match(css,/data-type="modutalk-sync-view"/);
  assert.match(css,/\.modutalk-sync-menu-toggle/);
});
