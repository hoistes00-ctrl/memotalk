'use strict';
const { contextBridge, ipcRenderer } = require('electron');
// Only these operations cross the renderer/native boundary.
contextBridge.exposeInMainWorld('MemoTalkNative', {
  version: (process.argv.find(arg=>/^--modutalk-version=\d+\.\d+\.\d+$/.test(arg))||'').split('=')[1]||null,
  request(command, args = {}) { return ipcRenderer.invoke('memotalk:request', { command, args }); }
});
