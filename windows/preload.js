'use strict';
const { contextBridge, ipcRenderer } = require('electron');
// Only these operations cross the renderer/native boundary.
contextBridge.exposeInMainWorld('MemoTalkNative', {
  request(command, args = {}) { return ipcRenderer.invoke('memotalk:request', { command, args }); }
});
