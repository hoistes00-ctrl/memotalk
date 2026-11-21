'use strict';
const {Plugin,ItemView,PluginSettingTab,Setting,Modal,Notice,Platform,normalizePath}=require('obsidian');
// Backend byte limit, matching the native bridge. Higher permits larger binary files.
const MAX_BYTES=64*1024*1024;
// Backend path limit, matching native traversal. Higher permits deeper descendants.
const MAX_PARTS=32;
// Backend base64 chunk size. Higher uses larger temporary strings.
const BASE64_CHUNK=16384;
const VIEW_TYPE='modutalk-sync-view',GROUP_FILE='memotalk-peer-group.json';
const fail=(code,message=code)=>Object.assign(new Error(message),{code});
function namePart(value){
  if(typeof value!=='string'||!value||value==='.'||value==='..'||/[\\/\x00-\x1f]/.test(value))throw fail('EINVAL','잘못된 파일 이름');
  return value;
}
function safeFolder(value){
  if(typeof value!=='string'||!value||/^[\\/]|^[a-z]:/i.test(value))throw fail('EINVAL','볼트 안의 공유 폴더를 선택하세요.');
  const parts=value.split('/');if(parts.length>MAX_PARTS)throw fail('EINVAL');parts.forEach(namePart);
  return normalizePath(value).normalize('NFC');
}
function asBytes(value){
  if(ArrayBuffer.isView(value))return new Uint8Array(value.buffer,value.byteOffset,value.byteLength);
  return new Uint8Array(value);
}
function encode(bytes){let text='';for(let i=0;i<bytes.length;i+=BASE64_CHUNK)text+=String.fromCharCode(...bytes.subarray(i,i+BASE64_CHUNK));return btoa(text);}
function decode(text){if(typeof text!=='string'||text.length>Math.ceil(MAX_BYTES/3)*4)throw fail('EFBIG');const raw=atob(text),out=Uint8Array.from(raw,c=>c.charCodeAt(0));if(out.length>MAX_BYTES)throw fail('EFBIG');return out;}
const equal=(a,b)=>a===null||b===null?a===b:a.length===b.length&&a.every((v,i)=>v===b[i]);

/** One selected vault subtree, append-only verified publication, no general delete API. */
class VaultHost {
  constructor(vault,folder,{onChange=()=>{}}={}){
    this.vault=vault;this.adapter=vault.adapter;this.folder=safeFolder(folder);this.onChange=onChange;
    this.folderToken=crypto.randomUUID();this.lease=null;this.connected=true;this.closed=false;
    this.queue=Promise.resolve();this.active=null;this.last=null;this.ownedTemps=new Set();
  }
  async initialize(expectedGroup){
    const stat=await this.adapter.stat(this.folder);if(!stat||stat.type!=='folder')throw fail('ENOENT','공유 폴더가 아직 내려오지 않았어요.');
    const raw=await this.adapter.read(this.folder+'/'+GROUP_FILE),group=JSON.parse(raw);
    if(group.format!=='memotalk-peer-group'||group.version!==1||typeof group.id!=='string'||!/^[a-zA-Z0-9_-]{1,256}$/.test(group.id))throw fail('peer_group');
    if(expectedGroup&&expectedGroup!==group.id)throw fail('peer_group_changed','선택한 폴더의 공유 그룹이 바뀌었습니다.');
    this.groupId=group.id;return group;
  }
  status(){return {connected:this.connected&&!this.closed,name:this.folder,folderToken:this.folderToken,atomicWrites:true,
    location:{kind:'obsidian-vault',displayPath:this.vault.getName()+' / '+this.folder,vaultName:this.vault.getName(),relativePath:this.folder,canReveal:false}};}
  diagnostics(){const now=Date.now();return {activeOperation:this.active?{...this.active,elapsedMs:now-this.active.startedMs,stageElapsedMs:now-this.active.stageMs,startedMs:undefined,stageMs:undefined}:null,lastCompletedOperation:this.last};}
  phase(stage){if(this.active)this.active={...this.active,stage,stageMs:Date.now()};}
  check(){if(this.closed||!this.connected)throw fail('ESTALE');}
  path(parts,allowRoot=false){
    if(!Array.isArray(parts)||parts.length>MAX_PARTS||(!allowRoot&&!parts.length))throw fail('EINVAL');parts.forEach(namePart);
    return parts.length?this.folder+'/'+parts.join('/'):this.folder;
  }
  async stat(file){const s=await this.adapter.stat(file);if(!s)return {exists:false};if(!['file','folder'].includes(s.type))throw fail('EIO');return {exists:true,kind:s.type==='folder'?'directory':'file'};}
  async readOrNull(file){
    this.check();this.phase('stat');const s=await this.stat(file);if(!s.exists)return null;if(s.kind!=='file')throw fail('EISDIR');
    this.phase('read-document');const bytes=asBytes(await this.adapter.readBinary(file));if(bytes.length>MAX_BYTES)throw fail('EFBIG');return bytes;
  }
  async writeAppend(file,data,expected){
    this.check();this.phase('compare');const current=await this.readOrNull(file);
    if(!equal(current,expected))throw fail('ESTALE');if(equal(current,data))return true;if(current!==null)throw fail('EOPNOTSUPP','기존 파일은 덮어쓰지 않습니다.');
    const parent=file.slice(0,file.lastIndexOf('/'));if((await this.stat(parent)).kind!=='directory')throw fail('ENOENT');
    const temporary=parent+'/modutalk-pending-'+crypto.randomUUID()+'.tmp';let handle=null,published=false;
    try{
      this.check();this.phase('create-temporary');
      handle=await this.vault.createBinary(temporary,data.slice().buffer);this.ownedTemps.add(temporary);
      if(!handle||handle.path!==temporary)throw fail('EIO','Obsidian이 임시 파일을 인식하지 못했습니다.');
      this.check();this.phase('verify-temporary');if(!equal(asBytes(await this.adapter.readBinary(temporary)),data))throw fail('EIO');
      this.check();this.phase('compare-before-publish');if(await this.readOrNull(file)!==null)throw fail('ESTALE');
      this.check();this.phase('publish');
      // Vault.rename publishes through Obsidian's own file events, so Sync sees the JSON.
      // An existing destination must be rejected by Vault; never modify or replace it.
      await this.vault.rename(handle,file);published=true;this.ownedTemps.delete(temporary);
      this.phase('verify-target');if(!equal(await this.readOrNull(file),data))throw fail('EIO');
      return true;
    }finally{
      if(!published&&handle&&this.ownedTemps.has(temporary)){
        this.ownedTemps.delete(temporary);
        // Only the exact temporary object created above can be cleaned up.
        if(handle.path===temporary)await this.vault.delete(handle).catch(()=>{});
      }
    }
  }
  async perform(command,args={}){
    if(this.closed)throw fail('ESTALE');
    if(command==='hasFolder')return this.status();
    if(command==='pickFolder'){if(this.lease)throw fail('EBUSY');this.connected=true;return this.status();}
    if(command==='disconnect'){if(this.lease)throw fail('EBUSY');this.connected=false;this.folderToken=crypto.randomUUID();return true;}
    this.check();
    if(command==='download'){
      const name=namePart(args.name);if(!name||/[<>:"|?*]/.test(name))throw fail('EINVAL');
      const dir=this.folder+'/Exports';if(!(await this.stat(dir)).exists)await this.vault.createFolder(dir);
      await this.writeAppend(dir+'/'+name,decode(args.base64),null);return {saved:true,path:dir+'/'+name};
    }
    if(args.folderToken!==this.folderToken)throw fail('ESTALE');
    if(command==='beginMirror'){if(this.lease)throw fail('EBUSY');this.lease=crypto.randomUUID();return {leaseId:this.lease};}
    if(this.lease&&args.leaseId!==this.lease)throw fail('EBUSY');
    if(command==='endMirror'){this.lease=null;return true;}
    const file=this.path(args.path,command==='list'||command==='stat');
    if(command==='stat')return this.stat(file);
    if(command==='read'){const bytes=await this.readOrNull(file);if(bytes===null)throw fail('ENOENT','NotFoundError');return {base64:encode(bytes)};}
    if(command==='list'){
      this.phase('list');const s=await this.stat(file);if(!s.exists)throw fail('ENOENT');if(s.kind!=='directory')throw fail('ENOTDIR');
      const listed=await this.adapter.list(file),result=[];
      for(const [kind,paths]of [['file',listed.files],['directory',listed.folders]])for(const full of paths){
        if(typeof full!=='string'||!full.startsWith(file+'/'))throw fail('EIO');const name=namePart(full.slice(file.length+1));result.push({name,kind});
      }
      return result;
    }
    if(command==='mkdir'){
      const s=await this.stat(file);if(s.exists){if(s.kind!=='directory')throw fail('ENOTDIR');return s;}
      const parent=file.slice(0,file.lastIndexOf('/'));if((await this.stat(parent)).kind!=='directory')throw fail('ENOENT');
      try{await this.vault.createFolder(file);}catch(error){if((await this.stat(file)).kind!=='directory')throw error;}
      return {exists:true,kind:'directory'};
    }
    if(command==='write'){
      if(!Object.prototype.hasOwnProperty.call(args,'expectedBase64'))throw fail('EINVAL');
      return this.writeAppend(file,decode(args.base64),args.expectedBase64===null?null:decode(args.expectedBase64));
    }
    throw fail('EOPNOTSUPP','이 동기화 화면에서는 원본 파일을 삭제하거나 덮어쓰지 않습니다.');
  }
  request(command,args={}){
    const task=async()=>{
      const start=Date.now();this.active={command,relativePath:Array.isArray(args.path)?args.path.join('/'):'',stage:'start',startedAt:new Date(start).toISOString(),startedMs:start,stageMs:start};
      try{return {ok:true,result:await this.perform(command,args)};}
      catch(e){return {ok:false,error:{code:e.code||'EIO',message:String(e.message||e.code),operation:command,relativePath:this.active.relativePath}};}
      finally{const snapshot=this.diagnostics().activeOperation;this.last={...snapshot,completedAt:new Date().toISOString()};this.active=null;try{this.onChange();}catch(_){};}
    };
    const result=this.queue.then(task,task);this.queue=result.then(()=>{},()=>{});return result;
  }
  dispose(){this.closed=true;this.lease=null;this.folderToken=crypto.randomUUID();}
}

/** Runs inside the isolated view. Other Obsidian storage keys/databases stay untouched. */
function frameBootstrap(config){
  window.__modutalkHostReady=false;
  try{
    const host=window.frameElement.__modutalkHost;if(!host)throw Error('연동 창을 준비하지 못했습니다.');
    const rawStorage=window.localStorage,rawDb=window.indexedDB,prefix=config.storagePrefix;
    const keys=()=>Array.from({length:rawStorage.length},(_,i)=>rawStorage.key(i)).filter(k=>k&&k.startsWith(prefix));
    const scoped={getItem:k=>rawStorage.getItem(prefix+String(k)),setItem:(k,v)=>rawStorage.setItem(prefix+String(k),String(v)),removeItem:k=>rawStorage.removeItem(prefix+String(k)),key:i=>{const list=keys();return list[i]===undefined?null:list[i].slice(prefix.length);},clear:()=>keys().forEach(k=>rawStorage.removeItem(k))};
    Object.defineProperty(scoped,'length',{get:()=>keys().length});
    const db={open:(name,version)=>version===undefined?rawDb.open(prefix+name):rawDb.open(prefix+name,version),deleteDatabase:name=>rawDb.deleteDatabase(prefix+name),cmp:rawDb.cmp.bind(rawDb)};
    if(rawDb.databases)db.databases=async()=>{const list=await rawDb.databases();return list.filter(x=>x.name?.startsWith(prefix)).map(x=>({...x,name:x.name.slice(prefix.length)}));};
    Object.defineProperty(window,'localStorage',{value:scoped,configurable:true});
    Object.defineProperty(window,'indexedDB',{value:db,configurable:true});
    if(window.localStorage!==scoped||window.indexedDB!==db)throw Error('분리된 저장 공간을 준비하지 못했습니다.');
    window.MemoTalkNative={request:(command,args)=>host.request(command,args),diagnostics:()=>host.diagnostics()};
    window.MemoTalkHostCapabilities={openRoomWindow:false};
    document.documentElement.classList.add('native-android');
    if(!scoped.getItem('memotalk.hosted.initialized')){
      if(scoped.getItem('memotalk.v1')===null)scoped.setItem('memotalk.v1',JSON.stringify({seeded:true,rooms:{},msgs:{}}));
      scoped.setItem('memotalk.fileMirror.auto','false');
      scoped.setItem('memotalk.nativeFolder.linkId',config.groupId);
      scoped.setItem('memotalk.peer.config',JSON.stringify({enabled:true,groupId:config.groupId}));
      scoped.setItem('memotalk.hosted.initialized','1');
    }
    window.__modutalkHostReady=true;
  }catch(error){
    window.__modutalkHostError=String(error.message||error);
    document.addEventListener('DOMContentLoaded',()=>{document.body.textContent='모두톡을 열지 못했습니다. '+window.__modutalkHostError;});
  }
}

class FolderModal extends Modal {
  constructor(app,plugin){super(app);this.plugin=plugin;}
  onOpen(){
    this.contentEl.createEl('h2',{text:'기존 모두톡 공유 폴더 선택'});
    this.contentEl.createEl('p',{text:'PC와 공유하는 기존 그룹이 있는 폴더를 선택하세요. 그룹을 새로 만들지 않습니다.'});
    const files=this.app.vault.getFiles().filter(f=>f.name===GROUP_FILE&&f.parent?.path);
    if(!files.length)this.contentEl.createEl('p',{text:'그룹 파일이 아직 없습니다. Obsidian 동기화가 끝난 뒤 다시 열어 주세요.'});
    for(const file of files)new Setting(this.contentEl).setName(file.parent.path).addButton(b=>b.setButtonText('연결').onClick(async()=>{
      try{const group=JSON.parse(await this.app.vault.read(file));if(group.format!=='memotalk-peer-group'||group.version!==1)throw fail('peer_group');
        this.plugin.data={folder:safeFolder(file.parent.path),groupId:group.id};await this.plugin.saveData(this.plugin.data);this.close();await this.plugin.openView();
      }catch(e){new Notice('공유 폴더를 열지 못했습니다: '+e.message);}
    }));
  }
}
class ModutalkView extends ItemView {
  constructor(leaf,plugin){super(leaf);this.plugin=plugin;this.ready=false;this.showObsidianChrome=false;}
  getViewType(){return VIEW_TYPE;}
  getDisplayText(){return '모두톡';}
  getIcon(){return 'messages-square';}
  async onOpen(){
    this.ready=false;this.showObsidianChrome=false;
    this.plugin.refreshImmersive();
    this.contentEl.empty();this.contentEl.classList.add('modutalk-sync-content');
    if(!this.plugin.data.folder){this.contentEl.createEl('p',{text:'기존 모두톡 공유 폴더를 연결해 주세요.'});this.contentEl.createEl('button',{text:'공유 폴더 선택'}).onclick=()=>new FolderModal(this.app,this.plugin).open();return;}
    try{
      this.host=new VaultHost(this.app.vault,this.plugin.data.folder,{onChange:()=>this.updateStatus()});await this.host.initialize(this.plugin.data.groupId);
      const controls=this.contentEl.createDiv({cls:'modutalk-sync-controls'});
      this.statusEl=controls.createSpan({cls:'modutalk-sync-status',attr:{'aria-live':'off'}});
      const toggle=controls.createEl('button',{cls:'modutalk-sync-menu-toggle',text:'Obsidian 메뉴',attr:{type:'button','aria-label':'Obsidian 메뉴 표시'}});
      toggle.addEventListener('click',()=>{
        this.showObsidianChrome=!this.showObsidianChrome;
        toggle.setText(this.showObsidianChrome?'전체 화면':'Obsidian 메뉴');
        toggle.setAttribute('aria-label',this.showObsidianChrome?'모두톡 전체 화면으로 돌아가기':'Obsidian 메뉴 표시');
        this.plugin.refreshImmersive();
      });
      this.updateStatus();
      const frame=this.contentEl.createEl('iframe',{cls:'modutalk-sync-frame',attr:{title:'모두톡',sandbox:'allow-scripts allow-same-origin allow-forms allow-downloads allow-modals',allow:'clipboard-read; clipboard-write'}});
      this.frame=frame;frame.__modutalkHost=this.host;
      const config={groupId:this.host.groupId,storagePrefix:'modutalk.sync-view.'+this.host.groupId+'.'};
      const script='('+frameBootstrap.toString()+')('+JSON.stringify(config).replace(/</g,'\\u003c')+');';
      const html=await this.app.vault.adapter.read(this.plugin.manifest.dir+'/app.html');
      if(!html.includes('<!--MODUTALK_BOOTSTRAP-->'))throw Error('화면 파일이 올바르지 않습니다.');
      frame.srcdoc=html.replace('<!--MODUTALK_BOOTSTRAP-->','<script>'+script.replace(/<\/script/gi,'<\\/script')+'</script>');
      this.ready=true;this.plugin.refreshImmersive();
    }catch(e){this.ready=false;this.plugin.refreshImmersive();this.host?.dispose();this.contentEl.empty();this.contentEl.createEl('p',{text:'모두톡 연결을 확인하세요: '+e.message});}
  }
  updateStatus(){
    if(!this.statusEl)return;
    // Do not flash between "syncing" and "synced" for routine background work.
    // This is a folder-connection label, not a claim of delivery on other devices.
    const text='공유 폴더 연결됨';
    if(this.statusEl.textContent!==text)this.statusEl.textContent=text;
    this.statusEl.title=this.app.vault.getName()+' / '+this.plugin.data.folder;
  }
  async onClose(){
    this.ready=false;this.plugin.refreshImmersive();
    this.host?.dispose();this.frame?.remove();
  }
}
class ModutalkSettings extends PluginSettingTab {
  constructor(app,plugin){super(app,plugin);this.plugin=plugin;}
  display(){
    this.containerEl.empty();this.containerEl.createEl('h2',{text:'모두톡 한 화면 동기화'});
    new Setting(this.containerEl).setName('공유 폴더').setDesc(this.plugin.data.folder||'아직 연결하지 않았습니다.').addButton(b=>b.setButtonText('모두톡 열기').onClick(()=>this.plugin.openView()));
    this.containerEl.createEl('p',{text:'메모 화면과 Obsidian 전송을 같은 앱에서 실행합니다. 기존 모두톡 앱의 데이터는 유지됩니다. 속도와 제목 표시는 모두톡 화면 안의 설정에서 조절할 수 있습니다.'});
  }
}
class ModutalkPlugin extends Plugin {
  refreshImmersive(){
    if(!Platform.isMobileApp)return;
    const active=this.app.workspace.activeLeaf?.view;
    const immersive=active instanceof ModutalkView&&active.ready&&!active.showObsidianChrome;
    document.body.classList.toggle('modutalk-immersive',immersive);
  }
  async onload(){
    this.data=Object.assign({folder:'',groupId:null},await this.loadData()||{});
    if(!Platform.isMobileApp)return;
    this.registerView(VIEW_TYPE,leaf=>new ModutalkView(leaf,this));
    this.registerEvent(this.app.workspace.on('active-leaf-change',()=>this.refreshImmersive()));
    this.registerEvent(this.app.workspace.on('layout-change',()=>this.refreshImmersive()));
    this.addRibbonIcon('messages-square','모두톡',()=>this.openView());
    this.addCommand({id:'open-modutalk',name:'모두톡 열기',callback:()=>this.openView()});
    this.registerObsidianProtocolHandler('modutalk',()=>this.openView());
    this.addSettingTab(new ModutalkSettings(this.app,this));
  }
  async openView(){
    if(!Platform.isMobileApp){new Notice('PC에서는 설치된 모두톡 앱을 사용하세요.');return;}
    const existing=this.app.workspace.getLeavesOfType(VIEW_TYPE)[0];
    if(existing){await this.app.workspace.revealLeaf(existing);this.refreshImmersive();return existing;}
    const leaf=this.app.workspace.getLeaf('tab');await leaf.setViewState({type:VIEW_TYPE,active:true});await this.app.workspace.revealLeaf(leaf);this.refreshImmersive();return leaf;
  }
  onunload(){
    document.body.classList.remove('modutalk-immersive');
    for(const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE))leaf.view.host?.dispose();
  }
}
ModutalkPlugin.VaultHost=VaultHost;ModutalkPlugin.frameBootstrap=frameBootstrap;ModutalkPlugin.safeFolder=safeFolder;
module.exports=ModutalkPlugin;
