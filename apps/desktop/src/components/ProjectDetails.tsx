import { RuntimeEnvironments } from './RuntimeEnvironments';
import { DomainIcon } from '@industrial-agent-harness/viewer-builtin/domain-icon';
import { useDisplayText } from '@industrial-agent-harness/viewer-builtin/text';
import { useEffect, useState } from 'react';
import { ProjectExecution } from './RemoteExecution';
import { ResourceList } from './CapabilityResources';
import { MessageSquarePlus } from 'lucide-react';
import type { DomainOption, ProjectBinding } from '@industrial-agent-harness/viewer-builtin/api';

export function ProjectDetails({
  project,
  domains,
  busy,
  resourceRevision,
  onDomainChange,
  onResourcesChanged,
  onNewChat,
}: {
  project: ProjectBinding;
  domains: DomainOption[];
  busy: boolean;
  resourceRevision: number;
  onDomainChange: (id: string, domain: string) => Promise<void>;
  onResourcesChanged: () => void;
  onNewChat: () => Promise<void>;
}) {
  const { t } = useDisplayText();
  const [domain, setDomain] = useState(project.domain || '');
  const domainOffered = domains.some(item => item.id === project.domain);
  const [executionReady, setExecutionReady] = useState(project.executionLocation !== 'remote');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    setDomain(project.domain || '');
    setError('');
  }, [project.id, project.domain]);
  async function save() {
    if (!domain || domain === project.domain) return;
    setSaving(true);
    setError('');
    try {
      await onDomainChange(project.id, domain);
    } catch (reason) {
      setError(String(reason));
    } finally {
      setSaving(false);
    }
  }
  return (
    <div className="ia-project-page">
      <div className="ia-project-page-inner">
        <div className="ia-project-page-heading">
          <div>
            <h1>{project.name}</h1>
            <p className="ia-project-page-subtitle">{t('Project details')}</p>
          </div>
          <button
            className="ia-project-start"
            onClick={() => void onNewChat()}
            disabled={busy || !project.domain || !executionReady}
          >
            <MessageSquarePlus size={15} />
            {t('New chat')}
          </button>
        </div>
        {!project.domain && (
          <p className="ia-project-hint">{t('Select and save a domain to start a chat.')}</p>
        )}
        <div className="ia-project-properties">
          <div className="ia-project-property">
            <span>{t('Local directory')}</span>
            <code title={project.path}>{project.path}</code>
          </div>
          <div className="ia-project-property">
            <label htmlFor="ia-project-domain">{t('Domain')}</label>
            <div className="ia-project-domain-edit">
              <span className="ia-domain-select">
                <DomainIcon domain={domain} />
                <select
                  id="ia-project-domain"
                  aria-label={t('Project domain')}
                  value={domain}
                  onChange={event => setDomain(event.target.value)}
                  disabled={busy || saving}
                >
                  <option value="" disabled>
                    {t('Select a domain')}
                  </option>
                  {project.domain && !domainOffered && (
                    <option value={project.domain} disabled>
                      {project.domain}
                    </option>
                  )}
                  {domains.map(item => (
                    <option key={item.id} value={item.id}>
                      {t(item.label)}
                    </option>
                  ))}
                </select>
              </span>
              <button
                onClick={() => void save()}
                disabled={busy || saving || !domain || domain === project.domain}
              >
                {t('Save')}
              </button>
            </div>
          </div>
        </div>
        {project.domain && domainOffered && (
          <ProjectExecution
            project={project}
            busy={busy}
            onChanged={onResourcesChanged}
            onReady={setExecutionReady}
          />
        )}
        {project.domain && domainOffered && project.executionLocation !== 'remote' && (
          <RuntimeEnvironments
            domain={project.domain}
            projectId={project.id}
            busy={busy}
            onChanged={onResourcesChanged}
          />
        )}
        {project.executionLocation !== 'remote' && (
          <>
            <ResourceList
              kind="skills"
              heading={t('Skills')}
              key={`skills-${project.id}${project.domain}${resourceRevision}`}
              projectId={project.id}
              busy={busy}
              onChanged={onResourcesChanged}
            />
            <ResourceList
              kind="mcpServers"
              heading={t('MCP servers')}
              key={`mcp-${project.id}${project.domain}${resourceRevision}`}
              projectId={project.id}
              busy={busy}
              onChanged={onResourcesChanged}
            />
          </>
        )}
        {error && <p className="ia-project-error">{t(error)}</p>}
      </div>
    </div>
  );
}
