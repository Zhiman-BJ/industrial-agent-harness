import { useEffect, useRef, useState } from 'react';
import { Check, ExternalLink } from 'lucide-react';
import { useDisplayText } from '@industrial-agent-harness/viewer-builtin/text';
import type { GuiPluginState } from '@industrial-agent-harness/viewer-builtin/api';

export function ComputerUseSettings() {
  const { t } = useDisplayText();
  const [state, setState] = useState<GuiPluginState>();
  const [browserAutomation, setBrowserAutomation] = useState<boolean>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const revision = useRef(0);
  const toggling = useRef(false);
  useEffect(() => {
    const host = window.viewerHost;
    if (!host) return;
    void host
      .browserAutomationState()
      .then(value => setBrowserAutomation(value.enabled))
      .catch(() => setBrowserAutomation(undefined));
    let disposed = false;
    const refresh = async () => {
      if (toggling.current) return;
      const request = ++revision.current;
      try {
        const next = await host.guiState();
        if (!disposed && request === revision.current) setState(next);
      } catch (reason) {
        if (!disposed && request === revision.current) setError(String(reason));
      }
    };
    void refresh();
    const unsubscribe = host.onGuiProgress(() => void refresh());
    const onFocus = () => void refresh();
    window.addEventListener('focus', onFocus);
    const timer = window.setInterval(() => void refresh(), 2000);
    return () => {
      disposed = true;
      revision.current++;
      unsubscribe();
      window.removeEventListener('focus', onFocus);
      window.clearInterval(timer);
    };
  }, []);

  async function toggle(enabled: boolean) {
    toggling.current = true;
    const request = ++revision.current;
    setBusy(true);
    setError('');
    try {
      const next = await window.viewerHost!.setGuiPlugin(enabled);
      if (request === revision.current) setState(next);
    } catch (reason) {
      if (request === revision.current) setError(String(reason));
    } finally {
      toggling.current = false;
      if (request === revision.current) setBusy(false);
    }
  }
  async function openPermission(permission: 'screen' | 'accessibility') {
    try {
      await window.viewerHost!.openGuiPermissionSettings(permission);
    } catch (reason) {
      setError(String(reason));
    }
  }
  async function toggleBrowserAutomation(enabled: boolean) {
    try {
      const next = await window.viewerHost!.setBrowserAutomation(enabled);
      setBrowserAutomation(next.enabled);
    } catch (reason) {
      setError(String(reason));
    }
  }
  const failed = Boolean(error || (state?.enabled && state.install === 'error'));
  const permissions = state?.permissions;
  const authorized = permissions?.screen === 'granted' && permissions.accessibility === 'granted';
  const status = failed
    ? 'Unable to prepare desktop control'
    : !state
      ? 'Checking…'
      : !state.enabled
        ? 'Allow the agent to operate desktop apps.'
        : state.install !== 'ready'
          ? 'Preparing desktop control…'
          : !permissions
            ? 'Desktop control is ready.'
            : authorized
              ? 'Authorized'
              : permissions.screen === 'unknown' || permissions.accessibility === 'unknown'
                ? 'Unable to check system permissions'
                : 'System permission needed';
  return (
    <section className="ia-computer-use" aria-label={t('Computer Use')}>
      <div className="ia-settings-row">
        <span>{t('Computer Use')}</span>
        <button
          type="button"
          aria-pressed={Boolean(state?.enabled)}
          disabled={!state || busy}
          onClick={() => void toggle(!state?.enabled)}
        >
          {state?.enabled ? t('Enabled') : t('Disabled')}
        </button>
      </div>
      <div className="ia-gui-status" role="status">
        <span className={authorized && state?.enabled && !failed ? 'ia-gui-authorized' : ''}>
          {authorized && state?.enabled && state.install === 'ready' && !failed && (
            <Check size={12} />
          )}
          {t(status)}
        </span>
        {failed && (
          <button disabled={busy} onClick={() => void toggle(Boolean(state?.enabled))}>
            {t('Retry')}
          </button>
        )}
        {state?.enabled && state.install === 'ready' && permissions && !authorized && (
          <div className="ia-gui-permissions">
            {(['screen', 'accessibility'] as const)
              .filter(key => permissions[key] !== 'granted')
              .map(key => (
                <button key={key} onClick={() => void openPermission(key)}>
                  {t(key === 'screen' ? 'Screen Recording' : 'Accessibility')}{' '}
                  <ExternalLink size={11} />
                </button>
              ))}
          </div>
        )}
      </div>
      {failed && (error || state?.error) && (
        <details className="ia-gui-error">
          <summary>{t('Details')}</summary>
          <p>{error || state?.error}</p>
        </details>
      )}
      <div className="ia-settings-row">
        <span>{t('Browser Automation')}</span>
        <button
          type="button"
          aria-pressed={Boolean(browserAutomation)}
          disabled={browserAutomation === undefined}
          onClick={() => void toggleBrowserAutomation(!browserAutomation)}
        >
          {browserAutomation ? t('Enabled') : t('Disabled')}
        </button>
      </div>
      <div className="ia-gui-status" role="status">
        <span>
          {t(
            'Let the agent drive the workspace browser tab. No download or system permission needed.',
          )}
        </span>
      </div>
    </section>
  );
}
