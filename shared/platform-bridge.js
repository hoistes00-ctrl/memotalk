/* MemoTalk: native filesystem bridge for Android WebView and Electron.
   Never exposes arbitrary paths to HTML: native implementations limit commands
   to the explicitly selected folder. Desktop/Android do not auto-sync. */
(() => {
  'use strict';
  // Four 32-bit words identify this renderer session; increasing adds nonce entropy.
  const SESSION_NONCE_WORDS=4;
  const clientSession=crypto.randomUUID?.()||Array.from(crypto.getRandomValues(new Uint32Array(SESSION_NONCE_WORDS)),n=>n.toString(16)).join('-');
  const native = window.MemoTalkNative || (window.AndroidMemoTalk ? {
    request(command, args = {}) {
      return new Promise((resolve, reject) => {
        const id = ++sequence;
        pending.set(id, { resolve, reject });
        try { window.AndroidMemoTalk.postMessage(JSON.stringify({ id, command, args, session:clientSession })); }
        catch (error) { pending.delete(id); reject(error); }
      });
    }
  } : null);
  if (!native) return;

  let sequence = 0;
  const pending = new Map();
  window.__memoNativeResolve = response => {
    if(response.session&&response.session!==clientSession)return;
    const p = pending.get(response.id);
    if (!p) return;
    pending.delete(response.id);
    if (response.error) p.reject(typeof response.error==='object' ? Object.assign(new Error(response.error.message),response.error) : new Error(response.error));
    else p.resolve(response.result);
  };
  const ask = async (command, args = {}) => {
    let response;
    try{response=await native.request(command,args);}catch(error){
      if(error.code==='ENOENT'||error.message==='NotFoundError')error.name='NotFoundError';
      if(error.message==='cancelled')error.name='AbortError';
      throw error;
    }
    if (response?.ok === false) {
      const error=Object.assign(new Error(response.error.message),response.error);
      if(error.code==='ENOENT')error.name='NotFoundError';
      throw error;
    }
    return response?.ok === true ? response.result : response;
  };
  function assertName(name) {
    if (typeof name !== 'string' || !name || name === '.' || name === '..' || /[\\/\x00-\x1f]/.test(name)) {
      throw new TypeError('올바르지 않은 파일/폴더 이름');
    }
    return name;
  }
  function notFound() { return new DOMException('파일이 없습니다', 'NotFoundError'); }
  function wrongType() { return new DOMException('다른 종류의 항목입니다', 'TypeMismatchError'); }
  function toBase64(bytes) {
    const step = 16384;
    let binary = '';
    for (let i = 0; i < bytes.length; i += step) binary += String.fromCharCode(...bytes.subarray(i, i + step));
    return btoa(binary);
  }
  function fromBase64(str) {
    const binary = atob(str), data = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) data[i] = binary.charCodeAt(i);
    return data;
  }
  class NativeFile {
    constructor(parts, context) { this.context=context; this.parts = parts; this.kind = 'file'; this.name = parts.at(-1); }
    async getFile() {
      const result = await ask('read', { path: this.parts, ...this.context });
      if (!result || typeof result.base64 !== 'string') throw notFound();
      return new File([fromBase64(result.base64)], this.name, { lastModified: Date.now() });
    }

  }
  // Writer keeps a stable path and buffers each file until close().
  NativeFile.prototype.createWritable = async function(options = {}) {
    const filePath = this.parts.slice(), chunks = [], context=this.context;
    let closed = false;
    const expected = options.expectedBytes;
    const baseline = expected === null ? null : expected instanceof Uint8Array ? toBase64(expected) : toBase64(new Uint8Array(await (await this.getFile()).arrayBuffer()));
    return {
      async write(value) {
        if (closed) throw new Error('이미 닫힌 파일');
        let data;
        if (value instanceof Blob) data = new Uint8Array(await value.arrayBuffer());
        else if (typeof value === 'string') data = new TextEncoder().encode(value);
        else if (value instanceof ArrayBuffer) data = new Uint8Array(value);
        else if (ArrayBuffer.isView(value)) data = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
        else throw new TypeError('지원되지 않는 쓰기 형식');
        chunks.push(data);
      },
      async close() {
        if (closed) return;
        closed = true;
        const length = chunks.reduce((sum, b) => sum+b.length, 0);
        const all = new Uint8Array(length);
        let index = 0;
        for (const chunk of chunks) { all.set(chunk, index); index += chunk.length; }
        await ask('write', { path: filePath, base64: toBase64(all), expectedBase64:baseline, ...context });
      },
      async abort() { closed = true; chunks.length = 0; }
    };
  };
  class NativeDir {
    constructor(parts, name, context={}) { this.context=context; this.parts = parts; this.name = name; this.kind = 'directory'; }
    async getDirectoryHandle(name, options = {}) {
      assertName(name);
      const path = [...this.parts, name];
      const result = await ask(options.create ? 'mkdir' : 'stat', { path, ...this.context });
      if (!result || !result.exists) throw notFound();
      if (result.kind !== 'directory') throw wrongType();
      return new NativeDir(path, name, this.context);
    }
    async getFileHandle(name, options = {}) {
      assertName(name);
      const path = [...this.parts, name];
      const result = await ask(options.create && !window.MemoTalkNative && !this.context.atomicWrites ? 'touch' : 'stat', { path, ...this.context });
      if ((!result || !result.exists) && options.create) return new NativeFile(path, this.context);
      if (!result || !result.exists) throw notFound();
      if (result.kind !== 'file') throw wrongType();
      return new NativeFile(path, this.context);
    }
    async removeEntry(name, options = {}) {
      assertName(name);
      if (options.recursive) throw new Error('안전을 위해 재귀 삭제는 지원하지 않습니다');
      return ask('remove', { path: [...this.parts, name], ...this.context });
    }
    async *values() {
      const entries = await ask('list', { path: this.parts, ...this.context });
      for (const entry of entries) yield entry.kind === 'directory'
        ? new NativeDir([...this.parts, entry.name], entry.name, this.context)
        : new NativeFile([...this.parts, entry.name], this.context);
    }
    async queryPermission() { return (await ask('hasFolder')).connected ? 'granted' : 'denied'; }
    async requestPermission() { return this.queryPermission(); }
  }
  async function restore() {
    const status = await ask('hasFolder');
    const linkId = localStorage.getItem('memotalk.nativeFolder.linkId');
    if (!status.connected || !linkId) return null;
    return { handle: new NativeDir([], status.name, {folderToken:status.folderToken,atomicWrites:!!status.atomicWrites}), linkId };
  }
  window.MemoTalkFS = {
    restore,
    async beginMirror(root) {
      if(!window.MemoTalkNative&&!root.context.atomicWrites)return;
      const lease=await ask('beginMirror',root.context);
      root.context.leaseId=lease.leaseId;
    },
    async endMirror(root) {
      if((!window.MemoTalkNative&&!root.context.atomicWrites)||!root.context.leaseId)return;
      try{await ask('endMirror',root.context);}finally{delete root.context.leaseId;}
    },
    async put(value) { localStorage.setItem('memotalk.nativeFolder.linkId', value.linkId); },
    async clear() {
      await ask('disconnect');
      localStorage.removeItem('memotalk.nativeFolder.linkId');
    },
    async download(name, blob) {
      const data = new Uint8Array(await blob.arrayBuffer());
      return ask('download', { name, base64: toBase64(data) });
    }
  };
  window.showDirectoryPicker = async () => {
    const status = await ask('pickFolder');
    if (!status || !status.connected) throw new DOMException('폴더 선택 취소', 'AbortError');
    return new NativeDir([], status.name, {folderToken:status.folderToken,atomicWrites:!!status.atomicWrites});
  };
})();
