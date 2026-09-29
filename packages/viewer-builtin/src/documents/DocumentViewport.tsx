import {Component, lazy, Suspense, useCallback, useDeferredValue, useEffect, useRef, useState} from 'react';
import type {ReactNode} from 'react';
import type {DocumentData, DocumentKind} from '../api';
import {useViewNavigation, useWheelZoom} from '../navigation';
import {TableView} from './TableView';
import {JsonView} from './JsonView';
import {TextView} from './TextView';
const MarkdownView = lazy(() => import('./MarkdownView'));

class MarkdownBoundary extends Component<{text: string; children: ReactNode; onFailure: (message: string) => void}, {error: string}> {
  state = {error: ''};
  static getDerivedStateFromError(error: Error) {return {error: error.message};}
  componentDidCatch(error: Error) {this.props.onFailure(error.message);}
  render() {return this.state.error ? <><p role="alert">Markdown preview unavailable: {this.state.error}. Original source follows.</p><TextView text={this.props.text}/></> : this.props.children;}
}

export function DocumentViewport({kind, data, onReady}: {kind: DocumentKind; data: DocumentData; onReady: () => void}) {
  const [source, setSource] = useState(Boolean(data.error || data.warning));
  const [zoom, setZoom] = useState(1);
  const [ready, setReady] = useState(kind !== 'markdown' || source);
  const [query, setQuery] = useState('');
  const [renderError, setRenderError] = useState('');
  const deferredQuery = useDeferredValue(query);
  const viewport = useRef<HTMLDivElement>(null);
  const callback = useRef(onReady); callback.current = onReady;
  const notifyReady = useCallback(() => {setReady(true); callback.current();}, []);
  const markdownFailed = useCallback((message: string) => {setRenderError(message); setSource(true);}, []);
  useEffect(() => {if (kind !== 'markdown' || source) notifyReady();}, [kind, source, notifyReady]);
  const changeZoom = (factor: number) => setZoom(value => Math.max(.5, Math.min(3, value * factor)));
  const fit = () => {setZoom(1); viewport.current?.scrollTo({top: 0, left: 0});};
  useViewNavigation({zoomIn: () => changeZoom(1.2), zoomOut: () => changeZoom(1 / 1.2), fit, ready, percent: Math.round(zoom * 100)});
  useWheelZoom(viewport, changeZoom);
  const description = kind === 'table' ? 'Table' : kind === 'jsonl' ? 'JSON Lines' : kind === 'json' ? 'JSON' : kind === 'markdown' ? 'Markdown' : 'Text';
  const error = data.error || renderError;
  let content: ReactNode;
  if (source || kind === 'text') content = <TextView text={data.text} query={deferredQuery}/>;
  else if (kind === 'table') content = <TableView rows={data.rows!} columns={data.columns!} ragged={data.ragged!} query={deferredQuery}/>;
  else if (kind === 'json' || kind === 'jsonl') content = <JsonView text={data.text} lines={kind === 'jsonl'}/>;
  else content = <MarkdownBoundary text={data.text} onFailure={markdownFailed}><Suspense fallback={<p role="status">Preparing Markdown…</p>}><MarkdownView text={data.text} onReady={notifyReady}/></Suspense></MarkdownBoundary>;
  return <div className="rp-document" data-document-kind={kind}>
    <div className="rp-document-toolbar">
      <strong>{description}</strong>
      {kind !== 'text' && <div role="group" aria-label="Document mode">
        <button aria-pressed={!source} disabled={Boolean(error)} onClick={() => setSource(false)}>Preview</button>
        <button aria-pressed={source} onClick={() => setSource(true)}>Source</button>
      </div>}
      {(source || kind === 'text' || kind === 'table') && <label>Find <input type="search" aria-label="Find in document" value={query} onChange={event => setQuery(event.target.value)}/></label>}
      <small>Wheel to zoom · Shift+wheel to scroll</small>
    </div>
    {error && <p className="rp-document-notice" role="alert">Cannot preview {description}: {error}. Original source is available.</p>}
    {data.warning && <p className="rp-document-notice" role="status">{data.warning}</p>}
    <div ref={viewport} className="rp-document-viewport" tabIndex={0} aria-label={`${description} preview`}>
      <div className="rp-document-content" style={{zoom}}>
        {content}
      </div>
    </div>
  </div>;
}
