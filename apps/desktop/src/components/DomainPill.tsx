import type {DomainOption} from '@industrial-agent-harness/viewer-builtin/api';

export function DomainPill({domain, domains, label}: {
  domain: string | null;
  domains: DomainOption[];
  label?: string;
}) {
  const selected = domains.find(item => item.id === domain);
  return <span className="ia-domain-pill" role="status" aria-label={`${label || 'Domain'}: ${selected?.label || domain || 'None'}`}><span aria-hidden="true">{selected?.emoji || '✨'}</span><span>{selected?.label || domain || 'No domain'}</span></span>;
}
