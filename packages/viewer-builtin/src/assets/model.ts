import type {SpriteFrame} from '../api';
export function gridFrames(image: number, width: number, height: number, columns: number, rows: number, fps: number): SpriteFrame[] {
  const w = width / columns; const h = height / rows;
  return Array.from({length: columns * rows}, (_, index) => ({image, rect: [(index % columns) * w, Math.floor(index / columns) * h, w, h], duration: 1 / fps}));
}
export function frameAtTime(frames: SpriteFrame[], seconds: number, loop: boolean): {index: number; ended: boolean} {
  const total = frames.reduce((sum, frame) => sum + frame.duration, 0);
  if (!frames.length || total <= 0) return {index: 0, ended: true};
  if (!loop && seconds >= total) return {index: frames.length - 1, ended: true};
  let time = loop ? seconds % total : Math.max(0, seconds);
  for (let index = 0; index < frames.length; index++) {if (time < frames[index].duration) return {index, ended: false}; time -= frames[index].duration;}
  return {index: frames.length - 1, ended: false};
}
