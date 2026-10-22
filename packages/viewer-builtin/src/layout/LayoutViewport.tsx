import { useContext, useRef, useState } from 'react';
import { Layers } from 'lucide-react';
import type { LayoutMeta } from '../api';
import { useDisplayText } from '../text';
import { ViewNavigationContext } from '../navigation';
import { LayoutRasterViewport } from './LayoutRasterViewport';
import type { RasterControls } from './LayoutRasterViewport';
import { Layout3DViewport } from './Layout3DViewport';

type Props = { meta: LayoutMeta; onReady: () => void; onError: (message: string) => void };
export function LayoutViewport(props: Props) {
  return <LayoutViews key={props.meta.token} {...props} />;
}
function LayoutViews({ meta, onReady, onError }: Props) {
  const { t } = useDisplayText();
  const publish = useContext(ViewNavigationContext);
  const controls = useRef<RasterControls | undefined>(undefined);
  const [theme, setTheme] = useState('02_blueprint');
  const [visible, setVisible] = useState(meta.layers.map(layer => layer.key));
  const [layerMenu, setLayerMenu] = useState(false);
  const [mode, setMode] = useState<'2d' | '3d'>('2d');
  const [box, setBox] = useState<number[] | null>(null);
  const viewBox = useRef<number[] | null>(null);
  const [spacing, setSpacing] = useState(1);
  const [revision, setRevision] = useState(0);
  const [rasterReady, setRasterReady] = useState(false);
  const [selectedLayer, setSelectedLayer] = useState<string | null>(null);
  const [viewPreset, setViewPreset] = useState<'isometric' | 'top'>('isometric');
  const selected = meta.layers.find(layer => layer.key === selectedLayer);
  const layerLabel = (layer: LayoutMeta['layers'][number]) =>
    layer.name === `Layer ${layer.key}` ? t('Layer {0}', { 0: layer.key }) : layer.name;
  function toggleLayer(key: string) {
    const selected = new Set(visible);
    if (selected.has(key)) selected.delete(key);
    else selected.add(key);
    layers(meta.layers.filter(layer => selected.has(layer.key)).map(layer => layer.key));
  }
  function isolateLayer(key: string) {
    setSelectedLayer(key);
    layers([key]);
  }

  function layers(keys: string[]) {
    setVisible(keys);
    setSelectedLayer(current => (current && keys.includes(current) ? current : null));
    controls.current?.layers(keys);
  }
  function open3D() {
    if (mode === '3d') return;
    const current = controls.current?.box();
    if (!current) return;
    viewBox.current = current;
    setBox(previous => (JSON.stringify(previous) === JSON.stringify(current) ? previous : current));
    setMode('3d');
  }
  return (
    <div className="rp-layout">
      <div className="rp-view-tools rp-layout-tools">
        <span className="rp-tool-caption">
          {meta.cell}
          {selected ? ` · ${selected.key}` : ''}
        </span>
        <div className="rp-layout-modes" role="group" aria-label={t('Layout view mode')}>
          <button
            aria-label={t('2D layout')}
            aria-pressed={mode === '2d'}
            onClick={() => setMode('2d')}
          >
            2D
          </button>
          <button
            aria-label={t('2.5D layout')}
            aria-pressed={mode === '3d'}
            disabled={!rasterReady}
            onClick={open3D}
          >
            2.5D
          </button>
        </div>
        <select
          aria-label={t('Layout theme')}
          value={theme}
          onChange={event => {
            setTheme(event.target.value);
            controls.current?.theme(event.target.value);
          }}
        >
          <option value="01_neon">{t('Neon')}</option>
          <option value="02_blueprint">{t('Blueprint')}</option>
          <option value="03_ember">{t('Ember')}</option>
          <option value="04_routing">{t('Routing')}</option>
        </select>
        <button
          className="rp-layers-button"
          onClick={() => setLayerMenu(!layerMenu)}
          aria-expanded={layerMenu}
        >
          <Layers size={15} />
          {t('Layers')}
        </button>
        {layerMenu ? (
          <div
            className="rp-layer-menu"
            onKeyDown={event => {
              if (event.key === 'Escape') {
                event.stopPropagation();
                setLayerMenu(false);
              }
            }}
          >
            <button onClick={() => layers(meta.layers.map(layer => layer.key))}>
              {t('Show all')}
            </button>
            {meta.layers.map(layer => (
              <label key={layer.key}>
                <input
                  type="checkbox"
                  checked={visible.includes(layer.key)}
                  onChange={() => toggleLayer(layer.key)}
                />
                {layerLabel(layer)}
                <button
                  onClick={event => {
                    event.preventDefault();
                    isolateLayer(layer.key);
                  }}
                >
                  {t('Only')}
                </button>
              </label>
            ))}
          </div>
        ) : null}
      </div>
      {mode === '3d' ? (
        <div className="rp-layout-stack-tools">
          <div className="rp-layout-modes" role="group" aria-label={t('Projection')}>
            <button
              aria-pressed={viewPreset === 'isometric'}
              onClick={() => setViewPreset('isometric')}
            >
              {t('Angled')}
            </button>
            <button aria-pressed={viewPreset === 'top'} onClick={() => setViewPreset('top')}>
              {t('Top / XY')}
            </button>
          </div>
          <label>
            {t('Layer spacing')}
            <input
              type="range"
              min="0.2"
              max="3"
              step="0.1"
              value={spacing}
              onChange={event => setSpacing(Number(event.target.value))}
            />
            <output>{spacing.toFixed(1)}×</output>
          </label>
          <button onClick={() => setRevision(value => value + 1)}>{t('Reload 3D')}</button>
        </div>
      ) : null}
      {mode === '3d' && box ? (
        <div className="rp-layout-region" aria-label={t('Extracted region')}>
          <span>
            {t('Requested region')}: {(box[2] - box[0]).toFixed(2)} × {(box[3] - box[1]).toFixed(2)}{' '}
            µm
          </span>
          <span>
            X {box[0].toFixed(2)}–{box[2].toFixed(2)} · Y {box[1].toFixed(2)}–{box[3].toFixed(2)} µm
          </span>
        </div>
      ) : null}
      <div className="rp-layout-pane" hidden={mode !== '2d'}>
        <ViewNavigationContext.Provider value={mode === '2d' ? publish : undefined}>
          <LayoutRasterViewport
            meta={meta}
            active={mode === '2d'}
            controls={controls}
            onReady={() => {
              setRasterReady(true);
              onReady();
            }}
            onError={message => {
              setRasterReady(false);
              onError(message);
            }}
          />
        </ViewNavigationContext.Provider>
      </div>
      {box ? (
        <div className="rp-layout-pane rp-layout-inspect-pane" hidden={mode !== '3d'}>
          <ViewNavigationContext.Provider value={mode === '3d' ? publish : undefined}>
            <Layout3DViewport
              key={revision}
              meta={meta}
              box={box}
              visible={visible}
              theme={theme}
              spacing={spacing}
              active={mode === '3d'}
              selectedLayer={selectedLayer}
              onSelectLayer={setSelectedLayer}
              viewPreset={viewPreset}
              onViewBox={next => {
                viewBox.current = next;
              }}
              onReturnTo2D={() => setMode('2d')}
            />
          </ViewNavigationContext.Provider>
          <aside className="rp-layout-inspector" aria-label={t('GDS layer inspector')}>
            <header>
              <strong>{t('GDS layers')}</strong>
              <button onClick={() => layers(meta.layers.map(layer => layer.key))}>
                {t('Show all')}
              </button>
            </header>
            <p>{t('Click a shape or a layer to inspect it.')}</p>
            <div className="rp-layout-selection" aria-live="polite">
              {selected ? (
                <>
                  <strong>{layerLabel(selected)}</strong>
                  <code>{selected.key}</code>
                  <span>{t('GDS layer / datatype')}</span>
                  <span>
                    {t(
                      visible.includes(selected.key)
                        ? 'Selected layer highlighted through other layers'
                        : 'Selected layer is hidden. Enable its visibility to show it.',
                    )}
                  </span>
                  <button onClick={() => isolateLayer(selected.key)}>
                    {t('Isolate selected layer')}
                  </button>
                  <button
                    onClick={() => {
                      isolateLayer(selected.key);
                      if (viewBox.current) controls.current?.region(viewBox.current);
                      setMode('2d');
                    }}
                  >
                    {t('Compare selected in 2D')}
                  </button>
                  <button onClick={() => setSelectedLayer(null)}>{t('Clear selection')}</button>
                </>
              ) : (
                <span>{t('No layer selected')}</span>
              )}
            </div>
            <div className="rp-layout-layer-list" role="group" aria-label={t('Select GDS layer')}>
              {[...meta.layers].reverse().map(layer => (
                <div
                  className="rp-layout-layer-row"
                  key={layer.key}
                  data-selected={selectedLayer === layer.key}
                >
                  <input
                    type="checkbox"
                    aria-label={`${t('Show layer')} ${layer.key}`}
                    checked={visible.includes(layer.key)}
                    onChange={() => toggleLayer(layer.key)}
                  />
                  <button
                    data-layer-key={layer.key}
                    aria-pressed={selectedLayer === layer.key}
                    onClick={() => setSelectedLayer(layer.key)}
                    title={`${t('GDS layer / datatype')}: ${layer.key}`}
                  >
                    <span>{layerLabel(layer)}</span>
                    <code>{layer.key}</code>
                  </button>
                </div>
              ))}
            </div>
            <p>{t('GDS layer order; process stack and physical heights are not loaded.')}</p>
          </aside>
        </div>
      ) : null}
    </div>
  );
}
