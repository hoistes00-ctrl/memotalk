'use strict';
const { app, BrowserWindow, ipcMain, dialog, protocol, net, shell } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const crypto = require('node:crypto');

protocol.registerSchemesAsPrivileged([
  { scheme: 'memotalk', privileges: { secure: true, standard: true, supportFetchAPI: true, stream: true } }
]);
let windowRef;
const memoWindows=new Set();
const settingsPath = () => path.join(app.getPath('userData'), 'native-folder.json');
let chosenFolder = null;
async function loadFolder() {
  try {
    const obj = JSON.parse(await fs.readFile(settingsPath(), 'utf8'));
    if (typeof obj.folder === 'string') {
      const stats = await fs.stat(obj.folder);
      if (stats.isDirectory()) chosenFolder = obj.folder;
    }
  } catch (_) {}
}
async function persistFolder() {
  if (chosenFolder) await fs.writeFile(settingsPath(), JSON.stringify({folder: chosenFolder}), { mode: 0o600 });
  else await fs.rm(settingsPath(), { force: true });
}
function verifyPath(parts, allowRoot = false) {
  if (!chosenFolder) throw new Error('먼저 저장 폴더를 선택하세요');
  if (!Array.isArray(parts) || (!allowRoot && !parts.length) || parts.length > 32) throw new Error('잘못된 경로');
  for (const segment of parts) {
    if (typeof segment !== 'string' || !segment || segment === '.' || segment === '..' || /[\\/\0-\x1f]/.test(segment)) {
      throw new Error('허용되지 않는 경로 이름');
    }
  }
  const base = path.resolve(chosenFolder);
  const abs = path.resolve(base, ...parts);
  if (abs !== base && !abs.startsWith(base + path.sep)) throw new Error('저장 폴더 외부 접근 차단');
  return abs;
}
async function assertNoSymlinks(target) {
  const base = path.resolve(chosenFolder);
  let at = base;
  const parts = path.relative(base, target).split(path.sep).filter(Boolean);
  for (const part of parts) {
    at = path.join(at, part);
    try { if ((await fs.lstat(at)).isSymbolicLink()) throw new Error('심볼릭 링크는 지원하지 않아요'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}
async function nativeStat(abs) {
  try {
    const stat = await fs.lstat(abs);
    if (stat.isSymbolicLink()) throw new Error('심볼릭 링크는 지원하지 않아요');
    return { exists:true, kind:stat.isDirectory()?'directory':'file' };
  } catch (error) {
    if (error.code === 'ENOENT') return {exists:false};
    throw error;
  }
}
function safeDownloadName(name) {
  if (typeof name !== 'string') throw new Error('잘못된 파일 이름');
  return name.replace(/[\\/<>:"|?*\x00-\x1f]/g, '_').slice(0, 120) || 'memotalk.zip';
}
const MAX_NATIVE_BYTES = 64 * 1024 * 1024;
async function perform(command, args = {}, ownerWindow = windowRef) {
  if (command === 'hasFolder') return { connected:!!chosenFolder, name:chosenFolder?path.basename(chosenFolder):null };
  if (command === 'pickFolder') {
    const result = await dialog.showOpenDialog(ownerWindow, {
      title: '메모톡 저장 폴더 선택 (가능하면 빈 폴더)',
      properties: ['openDirectory', 'createDirectory']
    });
    if (result.canceled || !result.filePaths.length) return {connected:false};
    chosenFolder = result.filePaths[0];
    await persistFolder();
    return {connected:true, name:path.basename(chosenFolder)};
  }
  if (command === 'disconnect') { chosenFolder = null; await persistFolder(); return true; }
  if (command === 'download') {
    const name = safeDownloadName(args.name);
    const binary = Buffer.from(args.base64 || '', 'base64');
    if (binary.length > MAX_NATIVE_BYTES) throw new Error('한 번에 저장 가능한 파일은 64MB까지입니다');
    const result = await dialog.showSaveDialog(ownerWindow, {title:'메모톡 파일 저장',defaultPath:path.join(app.getPath('downloads'),name)});
    if(result.canceled || !result.filePath) throw new Error('cancelled');
    await fs.writeFile(result.filePath, binary);
    return true;
  }
  const p = verifyPath(args.path, command==='list' || command==='stat');
  await assertNoSymlinks(p);
  if(command==='stat') return nativeStat(p);
  if(command==='list') {
    const values = await fs.readdir(p,{withFileTypes:true});
    return values.filter(v=>!v.isSymbolicLink()).map(v=>({name:v.name,kind:v.isDirectory()?'directory':'file'}));
  }
  if(command==='mkdir') {
    const existing=await nativeStat(p);
    if(existing.exists) return existing;
    await fs.mkdir(p); return {exists:true,kind:'directory'};
  }
  if(command==='touch') {
    const s = await nativeStat(p);
    if(s.exists) return s;
    const file = await fs.open(p,'wx'); await file.close();
    return {exists:true,kind:'file'};
  }
  if(command==='read') {
    const data = await fs.readFile(p);
    if(data.length>MAX_NATIVE_BYTES) throw new Error('파일이 너무 큽니다 (64MB 제한)');
    return {base64:data.toString('base64')};
  }
  if(command==='write') {
    const data=Buffer.from(args.base64 || '', 'base64');
    if(data.length>MAX_NATIVE_BYTES) throw new Error('파일이 너무 큽니다 (64MB 제한)');
    // Write via temporary file and replace; index is committed last by the HTML layer.
    const tmp=p+'.memotalk-tmp-'+crypto.randomBytes(6).toString('hex');
    try { await fs.writeFile(tmp,data,{flag:'wx'}); await fs.rename(tmp,p); }
    finally {await fs.rm(tmp,{force:true}).catch(()=>{});}
    return true;
  }
  if(command==='remove') {
    const entry = await nativeStat(p);
    if(!entry.exists) throw new Error('NotFoundError');
    if(entry.kind==='directory') await fs.rmdir(p);
    else await fs.rm(p,{force:false});
    return true;
  }
  throw new Error('지원하지 않는 작업');
}

app.whenReady().then(async () => {
  await loadFolder();
  const assetDirectory=app.isPackaged
    ? path.join(process.resourcesPath,'web')
    : path.resolve(__dirname,'..','shared');
  protocol.handle('memotalk',async request=>{
    const uri=new URL(request.url);
    const rel=decodeURIComponent(uri.pathname.replace(/^\/+/,''))||'index.html';
    const candidate=path.resolve(assetDirectory,rel);
    if(candidate!==assetDirectory&&!candidate.startsWith(assetDirectory+path.sep))
      return new Response('Forbidden',{status:403});
    try{await fs.access(candidate);}catch(_){return new Response('Not found',{status:404});}
    return net.fetch(pathToFileURL(candidate).toString());
  });
  function createMemoWindow(roomId=null,roomTitle='메모방'){
    const child=Boolean(roomId);
    const win=new BrowserWindow({
      width:child?780:1120,height:child?700:800,
      minWidth:390,minHeight:480,resizable:true,maximizable:true,
      title:child?'메모톡 · '+roomTitle:'메모톡',
      backgroundColor:'#F5F6F8',
      webPreferences:{
        preload:path.join(__dirname,'preload.js'),
        contextIsolation:true,nodeIntegration:false,sandbox:true,webSecurity:true
      }
    });
    memoWindows.add(win);
    win.on('closed',()=>{memoWindows.delete(win);if(windowRef===win)windowRef=null;});
    win.webContents.setWindowOpenHandler(({url})=>{
      if(url.startsWith('https://')||url.startsWith('http://'))shell.openExternal(url);
      return {action:'deny'};
    });
    win.webContents.on('will-navigate',(event,target)=>{
      if(!target.startsWith('memotalk://app/'))event.preventDefault();
    });
    const url='memotalk://app/index.html'+(roomId?'#room='+encodeURIComponent(roomId):'');
    win.loadURL(url).catch(error=>console.error('MemoTalk window load error:',error));
    return win;
  }
  ipcMain.handle('memotalk:request',async(event,request)=>{
    const owner=BrowserWindow.fromWebContents(event.sender);
    if(!owner||!memoWindows.has(owner)||!event.sender.getURL().startsWith('memotalk://app/index.html'))
      throw new Error('허용되지 않은 요청');
    if(!request||typeof request.command!=='string')throw new Error('잘못된 요청');
    const args=request.args&&typeof request.args==='object'?request.args:{};
    if(request.command==='openRoomWindow'){
      const id=args.roomId;
      if(typeof id!=='string'||!id||id.length>256||/[\u0000-\u001f]/.test(id))
        throw new Error('잘못된 메모방 ID');
      const title=typeof args.title==='string'?args.title.slice(0,80):'메모방';
      createMemoWindow(id,title);
      return {opened:true};
    }
    return perform(request.command,args,owner);
  });
  windowRef=createMemoWindow();
});
app.on('window-all-closed',()=>{if(process.platform!=='darwin')app.quit();});
