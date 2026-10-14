import { useEffect, useRef, useState } from 'react';
import { X } from 'lucide-react';
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
            <p>{t('Sign in with your platform account. Cloud services require separate setup.')}</p>
          </div>
          <button onClick={onClose} aria-label={t('Close settings')}>
            <X size={17} />
          </button>
        </header>
        <div className="ia-model-fields">
          <p role="status">{view ? t(labels[view.status]) : t('Loading…')}</p>
          {view?.user && (
            <p>
              <strong>{view.user.name}</strong>
            </p>
          )}
          <p>{view?.issuer}</p>
          {pending && view?.login && (
            <form
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
              <p>
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
                disabled={submittingCode}
                onClick={() => void act(() => window.harnessAccount.openManual())}
              >
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
              <button type="submit" disabled={submittingCode || !code.trim()}>
                {t('Complete sign-in')}
              </button>
            </form>
          )}
          {view && !view.persistent && (
            <p>
              {t('Secure storage is unavailable. This sign-in lasts only until the app closes.')}
            </p>
          )}
          {view && (view.config.modelBaseUrl || view.usePlatformModel) && (
            <label>
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
          <p>{t('Local features and your own API keys remain available without signing in.')}</p>
          {config && (
            <details open={view?.status === 'not_configured'}>
              <summary>{t('Platform connection')}</summary>
              {(
                [
                  ['issuer', 'Account issuer'],
                  ['clientId', 'Native client ID'],
                  ['audience', 'Application audience'],
                  ['remoteOrigin', 'Remote service origin'],
                  ['modelBaseUrl', 'Model API base URL'],
                ] as const
              ).map(([key, label]) => (
                <label key={key}>
                  {t(label)}
                  <input
                    value={config[key]}
                    disabled={busy || pending || Boolean(view?.user)}
                    autoComplete="off"
                    onChange={event => setConfig({ ...config, [key]: event.target.value })}
                  />
                </label>
              ))}
              <button
                disabled={busy || pending || Boolean(view?.user)}
                onClick={() => void act(() => window.harnessAccount.configure(config))}
              >
                {t('Save connection')}
              </button>
            </details>
          )}
          {(error || view?.error) && (
            <p role="alert" className="ia-sidebar-error">
              {t(error || view?.error || '')}
            </p>
          )}
          {notice && <p role="status">{t(notice)}</p>}
        </div>
        <footer className="ia-account-actions">
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
              disabled={busy || !view?.config.clientId}
              onClick={() => void act(() => window.harnessAccount.login())}
            >
              {t('Sign in with browser')}
            </button>
          )}
          <span>{t('Signing out does not stop submitted remote tasks.')}</span>
        </footer>
      </section>
    </div>
  );
}
