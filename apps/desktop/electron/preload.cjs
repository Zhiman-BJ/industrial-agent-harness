const {contextBridge, ipcRenderer} = require('electron');

const api = {
  list: () => ipcRenderer.invoke('viewer:list'),
  choose: () => ipcRenderer.invoke('viewer:choose'),
  open: request => ipcRenderer.invoke('viewer:open', request),
  render: request => ipcRenderer.invoke('viewer:render', request),
  netlist: request => ipcRenderer.invoke('viewer:netlist', request),
  resolve: request => ipcRenderer.invoke('broker:resolve', request),
  detail: capabilityId => ipcRenderer.invoke('broker:detail', capabilityId),
  brokerTrace: () => ipcRenderer.invoke('broker:trace'),
  agentStatus: () => ipcRenderer.invoke('agent:status'),
  chooseProject: () => ipcRenderer.invoke('agent:choose-project'),
  projectFiles: () => ipcRenderer.invoke('project:list'),
  openProjectFile: relative => ipcRenderer.invoke('project:open', relative),
  runAgent: task => ipcRenderer.invoke('agent:run', task),
  approveAgent: (id, response) => ipcRenderer.invoke('agent:approve', {id, response}),
  interruptAgent: () => ipcRenderer.invoke('agent:interrupt'),
  onAgentEvent: callback => {const listener = (_event, value) => callback(value); ipcRenderer.on('agent:event', listener); return () => ipcRenderer.removeListener('agent:event', listener);},
};
contextBridge.exposeInMainWorld('viewerHost', api);
