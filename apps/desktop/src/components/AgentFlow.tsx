import type {AgentEvent} from '@industrial-agent-harness/viewer-builtin/api';
import {ThinkingPreview} from './ThinkingPreview';

export function AgentFlow({events, running, debug, approve}: {events: AgentEvent[]; running: boolean; debug: boolean; approve: (id: string, decision: 'approve' | 'reject') => void}) {
  return <section className="ia-agent-flow">{events.map((event, index) => {
    if (event.type === 'text') return <article className="ia-agent-text" key={index}><p>{event.text}</p></article>;
    if (event.type === 'thinking') return <ThinkingPreview key={index} text={event.text} active={running && index === events.length - 1}/>;
    if (event.type === 'approval') return <div className="ia-approval" key={index}><b>Approval requested · {event.action}</b><p>{event.description}</p><button onClick={() => approve(event.id, 'approve')}>Approve</button><button onClick={() => approve(event.id, 'reject')}>Reject</button></div>;
    if (event.type === 'tool') return <details className="ia-agent-tool" key={index}><summary>Using {event.name}</summary><pre>{event.arguments || 'No arguments yet.'}</pre></details>;
    if (event.type === 'tool-result') return <details className={`ia-agent-tool ${event.error ? 'error' : ''}`} key={index}><summary>{event.error ? 'Tool failed' : 'Tool finished'} · {event.message}</summary><pre>{event.output || event.message}</pre></details>;
    if (event.type === 'error') return <p className="ia-flow-error" key={index}>{event.message}</p>;
    if (event.type === 'compaction') return <div className="ia-agent-minor" key={index}>Context {event.state === 'begin' ? 'compacting…' : 'compacted'}</div>;
    if (event.type === 'done') return <div className="ia-agent-minor" key={index}>Turn {event.result.status}</div>;
    if (event.type === 'status' && debug) return <div className="ia-agent-minor" key={index}>Context {event.contextUsage == null ? '—' : `${Math.round(event.contextUsage * 100)}%`} · Output {event.tokenUsage?.output ?? '—'} tokens</div>;
    if (event.type === 'step' && debug) return <div className="ia-agent-minor" key={index}>Step {event.number}</div>;
    return null;
  })}</section>;
}
