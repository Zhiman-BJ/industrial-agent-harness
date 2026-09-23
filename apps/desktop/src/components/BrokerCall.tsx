import type {BrokerResult, CapabilityDetail} from '@industrial-agent-harness/viewer-builtin/api';

export function BrokerCall({broker, detail, debug, selectedDomain, onContext, onDetail}: {
  broker: BrokerResult;
  detail?: CapabilityDetail;
  debug: boolean;
  selectedDomain: string | null;
  onContext: (context: {domain: string; stage: string}) => void;
  onDetail: (id: string) => void;
}) {
  const {scope, matches} = broker;
  return <details className="ia-agent-tool ia-broker-tool">
    <summary>Capability Broker · {scope.domain || 'Auto'}{scope.stage ? ` / ${scope.stage}` : ''} · {matches.length} {matches.length === 1 ? 'capability' : 'capabilities'}</summary>
    <div className="ia-tool-detail">
      <small>Scope {scope.version.slice(0, 8)}</small>
      <div className="ia-broker-context"><span>Context</span><div>{broker.contexts.filter(context => !selectedDomain || context.domain === selectedDomain).map(context => <button key={`${context.domain}:${context.stage}`} onClick={() => onContext(context)}>{context.domain} / {context.stage}</button>)}</div></div>
      {matches.length ? <><small>Selected capabilities</small>{matches.map(item => <button className="ia-broker-capability" key={item.id} onClick={() => onDetail(item.id)}><b>{item.title}</b><span>{item.id}</span></button>)}<small>{scope.skills.length} skills · {scope.tools.length} tools</small></> : <p>No domain capability selected. Kimi can continue with its standard project tools.</p>}
      {detail && <div className="ia-broker-detail"><b>L3 · {detail.capability}</b>{detail.skills.map(item => <p key={item.id}><b>{item.id}</b><br/>{item.reference}</p>)}{detail.tools.map(item => <p key={item.id}><b>{item.id}</b> · {JSON.stringify(item.schema)}</p>)}</div>}
      {debug && <div className="ia-broker-trace"><small>Disclosure log</small>{broker.trace.map((entry, index) => <details key={index}><summary><code>{entry.level}</code> {entry.event}</summary><pre>{JSON.stringify(entry.detail, null, 2)}</pre></details>)}</div>}
    </div>
  </details>;
}
