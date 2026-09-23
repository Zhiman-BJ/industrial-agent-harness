import {useEffect, useState} from 'react';
import {Activity, Bug, ChevronDown, ChevronRight, CircuitBoard, Cpu, File, Folder, FolderOpen, Layers3, Moon, PanelLeftClose, PanelLeftOpen, PanelRightClose, PanelRightOpen, Play, Settings2, Square, Sun, Waves} from 'lucide-react';
import {LayoutViewport} from '@industrial-agent-harness/viewer-builtin/layout';
import {NetlistViewport} from '@industrial-agent-harness/viewer-builtin/netlist';
import {WaveformViewport, type SignalRequest} from '@industrial-agent-harness/viewer-builtin/waveform';
import type {AgentEvent, BrokerResult, CapabilityDetail, OpenedViewer, ViewerArtifact} from '@industrial-agent-harness/viewer-builtin/api';

const icons = {layout: Layers3, netlist: CircuitBoard, waveform: Waves};
const labels = {layout: 'Layout', netlist: 'Netlist', waveform: 'Waveform'};
type Theme = 'light' | 'dark';

export function App() {
  const [artifacts, setArtifacts] = useState<ViewerArtifact[]>([]);
  const [projectFiles, setProjectFiles] = useState<Array<{path: string; name: string; depth: number; directory: boolean}>>([]);
  const [selectedId, setSelectedId] = useState('reference-netlist');
  const [opened, setOpened] = useState<OpenedViewer>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [ready, setReady] = useState(false);
  const [leftOpen, setLeftOpen] = useState(true);
  const [rightOpen, setRightOpen] = useState(true);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [theme, setTheme] = useState<Theme>(() => localStorage.getItem('ia-theme') === 'dark' ? 'dark' : 'light');
  const [debug, setDebug] = useState(false);
  const [signal, setSignal] = useState<SignalRequest>();
  const [task, setTask] = useState('');
  const [submittedTask, setSubmittedTask] = useState('');
  const [domain, setDomain] = useState('chip');
  const [stage, setStage] = useState('rtl');
  const [broker, setBroker] = useState<BrokerResult>();
  const [detail, setDetail] = useState<CapabilityDetail>();
  const [brokerError, setBrokerError] = useState('');
  const [agentStatus, setAgentStatus] = useState<{available: boolean; version: string; projectDir: string | null}>();
  const [agentEvents, setAgentEvents] = useState<AgentEvent[]>([]);
  const [agentBusy, setAgentBusy] = useState(false);

  useEffect(() => {localStorage.setItem('ia-theme', theme);}, [theme]);
  useEffect(() => {
    let cancelled = false;
    if (!window.viewerHost) {setError('Open the Electron desktop app to inspect local artifacts.'); setLoading(false); return;}
    window.viewerHost.list().then(items => {if (!cancelled) setArtifacts(items);}).catch(reason => {if (!cancelled) {setError(String(reason)); setLoading(false);}});
    return () => {cancelled = true;};
  }, []);
  useEffect(() => {
    if (!window.viewerHost) return;
    void window.viewerHost.agentStatus().then(setAgentStatus);
    return window.viewerHost.onAgentEvent(event => {
      setAgentEvents(current => [...current, event]);
      if (event.type === 'tool-result') void window.viewerHost!.brokerTrace().then(trace => setBroker(current => current ? {...current, trace} : current));
      if (event.type === 'done' || event.type === 'error') setAgentBusy(false);
    });
  }, []);
  useEffect(() => {
    if (!artifacts.some(item => item.id === selectedId)) return;
    let cancelled = false;
    setLoading(true); setReady(false); setError(''); setOpened(undefined);
    window.viewerHost!.open({artifactId: selectedId}).then(view => {if (!cancelled) {setOpened(view); setLoading(false);}}).catch(reason => {if (!cancelled) {setError(String(reason)); setLoading(false);}});
    return () => {cancelled = true;};
  }, [selectedId, artifacts]);

  const selected = artifacts.find(item => item.id === selectedId);
  async function chooseFile() {
    try {const item = await window.viewerHost!.choose(); if (item) {setArtifacts(current => [...current, item]); setSelectedId(item.id); setRightOpen(true);}}
    catch (reason) {setError(String(reason));}
  }
  function showSignal(name: string) {
    if (selectedId !== 'reference-netlist') return;
    setSignal({name, id: Date.now()}); setSelectedId('reference-waveform'); setRightOpen(true);
  }
  async function resolveTask() {
    if (!task.trim()) return;
    setBrokerError(''); setDetail(undefined); setSubmittedTask(task); setAgentEvents([]);
    try {setBroker(await window.viewerHost!.resolve({domain, stage, task}));}
    catch (reason) {setBrokerError(String(reason));}
  }
  async function showDetail(id: string) {
    try {setDetail(await window.viewerHost!.detail(id)); const trace = await window.viewerHost!.brokerTrace(); setBroker(current => current ? {...current, trace} : current);}
    catch (reason) {setBrokerError(String(reason));}
  }
  async function chooseProject() {
    try {const projectDir = await window.viewerHost!.chooseProject(); setAgentStatus(current => current ? {...current, projectDir} : current); setProjectFiles(await window.viewerHost!.projectFiles());}
    catch (reason) {setBrokerError(String(reason));}
  }
  async function openProjectFile(relative: string) {
    try {const item = await window.viewerHost!.openProjectFile(relative); setArtifacts(current => [...current, item]); setSelectedId(item.id); setRightOpen(true);}
    catch (reason) {setError(String(reason));}
  }
  async function runAgent() {
    setAgentEvents([]); setAgentBusy(true);
    try {await window.viewerHost!.runAgent(submittedTask);}
    catch (reason) {setAgentEvents([{type: 'error', message: String(reason)}]); setAgentBusy(false);}
  }

  return <div className={`rp-shell ia-app theme-${theme} ${leftOpen ? '' : 'left-collapsed'} ${rightOpen ? '' : 'right-collapsed'}`}>
    <div className="ia-topbar">
      <div className="ia-top-left"><button className="ia-icon" onClick={() => setLeftOpen(value => !value)} title={leftOpen ? 'Hide project tree' : 'Show project tree'}>{leftOpen ? <PanelLeftClose size={16}/> : <PanelLeftOpen size={16}/>}</button><span className="ia-product-mark"><Cpu size={15}/></span><b>Industrial Agent Harness</b></div>
      <div className="ia-top-right"><span className="ia-project-name">{agentStatus?.projectDir?.split(/[\\/]/).pop() || 'No project selected'}</span><button className="ia-icon" onClick={() => setRightOpen(value => !value)} title={rightOpen ? 'Hide viewer' : 'Show viewer'}>{rightOpen ? <PanelRightClose size={16}/> : <PanelRightOpen size={16}/>}</button></div>
    </div>
    <div className="ia-columns">
      {leftOpen && <aside className="ia-tree">
        <div className="ia-tree-heading"><span>PROJECT</span><button className="ia-icon" onClick={() => void chooseProject()} title="Choose project"><FolderOpen size={15}/></button></div>
        <button className="ia-tree-root" onClick={() => void chooseProject()}><ChevronDown size={14}/><FolderOpen size={15}/><span>{agentStatus?.projectDir?.split(/[\\/]/).pop() || 'Reference artifacts'}</span></button>
        {projectFiles.length > 0 && <div className="ia-project-files">{projectFiles.map(item => <button key={item.path} style={{paddingLeft: 12 + item.depth * 12}} disabled={item.directory || !/\.(gds|gdsii|oas|oasis|json|vcd|fst|ghw)$/i.test(item.name)} onClick={() => void openProjectFile(item.path)} title={item.path}>{item.directory ? <Folder size={14}/> : <File size={14}/>}<span>{item.name}</span></button>)}</div>}
        <div className="ia-tree-section">ARTIFACTS</div>
        <div className="ia-tree-items">{artifacts.map(item => {const Icon = icons[item.kind]; return <button key={item.id} className={item.id === selectedId ? 'selected' : ''} onClick={() => {setSelectedId(item.id); setRightOpen(true);}}><Icon size={15}/><span>{item.name}</span></button>;})}</div>
        <button className="ia-add-file" onClick={() => void chooseFile()}><FolderOpen size={14}/> Open artifact</button>
        <div className="ia-tree-bottom"><button className="ia-settings-button" onClick={() => setSettingsOpen(value => !value)}><Settings2 size={16}/> Settings <ChevronRight size={14}/></button></div>
        {settingsOpen && <div className="ia-settings-popover"><div className="ia-settings-title"><b>Settings</b><button className="ia-icon" onClick={() => setSettingsOpen(false)}>×</button></div><div className="ia-settings-row"><span>Appearance</span><button onClick={() => setTheme(value => value === 'light' ? 'dark' : 'light')}>{theme === 'light' ? <Sun size={14}/> : <Moon size={14}/>} {theme === 'light' ? 'Light' : 'Dark'}</button></div><div className="ia-settings-row"><span>Debug logs</span><button onClick={() => setDebug(value => !value)}><Bug size={14}/> {debug ? 'On' : 'Off'}</button></div><div className="ia-settings-note">Kimi CLI: {agentStatus?.available ? agentStatus.version || 'available' : 'unavailable'}</div></div>}
      </aside>}
      <main className="ia-chat">
        <header className="ia-chat-header"><div><b>Agent</b><span>{broker ? `${broker.scope.domain} / ${broker.scope.stage}` : 'New task'}</span></div><div className="ia-chat-actions"><button className={debug ? 'active' : ''} onClick={() => setDebug(value => !value)} title="Toggle debug logs"><Bug size={15}/></button>{!leftOpen && <button onClick={() => setLeftOpen(true)} title="Show project tree"><PanelLeftOpen size={15}/></button>}</div></header>
        <div className="ia-chat-scroll">
          {!submittedTask && <div className="ia-chat-welcome"><span className="ia-welcome-icon"><Cpu size={22}/></span><h1>What are you working on?</h1><p>Describe an engineering task to discover the relevant skills and tools. Open an artifact to inspect it alongside the conversation.</p><div className="ia-suggestions"><button onClick={() => {setDomain('chip'); setStage('rtl'); setTask('Inspect the netlist signals');}}>Inspect a netlist</button><button onClick={() => {setDomain('chip'); setStage('verification'); setTask('Inspect the simulation waveform');}}>Review a waveform</button><button onClick={() => {setDomain('chip'); setStage('physical'); setTask('Inspect the GDS layout');}}>Explore a layout</button></div></div>}
          {submittedTask && <><div className="ia-user-message">{submittedTask}</div>{brokerError && <div className="ia-flow-error">{brokerError}</div>}{broker && <section className="ia-broker-message"><div className="ia-message-label"><Activity size={14}/> Capability Broker <span>Scope {broker.scope.version.slice(0, 8)}</span></div>{broker.matches.length ? <><p>Selected {broker.matches.length} capability{broker.matches.length === 1 ? '' : 'ies'} for {broker.scope.domain} / {broker.scope.stage}.</p>{broker.matches.map(item => <button className="ia-capability" key={item.id} onClick={() => void showDetail(item.id)}><span><b>{item.title}</b><small>{item.id}</small></span><ChevronRight size={14}/></button>)}<div className="ia-scope-summary"><span>{broker.scope.skills.length} skills</span><span>{broker.scope.tools.length} tools</span></div></> : <p>No matching capability. Refine the task or stage.</p>}</section>}{detail && <section className="ia-detail-message"><div className="ia-message-label">L3 · {detail.capability}</div>{detail.skills.map(item => <p key={item.id}><b>{item.id}</b><br/>{item.reference}</p>)}{detail.tools.map(item => <p key={item.id}><b>{item.id}</b> · {JSON.stringify(item.schema)}</p>)}</section>}{agentEvents.length > 0 && <section className="ia-agent-flow">{agentEvents.map((event, index) => <div key={index}>{event.type === 'text' ? <p>{event.text}</p> : event.type === 'approval' ? <div className="ia-approval"><b>Approval requested · {event.action}</b><p>{event.description}</p><button onClick={() => void window.viewerHost!.approveAgent(event.id, 'approve')}>Approve</button><button onClick={() => void window.viewerHost!.approveAgent(event.id, 'reject')}>Reject</button></div> : event.type === 'error' ? <p className="ia-flow-error">{event.message}</p> : <small>{event.type === 'tool' ? `Tool · ${event.name}` : event.type === 'tool-result' ? `Tool result · ${event.message}` : event.type === 'step' ? `Step ${event.number}` : event.type === 'done' ? `Finished · ${event.result.status}` : ''}</small>}</div>)}</section>}{debug && broker && <section className="ia-debug-flow"><div className="ia-message-label"><Bug size={14}/> Broker disclosure log</div>{broker.trace.map((entry, index) => <details key={index}><summary><code>{entry.level}</code> {entry.event}</summary><pre>{JSON.stringify(entry.detail, null, 2)}</pre></details>)}</section>}</>}
        </div>
        <div className="ia-composer-wrap"><div className="ia-composer"><textarea aria-label="Engineering task" placeholder="Ask about your engineering project…" value={task} onChange={event => setTask(event.target.value)} onKeyDown={event => {if (event.key === 'Enter' && !event.shiftKey) {event.preventDefault(); void resolveTask();}}}/><div className="ia-composer-footer"><div className="ia-context-select"><select aria-label="Domain" value={domain} onChange={event => {setDomain(event.target.value); setStage(event.target.value === 'pcb' ? 'layout' : 'rtl'); setBroker(undefined); setDetail(undefined);}}><option value="chip">Chip</option><option value="pcb">PCB</option></select><select aria-label="Stage" value={stage} onChange={event => {setStage(event.target.value); setBroker(undefined); setDetail(undefined);}}>{(domain === 'chip' ? ['rtl', 'verification', 'physical'] : ['layout']).map(value => <option key={value}>{value}</option>)}</select></div><div className="ia-send-actions">{agentBusy && <button onClick={() => void window.viewerHost!.interruptAgent()} title="Stop agent"><Square size={14}/></button>}{broker && agentStatus?.available && agentStatus.projectDir && <button onClick={() => void runAgent()} disabled={agentBusy || task !== submittedTask} title="Run with Kimi"><Play size={14}/></button>}<button className="ia-send" onClick={() => void resolveTask()} disabled={!task.trim()} title="Resolve capabilities"><ChevronRight size={17}/></button></div></div></div><div className="ia-composer-hint">{agentStatus?.available ? agentStatus.projectDir ? 'Kimi connected · resolve a task, then run it' : 'Choose a project from the left sidebar to run Kimi' : 'Kimi CLI unavailable · capability discovery and viewers are available'}</div></div>
      </main>
      {rightOpen && <section className="ia-viewer"><header className="ia-viewer-header"><div><b>Viewer</b><span>{loading ? 'Loading' : error ? 'Error' : ready ? 'Ready' : 'Preparing'}</span></div><button onClick={() => setRightOpen(false)} title="Hide viewer"><PanelRightClose size={15}/></button></header><div className="ia-viewer-tabs">{(['layout', 'netlist', 'waveform'] as const).map(kind => {const Icon = icons[kind]; return <button key={kind} className={selected?.kind === kind ? 'active' : ''} onClick={() => {const item = artifacts.find(candidate => candidate.kind === kind); if (item) setSelectedId(item.id);}}><Icon size={14}/>{labels[kind]}</button>;})}</div><div className="ia-viewer-artifact"><span>{selected?.name || 'No artifact selected'}</span><small>{selected?.source || ''}</small></div><div className="rp-stage ia-viewer-stage">{opened?.kind === 'layout' && <LayoutViewport key={selectedId} meta={opened.data} onReady={() => setReady(true)} onError={setError}/>} {opened?.kind === 'netlist' && <NetlistViewport key={selectedId} data={opened.data} onReady={() => setReady(true)} onError={setError} onSignal={showSignal} signalMap={selectedId === 'reference-netlist' ? {count: 'tb.dut.count', enable: 'tb.dut.enable'} : {}}/>}{opened?.kind === 'waveform' && <WaveformViewport key={selectedId} data={opened.data} onReady={() => setReady(true)} onError={setError} signal={signal}/ >}{!opened && <div className="rp-empty"><div className="rp-empty-symbol"><CircuitBoard size={28}/></div><h2>{error ? 'Viewer unavailable' : loading ? 'Opening artifact…' : 'Select an artifact'}</h2><p>{error || 'Choose an artifact from the project tree.'}</p></div>}</div><footer className="ia-viewer-footer">{selected ? `${selected.kind.toUpperCase()} · SHA-256 ${selected.sha256.slice(0, 16)}…` : 'No artifact'}</footer></section>}
    </div>
  </div>;
}
