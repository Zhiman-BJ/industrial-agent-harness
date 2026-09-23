const {contextBridge, ipcRenderer} = require('electron');

const api = {
  open: request => ipcRenderer.invoke('viewer:open', request),
  render: request => ipcRenderer.invoke('viewer:render', request),
  netlist: request => ipcRenderer.invoke('viewer:netlist', request),
  resolve: request => ipcRenderer.invoke('broker:resolve', request),
  domains: () => ipcRenderer.invoke('broker:domains'),
  detail: capabilityId => ipcRenderer.invoke('broker:detail', capabilityId),
  brokerTrace: () => ipcRenderer.invoke('broker:trace'),
  agentStatus: () => ipcRenderer.invoke('agent:status'),
  modelGet: () => ipcRenderer.invoke('model:get'),
  modelSave: request => ipcRenderer.invoke('model:save', request),
  chooseProjectDirectory: () => ipcRenderer.invoke('project:choose-directory'),
  createProject: request => ipcRenderer.invoke('project:create', request),
  projectBindings: () => ipcRenderer.invoke('project:bindings'),
  selectProject: id => ipcRenderer.invoke('project:select', id),
  setProjectDomain: (id, domain) => ipcRenderer.invoke('project:set-domain', {id, domain}),
  newChat: () => ipcRenderer.invoke('agent:new'),
  projectFiles: () => ipcRenderer.invoke('project:list'),
  readProjectFile: relative => ipcRenderer.invoke('project:read', relative),
  openProjectFile: relative => ipcRenderer.invoke('project:open', relative),
  runAgent: task => ipcRenderer.invoke('agent:run', task),
  approveAgent: (id, response) => ipcRenderer.invoke('agent:approve', {id, response}),
  interruptAgent: () => ipcRenderer.invoke('agent:interrupt'),
  onAgentEvent: callback => {const listener = (_event, value) => callback(value); ipcRenderer.on('agent:event', listener); return () => ipcRenderer.removeListener('agent:event', listener);},
};
contextBridge.exposeInMainWorld('viewerHost', api);
