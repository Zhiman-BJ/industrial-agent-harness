import {useEffect, useState} from 'react';
import {FolderOpen, MessageSquarePlus} from 'lucide-react';
import type {DomainOption, ProjectBinding, ResourceCatalog} from '@industrial-agent-harness/viewer-builtin/api';

export function ProjectDetails({project, domains, resources, busy, onDomainChange, onResourceChange, onNewChat}: {
  project: ProjectBinding;
  domains: DomainOption[];
  resources: ResourceCatalog;
  busy: boolean;
  onDomainChange: (id: string, domain: string) => Promise<void>;
  onResourceChange: (id: string, kind: 'skill' | 'mcp', resourceId: string, enabled: boolean) => Promise<void>;
  onNewChat: () => Promise<void>;
}) {
  const [domain, setDomain] = useState(project.domain || '');
  const [saving, setSaving] = useState(false);
  const [changingResource, setChangingResource] = useState('');
  const [error, setError] = useState('');
  useEffect(() => {setDomain(project.domain || ''); setError('');}, [project.id, project.domain]);
  async function save() {
    if (!domain || domain === project.domain) return;
    setSaving(true); setError('');
    try {await onDomainChange(project.id, domain);}
    catch (reason) {setError(String(reason));}
    finally {setSaving(false);}
  }
  async function changeResource(kind: 'skill' | 'mcp', id: string, enabled: boolean) {
    setChangingResource(id); setError('');
    try {await onResourceChange(project.id, kind, id, enabled);}
    catch (reason) {setError(String(reason));}
    finally {setChangingResource('');}
  }
  return <div className="ia-project-page"><div className="ia-project-page-inner"><span className="ia-project-page-icon"><FolderOpen size={21}/></span><h1>{project.name}</h1><p className="ia-project-page-subtitle">Project details</p><div className="ia-project-properties"><div className="ia-project-property"><span>Local directory</span><code title={project.path}>{project.path}</code></div><div className="ia-project-property"><label htmlFor="ia-project-domain">Domain</label><div className="ia-project-domain-edit"><select id="ia-project-domain" aria-label="Project domain" value={domain} onChange={event => setDomain(event.target.value)} disabled={busy || saving}><option value="" disabled>Select a domain</option>{domains.map(item => <option key={item.id} value={item.id}>{item.emoji} {item.label}</option>)}</select><button onClick={() => void save()} disabled={busy || saving || !domain || domain === project.domain}>Save</button></div></div></div><section className="ia-project-resources"><h2>Default resources</h2><p>Enabled resources are available when the Broker selects a matching capability. Changes apply to new sessions.</p><h3>Skills</h3>{resources.skills.map(item => <label key={item.id}><span><b>{item.title}</b><small>{item.id}</small></span><input type="checkbox" checked={!project.disabledSkills?.includes(item.id)} disabled={busy || Boolean(changingResource)} onChange={event => void changeResource('skill', item.id, event.target.checked)}/></label>)}<h3>MCP servers</h3>{resources.mcpServers.length ? resources.mcpServers.map(item => <label key={item.id}><span><b>{item.title}</b><small>{item.id}</small></span><input type="checkbox" checked={!project.disabledMcpServers?.includes(item.id)} disabled={busy || Boolean(changingResource)} onChange={event => void changeResource('mcp', item.id, event.target.checked)}/></label>) : <p>No default domain MCP servers are bundled yet.</p>}</section>{error && <p className="ia-project-error">{error}</p>}<button className="ia-project-start" onClick={() => void onNewChat()} disabled={busy || !project.domain}><MessageSquarePlus size={15}/> New chat</button>{!project.domain && <p className="ia-project-hint">Select and save a domain to start a chat.</p>}</div></div>;
}
