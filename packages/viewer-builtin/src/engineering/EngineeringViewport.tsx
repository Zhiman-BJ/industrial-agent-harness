import { useDisplayText } from '../text';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type { EngineeringData, EngineeringDrawing } from '../api';
import { useViewNavigation, useWheelZoom } from '../navigation';
import { TextView } from '../documents/TextView';
import { AssetViewport } from '../assets/AssetViewport';

function bounds(shapes: EngineeringDrawing[]) {
  let minX = Infinity,
    minY = Infinity,
    maxX = -Infinity,
    maxY = -Infinity;
  const add = (x: number, y: number) => {
    if (Number.isFinite(x) && Number.isFinite(y)) {
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    }
  };
  for (const item of shapes) {
    if (item.type === 'line' || item.type === 'rect' || item.type === 'pad') {
      add(item.x1, item.y1);
      add(item.x2, item.y2);
    } else if (item.type === 'circle') {
      add(item.x - item.r, item.y - item.r);
      add(item.x + item.r, item.y + item.r);
    } else if (item.type === 'label') add(item.x, item.y);
    else if ('points' in item) for (const point of item.points) add(point[0], point[1]);
  }
  if (!Number.isFinite(minX)) return { x: -10, y: -10, width: 20, height: 20 };
  const pad = Math.max(1, Math.max(maxX - minX, maxY - minY) * 0.04);
  return {
    x: minX - pad,
    y: minY - pad,
    width: Math.max(2, maxX - minX + pad * 2),
    height: Math.max(2, maxY - minY + pad * 2),
  };
}

function Drawing({ shape, color }: { shape: EngineeringDrawing; color: string }) {
  if (shape.type === 'line')
    return (
      <line
        x1={shape.x1}
        y1={shape.y1}
        x2={shape.x2}
        y2={shape.y2}
        stroke={color}
        strokeWidth={Math.max(0.08, shape.width || 0.12)}
        strokeLinecap="round"
      />
    );
  if (shape.type === 'rect' || shape.type === 'pad')
    return (
      <rect
        x={Math.min(shape.x1, shape.x2)}
        y={Math.min(shape.y1, shape.y2)}
        width={Math.abs(shape.x2 - shape.x1)}
        height={Math.abs(shape.y2 - shape.y1)}
        stroke={color}
        strokeWidth={0.13}
        fill={shape.type === 'pad' ? color : 'none'}
        fillOpacity={0.55}
      />
    );
  if (shape.type === 'circle')
    return (
      <circle
        cx={shape.x}
        cy={shape.y}
        r={Math.max(0.04, shape.r)}
        stroke={color}
        strokeWidth={0.12}
        fill="none"
      />
    );
  if (shape.type === 'polyline')
    return (
      <polyline
        points={shape.points.map(point => `${point[0]},${point[1]}`).join(' ')}
        stroke={color}
        strokeWidth={0.12}
        fill="none"
      />
    );
  if (shape.type === 'label')
    return (
      <text x={shape.x} y={shape.y} fill={color} fontSize={1.4}>
        {shape.label}
      </text>
    );
  return null;
}

// GDScript 基础高亮：注释 / 字符串 / 注解 / 关键字 / 数字。
const GD_TOKEN =
  /(#.*$)|("(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*')|(@\w+)|(\b(?:and|as|assert|await|break|class_name|const|continue|elif|else|enum|extends|false|for|func|if|in|is|match|not|null|or|pass|return|self|signal|static|super|true|var|void|while)\b)|(\b\d+(?:\.\d+)?\b)/g;
const GD_CLASS: Record<number, string> = {
  1: 'rp-engineering-comment',
  2: 'rp-engineering-string',
  3: 'rp-engineering-annotation',
  4: 'rp-engineering-keyword',
  5: 'rp-engineering-number',
};

function highlightGdscript(line: string): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  let key = 0;
  for (const match of line.matchAll(GD_TOKEN)) {
    const start = match.index ?? 0;
    if (start > last) out.push(line.slice(last, start));
    const group = [1, 2, 3, 4, 5].find(i => match[i] !== undefined);
    if (group) {
      out.push(
        <span className={GD_CLASS[group]} key={key++}>
          {match[0]}
        </span>,
      );
      last = start + match[0].length;
    }
  }
  if (last < line.length) out.push(line.slice(last));
  return out;
}

function Source({ data, query }: { data: EngineeringData; query: string }) {
  const { t } = useDisplayText();
  if (!data.source)
    return (
      <p className="rp-engineering-notice">{t('This binary file has no text source preview.')}</p>
    );
  if (data.format !== 'GDScript') return <TextView text={data.source} query={query} />;
  const lines = data.source.split('\n');
  const needle = query.toLocaleLowerCase();
  const selected = lines
    .map((line, index) => ({ line, number: index + 1 }))
    .filter(item => !needle || item.line.toLocaleLowerCase().includes(needle))
    .slice(0, 1000);
  return (
    <div className="rp-document-text">
      <p className="rp-document-options">
        {selected.length} {needle ? 'matching ' : ''}
        {t('lines · first 1,000 displayed')}
      </p>
      <pre className="is-wrapped">
        {selected.map(({ line, number }) => (
          <span className="rp-document-line" key={number} id={`engineering-line-${number}`}>
            <span className="rp-document-line-number">{number}</span>
            <span>{highlightGdscript(line)}</span>
          </span>
        ))}
      </pre>
    </div>
  );
}

function StructuredView({
  data,
  artifactId,
  onReady,
}: {
  data: EngineeringData;
  artifactId: string;
  onReady: () => void;
}) {
  const { t } = useDisplayText();
  const [mode, setMode] = useState<'preview' | 'source'>(
    data.mode === 'source' ? 'source' : 'preview',
  );
  const [selected, setSelected] = useState(
    data.sections.find(item => item.kind === 'node')?.id || data.sections[0]?.id || '',
  );
  const [query, setQuery] = useState('');
  const [zoom, setZoom] = useState(1);
  const [externalError, setExternalError] = useState('');
  const [visible, setVisible] = useState<Set<string>>(
    () =>
      new Set(
        (data.format === 'KiCad symbol library' ? data.sections.slice(0, 1) : data.sections).map(
          item => item.id,
        ),
      ),
  );
  const viewport = useRef<HTMLDivElement>(null);
  const selectedSection = data.sections.find(item => item.id === selected);
  const drawings = useMemo(
    () => (data.drawings || []).filter(item => visible.has(item.group)).slice(0, 12000),
    [data.drawings, visible],
  );
  const box = useMemo(() => bounds(drawings), [drawings]);
  const changeZoom = (factor: number) =>
    setZoom(value => Math.max(0.25, Math.min(8, value * factor)));
  const fit = () => {
    setZoom(1);
    viewport.current?.scrollTo({ top: 0, left: 0 });
  };
  useViewNavigation({
    ready: true,
    percent: Math.round(zoom * 100),
    zoomIn: () => changeZoom(1.2),
    zoomOut: () => changeZoom(1 / 1.2),
    fit,
  });
  // 滚轮缩放只作用于图形化预览（几何图、音视频）；原文（代码）视图保持滚轮滚动。
  const wheelZoomEnabled =
    mode === 'preview' && (Boolean(data.drawings?.length) || Boolean(data.mediaUrl));
  useWheelZoom(viewport, changeZoom, wheelZoomEnabled);
  const readyCallback = useRef(onReady);
  readyCallback.current = onReady;
  useEffect(() => {
    readyCallback.current();
  }, []);
  const choose = (id: string) => {
    setSelected(id);
    if (data.format === 'KiCad symbol library') setVisible(new Set([id]));
    if (mode === 'source') {
      const section = data.sections.find(item => item.id === id);
      if (section)
        document
          .getElementById(`engineering-line-${section.line}`)
          ?.scrollIntoView({ block: 'center' });
    }
  };
  const palette = ['#5fafd9', '#e7ad61', '#8dca83', '#d884ac', '#b4a0e7', '#e1d37d'];
  return (
    <div className="rp-engineering" data-engineering-format={data.format}>
      <header className="rp-engineering-toolbar">
        <strong title={data.name}>{data.name}</strong>
        <span>
          {data.format} {t('· Read only')}
        </span>
        {/\.(?:res|obj|gltf|glb|step|stp|wrl)$/i.test(data.name) && (
          <button
            onClick={() => {
              setExternalError('');
              void window
                .viewerHost!.openExternalArtifact(artifactId)
                .catch(error => setExternalError(String(error)));
            }}
          >
            {t('Open in app')}
          </button>
        )}
        <button aria-pressed={mode === 'preview'} onClick={() => setMode('preview')}>
          {t('Preview')}
        </button>
        {data.source && (
          <button aria-pressed={mode === 'source'} onClick={() => setMode('source')}>
            {t('Source')}
          </button>
        )}
      </header>
      {externalError && (
        <p className="rp-engineering-notice" role="alert">
          {externalError}
        </p>
      )}
      <div className="rp-engineering-summary">
        {data.summary} · {data.sha256.slice(0, 12)}
        {wheelZoomEnabled ? ` ${t('· Wheel or pinch to zoom')}` : ''}
      </div>
      {data.warnings.map((warning, index) => (
        <p className="rp-engineering-notice" role="status" key={index}>
          {warning}
        </p>
      ))}
      <div className="rp-engineering-body">
        <aside className="rp-engineering-outline">
          <label>
            {t('Find')}{' '}
            <input
              type="search"
              aria-label={t('Find engineering item')}
              value={query}
              onChange={event => setQuery(event.target.value)}
            />
          </label>
          <b>{t('Structure')}</b>
          {data.sections
            .filter(
              item =>
                !query ||
                `${item.label} ${item.kind}`
                  .toLocaleLowerCase()
                  .includes(query.toLocaleLowerCase()),
            )
            .slice(0, 1000)
            .map(item => (
              <div className="rp-engineering-row" key={item.id}>
                {data.drawings?.length ? (
                  <input
                    type="checkbox"
                    aria-label={t('Show {0}', { '0': item.label })}
                    checked={visible.has(item.id)}
                    onChange={() =>
                      setVisible(current => {
                        const next = new Set(current);
                        if (next.has(item.id)) next.delete(item.id);
                        else next.add(item.id);
                        return next;
                      })
                    }
                  />
                ) : null}
                <button
                  aria-pressed={selected === item.id}
                  onClick={() => choose(item.id)}
                  title={item.label}
                  style={{
                    paddingLeft:
                      item.kind === 'node'
                        ? 8 +
                          Math.min(
                            6,
                            String(item.properties.parent || '')
                              .split('/')
                              .filter(Boolean).length,
                          ) *
                            11
                        : undefined,
                  }}
                >
                  {item.label}
                  <small>{item.kind}</small>
                </button>
              </div>
            ))}
          {data.links.length > 0 && (
            <>
              <b>{t('References')}</b>
              {data.links.slice(0, 200).map((item, index) => (
                <div className="rp-engineering-link" key={index} title={item.path}>
                  {item.path}
                  <small>{item.status}</small>
                </div>
              ))}
            </>
          )}
        </aside>
        <div
          ref={viewport}
          className="rp-engineering-viewport"
          tabIndex={0}
          aria-label={`${data.format} preview`}
        >
          <div className="rp-engineering-content" style={{ zoom }}>
            {mode === 'source' ? (
              <Source data={data} query={query} />
            ) : (
              <>
                {data.mediaUrl && (
                  <audio
                    controls
                    preload="metadata"
                    src={data.mediaUrl}
                    aria-label={t('Audio preview')}
                  />
                )}
                {data.drawings?.length ? (
                  <div className="rp-engineering-geometry">
                    <svg
                      role="img"
                      aria-label={`${data.format} geometry`}
                      viewBox={`${box.x} ${box.y} ${box.width} ${box.height}`}
                      preserveAspectRatio="xMidYMid meet"
                    >
                      <rect
                        x={box.x}
                        y={box.y}
                        width={box.width}
                        height={box.height}
                        fill="#101821"
                      />
                      {drawings.map((shape, index) => (
                        <Drawing
                          key={index}
                          shape={shape}
                          color={
                            palette[
                              Math.max(
                                0,
                                data.sections.findIndex(item => item.id === shape.group),
                              ) % palette.length
                            ]
                          }
                        />
                      ))}
                    </svg>
                    {(data.drawings?.length || 0) > 12000 && (
                      <p>{t('Display limited to the first 12,000 visible primitives.')}</p>
                    )}
                  </div>
                ) : null}
                {selectedSection && (
                  <section className="rp-engineering-properties">
                    <h3>{selectedSection.label}</h3>
                    <small>
                      {selectedSection.kind} {t('· source line')} {selectedSection.line}
                    </small>
                    <dl>
                      {Object.entries(selectedSection.properties)
                        .slice(0, 200)
                        .map(([key, value]) => (
                          <div key={key}>
                            <dt>{key}</dt>
                            <dd>{String(value)}</dd>
                          </div>
                        ))}
                    </dl>
                  </section>
                )}
                {!selectedSection && !data.drawings?.length && !data.mediaUrl && (
                  <p>{t('No structured items found. Open Source for the original file.')}</p>
                )}
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

export function EngineeringViewport({
  data,
  artifactId,
  onReady,
  onError,
}: {
  data: EngineeringData;
  artifactId: string;
  onReady: () => void;
  onError: (message: string) => void;
}) {
  const { t } = useDisplayText();
  const [tab, setTab] = useState<'structure' | 'animation'>('structure');
  return (
    <div className="rp-engineering-shell">
      {data.animation && (
        <nav className="rp-engineering-tabs">
          <button aria-pressed={tab === 'structure'} onClick={() => setTab('structure')}>
            {t('Structure')}
          </button>
          <button aria-pressed={tab === 'animation'} onClick={() => setTab('animation')}>
            {t('Animation')}
          </button>
        </nav>
      )}
      {tab === 'animation' && data.animation ? (
        <AssetViewport data={data.animation} onReady={onReady} onError={onError} />
      ) : (
        <StructuredView data={data} artifactId={artifactId} onReady={onReady} />
      )}
    </div>
  );
}
