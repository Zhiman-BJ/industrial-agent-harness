import {useEffect, useLayoutEffect, useRef, useState} from 'react';
import {Activity, Bug, ChevronDown, ChevronRight, Cpu, File, FilePlus2, Folder, FolderOpen, Maximize, Minimize, Moon, PanelLeftClose, PanelLeftOpen, PanelRightClose, PanelRightOpen, Play, Plus, Settings2, Square, Sun, Trash2, X} from 'lucide-react';
import {ViewerCanvas, type ViewNavigation} from '@industrial-agent-harness/viewer-builtin/canvas';
import type {AgentEvent, ChatHistory, ChatSummary, SessionStatus, ChatTurn, BrokerResult, CapabilityDetail, DomainOption, OpenedViewer, ProjectBinding, PromptImage, ViewerArtifact} from '@industrial-agent-harness/viewer-builtin/api';
import {useImageAttachments, ImageAttachButton, ImageThumbnails} from './components/ImageAttachments';
import {AgentLogPanel} from './components/AgentLogPanel';
import {AgentFlow} from './components/AgentFlow';
import {BrokerCall} from './components/BrokerCall';
import {TodoList} from './components/TodoList';
import {GlobalResourceSettings} from './components/ResourceSettings';
import {ModelSettings} from './components/ModelSettings';
import {ProjectDetails} from './components/ProjectDetails';
import {CreateProjectModal} from './components/CreateProjectModal';
import {DomainPill} from './components/DomainPill';

type Theme = 'light' | 'dark';
type ProjectFile = {path: string; name: string; depth: number; directory: boolean};
function appendDisplayEvent(current: AgentEvent[], event: AgentEvent): AgentEvent[] {
  if (event.type === 'text' || event.type === 'thinking') {
    let index = current.length - 1;
    while (index >= 0 && (current[index].type === 'status' || current[index].type === 'step')) index--;
    const previous = current[index];
    if ((previous?.type === 'text' && event.type === 'text') || (previous?.type === 'thinking' && event.type === 'thinking')) {
      const updated = [...current]; updated[index] = {...previous, text: previous.text + event.text}; return updated;
    }
  }
  return [...current, event];
}

type SourceFile = {path: string; name: string; sizeBytes: number; content: string | null; truncated: boolean};

export function App() {
  const [artifacts, setArtifacts] = useState<ViewerArtifact[]>([]);
  const [projectFiles, setProjectFiles] = useState<ProjectFile[]>([]);
  const [collapsedDirs, setCollapsedDirs] = useState<Set<string>>(() => new Set());
  const [projects, setProjects] = useState<ProjectBinding[]>([]);
  const [domains, setDomains] = useState<DomainOption[]>([]);
  const [activeProjectId, setActiveProjectId] = useState<string | null>(null);
  const attachments = useImageAttachments(activeProjectId);
  const [modelImageInput, setModelImageInput] = useState(false);
  const sentImages = useRef(new Map<string, PromptImage[]>());
  const sentTasks = useRef(new Map<string, string>());
  const [page, setPage] = useState<'chat' | 'project'>('chat');
  const [projectDraft, setProjectDraft] = useState<{directory: string; name: string; domain: string} | null>(null);
  const [projectError, setProjectError] = useState('');
  const [selectedId, setSelectedId] = useState('');
  const [selectedProjectFile, setSelectedProjectFile] = useState('');
  const [sourceFile, setSourceFile] = useState<SourceFile>();
  const [opened, setOpened] = useState<OpenedViewer>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [ready, setReady] = useState(false);
  const [leftOpen, setLeftOpen] = useState(true);
  const [rightOpen, setRightOpen] = useState(false);
  const [fileTreeOpen, setFileTreeOpen] = useState(false);
  const workspace = useRef<HTMLElement>(null);
  const [viewerFullscreen, setViewerFullscreen] = useState(false);
  const [fullscreenError, setFullscreenError] = useState('');
  const [viewNavigation, setViewNavigation] = useState<ViewNavigation | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [modelSettingsOpen, setModelSettingsOpen] = useState(false);
  const [resourceSettingsOpen, setResourceSettingsOpen] = useState(false);
  const [resourceRevision, setResourceRevision] = useState(0);
  const [theme, setTheme] = useState<Theme>(() => localStorage.getItem('ia-theme') === 'dark' ? 'dark' : 'light');
  const [debug, setDebug] = useState(false);
  const [logOpen, setLogOpen] = useState(false);
  const [logTrace, setLogTrace] = useState<string>();
  function showAgentLog(traceId?: string) {setLogTrace(traceId); setLogOpen(true);}
  const [task, setTask] = useState('');
  const [submittedTask, setSubmittedTask] = useState('');
  const [broker, setBroker] = useState<BrokerResult>();
  const [detail, setDetail] = useState<CapabilityDetail>();
  const [brokerError, setBrokerError] = useState('');
  const [agentStatus, setAgentStatus] = useState<{available: boolean; version: string; projectDir: string | null; configured: boolean; gui?: {enabled: boolean; install: string; version: string | null}}>();
  const [agentEvents, setAgentEvents] = useState<AgentEvent[]>([]);
  const [agentBusy, setAgentBusy] = useState(false);
  const [guiInstall, setGuiInstall] = useState('');
  const [agentOwned, setAgentOwned] = useState(false);
  const [chatList, setChatList] = useState<ChatSummary[]>([]);
  const [runningSessions, setRunningSessions] = useState<SessionStatus[]>([]);
  const [navigating, setNavigating] = useState(false);
  const creatingChat = useRef(false);
  const projectIdRef = useRef<string | null>(null);
  projectIdRef.current = activeProjectId;
  const [activeChatId, setActiveChatId] = useState<string | null>(null);
  const chatIdRef = useRef<string | null>(null);
  const [turns, setTurns] = useState<ChatTurn[]>([]);
  const [historyBefore, setHistoryBefore] = useState<string | null>(null);
  const [hasEarlier, setHasEarlier] = useState(false);
  const [historyLoading, setHistoryLoading] = useState(false);
  const submitting = useRef(false);
  const chatScroll = useRef<HTMLDivElement>(null);
  const followMessages = useRef(true);
  const prependHeight = useRef<number | null>(null);
  useLayoutEffect(() => {
    const element = chatScroll.current;
    if (!element) return;
    if (prependHeight.current !== null) {element.scrollTop += element.scrollHeight - prependHeight.current; prependHeight.current = null;}
    else if (followMessages.current) element.scrollTop = element.scrollHeight;
  }, [turns, page]);
  function applyHistory(history: ChatHistory) {
    if (chatIdRef.current !== history.chat.id) {followMessages.current = true; prependHeight.current = null;}
    chatIdRef.current = history.chat.id; setActiveChatId(history.chat.id);
    setTurns(history.turns); setHistoryBefore(history.before); setHasEarlier(history.hasMore);
    const last = history.turns.at(-1);
    setSubmittedTask(last?.task || ''); setBroker(last?.broker || undefined); setAgentEvents(last?.events || []);
    setAgentBusy(last?.status === 'running'); setAgentOwned(Boolean(history.executing)); setDetail(undefined);
    attachments.clear();
    if (last && ['error', 'cancelled'].includes(last.status)) {const images = last.events.find(event => (event.type === 'user-images' || event.type === 'input-images')); if (images && (images.type === 'user-images' || images.type === 'input-images')) attachments.restore(images.images); setTask(last.task);}
  }
  async function refreshChats(openSelected = false) {
    const projectId = projectIdRef.current;
    const list = await window.viewerHost!.chats();
    if (projectId !== projectIdRef.current) return;
    setChatList(list.chats); setRunningSessions(list.sessions);
    if (openSelected && list.activeId) {
      const selectedId = chatIdRef.current;
      const history = await window.viewerHost!.chatHistory({id: list.activeId});
      if (projectId === projectIdRef.current && selectedId === chatIdRef.current) applyHistory(history);
    }
    else if (openSelected) {chatIdRef.current = null; setActiveChatId(null); setTurns([]); setHasEarlier(false);}
  }
  async function openChat(id: string) {
    setNavigating(true);
    try {const history = await window.viewerHost!.selectChat(id); setTask(''); applyHistory(history); setPage('chat'); setBrokerError('');}
    catch (reason) {setError(String(reason));}
    finally {setNavigating(false);}
  }
  async function deleteChat(id: string) {
    setNavigating(true);
    try {
      const list = await window.viewerHost!.deleteChat(id); setChatList(list.chats);
      if (id === activeChatId) {chatIdRef.current = null; setActiveChatId(null); setTurns([]); setHasEarlier(false); setSubmittedTask(''); setBroker(undefined); setAgentEvents([]); setTask('');}
    } catch (reason) {setError(String(reason));}
    finally {setNavigating(false);}
  }
  async function loadEarlier() {
    if (!activeChatId || !historyBefore || historyLoading) return;
    setHistoryLoading(true);
    const chatId = activeChatId;
    try {const history = await window.viewerHost!.chatHistory({id: chatId, before: historyBefore}); if (chatId !== chatIdRef.current) return; prependHeight.current = chatScroll.current?.scrollHeight || null; setTurns(current => [...history.turns, ...current]); setHistoryBefore(history.before); setHasEarlier(history.hasMore);}
    catch (reason) {setError(String(reason));}
    finally {setHistoryLoading(false);}
  }
  useEffect(() => {
    if (!agentBusy || agentOwned) return;
    const timer = window.setInterval(() => {void refreshChats(true).catch(reason => setError(String(reason)));}, 2000);
    return () => window.clearInterval(timer);
  }, [agentBusy, agentOwned, activeChatId]);

  useEffect(() => {localStorage.setItem('ia-theme', theme);}, [theme]);
  useEffect(() => {
    const changed = () => setViewerFullscreen(Boolean(workspace.current && document.fullscreenElement === workspace.current));
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && document.fullscreenElement === workspace.current) {
        void document.exitFullscreen().catch(() => setFullscreenError('Use the exit fullscreen button to restore the workspace.'));
      }
    };
    document.addEventListener('fullscreenchange', changed);
    window.addEventListener('keydown', escape);
    return () => {document.removeEventListener('fullscreenchange', changed); window.removeEventListener('keydown', escape);};
  }, []);
  async function toggleViewerFullscreen() {
    setFullscreenError('');
    try {
      if (document.fullscreenElement === workspace.current) await document.exitFullscreen();
      else await workspace.current?.requestFullscreen();
    } catch {setFullscreenError('Unable to enter fullscreen. Please try again.');}
  }
  useEffect(() => {
    if (!window.viewerHost) {setError('Open the Electron desktop app to inspect local files.'); return;}
    void window.viewerHost.modelGet().then(profile => setModelImageInput(profile.imageInput)).catch(reason => setError(String(reason)));
    void window.viewerHost.domains().then(setDomains).catch(reason => setError(String(reason)));
    void Promise.all([window.viewerHost.agentStatus(), window.viewerHost.projectBindings()]).then(([status, bindings]) => {
      setAgentStatus(status); setProjects(bindings.projects); setActiveProjectId(bindings.activeId); projectIdRef.current = bindings.activeId;
      if (bindings.projects.find(item => item.id === bindings.activeId && !item.domain)) setPage('project');
      if (status.projectDir) void window.viewerHost!.projectFiles().then(setProjectFiles);
      if (bindings.projects.find(item => item.id === bindings.activeId)?.domain) void refreshChats(true).catch(reason => setError(String(reason)));
    });
    const removeEvents = window.viewerHost.onAgentEvent(event => {
      const chatId = event.chatId || '';
      const images = sentImages.current.get(chatId) || [];
      const prompt = sentTasks.current.get(chatId) || '';
      if (event.type === 'done' || event.type === 'error') {sentImages.current.delete(chatId); sentTasks.current.delete(chatId);}
      if (event.chatId && event.chatId !== chatIdRef.current) return;
      setAgentOwned(true);
      setAgentEvents(current => appendDisplayEvent(current, event));
      setTurns(current => current.map((turn, index) => event.turnId ? turn.id === event.turnId ? {...turn, events: appendDisplayEvent(turn.events, event), status: event.type === 'done' ? event.result.status : event.type === 'error' ? 'error' : turn.status} : turn : index === current.length - 1 ? {...turn, events: appendDisplayEvent(turn.events, event)} : turn));
      if (event.type === 'tool-result') void window.viewerHost!.brokerTrace().then(trace => {if (chatId === chatIdRef.current) setBroker(current => current ? {...current, trace} : current);});
      if (event.type === 'done' || event.type === 'error') setAgentBusy(false);
      if (event.type === 'error' || (event.type === 'done' && event.result.status === 'cancelled')) {attachments.restore(images); setTask(prompt);}
    });
    const removeUpdated = window.viewerHost.onChatUpdated(() => {void refreshChats().catch(reason => setError(String(reason)));});
    return () => {removeEvents(); removeUpdated();};
  }, []);
  useEffect(() => {
    setViewNavigation(null);
    if (!selectedId) {setOpened(undefined); setLoading(false); return;}
    let cancelled = false;
    setLoading(true); setReady(false); setError(''); setOpened(undefined);
    window.viewerHost!.open({artifactId: selectedId}).then(view => {if (!cancelled) {setOpened(view); setLoading(false);}}).catch(reason => {if (!cancelled) {setError(String(reason)); setLoading(false);}});
    return () => {cancelled = true;};
  }, [selectedId]);

  useEffect(() => {
    if (!window.viewerHost) return;
    return window.viewerHost!.onGuiProgress(event => {
      if (event.phase === 'downloading' || event.phase === 'verified') setGuiInstall(event.phase);
      else if (event.phase === 'ready') {setGuiInstall(''); void window.viewerHost!.guiState().then(() => window.viewerHost!.agentStatus().then(setAgentStatus));}
      else if (event.phase === 'error') {setGuiInstall(`install failed · ${event.error}`); void window.viewerHost!.agentStatus().then(setAgentStatus);}
    });
  }, []);
  const selected = artifacts.find(item => item.id === selectedId);
  const activeProject = projects.find(item => item.id === activeProjectId);
  const projectName = activeProject?.name || 'No project selected';
  const fixedDomain = activeProject?.domain || null;
  const selectedDomain = fixedDomain;
  const domainFor = (id?: string | null) => domains.find(item => item.id === id);
  const activeName = sourceFile?.name || selected?.name;
  const todo = [...agentEvents].reverse().find(event => event.type === 'todo');
  const visibleProjectFiles = projectFiles.filter(item => ![...collapsedDirs].some(dir => item.path.replaceAll('\\', '/').startsWith(`${dir}/`)));
  function toggleDirectory(relative: string) {
    const key = relative.replaceAll('\\', '/');
    setCollapsedDirs(current => {const next = new Set(current); if (next.has(key)) next.delete(key); else next.add(key); return next;});
  }

  function selectArtifact(id: string) {setSourceFile(undefined); setSelectedId(id); setRightOpen(true);}
  function chooseProject() {
    setProjectError('');
    setProjectDraft({directory: '', name: '', domain: ''});
  }
  async function chooseProjectDirectory() {
    setProjectError('');
    try {
      const directory = await window.viewerHost!.chooseProjectDirectory();
      if (!directory) return;
      const existing = projects.find(item => item.path === directory);
      if (existing) {setProjectDraft(null); await selectProject(existing.id); return;}
      setProjectDraft(current => current ? {...current, directory, name: current.name || directory.split(/[\\/]/).at(-1) || 'New project'} : current);
    } catch (reason) {setProjectError(String(reason));}
  }
  async function createProject(request: {directory: string; name: string; domain: string}) {
    try {
      const bindings = await window.viewerHost!.createProject(request);
      setProjects(bindings.projects); setActiveProjectId(bindings.activeId); projectIdRef.current = bindings.activeId;
      setAgentStatus(current => current ? {...current, projectDir: bindings.projectDir} : current);
      setProjectFiles(await window.viewerHost!.projectFiles());
      setCollapsedDirs(new Set());
      setArtifacts([]);
      setSourceFile(undefined); setSelectedId(''); setSelectedProjectFile(''); setOpened(undefined); setRightOpen(false); setFileTreeOpen(false);
      setSubmittedTask(''); setBroker(undefined); setDetail(undefined); setAgentEvents([]);
      await refreshChats(true);
      setProjectDraft(null); setPage('project');
    } catch (reason) {setProjectError(String(reason));}
  }
  async function selectProject(id: string) {
    setNavigating(true);
    if (id === activeProjectId) {setPage('project'); setNavigating(false); return;}
    setError('');
    try {
      const bindings = await window.viewerHost!.selectProject(id);
      setProjects(bindings.projects); setActiveProjectId(bindings.activeId); projectIdRef.current = bindings.activeId;
      setAgentStatus(current => current ? {...current, projectDir: bindings.projectDir} : current);
      setProjectFiles(await window.viewerHost!.projectFiles());
      setCollapsedDirs(new Set());
      setArtifacts([]);
      setSourceFile(undefined); setSelectedId(''); setSelectedProjectFile(''); setOpened(undefined); setRightOpen(false); setFileTreeOpen(false);
      setSubmittedTask(''); setBroker(undefined); setDetail(undefined); setAgentEvents([]);
      await refreshChats(true);
      setPage('project');
    } catch (reason) {setError(String(reason));}
    finally {setNavigating(false);}
  }
  async function selectProjectFile(relative: string) {
    setError(''); setRightOpen(true);
    try {
      const file = await window.viewerHost!.readProjectFile(relative);
      setSelectedProjectFile(relative);
      if (file.viewer) {
        const item = await window.viewerHost!.openProjectFile(relative);
        setArtifacts(current => [...current, item]);
        selectArtifact(item.id);
      } else {
        setSelectedId(''); setOpened(undefined); setSourceFile(file);
      }
    } catch (reason) {setError(String(reason));}
  }
  async function newChat() {
    if (navigating || submitting.current || creatingChat.current) return;
    creatingChat.current = true;
    setNavigating(true);
    try {
      if (activeProject && !activeProject.domain) {setPage('project'); return;}
      const history = await window.viewerHost!.newChat();
      if (history.chat.id !== chatIdRef.current) {
        applyHistory(history);
        setTask(''); setSubmittedTask(''); setBroker(undefined); setDetail(undefined); setBrokerError(''); setAgentEvents([]);
      }
      await refreshChats();
      setPage('chat');
    } catch (reason) {setBrokerError(String(reason));}
    finally {creatingChat.current = false; setNavigating(false);}
  }
  async function resolveTask(context?: {domain: string; stage: string}, prompt = task) {
    if (navigating || submitting.current || agentBusy || attachments.loading || (!prompt.trim() && !attachments.images.length)) return;
    if (attachments.images.length && !modelImageInput) {setBrokerError('Choose a vision model and enable Image input in Model API settings.'); return;}
    prompt = prompt.trim() || 'Describe the attached images.';
    const images = [...attachments.images];
    submitting.current = true; followMessages.current = true; setAgentBusy(true);
    setBrokerError(''); setDetail(undefined);
    try {
      const artifactKind = /\b(this|selected|current)\b|这个|当前|该|它/i.test(prompt) ? selected?.kind : undefined;
      const result = await window.viewerHost!.resolve({task: prompt, chatId: chatIdRef.current || undefined, artifactKind, domain: selectedDomain || context?.domain, stage: context?.domain === selectedDomain || !selectedDomain ? context?.stage : undefined});
      setBroker(result);
      await refreshChats(true);
      setTask('');
      if (agentStatus?.available && agentStatus.configured && agentStatus.projectDir) await runAgent(prompt, images);
      else setAgentBusy(false);
    } catch (reason) {setBrokerError(String(reason)); setAgentBusy(false);}
    finally {submitting.current = false;}
  }
  async function setProjectDomain(id: string, domain: string) {
    try {
      const bindings = await window.viewerHost!.setProjectDomain(id, domain);
      setProjects(bindings.projects);
      setTask(''); setSubmittedTask(''); setBroker(undefined); setDetail(undefined); setBrokerError(''); setAgentEvents([]);
      await refreshChats(true);
    } catch (reason) {throw reason;}
  }
  function resourcesChanged() {
    setBroker(undefined); setDetail(undefined); setBrokerError('');
  }
  async function showDetail(id: string) {
    try {setDetail(await window.viewerHost!.detail(id)); const trace = await window.viewerHost!.brokerTrace(); setBroker(current => current ? {...current, trace} : current);}
    catch (reason) {setBrokerError(String(reason));}
  }
  async function runAgent(prompt = submittedTask, images: PromptImage[] = []) {
    const chatId = chatIdRef.current;
    if (chatId) {sentImages.current.set(chatId, images); sentTasks.current.set(chatId, prompt);}
    attachments.clear();
    setAgentEvents([]); setAgentBusy(true);
    try {await window.viewerHost!.runAgent({task: prompt, chatId: chatId || undefined, projectId: activeProjectId!, images}); await refreshChats(true);}
    catch (reason) {attachments.restore(images); setTask(prompt); setBrokerError(String(reason)); setAgentBusy(false);}
  }

  const diagnostic = agentEvents.filter(event => event.type === 'diagnostic-log').at(-1);
  // Failed installs/toggles record 'install failed · …' / 'toggle failed · …';
  // both must keep the toggle usable so the user can retry or disable.
  const guiFailed = guiInstall.startsWith('install failed') || guiInstall.startsWith('toggle failed');
  return <div className={`rp-shell ia-app theme-${theme} ${leftOpen ? '' : 'left-collapsed'} ${rightOpen ? '' : 'right-collapsed'}`}>
    <div className="ia-columns">
      {leftOpen && <aside className="ia-tree ia-sidebar">
        <div className="ia-sidebar-brand"><span className="ia-product-mark"><Cpu size={16}/></span><b>Industrial Harness</b><button className="ia-icon" onClick={() => setLeftOpen(false)} title="Hide sidebar"><PanelLeftClose size={16}/></button></div>
        <div className="ia-projects-heading"><span>PROJECTS</span><button onClick={chooseProject} disabled={navigating || submitting.current} aria-label="New project" title="New project"><Plus size={15}/></button></div>
        <div className="ia-project-list">{projects.map(item => {const domain = domainFor(item.domain); const active = item.id === activeProjectId; return <div key={item.id} className="ia-project-group">
          <button className={`ia-project-row ${active ? 'selected' : ''}`} onClick={() => void selectProject(item.id)} title={item.path} disabled={navigating || submitting.current}><FolderOpen size={15}/><span className="ia-project-row-name">{item.name}</span>{runningSessions.some(session => session.projectId === item.id && session.running) && <small className="ia-project-running" title="Running chats">{runningSessions.filter(session => session.projectId === item.id && session.running).length}</small>}{domain && <span className="ia-project-domain-badge" title={domain.label}><span aria-hidden="true">{domain.emoji}</span>{domain.label}</span>}</button>
          {active && <div className="ia-project-chats" role="group" aria-label={`${item.name} chats`} data-project-id={item.id}>
            <button className="ia-new-chat" onClick={() => void newChat()} disabled={navigating || submitting.current || !item.domain || (page === 'chat' && Boolean(activeChatId) && turns.length === 0)} title={page === 'chat' && activeChatId && turns.length === 0 ? 'Send a message in this chat before starting another' : 'New chat'} aria-label={`New chat in ${item.name}`}><FilePlus2 size={14}/> New chat</button>
            {chatList.map(chat => <div className="ia-chat-row" key={chat.id}><button className="ia-sidebar-chat" title={chat.title} disabled={navigating || submitting.current} aria-current={page === 'chat' && activeChatId === chat.id ? 'page' : undefined} onClick={() => void openChat(chat.id)}><Activity size={14}/><span>{chat.title}</span>{chat.running && <small className={`ia-session-running ${chat.awaitingApproval ? 'awaiting-approval' : ''}`} role="status" aria-label={chat.awaitingApproval ? 'Awaiting approval' : 'Running'} title={chat.awaitingApproval ? 'Awaiting approval' : 'Running'}/>}</button><button className="ia-chat-delete" aria-label={`Delete chat ${chat.title}`} title="Delete chat" disabled={chat.running || navigating || submitting.current} onClick={() => void deleteChat(chat.id)}><Trash2 size={12}/></button></div>)}
          </div>}
        </div>;})}</div>
        {error && <p className="ia-sidebar-error">{error}</p>}
        <div className="ia-sidebar-spacer"/>
        <div className="ia-tree-bottom"><button className="ia-settings-button" onClick={() => setSettingsOpen(value => !value)}><Settings2 size={16}/> Settings <ChevronRight size={14}/></button></div>
        {settingsOpen && <div className="ia-settings-popover"><div className="ia-settings-title"><b>Settings</b><button className="ia-icon" onClick={() => setSettingsOpen(false)}>×</button></div><div className="ia-settings-row"><span>Appearance</span><button onClick={() => setTheme(value => value === 'light' ? 'dark' : 'light')}>{theme === 'light' ? <Sun size={14}/> : <Moon size={14}/>} {theme === 'light' ? 'Light' : 'Dark'}</button></div><div className="ia-settings-row"><span>Debug logs</span><button onClick={() => setDebug(value => !value)}><Bug size={14}/> {debug ? 'On' : 'Off'}</button></div><div className="ia-settings-row"><span>Computer Use</span><button disabled={Boolean(guiInstall) && !guiFailed} onClick={() => {const next = !agentStatus?.gui?.enabled; setGuiInstall('installing'); void window.viewerHost!.setGuiPlugin(next).then(state => {setAgentStatus(current => current ? {...current, gui: state} : current); if (!state.enabled) setGuiInstall('');}).catch(reason => {setGuiInstall(`toggle failed · ${String(reason)}`);});}} title={agentStatus?.gui?.enabled ? 'Kimi can operate your desktop apps for this session' : 'Install and enable desktop GUI control'}>{agentStatus?.gui?.enabled ? 'On' : 'Off'}</button></div>{agentStatus?.gui?.enabled && <p className="ia-settings-note">{guiFailed ? guiInstall : guiInstall ? `Installing computer use · ${guiInstall}…` : agentStatus.gui.install !== 'ready' ? 'Installing…' : `Ready · v${agentStatus.gui.version || 'unknown'} · macOS: grant Screen Recording & Accessibility in System Settings → Privacy & Security.`}</p>}{!agentStatus?.gui?.enabled && <p className="ia-settings-note">Enabling installs the computer-use engine and lets Kimi drive desktop apps. It can be disabled at any time.</p>}<div className="ia-settings-row"><span>Model API</span><button onClick={() => {setSettingsOpen(false); setModelSettingsOpen(true);}}>Configure</button></div><div className="ia-settings-row"><span>MCP &amp; Skills</span><button onClick={() => {setSettingsOpen(false); setResourceSettingsOpen(true);}}>Configure</button></div><div className="ia-settings-note">Kimi CLI: {agentStatus?.available ? agentStatus.version || 'available' : 'unavailable'}</div></div>}
      </aside>}
      <main className="ia-chat">
        <header className="ia-chat-header"><div>{!leftOpen && <button className="ia-icon" onClick={() => setLeftOpen(true)} title="Show sidebar"><PanelLeftOpen size={16}/></button>}<Folder size={14}/><b>{projectName}</b></div><div className="ia-chat-actions"><button aria-label="View agent logs" title="View detailed agent logs" disabled={!activeProjectId} onClick={() => showAgentLog()}>Logs</button><button className={debug ? 'active' : ''} onClick={() => setDebug(value => !value)} title="Toggle debug logs"><Bug size={15}/></button><button onClick={() => setRightOpen(value => !value)} title={rightOpen ? 'Hide workspace' : 'Show workspace'}>{rightOpen ? <PanelRightClose size={16}/> : <PanelRightOpen size={16}/>}</button></div></header>
        {page === 'project' && activeProject ? <ProjectDetails key={activeProject.id} project={activeProject} domains={domains} busy={runningSessions.some(session => session.projectId === activeProjectId && session.running)} onDomainChange={setProjectDomain} resourceRevision={resourceRevision} onResourcesChanged={resourcesChanged} onNewChat={newChat}/> : <>
        <div className="ia-chat-scroll" ref={chatScroll} onScroll={event => {const element = event.currentTarget; followMessages.current = element.scrollHeight - element.scrollTop - element.clientHeight < 80;}}>
          {hasEarlier && <button className="ia-history-more" disabled={historyLoading} onClick={() => void loadEarlier()}>{historyLoading ? 'Loading…' : 'Load earlier messages'}</button>}
          {!turns.length && <div className="ia-chat-welcome"><span className="ia-welcome-icon"><Cpu size={22}/></span><h1>What are you working on?</h1><p>Describe a task in your project. Relevant capabilities and tools will appear as the work progresses.</p></div>}
          {turns.map((turn, index) => <div className="ia-chat-turn" key={turn.id} data-turn-id={turn.id}>
            <div className="ia-user-message">{turn.task}{turn.events.map(event => (event.type === 'user-images' || event.type === 'input-images') ? <ImageThumbnails key="input-images" images={event.images}/> : null)}</div>
            {turn.broker && <BrokerCall broker={turn.broker} detail={index === turns.length - 1 ? detail : undefined} debug={debug} selectedDomain={selectedDomain} readOnly={index !== turns.length - 1 || agentBusy} onContext={context => void resolveTask(context, turn.task)} onDetail={id => void showDetail(id)}/>}
            {turn.events.length > 0 && <AgentFlow onLog={showAgentLog} events={turn.events} running={agentOwned && agentBusy && index === turns.length - 1} debug={debug} approve={(id, decision) => window.viewerHost!.approveAgent(id, decision, chatIdRef.current || undefined)}/>}
          </div>)}
          {brokerError && <div className="ia-flow-error">{brokerError}</div>}
        </div>
        {todo?.type === 'todo' && <TodoList items={todo.items} running={agentBusy}/>}
        {agentBusy && !agentOwned && <p role="status" className="ia-composer-hint">This chat is running in another window. Open a new chat to work in parallel.</p>}
        <div className="ia-composer-wrap"><div className="ia-composer" onDragOver={event => {if (event.dataTransfer.types.includes('Files')) event.preventDefault();}} onDrop={event => {if (!event.dataTransfer.files.length) return; event.preventDefault(); if (!agentBusy) void attachments.addFiles(Array.from(event.dataTransfer.files));}} onPaste={event => {const files = Array.from(event.clipboardData.items).filter(item => item.kind === 'file').map(item => item.getAsFile()).filter((file): file is File => Boolean(file)); if (files.length) {event.preventDefault(); if (!agentBusy) void attachments.addFiles(files);}}}><ImageThumbnails images={attachments.images} onRemove={attachments.remove} disabled={agentBusy || attachments.loading}/>{attachments.error && <p role="alert" className="ia-flow-error">{attachments.error}</p>}{attachments.loading && <p role="status">Preparing images…</p>}{attachments.images.length > 0 && !modelImageInput && <p className="ia-image-model-hint">This model is configured for text only. <button onClick={() => setModelSettingsOpen(true)}>Configure image input</button></p>}<textarea aria-label="Engineering task" placeholder="Ask about your project…" value={task} disabled={agentBusy || navigating} onChange={event => setTask(event.target.value)} onKeyDown={event => {if (event.key === 'Enter' && !event.shiftKey) {event.preventDefault(); void resolveTask();}}}/><div className="ia-composer-footer"><DomainPill domain={fixedDomain} domains={domains} label="Session domain"/><div className="ia-send-actions"><ImageAttachButton attachments={attachments} disabled={agentBusy || attachments.loading || !activeProjectId}/>{agentOwned && agentBusy && <button onClick={() => void window.viewerHost!.interruptAgent(chatIdRef.current || undefined)} title="Stop agent"><Square size={14}/></button>}{Boolean(broker && agentStatus?.available && agentStatus.configured && agentStatus.projectDir) && <button onClick={() => void runAgent()} disabled={navigating || agentBusy || submitting.current || turns.at(-1)?.status !== 'scoped'} title="Run with Kimi"><Play size={14}/></button>}<button className="ia-send" onClick={() => void resolveTask()} disabled={navigating || agentBusy || attachments.loading || (!task.trim() && !attachments.images.length) || (attachments.images.length > 0 && !modelImageInput)} title="Send task"><ChevronRight size={17}/></button></div></div></div><div className="ia-composer-hint">{!agentStatus?.available ? 'Kimi CLI unavailable · run pnpm setup:kimi' : !agentStatus.configured ? 'Configure the Model API in Settings to run Kimi' : !agentStatus.projectDir ? 'Choose a project to run Kimi' : 'Kimi ready'}</div></div>
        </>}
      </main>
      {rightOpen && <section ref={workspace} className="ia-viewer ia-workspace">
        <header className="ia-viewer-header"><div><File size={14}/><b>{activeName || 'Workspace'}</b>{activeName && <button className="ia-icon" onClick={() => {setSourceFile(undefined); setSelectedId(''); setSelectedProjectFile('');}} title="Close file"><X size={13}/></button>}</div><div className="ia-workspace-actions">{fullscreenError && <span role="status">{fullscreenError}</span>}{opened && <div className="ia-view-navigation" aria-label="Viewer zoom controls"><button aria-label="Zoom out" title="Zoom out" disabled={!ready || !viewNavigation?.ready} onClick={() => viewNavigation?.zoomOut()}>−</button><output aria-label="Viewer zoom">{viewNavigation?.percent == null ? viewNavigation?.description || 'Zoom' : `${viewNavigation.percent}%`}</output><button aria-label="Zoom in" title="Zoom in" disabled={!ready || !viewNavigation?.ready} onClick={() => viewNavigation?.zoomIn()}>+</button><button aria-label="Fit viewer" title="Fit content to the view" disabled={!ready || !viewNavigation?.ready} onClick={() => viewNavigation?.fit()}>Fit</button></div>}<button onClick={() => void toggleViewerFullscreen()} title={viewerFullscreen ? 'Exit viewer fullscreen' : 'Fullscreen viewer'} aria-label={viewerFullscreen ? 'Exit viewer fullscreen' : 'Fullscreen viewer'} aria-pressed={viewerFullscreen}>{viewerFullscreen ? <Minimize size={15}/> : <Maximize size={15}/>}</button><button className="ia-file-tree-toggle" onClick={() => setFileTreeOpen(value => !value)} title={fileTreeOpen ? 'Hide file tree' : 'Show file tree'}>{fileTreeOpen ? <PanelRightClose size={15}/> : <PanelRightOpen size={15}/>}</button><button onClick={() => setRightOpen(false)} title="Hide workspace"><X size={15}/></button></div></header>
        <div className="ia-workspace-body"><div className="ia-workspace-content"><div className="ia-workspace-breadcrumb">{sourceFile?.path || selectedProjectFile || projectName}</div>
          {sourceFile ? <div className="ia-source-panel">{sourceFile.content == null ? <p>Binary file · no text preview available.</p> : <pre>{sourceFile.content}</pre>}{sourceFile.truncated && <small>Preview limited to the first 2 MB.</small>}</div> : selected ? <div className="rp-stage ia-viewer-stage">{opened ? <ViewerCanvas key={selectedId} onNavigation={setViewNavigation} opened={opened} onReady={() => setReady(true)} onError={setError}/> : <div className="ia-workspace-empty">{error || (loading ? 'Opening viewer…' : 'Preparing viewer…')}</div>}</div> : <div className="ia-workspace-empty">{error || 'Open the file tree to browse this project.'}</div>}
          {selected && <footer className="ia-viewer-footer">{selected.kind.toUpperCase()} · {ready ? 'Ready' : loading ? 'Loading' : error ? 'Error' : 'Preparing'} · SHA-256 {selected.sha256.slice(0, 16)}…</footer>}
        </div>{fileTreeOpen && <aside className="ia-workspace-tree"><div className="ia-file-search">FILES</div><button className="ia-file-root" onClick={() => setPage('project')}><ChevronDown size={13}/><FolderOpen size={14}/><span>{projectName}</span></button><div className="ia-file-list">{visibleProjectFiles.map(item => <button key={item.path} className={selectedProjectFile === item.path ? 'selected' : ''} style={{paddingLeft: 11 + item.depth * 13}} onClick={() => item.directory ? toggleDirectory(item.path) : void selectProjectFile(item.path)} title={item.path}>{item.directory ? collapsedDirs.has(item.path.replaceAll('\\', '/')) ? <ChevronRight size={12}/> : <ChevronDown size={12}/> : <File size={13}/>}<span>{item.name}</span></button>)}{!projectFiles.length && <p className="ia-file-hint">Choose a project to browse its files.</p>}</div></aside>}</div>
      </section>}
    </div>
    {projectDraft && <CreateProjectModal draft={projectDraft} domains={domains} error={projectError} onChange={setProjectDraft} onChooseDirectory={chooseProjectDirectory} onClose={() => setProjectDraft(null)} onCreate={createProject}/>}
    {logOpen && activeProjectId && <AgentLogPanel key={activeProjectId} projectId={activeProjectId} projectName={projectName} initialTraceId={logTrace} runningTraceId={diagnostic?.type === 'diagnostic-log' ? diagnostic.traceId : undefined} running={agentBusy} onClose={() => setLogOpen(false)}/>}
    {resourceSettingsOpen && <GlobalResourceSettings busy={runningSessions.some(session => session.running)} onChanged={() => {setResourceRevision(value => value + 1); resourcesChanged();}} onClose={() => setResourceSettingsOpen(false)}/>}
    {modelSettingsOpen && <ModelSettings onClose={() => setModelSettingsOpen(false)} onSaved={profile => {setModelImageInput(profile.imageInput); void window.viewerHost!.agentStatus().then(setAgentStatus);}}/>}
  </div>;
}
