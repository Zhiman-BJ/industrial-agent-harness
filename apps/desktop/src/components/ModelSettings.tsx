import { useDisplayText } from '@industrial-agent-harness/viewer-builtin/text';
import { useEffect, useState } from 'react';
import { X } from 'lucide-react';
import type {
  ModelProfile,
  ModelProfileStatus,
} from '@industrial-agent-harness/viewer-builtin/api';
import type { AccountView, PlatformModel } from '../account-api';

type Source = 'platform' | 'key';

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
  // Where the model comes from: the signed-in platform account, which bills the
  // user's own Obol account, or the user's own API key.
  const [account, setAccount] = useState<AccountView | null>(null);
  const [source, setSource] = useState<Source>('platform');
  const [models, setModels] = useState<PlatformModel[] | null>(null);
  const platform = source === 'platform';
  useEffect(() => {
    void window
      .viewerHost!.modelGet()
      .then(setProfile)
      .catch(reason => setError(String(reason)));
    void window.harnessAccount
      ?.get()
      .then(view => {
        setAccount(view);
        setSource(view.usePlatformModel ? 'platform' : 'key');
      })
      .catch(() => setSource('key'));
  }, []);
  useEffect(() => {
    if (!platform || !account?.user || models) return;
    void window.harnessAccount
      .models()
      .then(setModels)
      .catch(() => setModels([]));
  }, [platform, account, models]);
  function patch(value: Partial<ModelProfile>) {
    setProfile(current => ({ ...current, ...value }));
  }
  async function save(clearApiKey = false) {
    setSaving(true);
    setError('');
    setMessage('');
    try {
      if (account && account.usePlatformModel !== platform)
        setAccount(await window.harnessAccount.useModel(platform));
      // The platform's model API speaks the OpenAI-compatible protocol.
      const next = await window.viewerHost!.modelSave({
        ...profile,
        ...(platform ? { provider: 'openai_legacy' as const } : {}),
        apiKey: platform ? undefined : apiKey || undefined,
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
          {account && (
            <label>
              {t('Model source')}{' '}
              <select value={source} onChange={event => setSource(event.target.value as Source)}>
                <option value="platform">{t('Platform account')}</option>
                <option value="key">{t('Your own API key')}</option>
              </select>
            </label>
          )}
          {platform && account && (
            <small>
              {account.user
                ? t('Provided by your platform account. Usage is billed to your Obol account.')
                : t('Sign in under Settings → Platform account to use platform models.')}
            </small>
          )}
          {!platform && (
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
          )}
          {!platform && (
            <label>
              {t('API base URL')}{' '}
              <input
                value={profile.endpoint}
                onChange={event => patch({ endpoint: event.target.value, imageInputMode: 'auto' })}
                spellCheck={false}
              />
            </label>
          )}
          <label>
            {t('Model')}{' '}
            {platform && models?.length ? (
              <select
                value={models.some(m => m.id === profile.model) ? profile.model : ''}
                onChange={event => {
                  const chosen = models.find(m => m.id === event.target.value);
                  if (chosen)
                    patch({
                      model: chosen.id,
                      contextSize: chosen.contextWindow ?? profile.contextSize,
                      imageInputMode: 'auto',
                    });
                }}
              >
                <option value="" disabled>
                  {t('Choose a model')}
                </option>
                {models.map(m => (
                  <option key={m.id} value={m.id}>
                    {m.id}
                  </option>
                ))}
              </select>
            ) : (
              <input
                value={profile.model}
                onChange={event => patch({ model: event.target.value, imageInputMode: 'auto' })}
                spellCheck={false}
              />
            )}
          </label>
          {!platform && (
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
          )}
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
          {!platform && (
            <small>
              {profile.hasApiKey
                ? profile.keyPersisted
                  ? t('API key is stored using your OS credential protection.')
                  : t('API key is available for this app session only.')
                : t('An API key is required to run a Kimi turn.')}
            </small>
          )}
          {error && <p className="ia-model-error">{t(error)}</p>}
          {message && <p className="ia-model-success">{t(message)}</p>}
        </div>
        <footer>
          {profile.hasApiKey && !platform && (
            <button onClick={() => void save(true)} disabled={saving}>
              {t('Remove key')}
            </button>
          )}
          <span />
          <button onClick={onClose}>{t('Cancel')}</button>
          <button className="primary" onClick={() => void save()} disabled={saving}>
            {saving ? t('Saving…') : t('Save')}
          </button>
        </footer>
      </section>
    </div>
  );
}
