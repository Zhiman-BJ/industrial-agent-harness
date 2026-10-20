import { useDisplayText } from '../text';
import { useEffect, useRef, useState } from 'react';
import type { KiCadData, KiCadModelDownloads } from '../api';
import { useViewNavigation } from '../navigation';

type PcbLayer = { id: string; name: string; color: number[] };
type PcbSelection = {
  id: string;
  sourceId?: string;
  kind: string;
  label?: string;
  reference?: string;
  net?: number;
  netName?: string;
  layerId?: string;
};

export function KiCadViewport({
  data,
  onReady,
  onError,
}: {
  data: KiCadData;
  onReady: () => void;
  onError: (message: string) => void;
}) {
  const { t } = useDisplayText();
  const frame = useRef<HTMLIFrameElement>(null);
  const callbacks = useRef({ onReady, onError });
  callbacks.current = { onReady, onError };
  const [status, setStatus] = useState('Loading KiCad document…');
  const [connected, setConnected] = useState(false);
  const [percent, setPercent] = useState(100);
  const [mode, setMode] = useState<'2d' | '3d'>('2d');
  const [sceneReady, setSceneReady] = useState(false);
  const [sceneLoading, setSceneLoading] = useState(false);
  const [sceneError, setSceneError] = useState('');
  const [layers, setLayers] = useState<PcbLayer[]>([]);
  const [visibleLayers, setVisibleLayers] = useState<string[]>([]);
  const [separation, setSeparation] = useState(0);
  const [selection, setSelection] = useState<PcbSelection | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [schematicSpacing, setSchematicSpacing] = useState(false);
  const [missingModels, setMissingModels] = useState(0);
  const [renderedModels, setRenderedModels] = useState(0);
  const [unavailableModels, setUnavailableModels] = useState(0);
  const [showComponents, setShowComponents] = useState(true);
  const [incomplete, setIncomplete] = useState(false);
  const [downloads, setDownloads] = useState<KiCadModelDownloads | undefined>(data.modelDownloads);
  const [downloading, setDownloading] = useState(false);
  const [downloadError, setDownloadError] = useState('');
  const [downloadMessage, setDownloadMessage] = useState('');
  const downloadEpoch = useRef(0);
  const downloadingToken = useRef<string | null>(null);
  const downloadCancelled = useRef(false);
  const activeToken = useRef(data.token);
  const changedPlanMessage = 'Component model download plan changed. Reopen the document.';
  useEffect(() => {
    activeToken.current = data.token;
    downloadEpoch.current++;
    downloadingToken.current = null;
    downloadCancelled.current = false;
    setDownloads(data.modelDownloads);
    setDownloading(false);
    setDownloadError(data.modelDownloads?.error || '');
    setDownloadMessage('');
    setStatus('Loading KiCad document…');
    setConnected(false);
    setPercent(100);
    setMode('2d');
    setSceneReady(false);
    setSceneLoading(false);
    setSceneError('');
    setLayers([]);
    setVisibleLayers([]);
    setSeparation(0);
    setSelection(null);
    setWarnings([]);
    setMissingModels(0);
    setRenderedModels(0);
    setUnavailableModels(0);
    setShowComponents(true);
    setIncomplete(false);
    let captureIncomplete = false;
    let complete = false;
    const fail = (message: string) => {
      complete = true;
      clearTimeout(timer);
      setConnected(false);
      if (frame.current) frame.current.src = 'about:blank';
      setStatus(message);
      callbacks.current.onError(message);
    };
    const timer = setTimeout(() => {
      if (!complete) fail('KiCad Viewer timed out. Reopen the document.');
    }, 30000);
    const receive = (event: MessageEvent) => {
      if (
        event.source !== frame.current?.contentWindow ||
        event.origin !== 'app://kicad' ||
        event.data?.channel !== 'industrial-harness-kicad-v1'
      )
        return;
      if (
        event.data.type === 'view' &&
        Number.isFinite(event.data.percent) &&
        event.data.percent > 0
      ) {
        setPercent(event.data.percent);
        const stats = event.data.stats;
        if (stats)
          setIncomplete(
            captureIncomplete ||
              Boolean(
                stats.sourceOmittedPrimitives ||
                  stats.omittedPrimitives ||
                  stats.omittedBoardBodies ||
                  stats.omittedBodyHoles ||
                  stats.omittedDrillLayers ||
                  stats.unsupportedPrimitives ||
                  stats.boardTopologyIncomplete,
              ),
          );
        return;
      }
      switch (event.data.type) {
        case 'scene-loading':
          setSceneReady(false);
          setSceneLoading(true);
          setSceneError('');
          return;
        case 'scene-ready': {
          const nextLayers = event.data.layers as PcbLayer[];
          setSceneReady(true);
          setSceneLoading(false);
          setLayers(nextLayers);
          const ids = new Set(nextLayers.map(layer => layer.id));
          setVisibleLayers(
            Array.isArray(event.data.visibleLayers)
              ? event.data.visibleLayers.filter(
                  (id: unknown): id is string => typeof id === 'string' && ids.has(id),
                )
              : [...ids],
          );
          setSeparation(
            Number.isFinite(event.data.explode) ? Math.round(event.data.explode * 100) : 0,
          );
          setShowComponents(event.data.componentsVisible !== false);
          if (event.data.refitted)
            setDownloadMessage('The updated 3D view was fitted to the board and components.');
          setWarnings(event.data.warnings || []);
          setSchematicSpacing(event.data.zMode !== 'stackup');
          setMissingModels(event.data.missingModels || 0);
          setRenderedModels(event.data.renderedModels || 0);
          setUnavailableModels((event.data.failedModels || 0) + (event.data.omittedModels || 0));
          captureIncomplete = event.data.complete === false;
          setIncomplete(captureIncomplete);
          return;
        }
        case 'scene-error':
          setSceneLoading(false);
          setSceneReady(false);
          setMode('2d');
          setSceneError(String(event.data.error || 'PCB 3D could not be opened.'));
          return;
        case 'mode':
          setMode(event.data.mode === '3d' ? '3d' : '2d');
          if (event.data.mode === '2d') setSceneLoading(false);
          return;
        case 'selection':
          setSelection(event.data.selection);
          return;
      }
      if (complete) return;
      if (event.data.type === 'ready') {
        complete = true;
        clearTimeout(timer);
        setConnected(true);
        setStatus('');
        callbacks.current.onReady();
      } else if (event.data.type === 'error')
        fail(String(event.data.error || 'KiCad Viewer failed.'));
    };
    window.addEventListener('message', receive);
    return () => {
      const releasedEpoch = ++downloadEpoch.current;
      if (downloadingToken.current === data.token) {
        void window.viewerHost?.cancelViewerResources?.({ token: data.token }).catch(() => {});
        downloadingToken.current = null;
      }
      // A development StrictMode remount keeps this same token. Release only
      // after a real unmount or token change; hiding a retained tab does neither.
      queueMicrotask(() => {
        if (downloadEpoch.current === releasedEpoch || activeToken.current !== data.token)
          void window.viewerHost?.releaseViewerResources?.({ token: data.token }).catch(() => {});
      });
      clearTimeout(timer);
      window.removeEventListener('message', receive);
    };
  }, [data.token]);
  function command(command: string, args?: Record<string, unknown>) {
    if (connected)
      frame.current?.contentWindow?.postMessage(
        { channel: 'industrial-harness-kicad-v1', type: 'command', command, args },
        'app://kicad',
      );
  }
  useViewNavigation({
    ready: connected && !sceneLoading,
    percent,
    zoomIn: () => command('zoomIn'),
    zoomOut: () => command('zoomOut'),
    fit: () => command('fit'),
  });
  const showLayers = (ids: string[]) => {
    setVisibleLayers(ids);
    command('layers', { ids });
  };
  const prepareModels = async () => {
    const prepare = window.viewerHost?.prepareViewerResources;
    if (!prepare || downloadingToken.current) return;
    const token = data.token,
      epoch = downloadEpoch.current;
    downloadingToken.current = token;
    downloadCancelled.current = false;
    setDownloading(true);
    setDownloadError('');
    setDownloadMessage('');
    try {
      const result = await prepare({ token });
      if (downloadEpoch.current !== epoch || result.token !== token) return;
      if (downloadCancelled.current) {
        setDownloadMessage('Model download cancelled.');
        return;
      }
      setDownloads(result.modelDownloads);
      setDownloadError(result.modelDownloads.error || '');
      setDownloadMessage('Component models refreshed.');
      command('reload-models');
    } catch (error) {
      if (downloadEpoch.current !== epoch) return;
      if (downloadCancelled.current || (error as { name?: string })?.name === 'AbortError')
        setDownloadMessage('Model download cancelled.');
      else
        setDownloadError(
          String((error as { message?: string })?.message || error).includes(changedPlanMessage)
            ? changedPlanMessage
            : 'Model download failed. Retry.',
        );
    } finally {
      if (downloadEpoch.current === epoch) {
        downloadingToken.current = null;
        setDownloading(false);
      }
    }
  };
  const cancelDownload = async () => {
    if (downloadingToken.current !== data.token) return;
    downloadCancelled.current = true;
    try {
      await window.viewerHost?.cancelViewerResources?.({ token: data.token });
    } catch {
      if (downloadingToken.current === data.token)
        setDownloadError('Model download failed. Retry.');
    }
  };
  const canDownload =
    typeof window !== 'undefined' && Boolean(window.viewerHost?.prepareViewerResources);
  return (
    <div className="rp-kicad">
      <header className="rp-kicad-toolbar">
        <strong title={data.name}>{data.name}</strong>
        <span>
          {data.document === 'board' ? 'PCB' : t('Schematic')} {t('· Read only')}
        </span>
        {data.document === 'board' && (
          <div className="rp-pcb-mode" role="group" aria-label={t('PCB view')}>
            <button
              aria-label="2D PCB"
              aria-pressed={mode === '2d'}
              disabled={!connected}
              onClick={() => command('mode', { mode: '2d' })}
            >
              2D
            </button>
            <button
              aria-label="3D PCB"
              aria-pressed={mode === '3d'}
              disabled={!connected || sceneLoading}
              onClick={() => command('mode', { mode: '3d' })}
            >
              3D
            </button>
          </div>
        )}
        <button
          disabled={!connected || sceneLoading || mode === '3d'}
          onClick={() => command('page')}
          title={t('Fit the entire drawing sheet')}
        >
          {t('Whole page')}
        </button>
      </header>
      <div className="rp-kicad-navigation-hint">
        {mode === '3d'
          ? t('Drag to orbit · Scroll or pinch to zoom · Right drag to pan')
          : t('Scroll or pinch to zoom · Middle/right drag to pan')}
      </div>
      {data.document === 'board' &&
        downloads &&
        (downloads.downloadFiles > 0 ||
          downloads.unavailableFiles > 0 ||
          downloadError ||
          downloadMessage ||
          downloading) && (
          <section className="rp-pcb3d-downloads" aria-label={t('Component model downloads')}>
            {downloads.downloadFiles > 0 && (
              <p className="rp-pcb3d-note">
                {t('{0} model files · {1} MiB download', {
                  '0': downloads.downloadFiles,
                  '1': (downloads.downloadBytes / 1048576).toFixed(1),
                })}
              </p>
            )}
            {downloads.libraries.map(library => (
              <p className="rp-pcb3d-note" key={library.id + ':' + library.version}>
                {t('Official model library: {0} · {1} · {2}', {
                  '0': library.label,
                  '1': library.version,
                  '2': library.origin,
                })}
                {library.license?.spdx && ` · ${library.license.spdx}`}
              </p>
            ))}
            {downloads.unavailableFiles > 0 && (
              <p className="rp-pcb3d-note">
                {t('Unavailable for this preview: {0}', { '0': downloads.unavailableFiles })}
              </p>
            )}
            {canDownload &&
              downloadError !== changedPlanMessage &&
              (downloads.downloadFiles > 0 || downloadError) && (
                <button
                  disabled={!connected || sceneLoading || downloading}
                  onClick={() => void prepareModels()}
                >
                  {t(downloadError ? 'Retry model download' : 'Download missing models')}
                </button>
              )}
            {downloading && (
              <span role="status">
                <progress aria-label={t('Downloading component models…')} />{' '}
                {t('Downloading component models…')}
              </span>
            )}
            {downloading && window.viewerHost?.cancelViewerResources && (
              <button onClick={() => void cancelDownload()}>{t('Cancel download')}</button>
            )}
            {downloadError && (
              <p className="rp-pcb3d-error" role="alert">
                {t(downloadError)}
              </p>
            )}
            {downloadMessage && (
              <p className="rp-pcb3d-note" role="status">
                {t(downloadMessage)}
              </p>
            )}
          </section>
        )}
      {sceneError && (
        <p className="rp-pcb3d-error" role="alert">
          {t('PCB 3D could not be opened.')} {t(sceneError)}
        </p>
      )}
      <div className="rp-pcb3d-body">
        <div className="rp-kicad-canvas">
          <iframe
            key={data.token}
            ref={frame}
            src={data.url}
            title={t('KiCad document viewer')}
            sandbox="allow-scripts allow-same-origin"
          />
          {(status || sceneLoading) && (
            <div className="rp-kicad-status" role="status">
              {sceneLoading ? t('Preparing PCB 3D geometry…') : status}
            </div>
          )}
        </div>
        {mode === '3d' && sceneReady && (
          <aside className="rp-pcb3d-panel" aria-label={t('PCB layers')}>
            {incomplete && (
              <p className="rp-pcb3d-incomplete" role="status">
                {t('Reduced detail: some geometry could not be displayed.')}
              </p>
            )}
            <div className="rp-pcb3d-views" role="group" aria-label={t('View direction')}>
              {(['isometric', 'top', 'bottom'] as const).map(view => (
                <button key={view} onClick={() => command('preset', { view })}>
                  {t(view === 'isometric' ? 'Isometric' : view === 'top' ? 'Top' : 'Bottom')}
                </button>
              ))}
            </div>
            <label className="rp-pcb3d-separation">
              {t('Layer separation')}
              <input
                aria-label={t('Layer separation')}
                type="range"
                min="0"
                max="100"
                value={separation}
                onChange={event => {
                  const value = Number(event.target.value);
                  setSeparation(value);
                  command('explode', { value: value / 100 });
                }}
              />
            </label>
            <p className="rp-pcb3d-note">
              {t(
                schematicSpacing
                  ? 'Layer spacing is schematic.'
                  : 'Layer heights follow the source stackup.',
              )}
              {separation > 0 && ` ${t('Separation is for display only.')}`}
            </p>
            <div className="rp-pcb3d-layer-heading">
              <strong>{t('Component models')}</strong>
            </div>
            <label className="rp-pcb3d-layer">
              <input
                type="checkbox"
                checked={showComponents}
                disabled={renderedModels === 0}
                onChange={event => {
                  setShowComponents(event.target.checked);
                  command('components', { visible: event.target.checked });
                }}
              />
              {t('Show component bodies')}
            </label>
            <p className="rp-pcb3d-note">
              {t('Loaded models: {0}', { '0': renderedModels })}
              {(missingModels > 0 || unavailableModels > 0) &&
                ` · ${t('Unavailable: {0}', { '0': missingModels + unavailableModels })}`}
            </p>
            <div className="rp-pcb3d-layer-heading">
              <strong>{t('Layers')}</strong>
              <button onClick={() => showLayers(layers.map(layer => layer.id))}>
                {t('Show all')}
              </button>
            </div>
            <div className="rp-pcb3d-layers">
              {layers.map(layer => (
                <div className="rp-pcb3d-layer" key={layer.id}>
                  <input
                    type="checkbox"
                    aria-label={t('Show {0}', { '0': layer.name })}
                    checked={visibleLayers.includes(layer.id)}
                    onChange={event =>
                      showLayers(
                        event.target.checked
                          ? [...visibleLayers, layer.id]
                          : visibleLayers.filter(id => id !== layer.id),
                      )
                    }
                  />
                  <i
                    style={{
                      background: `rgb(${layer.color.map(value => Math.round(value * 255)).join(',')})`,
                    }}
                  />
                  <button
                    title={t('Isolate layer')}
                    aria-pressed={visibleLayers.length === 1 && visibleLayers[0] === layer.id}
                    onClick={() => showLayers([layer.id])}
                  >
                    {layer.name}
                  </button>
                </div>
              ))}
            </div>
            <div className="rp-pcb3d-selection">
              <strong>{t('Selection')}</strong>
              {selection ? (
                <>
                  <p>{selection.reference || selection.label || selection.kind}</p>
                  {selection.netName && (
                    <p>
                      {t('Net')}: {selection.netName}
                    </p>
                  )}
                  {selection.layerId && <p>{selection.layerId}</p>}
                  <small title={selection.sourceId}>{selection.sourceId || selection.id}</small>
                  <button onClick={() => command('mode', { mode: '2d' })}>{t('Show in 2D')}</button>
                </>
              ) : (
                <p>{t('Click copper or a pad to inspect its source object.')}</p>
              )}
            </div>
            {missingModels > 0 && (
              <p className="rp-pcb3d-note">
                {t('Missing component models are not replaced by placeholder shapes.')}
              </p>
            )}
            {warnings.length > 0 && (
              <details className="rp-pcb3d-warnings">
                <summary>
                  {t('Preview limitations')} ({warnings.length})
                </summary>
                {warnings.map((warning, index) => (
                  <p key={index}>{t(warning)}</p>
                ))}
              </details>
            )}
          </aside>
        )}
      </div>
    </div>
  );
}
