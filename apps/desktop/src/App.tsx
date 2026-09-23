import {useEffect, useState} from 'react';
import {Activity, Bug, ChevronDown, ChevronRight, Cpu, File, FilePlus2, Folder, FolderOpen, Moon, PanelLeftClose, PanelLeftOpen, PanelRightClose, PanelRightOpen, Play, Plus, Settings2, Square, Sun, X} from 'lucide-react';
import {LayoutViewport} from '@industrial-agent-harness/viewer-builtin/layout';
import {NetlistViewport} from '@industrial-agent-harness/viewer-builtin/netlist';
import {WaveformViewport} from '@industrial-agent-harness/viewer-builtin/waveform';
import type {AgentEvent, BrokerResult, CapabilityDetail, DomainOption, OpenedViewer, ProjectBinding, ViewerArtifact} from '@industrial-agent-harness/viewer-builtin/api';
import {AgentFlow} from './components/AgentFlow';
import {TodoList} from './components/TodoList';
import {ModelSettings} from './components/ModelSettings';
import {ProjectDetails} from './components/ProjectDetails';
import {CreateProjectModal} from './components/CreateProjectModal';
import {DomainPill} from './components/DomainPill';

type Theme = 'light' | 'dark';
type ProjectFile = {path: string; name: string; depth: number; directory: boolean};
type SourceFile = {path: string; name: string; sizeBytes: number; content: string | null; truncated: boolean};

export function App() {
  const [artifacts, setArtifacts] = useState<ViewerArtifact[]>([]);
  const [projectFiles, setProjectFiles] = useState<ProjectFile[]>([]);
  const [collapsedDirs, setCollapsedDirs] = useState<Set<string>>(() => new Set());
  const [projects, setProjects] = useState<ProjectBinding[]>([]);
  const [domains, setDomains] = useState<DomainOption[]>([]);
  const [activeProjectId, setActiveProjectId] = useState<string | null>(null);
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
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [modelSettingsOpen, setModelSettingsOpen] = useState(false);
  const [theme, setTheme] = useState<Theme>(() => localStorage.getItem('ia-theme') === 'dark' ? 'dark' : 'light');
  const [debug, setDebug] = useState(false);
  const [task, setTask] = useState('');
  const [submittedTask, setSubmittedTask] = useState('');
  const [broker, setBroker] = useState<BrokerResult>();
  const [detail, setDetail] = useState<CapabilityDetail>();
  const [brokerError, setBrokerError] = useState('');
  const [agentStatus, setAgentStatus] = useState<{available: boolean; version: string; projectDir: string | null; configured: boolean}>();
  const [agentEvents, setAgentEvents] = useState<AgentEvent[]>([]);
  const [agentBusy, setAgentBusy] = useState(false);

  useEffect(() => {localStorage.setItem('ia-theme', theme);}, [theme]);
  useEffect(() => {
    if (!window.viewerHost) {setError('Open the Electron desktop app to inspect local files.'); return;}
    void window.viewerHost.domains().then(setDomains).catch(reason => setError(String(reason)));
    void Promise.all([window.viewerHost.agentStatus(), window.viewerHost.projectBindings()]).then(([status, bindings]) => {
      setAgentStatus(status); setProjects(bindings.projects); setActiveProjectId(bindings.activeId);
      if (bindings.projects.find(item => item.id === bindings.activeId && !item.domain)) setPage('project');
      if (status.projectDir) void window.viewerHost!.projectFiles().then(setProjectFiles);
    });
    return window.viewerHost.onAgentEvent(event => {
      setAgentEvents(current => {
        const last = current.at(-1);
        if ((event.type === 'text' || event.type === 'thinking') && last?.type === event.type) return [...current.slice(0, -1), {...last, text: last.text + event.text}];
        return [...current, event];
      });
      if (event.type === 'tool-result') void window.viewerHost!.brokerTrace().then(trace => setBroker(current => current ? {...current, trace} : current));
      if (event.type === 'done' || event.type === 'error') setAgentBusy(false);
    });
  }, []);
  useEffect(() => {
    if (!selectedId) {setOpened(undefined); setLoading(false); return;}
    let cancelled = false;
    setLoading(true); setReady(false); setError(''); setOpened(undefined);
    window.viewerHost!.open({artifactId: selectedId}).then(view => {if (!cancelled) {setOpened(view); setLoading(false);}}).catch(reason => {if (!cancelled) {setError(String(reason)); setLoading(false);}});
    return () => {cancelled = true;};
  }, [selectedId]);

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
      setProjects(bindings.projects); setActiveProjectId(bindings.activeId);
      setAgentStatus(current => current ? {...current, projectDir: bindings.projectDir} : current);
      setProjectFiles(await window.viewerHost!.projectFiles());
      setCollapsedDirs(new Set());
      setArtifacts([]);
      setSourceFile(undefined); setSelectedId(''); setSelectedProjectFile(''); setOpened(undefined); setRightOpen(false); setFileTreeOpen(false);
      setSubmittedTask(''); setBroker(undefined); setDetail(undefined); setAgentEvents([]);
      setProjectDraft(null); setPage('project');
    } catch (reason) {setProjectError(String(reason));}
  }
  async function selectProject(id: string) {
    if (id === activeProjectId) {setPage('project'); return;}
    setError('');
    try {
      const bindings = await window.viewerHost!.selectProject(id);
      setProjects(bindings.projects); setActiveProjectId(bindings.activeId);
      setAgentStatus(current => current ? {...current, projectDir: bindings.projectDir} : current);
      setProjectFiles(await window.viewerHost!.projectFiles());
      setCollapsedDirs(new Set());
      setArtifacts([]);
      setSourceFile(undefined); setSelectedId(''); setSelectedProjectFile(''); setOpened(undefined); setRightOpen(false); setFileTreeOpen(false);
      setSubmittedTask(''); setBroker(undefined); setDetail(undefined); setAgentEvents([]);
      setPage('project');
    } catch (reason) {setError(String(reason));}
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
    if (activeProject && !activeProject.domain) {setPage('project'); return;}
    try {
      await window.viewerHost!.newChat();
      setPage('chat');
      setTask(''); setSubmittedTask(''); setBroker(undefined); setDetail(undefined); setBrokerError(''); setAgentEvents([]);
    } catch (reason) {setBrokerError(String(reason));}
  }
  async function resolveTask(context?: {domain: string; stage: string}) {
    if (!task.trim()) return;
    setBrokerError(''); setBroker(undefined); setDetail(undefined); setSubmittedTask(task); setAgentEvents([]);
    try {
      const artifactKind = /\b(this|selected|current)\b|这个|当前|该|它/i.test(task) ? selected?.kind : undefined;
      const result = await window.viewerHost!.resolve({task, artifactKind, domain: selectedDomain || context?.domain, stage: context?.domain === selectedDomain || !selectedDomain ? context?.stage : undefined});
      setBroker(result);
      if (agentStatus?.available && agentStatus.configured && agentStatus.projectDir) await runAgent(task);
    } catch (reason) {setBrokerError(String(reason));}
  }
  async function setProjectDomain(id: string, domain: string) {
    try {
      const bindings = await window.viewerHost!.setProjectDomain(id, domain);
      setProjects(bindings.projects);
      setTask(''); setSubmittedTask(''); setBroker(undefined); setDetail(undefined); setBrokerError(''); setAgentEvents([]);
    } catch (reason) {throw reason;}
  }
  async function showDetail(id: string) {
    try {setDetail(await window.viewerHost!.detail(id)); const trace = await window.viewerHost!.brokerTrace(); setBroker(current => current ? {...current, trace} : current);}
    catch (reason) {setBrokerError(String(reason));}
  }
  async function runAgent(prompt = submittedTask) {
    setAgentEvents([]); setAgentBusy(true);
    try {await window.viewerHost!.runAgent(prompt);}
    catch (reason) {setAgentEvents([{type: 'error', message: String(reason)}]); setAgentBusy(false);}
  }

  return <div className={`rp-shell ia-app theme-${theme} ${leftOpen ? '' : 'left-collapsed'} ${rightOpen ? '' : 'right-collapsed'}`}>
    <div className="ia-columns">
      {leftOpen && <aside className="ia-tree ia-sidebar">
        <div className="ia-sidebar-brand"><span className="ia-product-mark"><Cpu size={16}/></span><b>Industrial Harness</b><button className="ia-icon" onClick={() => setLeftOpen(false)} title="Hide sidebar"><PanelLeftClose size={16}/></button></div>
        <button className="ia-new-chat" onClick={() => void newChat()} disabled={agentBusy || Boolean(activeProject && !activeProject.domain)}><FilePlus2 size={15}/> New chat</button>
        <div className="ia-projects-heading"><span>PROJECTS</span><button onClick={chooseProject} disabled={agentBusy} aria-label="New project" title="New project"><Plus size={15}/></button></div>
        <div className="ia-project-list">{projects.map(item => {const domain = domainFor(item.domain); return <button key={item.id} className={item.id === activeProjectId ? 'selected' : ''} onClick={() => void selectProject(item.id)} title={item.path}><FolderOpen size={15}/><span className="ia-project-row-name">{item.name}</span>{domain && <span className="ia-project-domain-badge" title={domain.label}><span aria-hidden="true">{domain.emoji}</span>{domain.label}</span>}</button>;})}</div>
        {error && <p className="ia-sidebar-error">{error}</p>}
        {submittedTask && <button className="ia-sidebar-chat" title={submittedTask} onClick={() => setPage('chat')}><Activity size={14}/><span>{submittedTask}</span></button>}
        <div className="ia-sidebar-spacer"/>
        <div className="ia-tree-bottom"><button className="ia-settings-button" onClick={() => setSettingsOpen(value => !value)}><Settings2 size={16}/> Settings <ChevronRight size={14}/></button></div>
        {settingsOpen && <div className="ia-settings-popover"><div className="ia-settings-title"><b>Settings</b><button className="ia-icon" onClick={() => setSettingsOpen(false)}>×</button></div><div className="ia-settings-row"><span>Appearance</span><button onClick={() => setTheme(value => value === 'light' ? 'dark' : 'light')}>{theme === 'light' ? <Sun size={14}/> : <Moon size={14}/>} {theme === 'light' ? 'Light' : 'Dark'}</button></div><div className="ia-settings-row"><span>Debug logs</span><button onClick={() => setDebug(value => !value)}><Bug size={14}/> {debug ? 'On' : 'Off'}</button></div><div className="ia-settings-row"><span>Model API</span><button onClick={() => {setSettingsOpen(false); setModelSettingsOpen(true);}}>Configure</button></div><div className="ia-settings-note">Kimi CLI: {agentStatus?.available ? agentStatus.version || 'available' : 'unavailable'}</div></div>}
      </aside>}
      <main className="ia-chat">
        <header className="ia-chat-header"><div>{!leftOpen && <button className="ia-icon" onClick={() => setLeftOpen(true)} title="Show sidebar"><PanelLeftOpen size={16}/></button>}<Folder size={14}/><b>{projectName}</b></div><div className="ia-chat-actions"><button className={debug ? 'active' : ''} onClick={() => setDebug(value => !value)} title="Toggle debug logs"><Bug size={15}/></button><button onClick={() => setRightOpen(value => !value)} title={rightOpen ? 'Hide workspace' : 'Show workspace'}>{rightOpen ? <PanelRightClose size={16}/> : <PanelRightOpen size={16}/>}</button></div></header>
        {page === 'project' && activeProject ? <ProjectDetails project={activeProject} domains={domains} busy={agentBusy} onDomainChange={setProjectDomain} onNewChat={newChat}/> : <>
        <div className="ia-chat-scroll">
          {!submittedTask && <div className="ia-chat-welcome"><span className="ia-welcome-icon"><Cpu size={22}/></span><h1>What are you working on?</h1><p>Describe a task in your project. Relevant capabilities and tools will appear as the work progresses.</p></div>}
          {submittedTask && <><div className="ia-user-message">{submittedTask}</div>{brokerError && <div className="ia-flow-error">{brokerError}</div>}{broker && <section className="ia-broker-message"><div className="ia-message-label"><Activity size={14}/> Capability Broker <span>Scope {broker.scope.version.slice(0, 8)}</span></div><details className="ia-context-override"><summary>Context · {broker.scope.domain || 'Auto'}{broker.scope.stage ? ` / ${broker.scope.stage}` : ''}</summary><div>{broker.contexts.filter(context => !selectedDomain || context.domain === selectedDomain).map(context => <button key={`${context.domain}:${context.stage}`} onClick={() => void resolveTask(context)}>{context.domain} / {context.stage}</button>)}</div></details>{broker.matches.length ? <><p>Selected {broker.matches.length} capability{broker.matches.length === 1 ? '' : 'ies'} for {broker.scope.domain} / {broker.scope.stage}.</p>{broker.matches.map(item => <button className="ia-capability" key={item.id} onClick={() => void showDetail(item.id)}><span><b>{item.title}</b><small>{item.id}</small></span><ChevronRight size={14}/></button>)}<div className="ia-scope-summary"><span>{broker.scope.skills.length} skills</span><span>{broker.scope.tools.length} tools</span></div></> : <p>No domain capability selected. Kimi can continue with its standard project tools.</p>}</section>}{detail && <section className="ia-detail-message"><div className="ia-message-label">L3 · {detail.capability}</div>{detail.skills.map(item => <p key={item.id}><b>{item.id}</b><br/>{item.reference}</p>)}{detail.tools.map(item => <p key={item.id}><b>{item.id}</b> · {JSON.stringify(item.schema)}</p>)}</section>}{agentEvents.length > 0 && <AgentFlow events={agentEvents} running={agentBusy} debug={debug} approve={(id, decision) => void window.viewerHost!.approveAgent(id, decision)}/>}{debug && broker && <section className="ia-debug-flow"><div className="ia-message-label"><Bug size={14}/> Broker disclosure log</div>{broker.trace.map((entry, index) => <details key={index}><summary><code>{entry.level}</code> {entry.event}</summary><pre>{JSON.stringify(entry.detail, null, 2)}</pre></details>)}</section>}</>}
        </div>
        {todo?.type === 'todo' && <TodoList items={todo.items} running={agentBusy}/>}
        <div className="ia-composer-wrap"><div className="ia-composer"><textarea aria-label="Engineering task" placeholder="Ask about your project…" value={task} onChange={event => setTask(event.target.value)} onKeyDown={event => {if (event.key === 'Enter' && !event.shiftKey) {event.preventDefault(); void resolveTask();}}}/><div className="ia-composer-footer"><DomainPill domain={fixedDomain} domains={domains} label="Session domain"/><div className="ia-send-actions">{agentBusy && <button onClick={() => void window.viewerHost!.interruptAgent()} title="Stop agent"><Square size={14}/></button>}{Boolean(broker && agentStatus?.available && agentStatus.configured && agentStatus.projectDir) && <button onClick={() => void runAgent()} disabled={agentBusy || task !== submittedTask} title="Run with Kimi"><Play size={14}/></button>}<button className="ia-send" onClick={() => void resolveTask()} disabled={!task.trim()} title="Send task"><ChevronRight size={17}/></button></div></div></div><div className="ia-composer-hint">{!agentStatus?.available ? 'Kimi CLI unavailable · run pnpm setup:kimi' : !agentStatus.configured ? 'Configure the Model API in Settings to run Kimi' : !agentStatus.projectDir ? 'Choose a project to run Kimi' : 'Kimi ready'}</div></div>
        </>}
      </main>
      {rightOpen && <section className="ia-viewer ia-workspace">
        <header className="ia-viewer-header"><div><File size={14}/><b>{activeName || 'Workspace'}</b>{activeName && <button className="ia-icon" onClick={() => {setSourceFile(undefined); setSelectedId(''); setSelectedProjectFile('');}} title="Close file"><X size={13}/></button>}</div><div className="ia-workspace-actions"><button onClick={() => setFileTreeOpen(value => !value)} title={fileTreeOpen ? 'Hide file tree' : 'Show file tree'}>{fileTreeOpen ? <PanelRightClose size={15}/> : <PanelRightOpen size={15}/>}</button><button onClick={() => setRightOpen(false)} title="Hide workspace"><X size={15}/></button></div></header>
        <div className="ia-workspace-body"><div className="ia-workspace-content"><div className="ia-workspace-breadcrumb">{sourceFile?.path || selectedProjectFile || projectName}</div>
          {sourceFile ? <div className="ia-source-panel">{sourceFile.content == null ? <p>Binary file · no text preview available.</p> : <pre>{sourceFile.content}</pre>}{sourceFile.truncated && <small>Preview limited to the first 2 MB.</small>}</div> : selected ? <div className="rp-stage ia-viewer-stage">{opened?.kind === 'layout' && <LayoutViewport key={selectedId} meta={opened.data} onReady={() => setReady(true)} onError={setError}/ >}{opened?.kind === 'netlist' && <NetlistViewport key={selectedId} data={opened.data} onReady={() => setReady(true)} onError={setError}/>}{opened?.kind === 'waveform' && <WaveformViewport key={selectedId} data={opened.data} onReady={() => setReady(true)} onError={setError} / >}{!opened && <div className="ia-workspace-empty">{error || (loading ? 'Opening viewer…' : 'Preparing viewer…')}</div>}</div> : <div className="ia-workspace-empty">{error || 'Open the file tree to browse this project.'}</div>}
          {selected && <footer className="ia-viewer-footer">{selected.kind.toUpperCase()} · {ready ? 'Ready' : loading ? 'Loading' : error ? 'Error' : 'Preparing'} · SHA-256 {selected.sha256.slice(0, 16)}…</footer>}
        </div>{fileTreeOpen && <aside className="ia-workspace-tree"><div className="ia-file-search">FILES</div><button className="ia-file-root" onClick={() => setPage('project')}><ChevronDown size={13}/><FolderOpen size={14}/><span>{projectName}</span></button><div className="ia-file-list">{visibleProjectFiles.map(item => <button key={item.path} className={selectedProjectFile === item.path ? 'selected' : ''} style={{paddingLeft: 11 + item.depth * 13}} onClick={() => item.directory ? toggleDirectory(item.path) : void selectProjectFile(item.path)} title={item.path}>{item.directory ? collapsedDirs.has(item.path.replaceAll('\\', '/')) ? <ChevronRight size={12}/> : <ChevronDown size={12}/> : <File size={13}/>}<span>{item.name}</span></button>)}{!projectFiles.length && <p className="ia-file-hint">Choose a project to browse its files.</p>}</div></aside>}</div>
      </section>}
    </div>
    {projectDraft && <CreateProjectModal draft={projectDraft} domains={domains} error={projectError} onChange={setProjectDraft} onChooseDirectory={chooseProjectDirectory} onClose={() => setProjectDraft(null)} onCreate={createProject}/>}
    {modelSettingsOpen && <ModelSettings onClose={() => setModelSettingsOpen(false)} onSaved={() => void window.viewerHost!.agentStatus().then(setAgentStatus)}/>}
  </div>;
}
