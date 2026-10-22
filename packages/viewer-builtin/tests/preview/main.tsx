import { useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { LayoutViewport } from '../../src/layout/LayoutViewport';
import { ViewNavigationContext } from '../../src/navigation';
import type { ViewNavigation } from '../../src/navigation';
import { DisplayTextProvider } from '../../src/text';
import type { LayoutMeta, ViewerHostApi } from '../../src/api';
import {
  languageOptions,
  normalizePreference,
  systemLocale,
  translate,
} from '../../../../apps/desktop/src/i18n/core';
import './metrics';
import '../../src/viewer-styles.css';

async function request(operation: string, body: unknown) {
  const response = await fetch(`/api/layout/${operation}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await response.json();
  if (!response.ok) throw Error(data.error || `Layout request failed (${response.status})`);
  return data;
}
window.viewerHost = {
  render: body => request('render', body),
  layoutTile: body => request('tile', body),
  layoutTilesCancel: body => request('cancel', body),
  layoutGeometry: body => request('geometry', body),
} as ViewerHostApi;
function Preview() {
  const [meta, setMeta] = useState<LayoutMeta | null>(null),
    [error, setError] = useState('');
  const [navigation, setNavigation] = useState<ViewNavigation | null>(null),
    [fullscreen, setFullscreen] = useState(false);
  const [preference, setPreference] = useState(() => {
    const value = new URLSearchParams(location.search).get('lang');
    return normalizePreference(value === 'zh' ? 'zh-CN' : value);
  });
  const [system, setSystem] = useState(() => systemLocale(navigator.languages));
  const locale = preference === 'system' ? system : preference;
  const text = useMemo(
    () => ({
      locale,
      t: (key: string, values?: Record<string, string | number | undefined>) =>
        translate(locale, key, values),
    }),
    [locale],
  );
  const { t } = text;
  useEffect(() => {
    const changed = () => setSystem(systemLocale(navigator.languages));
    window.addEventListener('languagechange', changed);
    return () => window.removeEventListener('languagechange', changed);
  }, []);
  useEffect(() => {
    document.documentElement.lang = locale;
  }, [locale]);
  useEffect(() => {
    let cancelled = false;
    request('meta', { fixture: new URLSearchParams(location.search).get('fixture') || 'complex' })
      .then(data => {
        if (!cancelled) setMeta(data);
      })
      .catch(error => setError(error.message));
    return () => {
      cancelled = true;
    };
  }, []);
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setFullscreen(false);
    };
    document.addEventListener('keydown', key);
    return () => document.removeEventListener('keydown', key);
  }, []);
  return (
    <DisplayTextProvider value={text}>
      <div className={fullscreen ? 'preview fullscreen' : 'preview'}>
        <header>
          <strong>{meta?.cell || t('Loading real layout…')}</strong>
          <span>
            {t('{0} layers · read-only verification', {
              0: (meta?.layers.length || 0).toLocaleString(locale),
            })}
          </span>
          <select
            aria-label={t('Language')}
            value={preference}
            onChange={event => setPreference(normalizePreference(event.target.value))}
          >
            <option value="system">{t('Follow system')}</option>
            {languageOptions.map(option => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
          <button
            aria-label={t('Zoom out')}
            disabled={!navigation?.ready}
            onClick={() => navigation?.zoomOut()}
          >
            −
          </button>
          <output aria-label={t('Viewer zoom')}>{navigation?.percent || 100}%</output>
          <button
            aria-label={t('Zoom in')}
            disabled={!navigation?.ready}
            onClick={() => navigation?.zoomIn()}
          >
            +
          </button>
          <button
            aria-label={t('Fit viewer')}
            disabled={!navigation?.ready}
            onClick={() => navigation?.fit()}
          >
            {t('Fit')}
          </button>
          <button
            aria-label={t(fullscreen ? 'Exit viewer fullscreen' : 'Fullscreen viewer')}
            onClick={() => setFullscreen(!fullscreen)}
          >
            {t(fullscreen ? 'Exit viewer fullscreen' : 'Fullscreen viewer')}
          </button>
        </header>
        <main>
          <ViewNavigationContext.Provider value={setNavigation}>
            {meta ? <LayoutViewport meta={meta} onReady={() => {}} onError={setError} /> : null}
          </ViewNavigationContext.Provider>
        </main>
        <footer>
          {error
            ? t(error)
            : t(
                navigation?.status === 'ready'
                  ? 'Ready'
                  : navigation?.status === 'error'
                    ? 'Error'
                    : 'Loading',
              )}
        </footer>
      </div>
    </DisplayTextProvider>
  );
}
const style = document.createElement('style');
style.textContent = `*{box-sizing:border-box}body{margin:0;background:#071421;color:#dcebf5;font:13px system-ui;--ia-text-muted:#8ba4b6;--ia-border:#23313d;--ia-accent:#49baff}button,select{font:inherit;background:#14212c;color:#dcebf5;border:1px solid #344b5b;border-radius:4px;padding:5px 9px;cursor:pointer}button:disabled{opacity:.4;cursor:default}.preview{height:100vh;display:flex;flex-direction:column;padding:12px;gap:8px}.preview.fullscreen{position:fixed;inset:0;padding:0;z-index:100}header{display:flex;align-items:center;gap:12px}header strong{margin-right:auto}header span{color:#8ba4b6;font-size:11px}main{flex:1;min-height:0;border:1px solid #23313d;border-radius:6px;overflow:hidden}footer{font-size:10px;color:#8ba4b6}a{color:#49baff}`;
document.head.append(style);
createRoot(document.getElementById('root')!).render(<Preview />);
