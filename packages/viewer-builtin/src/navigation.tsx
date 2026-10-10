import { createContext, useContext, useEffect, useRef } from 'react';
import type { RefObject } from 'react';

/** Temporary view controls; never an industrial action or engineering state. */
export interface ViewNavigation {
  zoomIn: () => void;
  zoomOut: () => void;
  fit: () => void;
  ready: boolean;
  percent?: number;
  description?: string;
}
export const ViewNavigationContext = createContext<
  ((value: ViewNavigation | null) => void) | undefined
>(undefined);

export function useViewNavigation(value: ViewNavigation) {
  const publish = useContext(ViewNavigationContext);
  const latest = useRef(value);
  latest.current = value;
  useEffect(() => {
    publish?.({
      zoomIn: () => latest.current.zoomIn(),
      zoomOut: () => latest.current.zoomOut(),
      fit: () => latest.current.fit(),
      ready: value.ready,
      percent: value.percent,
      description: value.description,
    });
  }, [publish, value.ready, value.percent, value.description]);
  // Updating the scale must not briefly remove an otherwise ready controller.
  // Clear it when the Viewer or its host changes, not on every zoom event.
  useEffect(() => () => publish?.(null), [publish]);
}

/** Normalize mouse wheels, trackpad scroll and Ctrl+wheel pinch to a bounded view scale. */
export function wheelZoomFactor(deltaY: number, deltaMode = 0) {
  const pixels = deltaY * (deltaMode === 1 ? 8 : deltaMode === 2 ? 24 : 1);
  return Math.exp(-Math.max(-120, Math.min(120, pixels)) * 0.005);
}
export function useWheelZoom<T extends HTMLElement>(
  element: RefObject<T | null>,
  onZoom?: (factor: number) => void,
  enabled = true,
) {
  const callback = useRef(onZoom);
  callback.current = onZoom;
  useEffect(() => {
    const node = element.current;
    if (!node) return;
    const wheel = (event: WheelEvent) => {
      // 触控板捏合在浏览器里表现为 Ctrl+wheel；即使普通滚轮缩放被禁用
      // （文本/代码视图），捏合缩放仍然保留。
      const pinch = event.ctrlKey || event.metaKey;
      if (event.shiftKey || !callback.current) return;
      if (!enabled && !pinch) return;
      event.preventDefault();
      callback.current(wheelZoomFactor(event.deltaY, event.deltaMode));
    };
    node.addEventListener('wheel', wheel, { passive: false });
    return () => node.removeEventListener('wheel', wheel);
  }, [element, enabled]);
}
