const { contextBridge, ipcRenderer } = require('electron');

const api = {
  open: request => ipcRenderer.invoke('viewer:open', request),
  prepareViewerResources: request => ipcRenderer.invoke('viewer:resources-prepare', request),
  cancelViewerResources: request => ipcRenderer.invoke('viewer:resources-cancel', request),
  releaseViewerResources: request => ipcRenderer.invoke('viewer:resources-release', request),
  onViewerResourceProgress: callback => {
    const listener = (_event, progress) => callback(progress);
    ipcRenderer.on('viewer:resources-progress', listener);
    return () => ipcRenderer.removeListener('viewer:resources-progress', listener);
  },
  openExternalArtifact: artifactId => ipcRenderer.invoke('viewer:external-open', { artifactId }),
  render: request => ipcRenderer.invoke('viewer:render', request),
  layoutGeometry: request => ipcRenderer.invoke('viewer:layout-geometry', request),
  layoutTile: request => ipcRenderer.invoke('viewer:layout-tile', request),
  layoutTilesCancel: request => ipcRenderer.invoke('viewer:layout-tiles-cancel', request),
  netlist: request => ipcRenderer.invoke('viewer:netlist', request),
  resolve: request => ipcRenderer.invoke('broker:resolve', request),
  domains: () => ipcRenderer.invoke('broker:domains'),
  domainStatus: () => ipcRenderer.invoke('domains:status'),
  domainAvailable: () => ipcRenderer.invoke('domains:available'),
  domainCancel: () => ipcRenderer.invoke('domains:cancel'),
  domainInstall: (domains, options) =>
    ipcRenderer.invoke('domains:install', { domains, scope: options?.scope }),
  domainRuntimeArchives: domains => ipcRenderer.invoke('domains:runtime-archives', { domains }),
  domainImportRuntimeArchive: request =>
    ipcRenderer.invoke('domains:import-runtime-archive', request),
  domainOpenRuntimeArchive: request => ipcRenderer.invoke('domains:open-runtime-archive', request),
  domainRemove: domain => ipcRenderer.invoke('domains:remove', { domain }),
  domainRepair: (domain, options) =>
    ipcRenderer.invoke('domains:repair', { domain, scope: options?.scope }),
  onDomainProgress: callback => {
    const listener = (_event, progress) => callback(progress);
    ipcRenderer.on('domains:progress', listener);
    return () => ipcRenderer.removeListener('domains:progress', listener);
  },
  coreUpdateStatus: () => ipcRenderer.invoke('update:status'),
  coreUpdateCheck: () => ipcRenderer.invoke('update:check'),
  coreUpdateInstall: () => ipcRenderer.invoke('update:install'),
  onCoreUpdateChanged: callback => {
    const listener = (_event, state) => callback(state);
    ipcRenderer.on('update:changed', listener);
    return () => ipcRenderer.removeListener('update:changed', listener);
  },
  resourceGet: request => ipcRenderer.invoke('resource:get', request),
  resourceSet: request => ipcRenderer.invoke('resource:set', request),
  resourceCatalog: () => ipcRenderer.invoke('resource:catalog'),
  remoteService: () => ipcRenderer.invoke('remote:service'),
  remoteCheck: () => ipcRenderer.invoke('remote:check'),
  remoteProject: request => ipcRenderer.invoke('remote:project', request),
  remoteFiles: request => ipcRenderer.invoke('remote:files', request),
  remoteTools: request => ipcRenderer.invoke('remote:tools', request),
  remoteSetLocation: request => ipcRenderer.invoke('remote:set-location', request),
  remoteReview: request => ipcRenderer.invoke('remote:review', request),
  remoteSync: request => ipcRenderer.invoke('remote:sync', request),
  remoteRebind: request => ipcRenderer.invoke('remote:rebind', request),
  remoteTask: request => ipcRenderer.invoke('remote:task', request),
  remoteSession: request => ipcRenderer.invoke('remote:session', request),
  remoteTerminate: request => ipcRenderer.invoke('remote:terminate', request),
  remoteArtifacts: request => ipcRenderer.invoke('remote:artifacts', request),
  remoteDownload: request => ipcRenderer.invoke('remote:download', request),
  externalMcpList: () => ipcRenderer.invoke('external-mcp:list'),
  externalMcpAdd: request => ipcRenderer.invoke('external-mcp:add', request),
  externalMcpRefresh: id => ipcRenderer.invoke('external-mcp:refresh', { id }),
  externalMcpRemove: id => ipcRenderer.invoke('external-mcp:remove', { id }),
  detail: capabilityId => ipcRenderer.invoke('broker:detail', capabilityId),
  brokerTrace: () => ipcRenderer.invoke('broker:trace'),
  diagnosticRuns: request => ipcRenderer.invoke('agent:log-runs', request),
  diagnosticPage: request => ipcRenderer.invoke('agent:log-page', request),
  diagnosticView: request => ipcRenderer.invoke('agent:log-view', request),
  diagnosticDetail: request => ipcRenderer.invoke('agent:log-detail', request),
  diagnosticRecord: request => ipcRenderer.invoke('agent:log-record', request),
  agentStatus: () => ipcRenderer.invoke('agent:status'),
  guiState: () => ipcRenderer.invoke('settings:gui-state'),
  openGuiPermissionSettings: permission =>
    ipcRenderer.invoke('settings:gui-permission-settings', permission),
  setGuiPlugin: enabled => ipcRenderer.invoke('settings:set-gui', { enabled }),
  browserAutomationState: () => ipcRenderer.invoke('settings:browser-automation-state'),
  setBrowserAutomation: enabled =>
    ipcRenderer.invoke('settings:set-browser-automation', { enabled }),
  onBrowserOpen: callback => {
    const listener = () => callback();
    ipcRenderer.on('browser:open', listener);
    return () => ipcRenderer.removeListener('browser:open', listener);
  },
  setChatApprovalMode: request => ipcRenderer.invoke('chat:set-approval-mode', request),
  onGuiProgress: callback => {
    const listener = (_event, value) => callback(value);
    ipcRenderer.on('settings:gui-progress', listener);
    return () => ipcRenderer.removeListener('settings:gui-progress', listener);
  },
  modelGet: () => ipcRenderer.invoke('model:get'),
  modelSave: request => ipcRenderer.invoke('model:save', request),
  chooseProjectDirectory: locale => ipcRenderer.invoke('project:choose-directory', locale),
  createProject: request => ipcRenderer.invoke('project:create', request),
  projectBindings: () => ipcRenderer.invoke('project:bindings'),
  selectProject: id => ipcRenderer.invoke('project:select', id),
  setProjectDomain: (id, domain) => ipcRenderer.invoke('project:set-domain', { id, domain }),
  setProjectResource: (projectId, kind, id, enabled) =>
    ipcRenderer.invoke('project:set-resource', { projectId, kind, id, enabled }),
  chats: () => ipcRenderer.invoke('chat:list'),
  chatHistory: request => ipcRenderer.invoke('chat:history', request),
  refreshEvidence: request => ipcRenderer.invoke('chat:evidence', request),
  selectChat: id => ipcRenderer.invoke('chat:select', id),
  deleteChat: id => ipcRenderer.invoke('chat:delete', id),
  renameChat: (id, title) => ipcRenderer.invoke('chat:rename', { id, title }),
  onChatUpdated: callback => {
    const listener = () => callback();
    ipcRenderer.on('chat:updated', listener);
    return () => ipcRenderer.removeListener('chat:updated', listener);
  },
  onModelChanged: callback => {
    const listener = () => callback();
    ipcRenderer.on('model:changed', listener);
    return () => ipcRenderer.removeListener('model:changed', listener);
  },
  onProjectsChanged: callback => {
    const listener = () => callback();
    ipcRenderer.on('projects:changed', listener);
    return () => ipcRenderer.removeListener('projects:changed', listener);
  },
  newChat: () => ipcRenderer.invoke('agent:new'),
  projectFiles: () => ipcRenderer.invoke('project:list'),
  readProjectFile: relative => ipcRenderer.invoke('project:read', relative),
  revealResult: request => ipcRenderer.invoke('result:reveal', request),
  openResult: request => ipcRenderer.invoke('result:open', request),
  openProjectFile: relative => ipcRenderer.invoke('project:open', relative),
  validateImages: request => ipcRenderer.invoke('agent:validate-images', request),
  runAgent: (task, chatId) =>
    ipcRenderer.invoke('agent:run', typeof task === 'string' && chatId ? { task, chatId } : task),
  approveAgent: (id, response, chatId) =>
    ipcRenderer.invoke('agent:approve', { id, response, chatId }),
  answerAgentQuestion: (id, answers, chatId) =>
    ipcRenderer.invoke('agent:answer-question', { id, answers, chatId }),
  interruptAgent: chatId => ipcRenderer.invoke('agent:interrupt', { chatId }),
  onAgentEvent: callback => {
    const listener = (_event, value) => callback(value);
    ipcRenderer.on('agent:event', listener);
    return () => ipcRenderer.removeListener('agent:event', listener);
  },
  window: {
    minimize: () => ipcRenderer.send('window:minimize'),
    toggleMaximize: () => ipcRenderer.send('window:maximize-toggle'),
    close: () => ipcRenderer.send('window:close'),
  },
  platform: process.platform,
};
contextBridge.exposeInMainWorld('viewerHost', api);

contextBridge.exposeInMainWorld('harnessAccount', {
  get: () => ipcRenderer.invoke('account:get'),
  login: () => ipcRenderer.invoke('account:login'),
  openManual: () => ipcRenderer.invoke('account:open-manual'),
  submitCode: value => ipcRenderer.invoke('account:submit-code', value),
  cancel: () => ipcRenderer.invoke('account:cancel'),
  logout: () => ipcRenderer.invoke('account:logout'),
  useModel: enabled => ipcRenderer.invoke('account:use-model', enabled),
  onChanged: callback => {
    const listener = (_event, view) => callback(view);
    ipcRenderer.on('account:changed', listener);
    return () => ipcRenderer.removeListener('account:changed', listener);
  },
});
