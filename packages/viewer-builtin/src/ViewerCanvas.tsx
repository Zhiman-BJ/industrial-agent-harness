import { useDisplayText } from './text';
import { Component, lazy, memo, Suspense } from 'react';
import type { ReactNode } from 'react';
import type { OpenedViewer } from './api';
import { ViewNavigationContext } from './navigation';
import type { ViewNavigation } from './navigation';
export type { ViewNavigation } from './navigation';

const LayoutViewport = lazy(() =>
  import('./layout/LayoutViewport').then(module => ({ default: module.LayoutViewport })),
);
const NetlistViewport = lazy(() =>
  import('./netlist/NetlistViewport').then(module => ({ default: module.NetlistViewport })),
);
const WaveformViewport = lazy(() =>
  import('./waveform/WaveformViewport').then(module => ({ default: module.WaveformViewport })),
);
const GodotViewport = lazy(() =>
  import('./godot/GodotViewport').then(module => ({ default: module.GodotViewport })),
);
const AssetViewport = lazy(() =>
  import('./assets/AssetViewport').then(module => ({ default: module.AssetViewport })),
);
const KiCadViewport = lazy(() =>
  import('./kicad/KiCadViewport').then(module => ({ default: module.KiCadViewport })),
);
const DocumentViewport = lazy(() =>
  import('./documents/DocumentViewport').then(module => ({ default: module.DocumentViewport })),
);
const EngineeringViewport = lazy(() =>
  import('./engineering/EngineeringViewport').then(module => ({
    default: module.EngineeringViewport,
  })),
);
const CadViewport = lazy(() =>
  import('./cad/CadViewport').then(module => ({ default: module.CadViewport })),
);

class ViewerBoundary extends Component<
  { children: ReactNode; onError: (message: string) => void },
  { error: string }
> {
  state = { error: '' };
  static getDerivedStateFromError(error: Error) {
    return { error: error.message };
  }
  componentDidCatch(error: Error) {
    this.props.onError(error.message);
  }
  render() {
    return this.state.error ? (
      <p role="alert" className="rp-view-error">
        {this.state.error}
      </p>
    ) : (
      this.props.children
    );
  }
}

export const ViewerCanvas = memo(function ViewerCanvas({
  onNavigation,
  ...props
}: {
  opened: OpenedViewer;
  onReady: () => void;
  onError: (message: string) => void;
  onNavigation?: (value: ViewNavigation | null) => void;
}) {
  const { t } = useDisplayText();
  return (
    <ViewNavigationContext value={onNavigation}>
      <ViewerBoundary key={props.opened.artifact.id} onError={props.onError}>
        <Suspense fallback={<p role="status">{t('Opening viewer…')}</p>}>
          <ViewerContent {...props} />
        </Suspense>
      </ViewerBoundary>
    </ViewNavigationContext>
  );
});
function ViewerContent({
  opened,
  onReady,
  onError,
}: {
  opened: OpenedViewer;
  onReady: () => void;
  onError: (message: string) => void;
}) {
  switch (opened.kind) {
    case 'cad':
      return <CadViewport data={opened.data} onReady={onReady} onError={onError} />;
    case 'layout':
      return <LayoutViewport meta={opened.data} onReady={onReady} onError={onError} />;
    case 'netlist':
      return <NetlistViewport data={opened.data} onReady={onReady} onError={onError} />;
    case 'waveform':
      return <WaveformViewport data={opened.data} onReady={onReady} onError={onError} />;
    case 'godot':
      return <GodotViewport data={opened.data} onReady={onReady} onError={onError} />;
    case 'image':
    case 'sprite':
    case 'animation':
      return <AssetViewport data={opened.data} onReady={onReady} onError={onError} />;
    case 'kicad':
      return <KiCadViewport data={opened.data} onReady={onReady} onError={onError} />;
    case 'engineering':
      return (
        <EngineeringViewport
          data={opened.data}
          artifactId={opened.artifact.id}
          onReady={onReady}
          onError={onError}
        />
      );
    case 'table':
    case 'json':
    case 'jsonl':
    case 'markdown':
    case 'text':
    case 'html':
      return <DocumentViewport kind={opened.kind} data={opened.data} onReady={onReady} />;
  }
}
