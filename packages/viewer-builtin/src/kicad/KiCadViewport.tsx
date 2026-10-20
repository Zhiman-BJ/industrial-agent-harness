import { useDisplayText } from '../text';
import { useEffect, useRef, useState } from 'react';
import type { KiCadData } from '../api';
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
  const [incomplete, setIncomplete] = useState(false);
  useEffect(() => {
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
          setSceneLoading(true);
          setSceneError('');
          return;
        case 'scene-ready': {
          const nextLayers = event.data.layers as PcbLayer[];
          setSceneReady(true);
          setSceneLoading(false);
          setLayers(nextLayers);
          setVisibleLayers(nextLayers.map(layer => layer.id));
          setWarnings(event.data.warnings || []);
          setSchematicSpacing(event.data.zMode !== 'stackup');
          setMissingModels(event.data.missingModels || 0);
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
                {t('Component bodies are not loaded; pads show their actual placement.')}
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
