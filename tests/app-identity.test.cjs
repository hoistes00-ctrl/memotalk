'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {createRequire}=require('node:module');
const info=JSON.parse(fs.readFileSync('app-info.json','utf8'));

test('all distributed UI and package versions use the same Modutalk identity',()=>{
  const pkg=JSON.parse(fs.readFileSync('windows/package.json','utf8'));
  const native=JSON.parse(fs.readFileSync('windows/app-info.json','utf8'));
  const gradle=fs.readFileSync('android/app/build.gradle','utf8');
  const ui=fs.readFileSync('shared/index.html','utf8');
  assert.equal(info.displayName,'모두톡');assert.match(info.version,/^\d+\.\d+\.\d+$/);
  assert.equal(pkg.version,info.version);assert.deepEqual(native,info);
  assert.equal(pkg.build.productName,info.displayName);assert.equal(pkg.build.nsis.shortcutName,info.displayName);
  assert.ok(pkg.build.files.includes('app-info.json'));
  assert.ok(ui.includes('<title>'+info.displayName+' '+info.version+'</title>'));
  assert.ok(ui.includes('<h1>'+info.displayName+'</h1>'));assert.ok(!ui.includes('메모톡'));
  assert.match(gradle,/versionName appInfo\.version/);assert.match(gradle,/versionCode \(?appInfo\.androidVersionCode/);
  assert.ok(!gradle.includes("applicationLabel:'메모톡"));assert.ok(!gradle.includes('공유 시험판'));
  const debugManifest=fs.readFileSync('android/app/src/debug/AndroidManifest.xml','utf8');
  assert.ok(debugManifest.includes('android:label="${applicationLabel}"'));assert.ok(!debugManifest.includes('메모톡 테스트'));
  assert.equal(info.androidApplicationId,'kr.memotalk.app.sharingpreview5.syncfix');
  assert.equal(pkg.name,'memotalk-desktop');assert.equal(pkg.build.appId,'kr.memotalk.desktop');
});

function boot(override){
  const paths={appData:path.resolve('synthetic-roaming')},names=[];
  const realRequire=createRequire(path.resolve('windows/main.js'));
  const app={commandLine:{getSwitchValue:()=>override||''},getPath:key=>paths[key],setPath:(key,value)=>{paths[key]=value},setName:value=>names.push(value),whenReady:()=>({then(){}}),on(){}};
  const sandbox={require:name=>name==='electron'?{app,protocol:{registerSchemesAsPrivileged(){}}}:realRequire(name),process,console,module:{exports:{}}};
  vm.runInNewContext(fs.readFileSync('windows/main.js','utf8'),sandbox);
  return {paths,names};
}
test('renaming the installed Windows app retains the original default user and session profile',()=>{
  const {paths,names}=boot();
  assert.equal(paths.userData,path.join(paths.appData,'memotalk-desktop'));
  assert.equal(paths.sessionData,paths.userData);assert.deepEqual(names,['모두톡']);
});
test('explicit isolated profiles still override the preserved default profile',()=>{
  const custom=path.resolve('synthetic-isolated-profile'),{paths}=boot(custom);
  assert.equal(paths.userData,custom);assert.equal(paths.sessionData,custom);
});
