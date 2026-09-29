import {createContext, useContext, useEffect, useRef} from 'react';
import type {RefObject} from 'react';

/** Temporary view controls; never an industrial action or engineering state. */
export interface ViewNavigation {
  zoomIn: () => void;
  zoomOut: () => void;
  fit: () => void;
  ready: boolean;
  percent?: number;
  description?: string;
}
export const ViewNavigationContext = createContext<((value: ViewNavigation | null) => void) | undefined>(undefined);

export function useViewNavigation(value: ViewNavigation) {
  const publish = useContext(ViewNavigationContext);
  const latest = useRef(value);
  latest.current = value;
  useEffect(() => {
    publish?.({
      zoomIn: () => latest.current.zoomIn(), zoomOut: () => latest.current.zoomOut(), fit: () => latest.current.fit(),
      ready: value.ready, percent: value.percent, description: value.description,
    });
    return () => publish?.(null);
  }, [publish, value.ready, value.percent, value.description]);
}

/** Normalize mouse wheels, trackpad scroll and Ctrl+wheel pinch to a bounded view scale. */
export function wheelZoomFactor(deltaY: number, deltaMode = 0) {
  const pixels = deltaY * (deltaMode === 1 ? 8 : deltaMode === 2 ? 24 : 1);
  return Math.exp(-Math.max(-120, Math.min(120, pixels)) * 0.005);
}
export function useWheelZoom<T extends HTMLElement>(element: RefObject<T | null>, onZoom?: (factor: number) => void) {
  const callback = useRef(onZoom); callback.current = onZoom;
  useEffect(() => {
    const node = element.current;
    if (!node) return;
    const wheel = (event: WheelEvent) => {
      if (event.shiftKey || !callback.current) return;
      event.preventDefault();
      callback.current(wheelZoomFactor(event.deltaY, event.deltaMode));
    };
    node.addEventListener('wheel', wheel, {passive:false});
    return () => node.removeEventListener('wheel', wheel);
  }, [element]);
}
