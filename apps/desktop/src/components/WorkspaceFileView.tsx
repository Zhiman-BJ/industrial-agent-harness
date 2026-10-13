import { useCallback, useEffect, useState } from 'react';
import { ViewerCanvas, type ViewNavigation } from '@industrial-agent-harness/viewer-builtin/canvas';
import type { OpenedViewer, ViewerArtifact } from '@industrial-agent-harness/viewer-builtin/api';
import { useDisplayText } from '@industrial-agent-harness/viewer-builtin/text';
import { BrowserPanel } from './BrowserPanel';

export type WorkspaceFile = {
  id: string;
  path: string;
  name: string;
  preview?: boolean;
  artifact?: ViewerArtifact;
  source?: { content: string | null; truncated: boolean };
  browser?: boolean;
};
export type WorkspaceViewState = {
  id: string;
  opened?: OpenedViewer;
  navigation: ViewNavigation | null;
  ready: boolean;
  error: string;
};

export function WorkspaceFileView({
  file,
  active,
  onState,
}: {
  file: WorkspaceFile;
  active: boolean;
  onState: (state: WorkspaceViewState) => void;
}) {
  const { t } = useDisplayText();
  const [opened, setOpened] = useState<OpenedViewer>();
  const [navigation, setNavigation] = useState<ViewNavigation | null>(null);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState('');
  const [started, setStarted] = useState(false);
  const onReady = useCallback(() => setReady(true), []);
  const onError = useCallback((message: string) => {
    setError(message);
    setReady(false);
  }, []);
  // Once visited, keep the Viewer mounted across tab/layout changes. Closing
  // its tab or changing project releases it through the Viewer's normal cleanup.
  useEffect(() => {
    if (!active || !file.artifact || started) return;
    setStarted(true);
  }, [active, file.artifact, started]);
  useEffect(() => {
    if (!started || !file.artifact) return;
    let cancelled = false;
    void window
      .viewerHost!.open({ artifactId: file.artifact.id })
      .then(view => {
        if (!cancelled) setOpened(view);
      })
      .catch(reason => {
        if (!cancelled) setError(String(reason));
      });
    return () => {
      cancelled = true;
    };
  }, [started, file.artifact?.id]);
  useEffect(() => {
    if (active) onState({ id: file.id, opened, navigation, ready, error });
  }, [active, file.id, opened, navigation, ready, error, onState]);
  return (
    <div className="ia-file-view" hidden={!active} data-file-path={file.path}>
      {file.browser ? (
        <BrowserPanel />
      ) : file.source ? (
        <div className="ia-source-panel">
          {file.source.content == null ? (
            <p>{t('Binary file · no text preview available.')}</p>
          ) : (
            <pre>{file.source.content}</pre>
          )}
          {file.source.truncated && <small>{t('Preview limited to the first 2 MB.')}</small>}
        </div>
      ) : (
        <div className="rp-stage ia-viewer-stage">
          {opened ? (
            <ViewerCanvas
              opened={opened}
              onNavigation={setNavigation}
              onReady={onReady}
              onError={onError}
            />
          ) : (
            <div className="ia-workspace-empty">{error ? t(error) : t('Opening viewer…')}</div>
          )}
        </div>
      )}
    </div>
  );
}
