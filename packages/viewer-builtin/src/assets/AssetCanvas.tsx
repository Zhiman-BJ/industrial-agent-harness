import {useEffect, useRef, useState} from 'react';
import {useWheelZoom} from '../navigation';

export function AssetCanvas({image, rect, columns = 1, rows = 1, selected = 0, onSelect, pixelated, zoom, background, fitRevision = 0, onZoom}: {
  image: HTMLImageElement; rect?: [number, number, number, number]; columns?: number; rows?: number; selected?: number;
  onSelect?: (index: number) => void; pixelated: boolean; zoom: number; background: string; fitRevision?: number; onZoom?: (factor: number) => void;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  useWheelZoom(canvas, onZoom);
  const [size, setSize] = useState({width: 1, height: 1});
  const [pan, setPan] = useState({x: 0, y: 0});
  const drag = useRef<{x: number; y: number; panX: number; panY: number; moved: boolean} | null>(null);
  useEffect(() => {
    const node = canvas.current!;
    const observer = new ResizeObserver(([entry]) => setSize({width: entry.contentRect.width, height: entry.contentRect.height}));
    observer.observe(node); return () => observer.disconnect();
  }, []);
  useEffect(() => {setPan({x: 0, y: 0});}, [image, zoom, fitRevision]);
  const region: [number, number, number, number] = rect ?? [0, 0, image.naturalWidth, image.naturalHeight];
  const scale = Math.min((size.width - 32) / region[2], (size.height - 32) / region[3]) * zoom;
  const factor = Math.max(0.01, scale);
  const left = (size.width - region[2] * factor) / 2 + pan.x;
  const top = (size.height - region[3] * factor) / 2 + pan.y;
  useEffect(() => {
    const node = canvas.current!; const ratio = Math.min(window.devicePixelRatio || 1, 2);
    node.width = Math.max(1, Math.round(size.width * ratio)); node.height = Math.max(1, Math.round(size.height * ratio));
    const context = node.getContext('2d')!; context.scale(ratio, ratio); context.imageSmoothingEnabled = !pixelated;
    context.drawImage(image, ...region, left, top, region[2] * factor, region[3] * factor);
    if (onSelect) {
      const w = region[2] * factor / columns; const h = region[3] * factor / rows;
      context.strokeStyle = '#63bfe177'; context.lineWidth = 1; context.beginPath();
      for (let x = 0; x <= columns; x++) {context.moveTo(left + x * w, top); context.lineTo(left + x * w, top + region[3] * factor);}
      for (let y = 0; y <= rows; y++) {context.moveTo(left, top + y * h); context.lineTo(left + region[2] * factor, top + y * h);}
      context.stroke(); context.strokeStyle = '#ffd568'; context.lineWidth = 2;
      context.strokeRect(left + (selected % columns) * w, top + Math.floor(selected / columns) * h, w, h);
    }
  }, [image, region[0], region[1], region[2], region[3], size, left, top, factor, pixelated, columns, rows, selected, onSelect]);
  return <div className={`rp-asset-canvas rp-asset-bg-${background}`}>
    <canvas ref={canvas} aria-label={onSelect ? 'Sprite sheet; click a cell to select a frame' : 'Image preview'}
      onPointerDown={event => {event.currentTarget.setPointerCapture(event.pointerId); drag.current = {x: event.clientX, y: event.clientY, panX: pan.x, panY: pan.y, moved: false};}}
      onPointerMove={event => {const start = drag.current; if (!start) return; const x = event.clientX - start.x; const y = event.clientY - start.y; if (Math.hypot(x, y) > 3) start.moved = true; if (start.moved) setPan({x: start.panX + x, y: start.panY + y});}}
      onPointerUp={event => {
        const start = drag.current; drag.current = null;
        if (!onSelect || !start || start.moved) return;
        const box = event.currentTarget.getBoundingClientRect(); const x = (event.clientX - box.left - left) / factor; const y = (event.clientY - box.top - top) / factor;
        if (x >= 0 && y >= 0 && x < region[2] && y < region[3]) onSelect(Math.floor(y / (region[3] / rows)) * columns + Math.floor(x / (region[2] / columns)));
      }} onPointerCancel={() => {drag.current = null;}}/>
  </div>;
}
