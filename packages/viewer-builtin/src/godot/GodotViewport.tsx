import {useEffect, useRef, useState} from 'react';
import type {ReactNode} from 'react';
import type {GodotData, GodotNode, GodotState} from '../api';
import {useViewNavigation, wheelZoomFactor} from '../navigation';

const channel = 'industrial-harness-godot-v1';
const origin = 'app://godot';

export function GodotViewport({data, onReady, onError}: {data: GodotData; onReady: () => void; onError: (message: string) => void}) {
  const frame = useRef<HTMLIFrameElement>(null);
  const sequence = useRef(0);
  const pending = useRef(new Map<number, {resolve: (value: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout>}>());
  const [connected, setConnected] = useState(false);
  const [restarting, setRestarting] = useState(false);
  const [state, setState] = useState<GodotState>({scene: data.name, tree: null, paused: false, selectedPath: '', overlays: {collision: false, navmesh: false, physics: false}});
  const [inspection, setInspection] = useState<Record<string, unknown> | null>(null);
  const [message, setMessage] = useState('Loading Godot Web Export…');
  const preview = useRef<HTMLDivElement>(null);
  const [zoom, setZoom] = useState(1);
  useViewNavigation({ready: connected, percent: Math.round(zoom * 100), zoomIn: () => setZoom(value => Math.min(8, value * 1.25)), zoomOut: () => setZoom(value => Math.max(0.25, value * 0.8)), fit: () => {setZoom(1); preview.current?.scrollTo(0, 0);}});

  useEffect(() => {
    setConnected(false);
    setRestarting(false);
    setState({scene: data.name, tree: null, paused: false, selectedPath: '', overlays: {collision: false, navmesh: false, physics: false}});
    setInspection(null);
    setMessage('Loading Godot Web Export…');
    const loadingTimer = setTimeout(() => {
      const error = 'Godot runtime did not connect. Check the export and HarnessViewerBridge autoload.';
      setMessage(error); onError(error);
      if (frame.current) frame.current.src = 'about:blank';
    }, 30000);
    const listener = (event: MessageEvent) => {
      if (event.source !== frame.current?.contentWindow || event.origin !== origin || event.data?.channel !== channel) return;
      const payload = event.data;
      if (payload.type === 'wheel' && Number.isFinite(payload.deltaY)) {setZoom(value => Math.max(0.25, Math.min(8, value * wheelZoomFactor(payload.deltaY, payload.deltaMode)))); return;}
      if (payload.type === 'loaded') setMessage('Waiting for HarnessViewerBridge autoload…');
      if (payload.type === 'ready') {clearTimeout(loadingTimer); setConnected(true); setMessage(''); onReady(); void send('state').catch(reason => onError(String(reason)));}
      if (payload.type === 'state' && payload.data && typeof payload.data === 'object') setState(payload.data as GodotState);
      if (payload.type === 'response' || payload.type === 'error') {
        const entry = pending.current.get(payload.id);
        if (!entry) return;
        clearTimeout(entry.timer); pending.current.delete(payload.id);
        if (payload.type === 'error') entry.reject(Error(String(payload.error || 'Godot command failed.')));
        else entry.resolve(payload.data);
      }
    };
    window.addEventListener('message', listener);
    const pendingCommands = pending.current;
    return () => {
      clearTimeout(loadingTimer);
      window.removeEventListener('message', listener);
      for (const entry of pendingCommands.values()) {clearTimeout(entry.timer); entry.reject(Error('Godot view closed.'));}
      pendingCommands.clear();
    };
  }, [data.token]);

  function send(command: string, args: Record<string, unknown> = {}): Promise<unknown> {
    if (!frame.current?.contentWindow) return Promise.reject(Error('Godot view is unavailable.'));
    const id = ++sequence.current;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {pending.current.delete(id); reject(Error('Godot command timed out.'));}, 10000);
      pending.current.set(id, {resolve, reject, timer});
      frame.current!.contentWindow!.postMessage({channel, type: 'command', id, command, args}, origin);
    });
  }
  async function command(name: string, args: Record<string, unknown> = {}) {
    if (name === 'stop') {setInspection(null); setRestarting(true);}
    try {await send(name, args); setMessage('');} catch (reason) {const error = String(reason); setMessage(error); onError(error);}
    finally {if (name === 'stop') setRestarting(false);}
  }
  async function select(path: string) {
    try {
      await send('select', {path});
      const result = await send('inspect', {path});
      setInspection(result as Record<string, unknown>);
    } catch (reason) {const error = String(reason); setMessage(error); onError(error);}
  }
  function tree(node: GodotNode, depth = 0): ReactNode {
    return <div key={node.path}><button className="rp-godot-node" disabled={restarting} style={{paddingLeft: 8 + depth * 12}} aria-pressed={state.selectedPath === node.path} onClick={() => void select(node.path)}>{node.name}<small>{node.class}</small></button>{node.children?.map(child => tree(child, depth + 1))}</div>;
  }
  return <div className="rp-godot">
    <header className="rp-godot-toolbar"><strong title={state.scene}>Scene: {state.scene}</strong><button disabled={!connected || restarting} aria-label="Play" onClick={() => void command('play')}>▶</button><button disabled={!connected || restarting} aria-label="Pause" onClick={() => void command('pause')}>Pause</button><button disabled={!connected || restarting} aria-label="Stop" onClick={() => void command('stop')}>Stop</button><button disabled={!connected || restarting || !state.paused} aria-label="Step frame" onClick={() => void command('stepFrame')}>Step</button><select aria-label="Camera" disabled={!connected || restarting} value="" onChange={event => {if (event.target.value) void command('camera', {path: event.target.value});}}><option value="">Camera</option>{cameraNodes(state.tree).map(node => <option key={node.path} value={node.path}>{node.name}</option>)}</select></header>
    <div className="rp-godot-body"><aside className="rp-godot-tree"><b>Scene Tree</b>{state.tree ? tree(state.tree) : <p>{connected ? 'No active scene' : 'Waiting for runtime…'}</p>}{inspection && <div className="rp-godot-inspect"><b>Inspect · {String(inspection.name || '')}</b><small>{String(inspection.class || '')}</small><dl>{Object.entries((inspection.properties || {}) as Record<string, string>).map(([key, value]) => <div key={key}><dt>{key}</dt><dd>{String(value)}</dd></div>)}</dl></div>}</aside><div className="rp-godot-canvas" ref={preview}><div className="rp-godot-preview-size" style={{width: `${zoom * 100}%`, height: `${zoom * 100}%`}}><iframe ref={frame} src={data.url} title="Godot Runtime View" sandbox="allow-scripts allow-same-origin" style={{width: `${100 / zoom}%`, height: `${100 / zoom}%`, transform: `scale(${zoom})`, transformOrigin: 'top left'}}/></div>{message && <div className="rp-godot-status" role="status">{message}</div>}</div></div>
    <footer className="rp-godot-state"><b>Runtime State</b>{(['collision', 'navmesh', 'physics'] as const).map(name => <label key={name} title="Requires a runtime-specific overlay provider"><input type="checkbox" checked={Boolean(state.overlays?.[name])} disabled onChange={event => void command('overlay', {name, enabled: event.target.checked})}/>{name === 'navmesh' ? 'NavMesh' : name[0].toUpperCase() + name.slice(1)}</label>)}</footer>
  </div>;
}

function cameraNodes(node: GodotNode | null): GodotNode[] {
  if (!node) return [];
  return [...(node.class === 'Camera2D' || node.class === 'Camera3D' ? [node] : []), ...(node.children || []).flatMap(cameraNodes)];
}
