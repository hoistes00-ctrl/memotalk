from playwright.sync_api import sync_playwright
from pathlib import Path
root=Path(__file__).parent/'shared'
html=(root/'index.html').read_text().replace('<script src="platform-bridge.js"></script>', '<script>'+(root/'platform-bridge.js').read_text()+'</script>')
MOCK=r'''
(() => {
  const tree = new Map([['',{kind:'directory'}]]);
  let connected = false;
  function path(parts) {return parts.join('/');}
  const enc = bytes => btoa(Array.from(bytes, b => String.fromCharCode(b)).join(''));
  const dec = s => Uint8Array.from(atob(s), c=>c.charCodeAt(0));
  window.__testTree = tree;
  window.AndroidMemoTalk = {
    postMessage(payload) {
      const {id,command,args}=JSON.parse(payload);
      Promise.resolve().then(() => {
        const key=path(args.path||[]);
        let result = null, error=null;
        try {
          if(command==='pickFolder'){connected=true;result={connected:true,name:'MemoTalkMock'};}
          else if(command==='hasFolder')result={connected,name:'MemoTalkMock'};
          else if(command==='disconnect'){connected=false;result=true;}
          else if(command==='stat')result=tree.has(key)?{exists:true,kind:tree.get(key).kind}:{exists:false};
          else if(command==='mkdir'){tree.set(key,{kind:'directory'});result={exists:true,kind:'directory'};}
          else if(command==='touch'){if(!tree.has(key))tree.set(key,{kind:'file',data:new Uint8Array()});result={exists:true,kind:'file'};}
          else if(command==='list')result=[...tree.entries()].filter(([name,item])=> name && name.slice(0,name.lastIndexOf('/'))===key || (key==='' && name && !name.includes('/'))).map(([name,item])=>({name:name.split('/').pop(),kind:item.kind}));
          else if(command==='read'){if(!tree.has(key))throw Error('not found');result={base64:enc(tree.get(key).data)};}
          else if(command==='write'){tree.set(key,{kind:'file',data:dec(args.base64)});result=true;}
          else if(command==='remove'){tree.delete(key);result=true;}
          else if(command==='download'){result=true;}
          else throw Error('unknown command '+command);
        } catch(e) {error=e.message;}
        window.__memoNativeResolve?.({id,result,error});
      });
    }
  };
})();
'''
try:
 with sync_playwright() as p:
  browser=p.chromium.launch(headless=True, executable_path='/usr/bin/chromium', args=['--no-sandbox','--disable-dev-shm-usage'])
  page=browser.new_page(viewport={'width':412,'height':860})
  page.evaluate('''() => {const map = new Map();Object.defineProperty(window,'localStorage',{configurable:true,value:{getItem:k=>map.has(k)?map.get(k):null,setItem:(k,v)=>map.set(k,String(v)),removeItem:k=>map.delete(k)}})}''')
  page.evaluate(MOCK)
  errors=[]
  page.on('pageerror',lambda e:errors.append(str(e)))
  page.set_content(html,wait_until='domcontentloaded')
  page.wait_for_selector('.room[data-id]',timeout=15000)
  assert page.evaluate('Boolean(window.MemoTalkFS)')
  page.locator('.room[data-id]').first.click()
  page.locator('#input').fill('앱에 보낸 메모    \n')
  page.locator('#btn-send').click()
  page.wait_for_function('document.querySelector("#input").value === ""',timeout=5000)
  assert '앱에 보낸 메모' in page.locator('#msgs').inner_text()
  page.locator('#btn-back').click()
  page.locator('#btn-file-folder').click()
  page.get_by_text('실제 저장 폴더 연결',exact=False).last.click()
  page.wait_for_function('window.__testTree.has("manifest.json")',timeout=10000)
  info=page.evaluate('''() => [...window.__testTree.keys()]''')
  assert any(k.endswith('.md') for k in info), info
  assert 'manifest.json' in info, info
  print('SMOKE OK: 메모 전송/입력창 초기화/네이티브 폴더 Markdown 생성')
  print('Files:',info[:12])
  print('Page errors:',errors)
  assert not errors,errors
  browser.close()
finally: pass
