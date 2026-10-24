'use strict';
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('replayControls', {
  metadata: () => ipcRenderer.invoke('replay:metadata'),
  control: request => ipcRenderer.invoke('replay:control', request),
  page: request => ipcRenderer.invoke('replay:page', request),
  onChanged: callback => {
    const listener = (_event, state) => callback(state);
    ipcRenderer.on('replay:changed', listener);
    return () => ipcRenderer.removeListener('replay:changed', listener);
  },
});
