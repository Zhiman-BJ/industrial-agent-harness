import { useEffect, useRef, useState } from 'react';
import { useDisplayText } from '@industrial-agent-harness/viewer-builtin/text';
import { ArrowLeft, ArrowRight, Globe, RotateCw, X } from 'lucide-react';

// Embedded web browsing lives in an Electron <webview>: a separate guest
// process with no preload and no Node integration, so web content stays
// untrusted and cannot reach viewerHost or the workbench renderer. The guest
// uses a non-persistent in-memory partition — cookies and storage vanish on
// app restart, and nothing here touches project files, artifacts, or
// verification state.
type WebviewElement = HTMLElement & {
  loadURL(url: string): Promise<void>;
  goBack(): void;
  goForward(): void;
  reload(): void;
  stop(): void;
  canGoBack(): boolean;
  canGoForward(): boolean;
  getURL(): string;
};

function normalizeAddress(input: string): string {
  const value = input.trim();
  if (!value) return '';
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(value)) return value;
  if (/^[\w-]+(\.[\w-]+)+([/?#:].*)?$/.test(value)) return `https://${value}`;
  return `https://www.baidu.com/s?wd=${encodeURIComponent(value)}`;
}

export function BrowserPanel() {
  const { t } = useDisplayText();
  const host = useRef<HTMLDivElement>(null);
  const frame = useRef<WebviewElement | null>(null);
  const [address, setAddress] = useState('');
  const [loading, setLoading] = useState(false);
  const [canBack, setCanBack] = useState(false);
  const [canForward, setCanForward] = useState(false);
  const [failure, setFailure] = useState('');
  useEffect(() => {
    const view = document.createElement('webview') as unknown as WebviewElement;
    frame.current = view;
    view.className = 'ia-browser-frame';
    // A webview only spins up its guest process once it has a src.
    view.setAttribute('src', 'about:blank');
    view.setAttribute('partition', 'browser');
    // Popups stay inside the same frame: main.cjs denies the native window
    // and redirects the URL into this guest instead.
    view.setAttribute('allowpopups', '');
    const sync = () => {
      setCanBack(view.canGoBack());
      setCanForward(view.canGoForward());
      const url = view.getURL();
      if (url && url !== 'about:blank') setAddress(url);
    };
    view.addEventListener('did-start-loading', () => {
      setLoading(true);
      setFailure('');
    });
    view.addEventListener('did-stop-loading', () => {
      setLoading(false);
      sync();
    });
    view.addEventListener('did-navigate', sync);
    view.addEventListener('did-navigate-in-page', sync);
    view.addEventListener('did-fail-load', event => {
      const { errorCode, errorDescription, isMainFrame } = event as unknown as {
        errorCode: number;
        errorDescription: string;
        isMainFrame: boolean;
      };
      // -3 is ERR_ABORTED: user navigation interrupts, not a real failure.
      if (isMainFrame && errorCode !== -3) setFailure(errorDescription);
    });
    host.current!.appendChild(view);
    return () => {
      frame.current = null;
      view.remove();
    };
  }, []);
  const go = () => {
    const url = normalizeAddress(address);
    if (url) void frame.current?.loadURL(url);
  };
  return (
    <div className="ia-browser">
      <form
        className="ia-browser-bar"
        onSubmit={event => {
          event.preventDefault();
          go();
        }}
      >
        <Globe size={14} aria-hidden />
        <button
          type="button"
          disabled={!canBack}
          onClick={() => frame.current?.goBack()}
          title={t('Back')}
          aria-label={t('Back')}
        >
          <ArrowLeft size={14} />
        </button>
        <button
          type="button"
          disabled={!canForward}
          onClick={() => frame.current?.goForward()}
          title={t('Forward')}
          aria-label={t('Forward')}
        >
          <ArrowRight size={14} />
        </button>
        <button
          type="button"
          onClick={() => (loading ? frame.current?.stop() : frame.current?.reload())}
          title={loading ? t('Stop') : t('Reload')}
          aria-label={loading ? t('Stop') : t('Reload')}
        >
          {loading ? <X size={14} /> : <RotateCw size={14} />}
        </button>
        <input
          type="text"
          value={address}
          onChange={event => setAddress(event.target.value)}
          placeholder={t('Enter an address or search')}
          aria-label={t('Address')}
          spellCheck={false}
        />
        <button type="submit" disabled={!address.trim()}>
          {t('Go')}
        </button>
      </form>
      {failure && (
        <p role="alert" className="ia-browser-notice">
          {t('Cannot load this page:')} {failure}
        </p>
      )}
      <div ref={host} className="ia-browser-host" />
    </div>
  );
}
