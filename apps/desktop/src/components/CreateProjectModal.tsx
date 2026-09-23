import {useState} from 'react';
import {X} from 'lucide-react';

type Draft = {directory: string; name: string; domain: string};

export function CreateProjectModal({draft, domains, error, onChange, onClose, onCreate}: {
  draft: Draft;
  domains: Array<{id: string; label: string}>;
  error: string;
  onChange: (draft: Draft) => void;
  onClose: () => void;
  onCreate: (request: Draft) => Promise<void>;
}) {
  const [saving, setSaving] = useState(false);
  async function create() {setSaving(true); try {await onCreate(draft);} finally {setSaving(false);}}
  return <div className="ia-modal-backdrop" onMouseDown={event => {if (event.target === event.currentTarget) onClose();}}><section className="ia-model-modal ia-create-project" role="dialog" aria-modal="true" aria-label="Create project"><header><div><h2>Create project</h2><p>Bind one local directory to one industrial domain.</p></div><button onClick={onClose} aria-label="Close project creation"><X size={17}/></button></header><div className="ia-model-fields"><label>Project name<input value={draft.name} onChange={event => onChange({...draft, name: event.target.value})} maxLength={100}/></label><label>Local directory<input value={draft.directory} readOnly title={draft.directory}/></label><label>Domain<select aria-label="New project domain" value={draft.domain} onChange={event => onChange({...draft, domain: event.target.value})}><option value="" disabled>Select a domain</option>{domains.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}</select></label>{error && <p className="ia-model-error">{error}</p>}</div><footer><span/><button onClick={onClose}>Cancel</button><button className="primary" onClick={() => void create()} disabled={saving || !draft.name.trim() || !draft.domain}>{saving ? 'Creating…' : 'Create project'}</button></footer></section></div>;
}
