import { useDisplayText } from '@industrial-agent-harness/viewer-builtin/text';
import { useEffect, useState } from 'react';
import { X } from 'lucide-react';
import type {
  ModelProfile,
  ModelProfileStatus,
} from '@industrial-agent-harness/viewer-builtin/api';

const initial: ModelProfileStatus = {
  provider: 'kimi',
  endpoint: 'https://api.moonshot.cn/v1',
  model: 'kimi-k2-thinking-turbo',
  contextSize: 262144,
  thinking: true,
  imageInput: false,
  imageInputMode: 'auto',
  hasApiKey: false,
  keyPersisted: false,
};

export function ModelSettings({
  onClose,
  onSaved,
}: {
  onClose: () => void;
  onSaved: (status: ModelProfileStatus) => void;
}) {
  const { t } = useDisplayText();
  const [profile, setProfile] = useState<ModelProfileStatus>(initial);
  const [apiKey, setApiKey] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  // First-time configuration needs a key; saving without one would silently
  // leave every turn failing with 401 while showing "saved".
  const needsKey = !profile.hasApiKey && !apiKey.trim();
  useEffect(() => {
    void window
      .viewerHost!.modelGet()
      .then(setProfile)
      .catch(reason => setError(String(reason)));
  }, []);
  function patch(value: Partial<ModelProfile>) {
    setProfile(current => ({ ...current, ...value }));
  }
  async function save(clearApiKey = false) {
    setSaving(true);
    setError('');
    setMessage('');
    try {
      const next = await window.viewerHost!.modelSave({
        ...profile,
        apiKey: apiKey || undefined,
        clearApiKey,
      });
      setProfile(next);
      setApiKey('');
      setMessage(clearApiKey ? 'API key removed.' : 'Model settings saved.');
      onSaved(next);
    } catch (reason) {
      setError(String(reason));
    } finally {
      setSaving(false);
    }
  }
  return (
    <div
      className="ia-modal-backdrop"
      onMouseDown={event => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section
        className="ia-model-modal"
        role="dialog"
        aria-modal="true"
        aria-label={t('Model API settings')}
      >
        <header>
          <div>
            <h2>{t('Model API')}</h2>
            <p>{t('Connection settings for Kimi Code sessions in this app')}</p>
          </div>
          <button onClick={onClose} aria-label={t('Close settings')}>
            <X size={17} />
          </button>
        </header>
        <div className="ia-model-fields">
          <label>
            {t('API format')}{' '}
            <select
              value={profile.provider}
              onChange={event =>
                patch({
                  provider: event.target.value as ModelProfile['provider'],
                  imageInputMode: 'auto',
                })
              }
            >
              <option value="kimi">{t('Kimi (Moonshot) API')}</option>
              <option value="openai_legacy">{t('OpenAI-compatible')}</option>
            </select>
          </label>
          <label>
            {t('API base URL')}{' '}
            <input
              value={profile.endpoint}
              onChange={event => patch({ endpoint: event.target.value, imageInputMode: 'auto' })}
              spellCheck={false}
            />
          </label>
          <label>
            {t('Model')}{' '}
            <input
              value={profile.model}
              onChange={event => patch({ model: event.target.value, imageInputMode: 'auto' })}
              spellCheck={false}
            />
          </label>
          <label>
            {t('API key')}{' '}
            <input
              type="password"
              value={apiKey}
              onChange={event => setApiKey(event.target.value)}
              placeholder={
                profile.hasApiKey ? t('Saved · enter a new key to replace') : t('Enter API key')
              }
              autoComplete="off"
              spellCheck={false}
            />
          </label>
          <div className="ia-model-row">
            <label>
              {t('Context size')}{' '}
              <input
                type="number"
                min={8192}
                max={2000000}
                value={profile.contextSize}
                onChange={event => patch({ contextSize: Number(event.target.value) })}
              />
            </label>
            <label className="ia-check">
              <input
                type="checkbox"
                checked={profile.thinking}
                onChange={event => patch({ thinking: event.target.checked })}
              />{' '}
              {t('Thinking')}
            </label>
          </div>
          <label>
            {t('Image input')}{' '}
            <select
              aria-label={t('Model image input')}
              value={profile.imageInputMode}
              onChange={event =>
                patch({ imageInputMode: event.target.value as ModelProfile['imageInputMode'] })
              }
            >
              <option value="auto">{t('Auto')}</option>
              <option value="enabled">{t('Enabled')}</option>
              <option value="disabled">{t('Disabled')}</option>
            </select>
          </label>
          <small>
            {t(
              'Auto recognizes verified model/API combinations. For other vision models choose Enabled; this declares support and does not add vision to a text-only model.',
            )}
          </small>
          <small>
            {profile.hasApiKey
              ? profile.keyPersisted
                ? t('API key is stored using your OS credential protection.')
                : t('API key is available for this app session only.')
              : needsKey
                ? t('Enter an API key before saving; tasks cannot run without one.')
                : t('An API key is required to run a Kimi turn.')}
          </small>
          {error && <p className="ia-model-error">{t(error)}</p>}
          {message && <p className="ia-model-success">{t(message)}</p>}
        </div>
        <footer>
          {profile.hasApiKey && (
            <button onClick={() => void save(true)} disabled={saving}>
              {t('Remove key')}
            </button>
          )}
          <span />
          <button onClick={onClose}>{t('Cancel')}</button>
          <button className="primary" onClick={() => void save()} disabled={saving || needsKey}>
            {saving ? t('Saving…') : t('Save')}
          </button>
        </footer>
      </section>
    </div>
  );
}
