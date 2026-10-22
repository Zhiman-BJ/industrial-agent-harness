'use strict';

const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('replayHost', {
  metadata: () => ipcRenderer.invoke('replay:metadata'),
  page: request => ipcRenderer.invoke('replay:page', request),
  control: request => ipcRenderer.invoke('replay:control', request),
  image: assetId => ipcRenderer.invoke('replay:image', assetId),
  flow: request => ipcRenderer.invoke('replay:flow', request),
  onChanged: callback => {
    const listener = (_event, state) => callback(state);
    ipcRenderer.on('replay:changed', listener);
    return () => ipcRenderer.removeListener('replay:changed', listener);
  },
});
