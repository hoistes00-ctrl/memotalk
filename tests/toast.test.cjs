'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const html=fs.readFileSync('shared/index.html','utf8');
function fixture(){
  let now=0,seq=0;const timers=new Map(),visible=[];
  const tuning={toast:2500,toastFade:250};
  const context=vm.createContext({tuning,
    setTimeout:(fn,delay)=>{const id=++seq;timers.set(id,{fn,at:now+delay});return id;},
    clearTimeout:id=>timers.delete(id),
    document:{body:{appendChild:el=>visible.push(el)},documentElement:{style:{setProperty(){}}},
      createElement:()=>{const classes=new Set();const el={classList:{add:s=>classes.add(s),remove:s=>classes.delete(s),contains:s=>classes.has(s)},setAttribute(){},remove(){visible.splice(visible.indexOf(el),1);}};return el;}}});
  const source=html.slice(html.indexOf('let toastEl = null'),html.indexOf('/* ---------- sheets'));
  const apply=html.slice(html.indexOf('function applyTuning()'),html.indexOf('\napplyTuning();'));
  vm.runInContext(source+'\n'+apply,context);
  const advance=ms=>{const end=now+ms;while(true){const pending=[...timers].filter(([,v])=>v.at<=end).sort((a,b)=>a[1].at-b[1].at)[0];if(!pending)break;now=pending[1].at;timers.delete(pending[0]);pending[1].fn();}now=end;};
  return {context,tuning,visible,advance,run:code=>vm.runInContext(code,context)};
}
test('legacy sticky error fades after 2.5 seconds and is removed after the fade',()=>{
  const f=fixture();f.run("toast('failed sharing',true)");f.advance(2499);
  assert.equal(f.visible.length,1);assert.equal(f.visible[0].classList.contains('toast-out'),false);
  f.advance(1);assert.equal(f.visible[0].classList.contains('toast-out'),true);
  f.advance(249);assert.equal(f.visible.length,1);f.advance(1);assert.equal(f.visible.length,0);
});
test('a new notification survives an older fading notification removal',()=>{
  const f=fixture();f.run("toast('old',true)");f.advance(2500);f.advance(100);
  f.run("toast('new',true)");f.advance(150);
  assert.equal(f.visible.length,1);assert.equal(f.visible[0].textContent,'new');
  assert.equal(f.visible[0].classList.contains('toast-out'),false);
  f.advance(2600);assert.equal(f.visible.length,0);
});
test('live duration and fade settings apply to the notification already on screen',()=>{
  const f=fixture();f.run("toast('visible',true)");f.tuning.toast=100;f.tuning.toastFade=0;
  f.run('applyTuning()');f.advance(99);assert.equal(f.visible.length,1);
  f.advance(1);assert.equal(f.visible.length,0);
  f.run('hideToast()');assert.equal(f.visible.length,0);
});
