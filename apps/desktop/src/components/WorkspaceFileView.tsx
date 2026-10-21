import { useCallback, useEffect, useRef, useState } from 'react';
import { ViewerCanvas, type ViewNavigation } from '@industrial-agent-harness/viewer-builtin/canvas';
import type { OpenedViewer, ViewerArtifact } from '@industrial-agent-harness/viewer-builtin/api';
import { useDisplayText } from '@industrial-agent-harness/viewer-builtin/text';
import { BrowserPanel } from './BrowserPanel';
import { openViewerLifecycle, type ViewerOpenLifecycle } from './viewer-open-lifecycle.mjs';
import { viewerDependencyMessage } from './domain-readiness.mjs';

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
  onManageDomains,
}: {
  file: WorkspaceFile;
  active: boolean;
  onState: (state: WorkspaceViewState) => void;
  onManageDomains: () => void;
}) {
  const { t } = useDisplayText();
  const [opened, setOpened] = useState<OpenedViewer>();
  const [navigation, setNavigation] = useState<ViewNavigation | null>(null);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState('');
  const [started, setStarted] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const dependencyMessage = viewerDependencyMessage(error);
  const opening = useRef<ViewerOpenLifecycle<OpenedViewer> | null>(null);
  const onNavigation = useCallback(
    (value: ViewNavigation | null) => {
      setNavigation(value);
      // ViewerCanvas can commit a Suspense fallback before its lazy Viewport
      // mounts. Its navigation controller confirms the Viewport owns cleanup.
      if (value && opened) opening.current?.commit(opened);
    },
    [opened],
  );
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
    const lifecycle = openViewerLifecycle(
      window.viewerHost!,
      { artifactId: file.artifact.id },
      { onOpened: setOpened, onError: reason => setError(String(reason)) },
    );
    opening.current = lifecycle;
    return () => {
      if (opening.current === lifecycle) opening.current = null;
      lifecycle.cancel();
    };
  }, [started, file.artifact?.id, attempt]);
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
          {opened && !error ? (
            <ViewerCanvas
              opened={opened}
              onNavigation={onNavigation}
              onReady={onReady}
              onError={onError}
            />
          ) : (
            <div className="ia-workspace-empty">
              <div>
                <p role={error ? 'alert' : 'status'}>
                  {error ? t(dependencyMessage || error) : t('Opening viewer…')}
                </p>
                <div className="ia-domain-setup-actions">
                  {dependencyMessage?.includes('Open Settings') && (
                    <button className="ia-pack-action" onClick={onManageDomains}>
                      {t('Open domain settings')}
                    </button>
                  )}
                  {error && (
                    <button
                      className="ia-pack-action"
                      onClick={() => {
                        setOpened(undefined);
                        setNavigation(null);
                        setReady(false);
                        setError('');
                        setAttempt(value => value + 1);
                      }}
                    >
                      {t('Retry viewer')}
                    </button>
                  )}
                </div>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
