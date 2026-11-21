'use strict';
const {Plugin,ItemView,PluginSettingTab,Setting,Modal,Notice,Platform,normalizePath,requestUrl}=require('obsidian');
// Custom default: six hours between automatic checks; lower checks on more opens.
const UPDATE_CHECK_INTERVAL_MS=6*60*60*1000;
// Custom default: 12 seconds (Obsidian Notice default is 5); higher stays longer, zero stays until dismissed.
const UPDATE_NOTICE_DURATION_MS=12000;
// Browser timer valid nonnegative range; larger permits longer user-selected delays.
const UPDATE_TIMER_MAX_MS=2147483647;
// Display-unit conversions, independent of user interaction speed.
const UPDATE_HOUR_MS=3600000,UPDATE_SECOND_MS=1000;
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

/** Update discovery is read-only. Trusted payloads must come from a repo release
 * with individually GitHub-hashed plugin assets, never from a URL in memo data. */
const UPDATE_API='https://api.github.com/repos/hoistes00-ctrl/memotalk/releases?per_page=25';
const PLUGIN_FILES=['app.html','styles.css','manifest.json','main.js'];
const PLUGIN_MAX_BYTES={'app.html':4*1024*1024,'styles.css':256*1024,'manifest.json':16*1024,'main.js':1024*1024};
function versionParts(value){
  if(typeof value!=='string'||!/^\d+\.\d+\.\d+$/.test(value))return null;
  return value.split('.').map(Number);
}
function compareVersions(a,b){
  const left=versionParts(a),right=versionParts(b);
  if(!left||!right)throw Error('invalid_version');
  for(let i=0;i<3;i++)if(left[i]!==right[i])return Math.sign(left[i]-right[i]);
  return 0;
}
function selectPluginUpdate(releases,installed,installedTag=''){
  if(!Array.isArray(releases))return null;
  const known=/^modutalk-obsidian-v(\d+\.\d+\.\d+)-(?:browser|virtual|test)\.(\d+)$/.exec(installedTag);
  const options=[];
  for(const release of releases){
    if(release?.draft||!release?.prerelease)continue;
    const match=/^modutalk-obsidian-v(\d+\.\d+\.\d+)-(?:browser|virtual|test)\.(\d+)$/.exec(release.tag_name||'');
    if(!match||!versionParts(installed))continue;
    const order=compareVersions(match[1],installed);
    if(order<0||(order===0&&(!known||known[1]!==installed||Number(match[2])<=Number(known[2]))))continue;
    if(release.html_url!=='https://github.com/hoistes00-ctrl/memotalk/releases/tag/'+release.tag_name)continue;
    const files=Object.fromEntries((release.assets||[]).filter(a=>PLUGIN_FILES.includes(a.name)).map(a=>[a.name,a]));
    if(!PLUGIN_FILES.every(name=>files[name]&&Number.isInteger(files[name].size)&&files[name].size>0&&
      files[name].size<=PLUGIN_MAX_BYTES[name]&&/^sha256:[a-f0-9]{64}$/.test(files[name].digest||'')&&
      files[name].browser_download_url===
       'https://github.com/hoistes00-ctrl/memotalk/releases/download/'+release.tag_name+'/'+name))continue;
    options.push({...release,version:match[1],build:Number(match[2]),files});
  }
  options.sort((a,b)=>compareVersions(b.version,a.version)||b.build-a.build);
  return options[0]||null;
}
async function sha256Hex(bytes){
  const data=new Uint8Array(await crypto.subtle.digest('SHA-256',bytes));
  return Array.from(data,b=>b.toString(16).padStart(2,'0')).join('');
}
async function fetchVerifiedPluginFiles(release,fetcher=requestUrl){
  const files={};
  for(const name of PLUGIN_FILES){
    const asset=release.files[name];
    const response=await fetcher({url:asset.browser_download_url,method:'GET',throw:false});
    if(response.status!==200)throw Error('update_http_'+response.status);
    const bytes=new Uint8Array(response.arrayBuffer);
    if(bytes.byteLength!==asset.size||bytes.byteLength>PLUGIN_MAX_BYTES[name]||
      'sha256:'+await sha256Hex(bytes)!==asset.digest)throw Error('update_checksum_'+name);
    files[name]=bytes;
  }
  const manifest=JSON.parse(new TextDecoder().decode(files['manifest.json']));
  if(manifest.id!=='modutalk-sync-view'||manifest.version!==release.version||manifest.isDesktopOnly!==false)
    throw Error('update_manifest_mismatch');
  if(!new TextDecoder().decode(files['app.html']).includes('<!--MODUTALK_BOOTSTRAP-->'))
    throw Error('update_missing_bootstrap');
  return files;
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
      const updateButton=controls.createEl('button',{cls:'modutalk-sync-menu-toggle',text:'업데이트',attr:{type:'button','aria-label':'모두톡 업데이트 확인'}});
      updateButton.addEventListener('click',()=>this.plugin.checkForUpdates({manual:true}));
      this.updateStatus();
      const frame=this.contentEl.createEl('iframe',{cls:'modutalk-sync-frame',attr:{title:'모두톡',sandbox:'allow-scripts allow-same-origin allow-forms allow-downloads allow-modals',allow:'clipboard-read; clipboard-write'}});
      this.frame=frame;frame.__modutalkHost=this.host;
      const config={groupId:this.host.groupId,storagePrefix:'modutalk.sync-view.'+this.host.groupId+'.'};
      const script='('+frameBootstrap.toString()+')('+JSON.stringify(config).replace(/</g,'\\u003c')+');';
      const html=await this.app.vault.adapter.read(this.plugin.manifest.dir+'/app.html');
      if(!html.includes('<!--MODUTALK_BOOTSTRAP-->'))throw Error('화면 파일이 올바르지 않습니다.');
      frame.srcdoc=html.replace('<!--MODUTALK_BOOTSTRAP-->','<script>'+script.replace(/<\/script/gi,'<\\/script')+'</script>');
      this.ready=true;this.plugin.refreshImmersive();
      void this.plugin.checkForUpdates({manual:false});
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
    this.plugin.addUpdateTuning(this.containerEl);
  }
}
class ModutalkPlugin extends Plugin {
  installedUpdateVersion(){
    const tag=this.data.appliedUpdateTag||'',known=/^modutalk-obsidian-v(\d+\.\d+\.\d+)-(?:browser|virtual|test)\.\d+$/.exec(tag);
    return {version:known&&compareVersions(known[1],this.manifest.version)>0?known[1]:this.manifest.version,tag};
  }
  updateSettingKey(name){return 'modutalk.sync-view.'+(this.data.groupId||'unconnected')+'.memotalk.hosted.'+name;}
  updateTiming(name,defaultValue){
    try{const raw=localStorage.getItem(this.updateSettingKey(name));if(raw!==null){const value=Number(raw);if(Number.isFinite(value)&&value>=0&&value<=UPDATE_TIMER_MAX_MS)return Math.round(value);}}catch(_){}
    return defaultValue;
  }
  rescheduleUpdateNotice(){
    clearTimeout(this.updateNoticeTimer);this.updateNoticeTimer=null;
    if(!this.updateNotice)return;
    const duration=this.updateTiming('updateNoticeMs',UPDATE_NOTICE_DURATION_MS);
    if(duration>0)this.updateNoticeTimer=setTimeout(()=>{this.updateNotice?.hide?.();this.updateNotice=null;},duration);
  }
  showUpdateNotice(message){
    this.updateNotice?.hide?.();this.updateNotice=new Notice(message,0);this.rescheduleUpdateNotice();
  }
  addUpdateTuning(container){
    const control=(name,label,description,defaultValue,unit)=>{
      let input;
      const setting=new Setting(container).setName(label).setDesc(description);
      const apply=()=>{input.setValue(String(this.updateTiming(name,defaultValue)/unit));if(name==='updateNoticeMs')this.rescheduleUpdateNotice();};
      setting.addText(text=>{
        input=text;text.inputEl.type='number';text.inputEl.min='0';text.inputEl.max=String(UPDATE_TIMER_MAX_MS/unit);text.inputEl.step=String(1/unit);
        text.onChange(value=>{const ms=Number(value)*unit;if(value.trim()===''||!Number.isFinite(ms)||ms<0||ms>UPDATE_TIMER_MAX_MS)return;try{localStorage.setItem(this.updateSettingKey(name),String(Math.round(ms)));}catch(_){this.showUpdateNotice('조절 값을 저장하지 못했습니다.');}if(name==='updateNoticeMs')this.rescheduleUpdateNotice();});
      }).addButton(button=>button.setButtonText('↺').setTooltip('기본값으로 복귀').onClick(()=>{try{localStorage.removeItem(this.updateSettingKey(name));}catch(_){}apply();}));
      apply();
    };
    control('updateIntervalMs','새 버전 자동 확인 간격 (시간)','0이면 화면을 열 때마다 확인합니다. 변경한 값은 다음 확인에 바로 적용됩니다.',UPDATE_CHECK_INTERVAL_MS,UPDATE_HOUR_MS);
    control('updateNoticeMs','업데이트 안내 표시 시간 (초)','현재 열린 안내에도 즉시 적용됩니다. 0이면 직접 닫을 때까지 표시합니다.',UPDATE_NOTICE_DURATION_MS,UPDATE_SECOND_MS);
  }
  async ensureUpgradeSafe(){
    for(const leaf of this.app.workspace?.getLeavesOfType?.(VIEW_TYPE)||[]){
      const w=leaf.view.frame?.contentWindow;if(!w?.__modutalkHostReady)continue;
      if(w.document.querySelector('#input')?.value||!w.document.querySelector('#editbar')?.hidden||w.document.querySelectorAll('#pending img').length)
        throw Error('작성 중인 메모·수정·사진을 먼저 저장해 주세요.');
      const cfg=JSON.parse(w.localStorage.getItem('memotalk.peer.config')||'null');
      const state=cfg?.groupId?await w.MemoTalkPeerClient.stateStore(cfg.groupId):null;
      if(state?.outbox?.length||state?.pending)throw Error('보낼 공유 기록의 처리가 끝난 뒤 다시 업그레이드해 주세요.');
    }
  }
  async checkForUpdates({manual=false}={}){
    if(this.updating||this.checking)return;
    // Regular opens do not cause repeated prompts or block the memo editor.
    if(!manual&&Date.now()-(this.data.lastUpdateCheckAt||0)<this.updateTiming('updateIntervalMs',UPDATE_CHECK_INTERVAL_MS))return;
    this.checking=true;
    try{
      const reply=await requestUrl({url:UPDATE_API,headers:{Accept:'application/vnd.github+json'},throw:false});
      if(reply.status!==200)throw Error('업데이트 서버에 연결할 수 없습니다.');
      const installed=this.installedUpdateVersion(),release=selectPluginUpdate(reply.json,installed.version,installed.tag);
      this.data.lastUpdateCheckAt=Date.now();await this.saveData(this.data);
      if(!release){if(manual)this.showUpdateNotice(installed.version!==this.manifest.version?'다운로드한 업데이트를 적용하려면 모두톡 플러그인을 껐다 켜 주세요.':'현재 최신 모두톡 연동 플러그인을 사용 중입니다.');return;}
      if(!manual&&this.data.dismissedUpdateTag===release.tag_name)return;
      this.showUpdateChoice(release);
    }catch(e){if(manual)this.showUpdateNotice('업데이트 확인 실패: '+String(e.message||e));}
    finally{this.checking=false;}
  }
  showUpdateChoice(release){
    const modal=new Modal(this.app);
    modal.onOpen=()=>{
      modal.contentEl.createEl('h3',{text:'모두톡 새 버전 '+release.version});
      modal.contentEl.createEl('p',{text:'현재 '+this.manifest.version+' → '+release.version+'. 기존 메모·공유 폴더는 변경하지 않습니다. 업그레이드는 선택 사항입니다.'});
      new Setting(modal.contentEl)
        .addButton(b=>b.setButtonText('나중에').onClick(async()=>{
          this.data.dismissedUpdateTag=release.tag_name;await this.saveData(this.data);modal.close();
        }))
        .addButton(b=>b.setButtonText('업그레이드').setCta().onClick(()=>{
          modal.close();void this.installPluginUpdate(release);
        }));
    };
    modal.open();
  }
  async installPluginUpdate(release){
    if(this.updating)return;
    this.updating=true;
    this.showUpdateNotice('업데이트 파일을 검증하고 있습니다.');
    let backup=null,wrote=false,rollbackVerified=false,restorationFailures=[];
    try{
      const installed=this.installedUpdateVersion(),selected=selectPluginUpdate([release],installed.version,installed.tag);
      if(!selected)throw Error('이미 설치됐거나 검증 대상이 아닌 버전입니다.');
      release=selected;await this.ensureUpgradeSafe();
      // All bytes and checksums are verified BEFORE modifying a plugin file.
      const files=await fetchVerifiedPluginFiles(release);
      await this.ensureUpgradeSafe();
      const adapter=this.app.vault.adapter,dir=this.manifest.dir;
      if(!dir||!dir.endsWith('/'+this.manifest.id))throw Error('plugin_dir_invalid');
      const original={},originalData=JSON.parse(JSON.stringify(this.data));
      for(const name of PLUGIN_FILES)original[name]=new Uint8Array(await adapter.readBinary(dir+'/'+name));
      const originalConfig=await adapter.exists(dir+'/data.json')?new Uint8Array(await adapter.readBinary(dir+'/data.json')):null;
      // Persistent copies recover even from an unexpected app exit while writing.
      backup=dir+'/.modutalk-backup-'+this.manifest.version+'-'+crypto.randomUUID();
      await adapter.mkdir(backup);
      const originals={...original,...(originalConfig?{'data.json':originalConfig}:{})};
      for(const [name,bytes]of Object.entries(originals)){
        await adapter.writeBinary(backup+'/'+name,bytes.buffer);
        if(await sha256Hex(new Uint8Array(await adapter.readBinary(backup+'/'+name)))!==await sha256Hex(bytes))throw Error('update_backup_verify_'+name);
      }
      const attempted=[];let configAttempted=false;
      try{
        // A concurrent external edit must be detected before touching live code.
        for(const name of PLUGIN_FILES)if(await sha256Hex(new Uint8Array(await adapter.readBinary(dir+'/'+name)))!==await sha256Hex(original[name]))throw Error('update_source_changed_'+name);
        for(const name of PLUGIN_FILES){
          wrote=true;attempted.push(name);
          await adapter.writeBinary(dir+'/'+name,files[name].buffer);
          const verify=new Uint8Array(await adapter.readBinary(dir+'/'+name));
          if('sha256:'+await sha256Hex(verify)!==release.files[name].digest)
            throw Error('update_write_verify_'+name);
        }
        this.data.appliedUpdateTag=release.tag_name;
        this.data.dismissedUpdateTag='';this.data.lastUpdateBackup=backup;
        configAttempted=true;await this.saveData(this.data);
      }catch(e){
        for(const name of attempted){
          try{await adapter.writeBinary(dir+'/'+name,original[name].buffer);if(await sha256Hex(new Uint8Array(await adapter.readBinary(dir+'/'+name)))!==await sha256Hex(original[name]))throw Error('restore_verify');}catch(_){restorationFailures.push(name);}
        }
        this.data=originalData;
        if(configAttempted&&originalConfig){try{await adapter.writeBinary(dir+'/data.json',originalConfig.buffer);if(await sha256Hex(new Uint8Array(await adapter.readBinary(dir+'/data.json')))!==await sha256Hex(originalConfig))throw Error('restore_config_verify');}catch(_){restorationFailures.push('data.json');}}
        rollbackVerified=wrote&&restorationFailures.length===0;
        throw e;
      }
      this.lastUpdateResult={ok:true,version:release.version,tag:release.tag_name,backup};
      this.showUpdateNotice('모두톡 '+release.version+' 설치 완료. Obsidian에서 모두톡 플러그인을 껐다 켜면 적용됩니다.');
      return this.lastUpdateResult;
    }catch(e){
      const detail=restorationFailures.length?'복원 확인에 실패했습니다 ('+restorationFailures.join(', ')+'). 보관한 이전 파일로 복구가 필요합니다.':rollbackVerified?'이전 파일 복원을 확인했습니다.':'기존 플러그인 파일을 변경하지 않았습니다.';
      this.lastUpdateResult={ok:false,error:String(e.message||e),backup,rollbackVerified,restorationFailures};
      this.showUpdateNotice('업그레이드 실패. '+detail+' '+String(e.message||e));
      return this.lastUpdateResult;
    }finally{this.updating=false;}
  }
  refreshImmersive(){
    if(!Platform.isMobileApp)return;
    const active=this.app.workspace.activeLeaf?.view;
    const immersive=active instanceof ModutalkView&&active.ready&&!active.showObsidianChrome;
    document.body.classList.toggle('modutalk-immersive',immersive);
  }
  async onload(){
    this.data=Object.assign({folder:'',groupId:null,lastUpdateCheckAt:0,dismissedUpdateTag:''},await this.loadData()||{});
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
    clearTimeout(this.updateNoticeTimer);this.updateNotice?.hide?.();this.updateNotice=null;
    document.body.classList.remove('modutalk-immersive');
    for(const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE))leaf.view.host?.dispose();
  }
}
ModutalkPlugin.selectPluginUpdate=selectPluginUpdate;
ModutalkPlugin.fetchVerifiedPluginFiles=fetchVerifiedPluginFiles;
ModutalkPlugin.VaultHost=VaultHost;ModutalkPlugin.frameBootstrap=frameBootstrap;ModutalkPlugin.safeFolder=safeFolder;
module.exports=ModutalkPlugin;
