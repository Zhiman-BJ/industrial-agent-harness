import type {AgentEvent} from '@industrial-agent-harness/viewer-builtin/api';
import {ThinkingPreview} from './ThinkingPreview';
import {useRef, useState} from 'react';

type ToolResult = Extract<AgentEvent, {type: 'tool-result'}>;

function ApprovalCard({event, decision, approve}: {event: Extract<AgentEvent, {type: 'approval'}>; decision?: string; approve: (id: string, decision: 'approve' | 'reject') => Promise<void>}) {
  const submitting = useRef(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function respond(value: 'approve' | 'reject') {
    if (submitting.current) return;
    submitting.current = true; setBusy(true); setError('');
    try {await approve(event.id, value);}
    catch (reason) {setError(String(reason));}
    finally {submitting.current = false; setBusy(false);}
  }
  if (decision) return <details className="ia-agent-tool ia-approval-resolved"><summary>{decision === 'reject' ? 'Rejected' : decision === 'expired' ? 'Approval expired' : 'Approved'} · {event.action}</summary><p>{event.description}</p></details>;
  return <div className="ia-approval"><b>Approval requested · {event.action}</b><p>{event.description}</p><button disabled={busy} onClick={() => void respond('approve')}>{busy ? 'Submitting…' : 'Approve'}</button><button disabled={busy} onClick={() => void respond('reject')}>Reject</button>{error && <p role="alert" className="ia-flow-error">{error}</p>}</div>;
}

export function AgentFlow({events, running, debug, approve, onLog}: {events: AgentEvent[]; running: boolean; debug: boolean; approve: (id: string, decision: 'approve' | 'reject') => Promise<void>; onLog?: (traceId?: string) => void}) {
  const results = new Map<string, ToolResult>();
  const toolIds = new Set<string>();
  const decisions = new Map<string, string>();
  // A tool call can emit more than one 'tool' event under the same id: the
  // initial frame has empty arguments, then a later frame arrives once the
  // streamed ToolCallPart arguments are assembled. Render only the last one
  // per id so the Input shows the complete arguments without duplication.
  const lastToolIndex = new Map<string, number>();
  for (const [index, event] of events.entries()) {
    if (event.type === 'tool') {toolIds.add(event.id); lastToolIndex.set(event.id, index);}
    if (event.type === 'tool-result') results.set(event.id, event);
    if (event.type === 'approval-resolved') decisions.set(event.id, event.decision);
  }
  let lastActivity = -1;
  for (let index = events.length - 1; index >= 0; index--) {
    if (['thinking', 'text', 'tool', 'tool-result', 'approval', 'done', 'error'].includes(events[index].type)) {lastActivity = index; break;}
  }

  return <section className="ia-agent-flow">{events.map((event, index) => {
    if (event.type === 'diagnostic-log') return <div className="ia-agent-minor" key={index}><button className="ia-log-link" onClick={() => onLog?.(event.traceId)}>View agent log · {event.traceId.slice(0,8)}</button>{debug && <span title={event.path}> · Full recorded events</span>}</div>;
    if (event.type === 'context-reset') return <div className="ia-agent-minor" key={index}>{event.message}</div>;
    if (event.type === 'text') return <article className="ia-agent-text" key={index}><p>{event.text}</p></article>;
    if (event.type === 'thinking') return <ThinkingPreview key={index} text={event.text} active={running && index === lastActivity}/>;
    if (event.type === 'approval') return <ApprovalCard key={index} event={event} decision={decisions.get(event.id) || (!running ? 'expired' : undefined)} approve={approve}/>;
    if (event.type === 'tool') {
      if (lastToolIndex.get(event.id) !== index) return null;
      const result = results.get(event.id);
      return <details className={`ia-agent-tool ${result?.error ? 'error' : ''}`} key={index}>
        <summary>{result?.error ? 'Tool failed' : result ? 'Tool finished' : 'Using tool'} · {event.name}</summary>
        <div className="ia-tool-detail"><small>Input</small><pre>{event.arguments || 'No arguments.'}</pre>{result && <><small>Result</small><pre>{result.output || result.message}{result.imageCount ? `\n[${result.imageCount} image${result.imageCount > 1 ? 's' : ''} sent to the model]` : ''}</pre>{result.outputTruncated && <small>Display shortened; full result was {result.outputBytes?.toLocaleString()} bytes. {onLog && <button className="ia-log-link" onClick={() => onLog()}>View full result in agent logs</button>}</small>}</>}</div>
      </details>;
    }
    if (event.type === 'tool-result') return toolIds.has(event.id) ? null : <details className={`ia-agent-tool ${event.error ? 'error' : ''}`} key={index}><summary>{event.error ? 'Tool failed' : 'Tool finished'} · {event.message}</summary><div className="ia-tool-detail"><pre>{event.output || event.message}</pre>{event.outputTruncated && <small>Display shortened; full result was {event.outputBytes?.toLocaleString()} bytes. {onLog && <button className="ia-log-link" onClick={() => onLog()}>View full result in agent logs</button>}</small>}</div></details>;
    if (event.type === 'error') return <p className="ia-flow-error" key={index}>{event.message}</p>;
    if (event.type === 'compaction') return <div className="ia-agent-minor" key={index}>Context {event.state === 'begin' ? 'compacting…' : 'compacted'}</div>;
    if (event.type === 'done') return <div className="ia-agent-minor" key={index}>Turn {event.result.status}</div>;
    if (event.type === 'status' && debug) return <div className="ia-agent-minor" key={index}>Context {event.contextUsage == null ? '—' : `${Math.round(event.contextUsage * 100)}%`} · Output {event.tokenUsage?.output ?? '—'} tokens</div>;
    if (event.type === 'context-metrics' && debug) return <div className="ia-agent-minor" key={index}>Peak context {event.peakContextUsage == null ? '—' : `${Math.round(event.peakContextUsage * 100)}%`} · Compressions {event.compactions} · Tool results {event.toolResults} · Largest result {event.peakToolResultBytes.toLocaleString()} bytes</div>;
    if (event.type === 'step' && debug) return <div className="ia-agent-minor" key={index}>Step {event.number}</div>;
    return null;
  })}</section>;
}
