import { useDisplayText } from '@industrial-agent-harness/viewer-builtin/text';
import { useEffect, useId, useRef, useState } from 'react';
import type {
  ProjectBinding,
  ResourceCatalog,
  ResourceMode,
  ResourceSettingsSnapshot,
} from '@industrial-agent-harness/viewer-builtin/api';
import { ExternalMcpPanel } from './ExternalMcpSettings';
import { RemoteServiceSettings } from './RemoteExecution';

export type ResourceKind = 'skills' | 'mcpServers';
type ToolProvider = ResourceCatalog['mcpServers'][number];
type ResourceEntry = ResourceCatalog['skills'][number] & Partial<ToolProvider>;
type Tool = NonNullable<ToolProvider['tools']>[number];

function matchesTool(tool: Tool, query: string) {
  return `${tool.id} ${tool.title || ''} ${tool.description || ''}`.toLowerCase().includes(query);
}

function ToolDetails({
  tools,
  search,
  standalone = false,
}: {
  tools: Tool[];
  search: string;
  standalone?: boolean;
}) {
  const { t } = useDisplayText();
  const matching = search ? tools.filter(tool => matchesTool(tool, search)) : tools;
  const visible = matching.length ? matching : tools;
  return (
    <details className="ia-resource-tools" open={search ? true : undefined}>
      <summary>
        {t(standalone ? 'Standalone MCP tools ({0})' : 'Registered tools ({0})', {
          '0': tools.length,
        })}
      </summary>
      {standalone && (
        <p>
          {t('Separate MCP transport. These declarations are not the current Runtime tool list.')}
        </p>
      )}
      <ul aria-label={t('Tool list')}>
        {visible.map(tool => (
          <li key={tool.id} data-tool-id={tool.id}>
            <div>
              <b>{t(tool.title || tool.id)}</b>
              {tool.risk && (
                <small>
                  {t(tool.risk === 'read-only' ? 'Read only' : 'Changes require approval')}
                </small>
              )}
            </div>
            {tool.title && tool.title !== tool.id && <code>{tool.id}</code>}
            {tool.description && <p>{t(tool.description)}</p>}
          </li>
        ))}
      </ul>
    </details>
  );
}

function ScopeSwitch({
  project,
  scope,
  onScope,
}: {
  project?: ProjectBinding;
  scope: 'global' | 'project';
  onScope: (scope: 'global' | 'project') => void;
}) {
  const { t } = useDisplayText();
  return (
    <div className="ia-scope-switch" role="radiogroup" aria-label={t('Settings scope')}>
      <button role="radio" aria-checked={scope === 'global'} onClick={() => onScope('global')}>
        {t('Global default')}
      </button>
      <button
        role="radio"
        aria-checked={scope === 'project'}
        disabled={!project}
        title={project?.name}
        onClick={() => onScope('project')}
      >
        {project ? project.name || t('This project') : t('This project')}
      </button>
    </div>
  );
}

function SearchBox({
  value,
  onChange,
  label,
}: {
  value: string;
  onChange: (v: string) => void;
  label: string;
}) {
  const { t } = useDisplayText();
  const id = useId();
  return (
    <input
      id={id}
      className="ia-resource-search"
      type="search"
      value={value}
      placeholder={t('Search…')}
      aria-label={label}
      onChange={event => onChange(event.target.value)}
    />
  );
}

export function ResourceList({
  kind,
  projectId,
  busy,
  search = '',
  heading,
  revision = 0,
  onChanged,
}: {
  kind: ResourceKind;
  projectId?: string;
  busy: boolean;
  search?: string;
  heading?: string;
  revision?: number;
  onChanged: () => void;
}) {
  const { t } = useDisplayText();
  const [snapshot, setSnapshot] = useState<ResourceSettingsSnapshot>();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const generation = useRef(0);
  const lock = useRef(false);
  useEffect(() => {
    const current = ++generation.current;
    setSnapshot(undefined);
    setError('');
    setSaving(false);
    void window
      .viewerHost!.resourceGet({ projectId })
      .then(value => {
        if (generation.current === current) setSnapshot(value);
      })
      .catch(reason => {
        if (generation.current === current) setError(String(reason));
      });
    return () => {
      generation.current++;
    };
  }, [projectId, kind, revision]);
  async function change(id: string, mode: ResourceMode) {
    if (lock.current) return;
    lock.current = true;
    const current = generation.current;
    setSaving(true);
    setError('');
    try {
      const next = await window.viewerHost!.resourceSet({
        projectId,
        kind: kind === 'skills' ? 'skill' : 'mcp',
        id,
        mode,
      });
      if (generation.current === current) {
        setSnapshot(next);
        onChanged();
      }
    } catch (reason) {
      if (generation.current === current) setError(String(reason));
    } finally {
      lock.current = false;
      if (generation.current === current) setSaving(false);
    }
  }
  const query = search.trim().toLowerCase();
  const allItems: ResourceEntry[] = snapshot?.catalog[kind] || [];
  const items = allItems.filter(
    item =>
      !query ||
      `${item.title} ${item.id} ${item.domain}`.toLowerCase().includes(query) ||
      item.tools?.some(tool => matchesTool(tool, query)) ||
      item.standaloneMcp?.tools.some(tool => matchesTool(tool, query)),
  );
  const groups = new Map<string, typeof items>();
  for (const item of items) {
    const list = groups.get(item.domain) || [];
    list.push(item);
    groups.set(item.domain, list);
  }
  return (
    <section
      className="ia-project-resources"
      data-resource-kind={kind}
      aria-label={heading || (kind === 'skills' ? t('Skills') : t('Tools & MCP'))}
    >
      {heading && <h2>{heading}</h2>}
      {kind === 'mcpServers' && (
        <p>
          {t('Enable access here. Check software and service readiness in Runtime diagnostics.')}
        </p>
      )}
      {busy && <p role="status">{t('Stop the current task to change resources.')}</p>}
      {error && (
        <p role="alert" className="ia-project-error">
          {t(error)}
        </p>
      )}
      {!snapshot
        ? !error && <p>{t('Loading resources…')}</p>
        : Array.from(groups.entries()).map(([domain, list]) => (
            <div key={domain}>
              <h3>
                {domain}
                <small> · {list.length}</small>
              </h3>
              {list.map(item => {
                const globalEnabled =
                  !snapshot.global[kind].includes(item.id) && item.enabledByDefault;
                const override = snapshot.overrides[kind][item.id];
                const mode = override === undefined ? 'inherit' : override ? 'enabled' : 'disabled';
                const enabled = !snapshot.effective[kind].includes(item.id);
                return (
                  <div key={item.id} data-resource-id={item.id} className="ia-resource-entry">
                    <label className="ia-resource-row">
                      <span className="ia-resource-info">
                        <b>{t(item.title)}</b>
                        <small>
                          {item.id} · {enabled ? t('Enabled') : t('Disabled')}
                          {!projectId &&
                            ` · ${t('Global: {0}', { '0': t(globalEnabled ? 'Enabled' : 'Disabled') })}`}
                        </small>
                        {kind === 'mcpServers' && (
                          <small>
                            {t(
                              item.external
                                ? 'External MCP'
                                : item.transport === 'runtime'
                                  ? 'Domain Runtime'
                                  : 'Standalone MCP',
                            )}
                            {item.version && ` · ${item.version}`}
                            {` · ${t('{0} registered tools', { '0': item.tools?.length || 0 })}`}
                          </small>
                        )}
                      </span>
                      {projectId ? (
                        <select
                          aria-label={t('{0} project setting', { '0': item.title })}
                          value={mode}
                          disabled={busy || saving}
                          onChange={event =>
                            void change(item.id, event.target.value as ResourceMode)
                          }
                        >
                          <option value="inherit">
                            {t('Inherit ({0})', { '0': t(globalEnabled ? 'Enabled' : 'Disabled') })}
                          </option>
                          <option value="enabled">{t('Enabled')}</option>
                          <option value="disabled">{t('Disabled')}</option>
                        </select>
                      ) : (
                        <input
                          type="checkbox"
                          aria-label={t('{0} global default', { '0': item.title })}
                          checked={enabled}
                          disabled={busy || saving}
                          onChange={event =>
                            void change(item.id, event.target.checked ? 'enabled' : 'disabled')
                          }
                        />
                      )}
                    </label>
                    {kind === 'mcpServers' &&
                      (item.catalogError ? (
                        <p role="alert">{t(item.catalogError)}</p>
                      ) : item.tools?.length ? (
                        <ToolDetails tools={item.tools} search={query} />
                      ) : (
                        <p>
                          {t(
                            'No active tools are registered. Check the domain setup in Domain packs and Runtime diagnostics.',
                          )}
                        </p>
                      ))}
                    {item.standaloneMcp && (
                      <ToolDetails tools={item.standaloneMcp.tools} search={query} standalone />
                    )}
                  </div>
                );
              })}
            </div>
          ))}
      {snapshot && !items.length && (
        <p>
          {query
            ? t('No resources match your search.')
            : kind === 'skills'
              ? t('No Skills are bundled for this domain.')
              : t(
                  'No tool providers are registered for this domain. Install a domain pack or add an external MCP service.',
                )}
        </p>
      )}
      {saving && <p role="status">{t('Saving…')}</p>}
    </section>
  );
}

export function McpSection({
  project,
  busy,
  onChanged,
}: {
  project?: ProjectBinding;
  busy: boolean;
  onChanged: () => void;
}) {
  const { t } = useDisplayText();
  const [scope, setScope] = useState<'global' | 'project'>('global');
  const [search, setSearch] = useState('');
  // External servers added or removed on this page must refresh the resource
  // list in place; ResourceList only refetches when its revision changes.
  const [revision, setRevision] = useState(0);
  const refresh = () => {
    setRevision(value => value + 1);
    onChanged();
  };
  return (
    <section className="ia-capability-section" aria-label={t('Tools & MCP')}>
      <div className="ia-capability-section-head">
        <h2>{t('Tools & MCP')}</h2>
        <ScopeSwitch project={project} scope={scope} onScope={setScope} />
      </div>
      <p>
        {scope === 'project'
          ? t(
              'Project overrides take priority over global defaults. Choose Inherit to follow the global setting.',
            )
          : t('Defaults for all projects. Each project can override these settings.')}{' '}
        {t('Changes apply to new sessions.')}
      </p>
      <RemoteServiceSettings />
      <SearchBox value={search} onChange={setSearch} label={t('Search providers and tools')} />
      <ResourceList
        kind="mcpServers"
        key={`${scope}-${project?.id || ''}`}
        projectId={scope === 'project' ? project?.id : undefined}
        busy={busy}
        search={search}
        revision={revision}
        onChanged={refresh}
      />
      {scope === 'global' && <ExternalMcpPanel busy={busy} onChanged={refresh} />}
    </section>
  );
}

export function SkillsSection({
  project,
  busy,
  onChanged,
}: {
  project?: ProjectBinding;
  busy: boolean;
  onChanged: () => void;
}) {
  const { t } = useDisplayText();
  const [scope, setScope] = useState<'global' | 'project'>('global');
  const [search, setSearch] = useState('');
  return (
    <section className="ia-capability-section" aria-label={t('Skills')}>
      <div className="ia-capability-section-head">
        <h2>{t('Skills')}</h2>
        <ScopeSwitch project={project} scope={scope} onScope={setScope} />
      </div>
      <p>
        {scope === 'project'
          ? t(
              'Project overrides take priority over global defaults. Choose Inherit to follow the global setting.',
            )
          : t('Defaults for all projects. Each project can override these settings.')}{' '}
        {t('Changes apply to new sessions.')}
      </p>
      <SearchBox value={search} onChange={setSearch} label={t('Skills')} />
      <ResourceList
        kind="skills"
        projectId={scope === 'project' ? project?.id : undefined}
        busy={busy}
        search={search}
        onChanged={onChanged}
      />
    </section>
  );
}
