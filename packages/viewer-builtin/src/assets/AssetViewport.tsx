import {useEffect, useMemo, useState} from 'react';
import type {AssetData, SpriteAnimation} from '../api';
import {AssetCanvas} from './AssetCanvas';
import {AnimationViewport} from './AnimationViewport';
import {gridFrames} from './model';
import {useViewNavigation} from '../navigation';

export function AssetViewport({data, onReady, onError}: {data: AssetData; onReady: () => void; onError: (message: string) => void}) {
  const [images, setImages] = useState<HTMLImageElement[]>([]);
  const [error, setError] = useState(''); const [mode, setMode] = useState(data.initialMode);
  const [imageIndex, setImageIndex] = useState(0);
  const [columns, setColumns] = useState(data.columns); const [rows, setRows] = useState(data.rows);
  const [selected, setSelected] = useState(0);
  const [zoom, setZoom] = useState(1); const [pixelated, setPixelated] = useState(true); const [background, setBackground] = useState('checker');
  const [clip, setClip] = useState(data.animations.length ? 0 : -1);
  const [start, setStart] = useState(0); const [end, setEnd] = useState<number | null>(null); const [fps, setFps] = useState(8);
  useEffect(() => {
    let cancelled = false;
    const loaded = data.images.map(source => {
      const image = new Image();
      const promise = new Promise<HTMLImageElement>((resolve, reject) => {
        image.onload = () => image.naturalWidth === source.width && image.naturalHeight === source.height ? resolve(image) : reject(Error('Image dimensions changed.'));
        image.onerror = () => reject(Error(`Unable to decode ${source.name}.`)); image.src = source.url;
      });
      return {image, promise};
    });
    void Promise.all(loaded.map(item => item.promise)).then(result => {if (!cancelled) {setImages(result); onReady();}}).catch(reason => {if (!cancelled) {setError(String(reason)); onError(String(reason));}});
    return () => {cancelled = true; for (const {image} of loaded) {image.onload = null; image.onerror = null;}};
  }, [data.images]);
  const source = data.images[imageIndex]; const image = images[imageIndex];
  const [fitRevision, setFitRevision] = useState(0);
  useViewNavigation({ready: Boolean(image) && !error, percent: Math.round(zoom * 100), zoomIn: () => setZoom(value => Math.min(8, value * 1.25)), zoomOut: () => setZoom(value => Math.max(0.25, value * 0.8)), fit: () => {setZoom(1); setFitRevision(value => value + 1);}});
  const validGrid = Number.isInteger(columns) && Number.isInteger(rows) && columns >= 1 && rows >= 1 && columns <= 128 && rows <= 128 && columns * rows <= 4096 && source.width % columns === 0 && source.height % rows === 0;
  const frames = useMemo(() => validGrid ? gridFrames(imageIndex, source.width, source.height, columns, rows, fps) : [], [validGrid, imageIndex, source.width, source.height, columns, rows, fps]);
  const frameIndex = Math.min(selected, Math.max(0, frames.length - 1));
  const rangeEnd = Math.min(end ?? frames.length - 1, frames.length - 1);
  const validRange = validGrid && Number.isInteger(start) && start >= 0 && Number.isInteger(rangeEnd) && rangeEnd >= start && fps > 0 && fps <= 120;
  const manual = useMemo<SpriteAnimation>(() => ({name: 'Manual range', loop: true, frames: validRange ? frames.slice(start, rangeEnd + 1) : []}), [frames, validRange, start, rangeEnd]);
  const animation = clip < 0 ? manual : data.animations[clip];
  const viewProps = {pixelated, zoom, background, fitRevision, onZoom: (factor: number) => setZoom(value => Math.max(0.25, Math.min(8, value * factor)))};
  const gridControls = <><label>Columns <input aria-label="Sprite columns" type="number" min={1} max={128} value={columns} onChange={event => setColumns(Number(event.target.value))}/></label><label>Rows <input aria-label="Sprite rows" type="number" min={1} max={128} value={rows} onChange={event => setRows(Number(event.target.value))}/></label></>;
  return <div className="rp-assets">
    <header className="rp-asset-toolbar"><div className="rp-asset-modes" aria-label="Asset viewer mode">{(['image', 'sprite', 'animation'] as const).map(value => <button key={value} aria-pressed={mode === value} onClick={() => setMode(value)}>{value === 'image' ? 'Image' : value === 'sprite' ? 'Sprite sheet' : 'Animation'}</button>)}</div>
      <label>Background <select aria-label="Asset background" value={background} onChange={event => setBackground(event.target.value)}><option value="checker">Checkerboard</option><option value="dark">Dark</option><option value="light">Light</option></select></label>
      <label><input type="checkbox" checked={pixelated} onChange={event => setPixelated(event.target.checked)}/>Pixelated</label>
    </header>
    {data.images.length > 1 && <div className="rp-asset-controls"><label>Texture <select aria-label="Asset texture" value={imageIndex} onChange={event => {setImageIndex(Number(event.target.value)); setSelected(0); setStart(0); setEnd(null);}}>{data.images.map((item, index) => <option key={index} value={index}>{item.name}</option>)}</select></label></div>}
    {error ? <p role="alert" className="rp-asset-error">{error}</p> : !image ? <div className="rp-asset-empty">Loading image…</div> : <>
      {mode === 'image' && <AssetCanvas image={image} {...viewProps}/>}
      {mode === 'sprite' && <>
        <div className="rp-asset-controls">{gridControls}<label>Frame <input aria-label="Sprite frame" type="number" min={0} max={Math.max(0, frames.length - 1)} value={frameIndex} onChange={event => setSelected(Math.max(0, Math.min(frames.length - 1, Math.floor(Number(event.target.value)))))}/></label><span>{validGrid ? `${frames.length} frames · ${source.width / columns} × ${source.height / rows} px` : 'Choose an evenly divisible grid, up to 4096 cells.'}</span></div>
        {validGrid ? <div className="rp-asset-sprite"><AssetCanvas image={image} columns={columns} rows={rows} selected={frameIndex} onSelect={setSelected} {...viewProps}/><div className="rp-asset-frame-preview"><b>Frame {frameIndex}</b><AssetCanvas image={image} rect={frames[frameIndex].rect} {...viewProps}/></div></div> : <div role="status" className="rp-asset-empty">Invalid sprite grid.</div>}
      </>}
      {mode === 'animation' && <>
        <div className="rp-asset-controls"><label>Action <select aria-label="Animation action" value={clip} onChange={event => setClip(Number(event.target.value))}>{data.animations.map((item, index) => <option key={item.name} value={index}>{item.name}</option>)}<option value={-1}>Manual range</option></select></label></div>
        {clip < 0 && <div className="rp-asset-controls">{gridControls}<label>First <input aria-label="Animation first frame" type="number" min={0} max={frames.length - 1} value={start} onChange={event => setStart(Number(event.target.value))}/></label><label>Last <input aria-label="Animation last frame" type="number" min={start} max={frames.length - 1} value={Math.max(0, rangeEnd)} onChange={event => setEnd(Number(event.target.value))}/></label><label>FPS <input aria-label="Animation FPS" type="number" min={1} max={120} value={fps} onChange={event => setFps(Number(event.target.value))}/></label><small>Manual preview; does not modify the project.</small></div>}
        {animation?.frames.length ? <AnimationViewport key={clip} animation={animation} images={images} {...viewProps}/> : <div role="status" className="rp-asset-empty">Choose a valid grid, frame range and FPS.</div>}
      </>}
    </>}
    <footer className="rp-asset-footer">{source.name} · {source.width} × {source.height} px · {data.animations.length ? `${data.animations.length} imported actions` : 'Manual sprite configuration'} · Scroll or pinch to zoom · Drag to pan</footer>
  </div>;
}
