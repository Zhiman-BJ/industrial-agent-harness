import { useDisplayText } from '@industrial-agent-harness/viewer-builtin/text';
import { useEffect, useState } from 'react';
import { ArrowLeft, Blocks, CircuitBoard, Stethoscope, UserRound, Wrench } from 'lucide-react';
import type { DomainOption, ProjectBinding } from '@industrial-agent-harness/viewer-builtin/api';
import { PacksSection, type DomainStatus, type DomainProgress } from './CapabilityPacks';
import { WindowControls } from './WindowControls';
import { McpSection, SkillsSection } from './CapabilityResources';
import { DiagnosticsSection } from './CapabilityDiagnostics';
import { AgentsSection } from './AgentSettings';

export type CapabilitySection = 'packs' | 'mcp' | 'skills' | 'agents' | 'diagnostics';

export function CapabilityCenter({
  project,
  domains,
  busy,
  initialSection,
  returnPage,
  onDomainsChanged,
  onResourcesChanged,
  onExit,
}: {
  project?: ProjectBinding;
  domains: DomainOption[];
  busy: boolean;
  initialSection: CapabilitySection;
  returnPage: 'chat' | 'project';
  onDomainsChanged: (domains: DomainOption[]) => void;
  onResourcesChanged: () => void;
  onExit: () => void;
}) {
  const { t } = useDisplayText();
  const [section, setSection] = useState<CapabilitySection>(initialSection);
  const [status, setStatus] = useState<DomainStatus>();
  const [statusError, setStatusError] = useState('');
  const [progress, setProgress] = useState<DomainProgress | null>(null);
  const [revision, setRevision] = useState(0);
  useEffect(() => setSection(initialSection), [initialSection]);
  useEffect(() => {
    let cancelled = false;
    void window
      .viewerHost!.domainStatus()
      .then(value => {
        if (cancelled) return;
        setStatus(value);
        setStatusError('');
        setProgress(value.operation?.active ? value.operation.progress : null);
      })
      .catch(reason => {
        if (!cancelled) setStatusError(String(reason));
      });
    return () => {
      cancelled = true;
    };
  }, [revision]);
  useEffect(() => {
    if (!status?.operation?.active || status.operation.source !== 'external') return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      try {
        const next = await window.viewerHost!.domainStatus();
        if (stopped) return;
        if (!next.operation?.active) {
          const domains = await window.viewerHost!.domains();
          if (stopped) return;
          onDomainsChanged(domains);
          setRevision(value => value + 1);
        }
        setStatus(next);
        setStatusError('');
        setProgress(next.operation?.active ? next.operation.progress : null);
        if (!next.operation?.active) return;
      } catch (reason) {
        if (!stopped) setStatusError(String(reason));
      }
      if (!stopped) timer = setTimeout(poll, 800);
    }
    timer = setTimeout(poll, 800);
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [status?.operation?.active, status?.operation?.source]);
  useEffect(
    () =>
      window.viewerHost!.onDomainProgress(next => {
        setProgress(next.active === false ? null : next);
        if (next.active === false) setRevision(value => value + 1);
      }),
    [],
  );
  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key !== 'Escape') return;
      if (document.querySelector('dialog[open]')) return;
      event.preventDefault();
      onExit();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onExit]);
  async function refreshStatus() {
    try {
      const value = await window.viewerHost!.domainStatus();
      setStatus(value);
      setStatusError('');
    } catch (reason) {
      setStatusError(String(reason));
    }
  }
  const sections = [
    { id: 'packs' as const, label: t('Domain packs'), icon: Blocks },
    { id: 'mcp' as const, label: t('MCP servers'), icon: CircuitBoard },
    { id: 'skills' as const, label: t('Skills'), icon: Wrench },
    { id: 'agents' as const, label: t('Agents'), icon: UserRound },
    { id: 'diagnostics' as const, label: t('Runtime diagnostics'), icon: Stethoscope },
  ];
  return (
    <div className="ia-capability">
      <header className="ia-capability-header">
        <button
          className="ia-icon"
          onClick={onExit}
          aria-label={t('Back to {0}', {
            '0': returnPage === 'project' ? t('Project details') : t('Chat'),
          })}
          title={t('Back')}
        >
          <ArrowLeft size={16} />
        </button>
        <h1>{t('Capability center')}</h1>
        <WindowControls />
      </header>
      <div className="ia-capability-body">
        <nav className="ia-capability-nav" aria-label={t('Capability sections')}>
          {sections.map(item => (
            <button
              key={item.id}
              type="button"
              onClick={() => setSection(item.id)}
              aria-current={section === item.id ? 'page' : undefined}
              aria-label={item.label}
              title={item.label}
            >
              <item.icon size={16} aria-hidden="true" />
              <span>{item.label}</span>
            </button>
          ))}
        </nav>
        <div className="ia-capability-content">
          <div className="ia-capability-inner">
            {section === 'packs' && (
              <PacksSection
                status={status}
                statusError={statusError}
                progress={progress}
                busy={busy}
                revision={revision}
                onStatus={setStatus}
                onChanged={installed => {
                  onDomainsChanged(installed);
                  void refreshStatus();
                }}
                onRefresh={() => setRevision(value => value + 1)}
              />
            )}
            {section === 'mcp' && (
              <McpSection project={project} busy={busy} onChanged={onResourcesChanged} />
            )}
            {section === 'skills' && (
              <SkillsSection project={project} busy={busy} onChanged={onResourcesChanged} />
            )}
            {section === 'agents' && (
              <AgentsSection domains={domains} busy={busy} onChanged={onResourcesChanged} />
            )}
            {section === 'diagnostics' && (
              <DiagnosticsSection
                status={status}
                statusError={statusError}
                onRefresh={() => setRevision(value => value + 1)}
                onGoToPacks={() => setSection('packs')}
              />
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
