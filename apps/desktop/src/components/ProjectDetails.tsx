import {useEffect, useState} from 'react';
import {FolderOpen, MessageSquarePlus} from 'lucide-react';
import type {ProjectBinding} from '@industrial-agent-harness/viewer-builtin/api';

type Domain = {id: string; label: string};

export function ProjectDetails({project, domains, busy, onDomainChange, onNewChat}: {
  project: ProjectBinding;
  domains: Domain[];
  busy: boolean;
  onDomainChange: (id: string, domain: string) => Promise<void>;
  onNewChat: () => Promise<void>;
}) {
  const [domain, setDomain] = useState(project.domain || '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {setDomain(project.domain || ''); setError('');}, [project.id, project.domain]);
  async function save() {
    if (!domain || domain === project.domain) return;
    setSaving(true); setError('');
    try {await onDomainChange(project.id, domain);}
    catch (reason) {setError(String(reason));}
    finally {setSaving(false);}
  }
  return <div className="ia-project-page"><div className="ia-project-page-inner"><span className="ia-project-page-icon"><FolderOpen size={21}/></span><h1>{project.name}</h1><p className="ia-project-page-subtitle">Project details</p><div className="ia-project-properties"><div className="ia-project-property"><span>Local directory</span><code title={project.path}>{project.path}</code></div><div className="ia-project-property"><label htmlFor="ia-project-domain">Domain</label><div className="ia-project-domain-edit"><select id="ia-project-domain" aria-label="Project domain" value={domain} onChange={event => setDomain(event.target.value)} disabled={busy || saving}><option value="" disabled>Select a domain</option>{domains.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}</select><button onClick={() => void save()} disabled={busy || saving || !domain || domain === project.domain}>Save</button></div></div></div>{error && <p className="ia-project-error">{error}</p>}<button className="ia-project-start" onClick={() => void onNewChat()} disabled={busy || !project.domain}><MessageSquarePlus size={15}/> New chat</button>{!project.domain && <p className="ia-project-hint">Select and save a domain to start a chat.</p>}</div></div>;
}
