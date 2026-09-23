import {useEffect, useState} from 'react';
import {X} from 'lucide-react';
import type {ModelProfile, ModelProfileStatus} from '@industrial-agent-harness/viewer-builtin/api';

const initial: ModelProfileStatus = {provider: 'kimi', endpoint: 'https://api.moonshot.cn/v1', model: 'kimi-k2-thinking-turbo', contextSize: 262144, thinking: true, hasApiKey: false, keyPersisted: false};

export function ModelSettings({onClose, onSaved}: {onClose: () => void; onSaved: () => void}) {
  const [profile, setProfile] = useState<ModelProfileStatus>(initial);
  const [apiKey, setApiKey] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  useEffect(() => {void window.viewerHost!.modelGet().then(setProfile).catch(reason => setError(String(reason)));}, []);
  function patch(value: Partial<ModelProfile>) {setProfile(current => ({...current, ...value}));}
  async function save(clearApiKey = false) {
    setSaving(true); setError(''); setMessage('');
    try {
      const next = await window.viewerHost!.modelSave({...profile, apiKey: apiKey || undefined, clearApiKey});
      setProfile(next); setApiKey(''); setMessage(clearApiKey ? 'API key removed.' : 'Model settings saved.'); onSaved();
    } catch (reason) {setError(String(reason));}
    finally {setSaving(false);}
  }
  return <div className="ia-modal-backdrop" onMouseDown={event => {if (event.target === event.currentTarget) onClose();}}><section className="ia-model-modal" role="dialog" aria-modal="true" aria-label="Model API settings"><header><div><h2>Model API</h2><p>Connection settings for Kimi Code sessions in this app</p></div><button onClick={onClose} aria-label="Close settings"><X size={17}/></button></header><div className="ia-model-fields"><label>Provider<select value={profile.provider} onChange={event => patch({provider: event.target.value as ModelProfile['provider']})}><option value="kimi">Kimi API</option><option value="openai_legacy">OpenAI-compatible</option></select></label><label>API base URL<input value={profile.endpoint} onChange={event => patch({endpoint: event.target.value})} spellCheck={false}/></label><label>Model<input value={profile.model} onChange={event => patch({model: event.target.value})} spellCheck={false}/></label><label>API key<input type="password" value={apiKey} onChange={event => setApiKey(event.target.value)} placeholder={profile.hasApiKey ? 'Saved · enter a new key to replace' : 'Enter API key'} autoComplete="off" spellCheck={false}/></label><div className="ia-model-row"><label>Context size<input type="number" min={8192} max={2000000} value={profile.contextSize} onChange={event => patch({contextSize: Number(event.target.value)})}/></label><label className="ia-check"><input type="checkbox" checked={profile.thinking} onChange={event => patch({thinking: event.target.checked})}/> Thinking</label></div><small>{profile.hasApiKey ? profile.keyPersisted ? 'API key is stored using your OS credential protection.' : 'API key is available for this app session only.' : 'An API key is required to run a Kimi turn.'}</small>{error && <p className="ia-model-error">{error}</p>}{message && <p className="ia-model-success">{message}</p>}</div><footer>{profile.hasApiKey && <button onClick={() => void save(true)} disabled={saving}>Remove key</button>}<span/><button onClick={onClose}>Cancel</button><button className="primary" onClick={() => void save()} disabled={saving}>{saving ? 'Saving…' : 'Save'}</button></footer></section></div>;
}
