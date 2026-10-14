import { useEffect, useRef, useState } from 'react';
import { ChevronDown, ExternalLink, ShieldCheck, X } from 'lucide-react';
import { useDisplayText } from '@industrial-agent-harness/viewer-builtin/text';
import type { AccountConfig, AccountView } from '../account-api';

export function AccountSettings({ onClose }: { onClose: () => void }) {
  const { t } = useDisplayText();
  const [view, setView] = useState<AccountView>();
  const [config, setConfig] = useState<AccountConfig>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [code, setCode] = useState('');
  const [submittingCode, setSubmittingCode] = useState(false);
  const dialog = useRef<HTMLElement>(null);
  useEffect(() => {
    let active = true;
    const receive = (next: AccountView) => {
      if (active) setView(next);
    };
    const unsubscribe = window.harnessAccount.onChanged(receive);
    void window.harnessAccount
      .get()
      .then(next => {
        if (active) {
          setView(next);
          setConfig(next.config);
        }
      })
      .catch(() => {
        if (active) setError('Unable to load account settings.');
      });
    const previous = document.activeElement as HTMLElement | null;
    dialog.current?.focus();
    return () => {
      active = false;
      unsubscribe();
      previous?.focus();
    };
  }, []);
  async function act(action: () => Promise<AccountView>) {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const next = await action();
      setView(next);
      setConfig(next.config);
      if (next.revoked === false)
        setNotice(
          'Signed out locally. The server session could not be revoked; retry from the account center.',
        );
    } catch (reason) {
      // Main returns only curated protocol errors, never server response bodies.
      setError(
        reason instanceof Error
          ? reason.message.replace(/^Error invoking remote method '[^']+': Error: /, '')
          : 'Account operation failed.',
      );
    } finally {
      setBusy(false);
    }
  }
  const pending = view?.status === 'signing_in';
  useEffect(() => {
    if (!pending) setCode('');
  }, [pending]);
  const labels: Record<string, string> = {
    not_configured: 'Account setup required',
    signed_out: 'Signed out',
    signing_in: 'Waiting for browser sign-in…',
    signed_in: 'Signed in',
    refreshing: 'Renewing session…',
    reauth_required: 'Sign in again',
  };
  return (
    <div
      className="ia-modal-backdrop"
      onMouseDown={event => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section
        className="ia-model-modal ia-account-modal"
        role="dialog"
        aria-modal="true"
        aria-label={t('Platform account')}
        ref={dialog}
        tabIndex={-1}
        onKeyDown={event => {
          if (event.key === 'Escape') onClose();
          if (event.key === 'Tab') {
            const nodes = Array.from(
              dialog.current?.querySelectorAll<HTMLElement>(
                'button:not(:disabled), input:not(:disabled), summary',
              ) || [],
            ).filter(node => node.offsetParent !== null);
            if (!nodes.length) return;
            if (event.shiftKey && document.activeElement === nodes[0]) {
              event.preventDefault();
              nodes.at(-1)?.focus();
            } else if (!event.shiftKey && document.activeElement === nodes.at(-1)) {
              event.preventDefault();
              nodes[0]?.focus();
            }
          }
        }}
      >
        <header>
          <div>
            <h2>{t('Platform account')}</h2>
            <p>{t('Manage your sign-in and platform connection.')}</p>
          </div>
          <button className="ia-icon" onClick={onClose} aria-label={t('Close settings')}>
            <X size={17} />
          </button>
        </header>
        <div className="ia-account-content">
          <div className="ia-account-identity">
            <div className="ia-account-person">
              <h3>{view?.user?.name || t('Your account')}</h3>
              {view?.issuer && <p>{view.issuer}</p>}
            </div>
            <span className="ia-account-status" data-status={view?.status} role="status">
              <span className="ia-account-status-dot" aria-hidden="true" />
              {view ? t(labels[view.status]) : t('Loading…')}
            </span>
          </div>
          {view?.user && view.persistent && (
            <p className="ia-account-note ia-account-storage">
              <ShieldCheck size={14} aria-hidden="true" />
              {t('Sign-in is saved securely on this device.')}
            </p>
          )}
          {pending && view?.login && (
            <form
              className="ia-account-manual"
              onSubmit={event => {
                event.preventDefault();
                if (submittingCode || !code.trim()) return;
                const value = code;
                setCode('');
                setSubmittingCode(true);
                void act(() => window.harnessAccount.submitCode(value)).finally(() =>
                  setSubmittingCode(false),
                );
              }}
            >
              <p className="ia-account-note">
                {t(
                  'If the browser does not return, open code sign-in and paste the complete authorization code below.',
                )}
              </p>
              <label>
                {t('Sign-in link (opens on any device)')}
                <input
                  readOnly
                  value={view.login.manualUrl}
                  onFocus={event => event.target.select()}
                />
              </label>
              <button
                type="button"
                className="ia-account-button ia-account-open-browser"
                disabled={submittingCode}
                onClick={() => void act(() => window.harnessAccount.openManual())}
              >
                <ExternalLink size={14} aria-hidden="true" />
                {t('Open code sign-in')}
              </button>
              <label>
                {t('Authorization code (code#state)')}
                <input
                  type="password"
                  autoComplete="off"
                  spellCheck={false}
                  maxLength={8192}
                  value={code}
                  disabled={submittingCode}
                  onChange={event => setCode(event.target.value)}
                />
              </label>
              <button
                className="ia-account-button primary ia-account-submit"
                type="submit"
                disabled={submittingCode || !code.trim()}
              >
                {t('Complete sign-in')}
              </button>
            </form>
          )}
          {view && !view.persistent && (
            <p className="ia-account-note ia-account-warning">
              {t('Secure storage is unavailable. This sign-in lasts only until the app closes.')}
            </p>
          )}
          {view && (view.config.modelBaseUrl || view.usePlatformModel) && (
            <label className="ia-account-model-toggle">
              <input
                type="checkbox"
                checked={view.usePlatformModel}
                disabled={busy || pending || (!view.user && !view.usePlatformModel)}
                onChange={event =>
                  void act(() => window.harnessAccount.useModel(event.target.checked))
                }
              />
              {t('Use platform account for model API')}
            </label>
          )}
          {!view?.user && (
            <p className="ia-account-note">
              {t('Local features and your own API keys remain available without signing in.')}
            </p>
          )}
          {config && (
            <details className="ia-account-connection" open={view?.status === 'not_configured'}>
              <summary>
                {t('Platform connection')}
                <ChevronDown size={14} aria-hidden="true" />
              </summary>
              <div className="ia-account-connection-fields">
                {view?.user && (
                  <p className="ia-account-note">
                    {t('Sign out to change the platform connection.')}
                  </p>
                )}
                {(
                  [
                    ['issuer', 'Account issuer'],
                    ['clientId', 'Native client ID'],
                    ['audience', 'Application audience'],
                    ['remoteOrigin', 'Remote service origin'],
                    ['remoteAudience', 'Remote service audience'],
                    ['modelBaseUrl', 'Model API base URL'],
                  ] as const
                ).map(([key, label]) => (
                  <label key={key}>
                    {t(label)}
                    <input
                      value={config[key]}
                      disabled={busy || pending || Boolean(view?.user)}
                      autoComplete="off"
                      spellCheck={false}
                      onChange={event => setConfig({ ...config, [key]: event.target.value })}
                    />
                  </label>
                ))}
                <button
                  className="ia-account-button ia-account-save"
                  disabled={busy || pending || Boolean(view?.user)}
                  onClick={() => void act(() => window.harnessAccount.configure(config))}
                >
                  {t('Save connection')}
                </button>
              </div>
            </details>
          )}
          {(error || view?.error) && (
            <p role="alert" className="ia-account-note ia-account-error">
              {t(error || view?.error || '')}
            </p>
          )}
          {notice && (
            <p className="ia-account-note ia-account-warning" role="status">
              {t(notice)}
            </p>
          )}
        </div>
        <footer className="ia-account-actions">
          <span>{view?.user && t('Signing out does not stop submitted remote tasks.')}</span>
          {pending ? (
            <button onClick={() => void act(() => window.harnessAccount.cancel())}>
              {t('Cancel sign-in')}
            </button>
          ) : view?.user ? (
            <button disabled={busy} onClick={() => void act(() => window.harnessAccount.logout())}>
              {t('Sign out')}
            </button>
          ) : (
            <button
              className="primary"
              disabled={busy || !view?.config.clientId}
              onClick={() => void act(() => window.harnessAccount.login())}
            >
              {t('Sign in with browser')}
            </button>
          )}
        </footer>
      </section>
    </div>
  );
}
