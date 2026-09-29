import {useEffect, useRef, useState} from 'react';
import type {ResourceMode, ResourceSettingsSnapshot} from '@industrial-agent-harness/viewer-builtin/api';

export function ResourceSettings({projectId, busy, onChanged}: {projectId?: string; busy: boolean; onChanged: () => void}) {
  const [snapshot, setSnapshot] = useState<ResourceSettingsSnapshot>();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const mounted = useRef(false);
  const lock = useRef(false);
  useEffect(() => {
    mounted.current = true;
    let cancelled = false;
    void window.viewerHost!.resourceGet({projectId}).then(value => {if (!cancelled) setSnapshot(value);}).catch(reason => {if (!cancelled) setError(String(reason));});
    return () => {cancelled = true; mounted.current = false;};
  }, [projectId]);
  async function change(kind: 'skill' | 'mcp', id: string, mode: ResourceMode) {
    if (lock.current) return;
    lock.current = true; setSaving(true); setError('');
    try {
      const next = await window.viewerHost!.resourceSet({projectId, kind, id, mode});
      if (mounted.current) setSnapshot(next);
      onChanged();
    } catch (reason) {if (mounted.current) setError(String(reason));}
    finally {lock.current = false; if (mounted.current) setSaving(false);}
  }
  return <section className="ia-project-resources" aria-label={projectId ? 'Project MCP and Skills' : 'Global MCP and Skills'}>
    <h2>MCP &amp; Skills</h2>
    <p>{projectId ? 'Project overrides take priority over global defaults. Choose Inherit to follow the global setting.' : 'Defaults for all projects. Each project can override these settings.'} Changes apply to new sessions.</p>
    {busy && <p role="status">Stop the current task to change resources.</p>}
    {error && <p role="alert" className="ia-project-error">{error}</p>}
    {!snapshot ? !error && <p>Loading resources…</p> : (['skills', 'mcpServers'] as const).map(key => <div key={key}>
      <h3>{key === 'skills' ? 'Skills' : 'MCP servers'}</h3>
      {!snapshot.catalog[key].length && <p>{key === 'skills' ? 'No Skills are bundled for this domain.' : 'No default domain MCP servers are bundled yet.'}</p>}
      {snapshot.catalog[key].map(item => {
        const globalEnabled = !snapshot.global[key].includes(item.id) && item.enabledByDefault;
        const override = snapshot.overrides[key][item.id];
        const mode = override === undefined ? 'inherit' : override ? 'enabled' : 'disabled';
        const enabled = !snapshot.effective[key].includes(item.id);
        return <label key={item.id}>
          <span><b>{item.title}</b><small>{item.id}{!projectId && ` · ${item.domain}`} · {enabled ? 'Enabled' : 'Disabled'}{projectId && ` · Global: ${globalEnabled ? 'enabled' : 'disabled'}`}</small></span>
          {projectId ? <select aria-label={`${item.title} project setting`} value={mode} disabled={busy || saving} onChange={event => void change(key === 'skills' ? 'skill' : 'mcp', item.id, event.target.value as ResourceMode)}><option value="inherit">Inherit ({globalEnabled ? 'enabled' : 'disabled'})</option><option value="enabled">Enabled</option><option value="disabled">Disabled</option></select> : <input type="checkbox" aria-label={`${item.title} global default`} checked={enabled} disabled={busy || saving} onChange={event => void change(key === 'skills' ? 'skill' : 'mcp', item.id, event.target.checked ? 'enabled' : 'disabled')}/>}
        </label>;
      })}
    </div>)}
    {saving && <p role="status">Saving…</p>}
  </section>;
}

export function GlobalResourceSettings({busy, onChanged, onClose}: {busy: boolean; onChanged: () => void; onClose: () => void}) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    dialog.current?.showModal();
    return () => {if (opener?.isConnected && opener !== document.body) opener.focus(); else document.querySelector<HTMLButtonElement>('.ia-settings-button')?.focus();};
  }, []);
  return <dialog ref={dialog} className="ia-resource-modal" aria-label="Global MCP and Skill settings" onCancel={onClose} onClick={event => {if (event.target !== event.currentTarget) return; const box = event.currentTarget.getBoundingClientRect(); if (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom) onClose();}}>
    <header><div><h1>Global resources</h1><p>MCP and Skill defaults</p></div><button aria-label="Close resource settings" onClick={onClose}>×</button></header>
    <ResourceSettings busy={busy} onChanged={onChanged}/>
  </dialog>;
}
