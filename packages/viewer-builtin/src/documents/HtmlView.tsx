import { memo } from 'react';
import { useDisplayText } from '../text';

// Project HTML is untrusted content. The page is served from its own
// app://html host with a CSP that allows inline scripts/styles but blocks
// every remote or sibling-file load, and the iframe adds a sandbox on an
// opaque origin: scripts may run (pages often need JS to render at all) but
// they cannot reach the host renderer, storage, cookies, or top-level
// navigation. Serving a real URL instead of srcdoc keeps the workbench CSP
// from being inherited, which would otherwise forbid inline scripts entirely.
function HtmlView({ url, onReady }: { url: string; onReady: () => void }) {
  const { t } = useDisplayText();
  return (
    <iframe
      className="rp-document-html"
      title={t('HTML Preview')}
      sandbox="allow-scripts"
      src={url}
      onLoad={onReady}
    />
  );
}
export default memo(HtmlView);
