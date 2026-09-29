import {LayoutViewport} from './layout/LayoutViewport';
import {NetlistViewport} from './netlist/NetlistViewport';
import {WaveformViewport} from './waveform/WaveformViewport';
import {GodotViewport} from './godot/GodotViewport';
import {AssetViewport} from './assets/AssetViewport';
import {KiCadViewport} from './kicad/KiCadViewport';
import {DocumentViewport} from './documents/DocumentViewport';
import type {OpenedViewer} from './api';
import {ViewNavigationContext} from './navigation';
import type {ViewNavigation} from './navigation';
export type {ViewNavigation} from './navigation';

export function ViewerCanvas({onNavigation, ...props}: {opened: OpenedViewer; onReady: () => void; onError: (message: string) => void; onNavigation?: (value: ViewNavigation | null) => void}) {
  return <ViewNavigationContext value={onNavigation}><ViewerContent {...props}/></ViewNavigationContext>;
}
function ViewerContent({opened, onReady, onError}: {opened: OpenedViewer; onReady: () => void; onError: (message: string) => void}) {
  switch (opened.kind) {
    case 'layout': return <LayoutViewport meta={opened.data} onReady={onReady} onError={onError}/>;
    case 'netlist': return <NetlistViewport data={opened.data} onReady={onReady} onError={onError}/>;
    case 'waveform': return <WaveformViewport data={opened.data} onReady={onReady} onError={onError}/>;
    case 'godot': return <GodotViewport data={opened.data} onReady={onReady} onError={onError}/>;
    case 'image': case 'sprite': case 'animation': return <AssetViewport data={opened.data} onReady={onReady} onError={onError}/>;
    case 'kicad': return <KiCadViewport data={opened.data} onReady={onReady} onError={onError}/>;
    case 'table': case 'json': case 'jsonl': case 'markdown': case 'text': return <DocumentViewport kind={opened.kind} data={opened.data} onReady={onReady}/>;
  }
}
