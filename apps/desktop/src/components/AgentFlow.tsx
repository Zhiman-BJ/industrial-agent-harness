import type {AgentEvent} from '@industrial-agent-harness/viewer-builtin/api';
import {ThinkingPreview} from './ThinkingPreview';

type ToolResult = Extract<AgentEvent, {type: 'tool-result'}>;

export function AgentFlow({events, running, debug, approve}: {events: AgentEvent[]; running: boolean; debug: boolean; approve: (id: string, decision: 'approve' | 'reject') => void}) {
  const results = new Map<string, ToolResult>();
  const toolIds = new Set<string>();
  // A tool call can emit more than one 'tool' event under the same id: the
  // initial frame has empty arguments, then a later frame arrives once the
  // streamed ToolCallPart arguments are assembled. Render only the last one
  // per id so the Input shows the complete arguments without duplication.
  const lastToolIndex = new Map<string, number>();
  for (let index = 0; index < events.length; index++) {
    const event = events[index];
    if (event.type === 'tool') {toolIds.add(event.id); lastToolIndex.set(event.id, index);}
    if (event.type === 'tool-result') results.set(event.id, event);
  }
  let lastActivity = -1;
  for (let index = events.length - 1; index >= 0; index--) {
    if (['thinking', 'text', 'tool', 'tool-result', 'approval', 'done', 'error'].includes(events[index].type)) {lastActivity = index; break;}
  }

  return <section className="ia-agent-flow">{events.map((event, index) => {
    if (event.type === 'diagnostic-log' && debug) return <div className="ia-agent-minor" key={index}>Full diagnostic log: {event.path}</div>;
    if (event.type === 'text') return <article className="ia-agent-text" key={index}><p>{event.text}</p></article>;
    if (event.type === 'thinking') return <ThinkingPreview key={index} text={event.text} active={running && index === lastActivity}/>;
    if (event.type === 'approval') return <div className="ia-approval" key={index}><b>Approval requested · {event.action}</b><p>{event.description}</p><button onClick={() => approve(event.id, 'approve')}>Approve</button><button onClick={() => approve(event.id, 'reject')}>Reject</button></div>;
    if (event.type === 'tool') {
      if (lastToolIndex.get(event.id) !== index) return null;
      const result = results.get(event.id);
      return <details className={`ia-agent-tool ${result?.error ? 'error' : ''}`} key={index}>
        <summary>{result?.error ? 'Tool failed' : result ? 'Tool finished' : 'Using tool'} · {event.name}</summary>
        <div className="ia-tool-detail"><small>Input</small><pre>{event.arguments || 'No arguments.'}</pre>{result && <><small>Result</small><pre>{result.output || result.message}{result.imageCount ? `\n[${result.imageCount} image${result.imageCount > 1 ? 's' : ''} sent to the model]` : ''}</pre>{result.outputTruncated && <small>Display shortened; full result was {result.outputBytes?.toLocaleString()} bytes.</small>}</>}</div>
      </details>;
    }
    if (event.type === 'tool-result') return toolIds.has(event.id) ? null : <details className={`ia-agent-tool ${event.error ? 'error' : ''}`} key={index}><summary>{event.error ? 'Tool failed' : 'Tool finished'} · {event.message}</summary><div className="ia-tool-detail"><pre>{event.output || event.message}</pre>{event.outputTruncated && <small>Display shortened; full result was {event.outputBytes?.toLocaleString()} bytes.</small>}</div></details>;
    if (event.type === 'error') return <p className="ia-flow-error" key={index}>{event.message}</p>;
    if (event.type === 'compaction') return <div className="ia-agent-minor" key={index}>Context {event.state === 'begin' ? 'compacting…' : 'compacted'}</div>;
    if (event.type === 'done') return <div className="ia-agent-minor" key={index}>Turn {event.result.status}</div>;
    if (event.type === 'status' && debug) return <div className="ia-agent-minor" key={index}>Context {event.contextUsage == null ? '—' : `${Math.round(event.contextUsage * 100)}%`} · Output {event.tokenUsage?.output ?? '—'} tokens</div>;
    if (event.type === 'context-metrics' && debug) return <div className="ia-agent-minor" key={index}>Peak context {event.peakContextUsage == null ? '—' : `${Math.round(event.peakContextUsage * 100)}%`} · Compressions {event.compactions} · Tool results {event.toolResults} · Largest result {event.peakToolResultBytes.toLocaleString()} bytes</div>;
    if (event.type === 'step' && debug) return <div className="ia-agent-minor" key={index}>Step {event.number}</div>;
    return null;
  })}</section>;
}
