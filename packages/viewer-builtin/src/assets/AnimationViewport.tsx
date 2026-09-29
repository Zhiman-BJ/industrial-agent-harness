import {useEffect, useRef, useState} from 'react';
import type {SpriteAnimation} from '../api';
import {AssetCanvas} from './AssetCanvas';
import {frameAtTime} from './model';

export function AnimationViewport({animation, images, pixelated, zoom, background, fitRevision, onZoom}: {
  animation: SpriteAnimation; images: HTMLImageElement[]; pixelated: boolean; zoom: number; background: string; fitRevision?: number; onZoom?: (factor: number) => void;
}) {
  const [index, setIndex] = useState(0); const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(1); const [loop, setLoop] = useState(animation.loop);
  const position = useRef(0);
  useEffect(() => {setPlaying(false); setIndex(0); position.current = 0; setLoop(animation.loop);}, [animation]);
  useEffect(() => {
    if (!playing) return;
    let previous = performance.now(); let id = 0;
    function tick(now: number) {
      position.current += Math.min(now - previous, 250) * speed / 1000; previous = now;
      const frame = frameAtTime(animation.frames, position.current, loop); setIndex(frame.index);
      if (frame.ended) setPlaying(false); else id = requestAnimationFrame(tick);
    }
    id = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(id);
  }, [playing, animation, loop, speed]);
  const current = animation.frames[Math.min(index, animation.frames.length - 1)];
  function seek(next: number) {setPlaying(false); setIndex(next); position.current = animation.frames.slice(0, next).reduce((sum, frame) => sum + frame.duration, 0);}
  return <div className="rp-asset-animation">
    <div className="rp-asset-controls">
      <button onClick={() => {if (!playing && frameAtTime(animation.frames, position.current, false).ended) seek(0); setPlaying(value => !value);}} aria-label={playing ? 'Pause animation' : 'Play animation'}>{playing ? 'Pause' : 'Play'}</button>
      <button onClick={() => seek(0)}>Reset</button><button onClick={() => seek(Math.max(0, index - 1))} aria-label="Previous animation frame">←</button><button onClick={() => seek(Math.min(animation.frames.length - 1, index + 1))} aria-label="Next animation frame">→</button>
      <label>Speed <select aria-label="Animation speed" value={speed} onChange={event => setSpeed(Number(event.target.value))}>{[0.25, 0.5, 1, 2, 4].map(value => <option key={value} value={value}>{value}×</option>)}</select></label>
      <label><input type="checkbox" checked={loop} onChange={event => setLoop(event.target.checked)}/>Loop</label>
    </div>
    <AssetCanvas image={images[current.image]} rect={current.rect} pixelated={pixelated} zoom={zoom} background={background} fitRevision={fitRevision} onZoom={onZoom}/>
    <div className="rp-asset-timeline"><label>Frame {index + 1} / {animation.frames.length}<input aria-label="Animation frame" type="range" min={0} max={animation.frames.length - 1} value={index} onChange={event => seek(Number(event.target.value))}/></label><span>{current.duration.toFixed(3)} s · {current.rect[2]} × {current.rect[3]} px</span></div>
  </div>;
}
