import { useEffect, useId, useRef, useState } from 'react';
import { ArrowLeft, Copy, Plus, Trash2, UserRound } from 'lucide-react';
import { useDisplayText } from '@industrial-agent-harness/viewer-builtin/text';
import type {
  AgentCatalog,
  AgentProfileInput,
  AgentProfileView,
  ChatSummary,
  DomainOption,
  ProjectBinding,
} from '@industrial-agent-harness/viewer-builtin/api';

const sourceLabels = { builtin: 'Built-in', pack: 'Domain pack', custom: 'Custom' } as const;

function useAgentCatalog(projectId: string | undefined, revision: number) {
  const [catalog, setCatalog] = useState<AgentCatalog>();
  const [error, setError] = useState('');
  useEffect(() => {
    let cancelled = false;
    let request = 0;
    setCatalog(undefined);
    setError('');
    const refresh = () => {
      const current = ++request;
      void window.viewerHost!.agentList({ projectId }).then(
        value => {
          if (!cancelled && current === request) {
            setCatalog(value);
            setError('');
          }
        },
        reason => {
          if (!cancelled && current === request) setError(String(reason));
        },
      );
    };
    refresh();
    window.addEventListener('focus', refresh);
    return () => {
      cancelled = true;
      window.removeEventListener('focus', refresh);
    };
  }, [projectId, revision]);
  return { catalog, setCatalog, error, setError };
}

function profileInput(profile: AgentProfileView): AgentProfileInput {
  return {
    id: profile.id,
    name: profile.name,
    description: profile.description,
    instructions: profile.instructions,
    domain: profile.domain,
    tools: profile.tools,
    disallowedTools: profile.disallowedTools,
    skills: profile.skills,
    subagents: profile.subagents,
  };
}

function AgentChoices({
  title,
  description,
  items,
  value,
  onChange,
  disabled,
}: {
  title: string;
  description: string;
  items: Array<{ id: string; label: string }>;
  value: string[] | undefined;
  onChange: (value: string[] | undefined) => void;
  disabled: boolean;
}) {
  const { t } = useDisplayText();
  const id = useId();
  const known = new Set(items.map(item => item.id));
  const options = [
    ...items,
    ...(value || []).filter(item => !known.has(item)).map(item => ({ id: item, label: item })),
  ];
  return (
    <fieldset className="ia-agent-choices" disabled={disabled}>
      <legend>{title}</legend>
      <p>{description}</p>
      <label className="ia-agent-choice-mode" htmlFor={id}>
        <span>{t('Selection')}</span>
        <select
          id={id}
          value={value === undefined ? 'inherit' : 'selected'}
          onChange={event => onChange(event.target.value === 'inherit' ? undefined : [])}
        >
          <option value="inherit">{t('Use defaults')}</option>
          <option value="selected">{t('Choose allowed items')}</option>
        </select>
      </label>
      {value !== undefined && (
        <div className="ia-agent-checklist">
          {options.map(item => (
            <label key={item.id}>
              <input
                type="checkbox"
                checked={value.includes(item.id)}
                onChange={event =>
                  onChange(
                    event.target.checked ? [...value, item.id] : value.filter(id => id !== item.id),
                  )
                }
              />
              <span>{item.label}</span>
            </label>
          ))}
          {!options.length && <p>{t('No items are available.')}</p>}
          {!value.length && (
            <small>{t('Nothing selected. This agent will not use these items.')}</small>
          )}
        </div>
      )}
    </fieldset>
  );
}

function AgentEditor({
  draft: initial,
  original,
  catalog,
  domains,
  busy,
  onClose,
  onSaved,
}: {
  draft: AgentProfileInput;
  original?: AgentProfileView;
  catalog: AgentCatalog;
  domains: DomainOption[];
  busy: boolean;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { t } = useDisplayText();
  const [draft, setDraft] = useState(initial);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [deleting, setDeleting] = useState(false);
  const [domainAdjusted, setDomainAdjusted] = useState(false);
  const lock = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const readOnly = Boolean(original && !original.editable);
  const disabled = busy || saving || readOnly;
  const patch = (value: Partial<AgentProfileInput>) =>
    setDraft(current => ({ ...current, ...value }));
  function changeDomain(domain: string) {
    const skills = draft.skills?.filter(id =>
      catalog.skills.some(
        skill =>
          skill.id === id && (!skill.domain || skill.domain === '*' || skill.domain === domain),
      ),
    );
    const subagents = draft.subagents?.filter(id =>
      catalog.agents.some(
        agent => agent.id === id && (agent.domain === '*' || agent.domain === domain),
      ),
    );
    setDomainAdjusted(
      skills?.length !== draft.skills?.length || subagents?.length !== draft.subagents?.length,
    );
    patch({ domain, skills, subagents });
  }
  const domainChoices =
    domains.some(domain => domain.id === draft.domain) || draft.domain === '*'
      ? domains
      : [...domains, { id: draft.domain, label: draft.domain }];
  async function save() {
    if (lock.current || disabled) return;
    lock.current = true;
    setSaving(true);
    setError('');
    try {
      await window.viewerHost!.agentSave(draft);
      if (mounted.current) onSaved();
    } catch (reason) {
      if (mounted.current) setError(String(reason));
    } finally {
      lock.current = false;
      if (mounted.current) setSaving(false);
    }
  }
  async function remove() {
    if (lock.current || disabled || !original) return;
    lock.current = true;
    setSaving(true);
    setError('');
    try {
      await window.viewerHost!.agentDelete({ id: original.id });
      if (mounted.current) onSaved();
    } catch (reason) {
      if (mounted.current) setError(String(reason));
    } finally {
      lock.current = false;
      if (mounted.current) setSaving(false);
    }
  }
  return (
    <section
      className="ia-capability-section ia-agent-editor"
      aria-label={t('Agent configuration')}
    >
      <div className="ia-capability-section-head">
        <button className="ia-agent-back" onClick={onClose} disabled={saving}>
          <ArrowLeft size={15} />
          {t('All agents')}
        </button>
        {original && (
          <span className="ia-agent-source">
            {t(sourceLabels[original.source])}
            {original.packId
              ? ` · ${original.packId} ${original.packVersion?.split('+')[0] || ''}`
              : ''}
          </span>
        )}
      </div>
      <h2>
        {original
          ? original.source === 'builtin'
            ? t(original.name)
            : original.name
          : t('New agent')}
      </h2>
      <p>
        {readOnly
          ? original?.source === 'builtin'
            ? t('Built-in agents keep their standard roles and capabilities.')
            : t('This agent is supplied by its source. Make a copy to customize it.')
          : t('Saved changes apply to new chats. Chats already started keep their configuration.')}
      </p>
      {busy && <p role="status">{t('Stop running tasks to change agent configurations.')}</p>}
      <form
        onSubmit={event => {
          event.preventDefault();
          void save();
        }}
      >
        <fieldset className="ia-agent-fields" disabled={disabled}>
          <label>
            {t('Agent name')}
            <input
              value={original?.source === 'builtin' ? t(draft.name) : draft.name}
              required
              maxLength={120}
              onChange={event => patch({ name: event.target.value })}
            />
          </label>
          <label>
            {t('Description')}
            <input
              value={original?.source === 'builtin' ? t(draft.description) : draft.description}
              required
              maxLength={2000}
              onChange={event => patch({ description: event.target.value })}
            />
          </label>
          <label>
            {t('Available in')}
            <select value={draft.domain} onChange={event => changeDomain(event.target.value)}>
              <option value="*">{t('All domains')}</option>
              {domainChoices.map(domain => (
                <option key={domain.id} value={domain.id}>
                  {t(domain.label)}
                </option>
              ))}
            </select>
          </label>
          <label>
            {t('Instructions')}
            <textarea
              rows={10}
              maxLength={32768}
              value={draft.instructions}
              onChange={event => patch({ instructions: event.target.value })}
              placeholder={t('Describe this agent’s role, approach, and expected output.')}
            />
          </label>
        </fieldset>
        {domainAdjusted && (
          <p className="ia-capability-note" role="status">
            {t('Skills and subagents were adjusted to the selected domain.')}
          </p>
        )}
        <AgentChoices
          title={t('Native tools')}
          description={t('Choose the tools this agent can use within the project’s permissions.')}
          items={catalog.tools.map(item => ({ ...item, label: t(item.label) }))}
          value={draft.tools}
          onChange={tools => patch({ tools })}
          disabled={disabled}
        />
        <AgentChoices
          title={t('Domain skills')}
          description={t('Limit registered skills available to this chat and its subagents.')}
          items={catalog.skills
            .filter(item => !item.domain || item.domain === '*' || item.domain === draft.domain)
            .map(item => ({ id: item.id, label: item.title }))}
          value={draft.skills}
          onChange={skills => patch({ skills })}
          disabled={disabled}
        />
        <AgentChoices
          title={t('Subagents')}
          description={t('Choose the specialist agents this agent can delegate to.')}
          items={catalog.agents
            .filter(
              item => item.id !== draft.id && (item.domain === '*' || item.domain === draft.domain),
            )
            .map(item => ({
              id: item.id,
              label: item.source === 'builtin' ? t(item.name) : item.name,
            }))}
          value={draft.subagents}
          onChange={subagents => patch({ subagents })}
          disabled={disabled}
        />
        <details className="ia-agent-advanced">
          <summary>{t('Excluded tools')}</summary>
          <p>{t('Excluded tools remain unavailable even when included above.')}</p>
          <fieldset className="ia-agent-checklist" disabled={disabled}>
            {[
              ...catalog.tools,
              ...(draft.disallowedTools || [])
                .filter(id => !catalog.tools.some(item => item.id === id))
                .map(id => ({ id, label: id })),
            ].map(item => (
              <label key={item.id}>
                <input
                  type="checkbox"
                  checked={Boolean(draft.disallowedTools?.includes(item.id))}
                  onChange={event =>
                    patch({
                      disallowedTools: event.target.checked
                        ? [...(draft.disallowedTools || []), item.id]
                        : draft.disallowedTools?.filter(id => id !== item.id),
                    })
                  }
                />
                <span>{t(item.label)}</span>
              </label>
            ))}
          </fieldset>
        </details>
        {error && (
          <p role="alert" className="ia-project-error">
            {t(error)}
          </p>
        )}
        <div className="ia-agent-editor-actions">
          {original?.editable && (
            <button
              type="button"
              className="ia-agent-delete"
              onClick={() => setDeleting(true)}
              disabled={disabled}
            >
              <Trash2 size={14} />
              {t('Delete agent')}
            </button>
          )}
          <span />
          <button type="button" onClick={onClose} disabled={saving}>
            {t(readOnly ? 'Close' : 'Cancel')}
          </button>
          {!readOnly && (
            <button
              className="primary"
              type="submit"
              disabled={disabled || !draft.name.trim() || !draft.description.trim()}
            >
              {saving ? t('Saving…') : t('Save agent')}
            </button>
          )}
        </div>
        {deleting && (
          <div className="ia-agent-delete-confirm" role="alert">
            <p>{t('Delete this custom agent? Existing chats keep their saved configuration.')}</p>
            <button type="button" onClick={() => setDeleting(false)} disabled={saving}>
              {t('Cancel')}
            </button>
            <button type="button" onClick={() => void remove()} disabled={disabled}>
              {t('Delete agent')}
            </button>
          </div>
        )}
      </form>
    </section>
  );
}

export function AgentsSection({
  domains,
  busy,
  onChanged,
}: {
  domains: DomainOption[];
  busy: boolean;
  onChanged: () => void;
}) {
  const { t } = useDisplayText();
  const [revision, setRevision] = useState(0);
  const { catalog, error } = useAgentCatalog(undefined, revision);
  const [search, setSearch] = useState('');
  const [editing, setEditing] = useState<{
    draft: AgentProfileInput;
    original?: AgentProfileView;
  }>();
  const query = search.trim().toLowerCase();
  const items = (catalog?.agents || []).filter(
    item =>
      !query || `${item.name} ${item.description} ${item.domain}`.toLowerCase().includes(query),
  );
  if (editing && catalog)
    return (
      <AgentEditor
        key={editing.original?.id || 'new'}
        {...editing}
        catalog={catalog}
        domains={domains}
        busy={busy}
        onClose={() => setEditing(undefined)}
        onSaved={() => {
          setEditing(undefined);
          setRevision(value => value + 1);
          onChanged();
        }}
      />
    );
  return (
    <section className="ia-capability-section" aria-label={t('Agents')}>
      <div className="ia-capability-section-head">
        <h2>{t('Agents')}</h2>
        <button
          className="ia-agent-new"
          disabled={busy || !catalog}
          onClick={() =>
            setEditing({ draft: { name: '', description: '', instructions: '', domain: '*' } })
          }
        >
          <Plus size={15} />
          {t('New agent')}
        </button>
      </div>
      <p>
        {t(
          'Choose an agent’s role, instructions, and available capabilities. Set a project default or choose one in a new chat.',
        )}
      </p>
      <input
        className="ia-resource-search"
        type="search"
        aria-label={t('Search agents')}
        placeholder={t('Search agents')}
        value={search}
        onChange={event => setSearch(event.target.value)}
      />
      {error && (
        <p role="alert" className="ia-project-error">
          {t(error)}
        </p>
      )}
      {!catalog && !error && <p role="status">{t('Loading agents…')}</p>}
      {(['builtin', 'pack', 'custom'] as const).map(source => {
        const group = items.filter(item => item.source === source);
        return group.length ? (
          <section className="ia-agent-group" key={source}>
            <h3>{t(sourceLabels[source])}</h3>
            {group.map(item => (
              <div className="ia-agent-row" key={item.id} data-agent-profile-id={item.id}>
                <button
                  className="ia-agent-open"
                  onClick={() => setEditing({ draft: profileInput(item), original: item })}
                >
                  <span className="ia-agent-row-name">
                    {item.source === 'builtin' ? t(item.name) : item.name}
                  </span>
                  <span>{item.source === 'builtin' ? t(item.description) : item.description}</span>
                  <small>
                    {item.domain === '*'
                      ? t('All domains')
                      : t(domains.find(domain => domain.id === item.domain)?.label || item.domain)}
                    {item.packId
                      ? ` · ${item.packId} ${item.packVersion?.split('+')[0] || ''}`
                      : ''}
                  </small>
                </button>
                {item.source !== 'builtin' && (
                  <button
                    className="ia-agent-copy"
                    disabled={busy}
                    title={t('Copy agent')}
                    aria-label={t('Copy agent {0}', { '0': item.name })}
                    onClick={() =>
                      setEditing({
                        draft: {
                          ...profileInput(item),
                          id: undefined,
                          name: t('{0} copy', { '0': item.name }),
                        },
                      })
                    }
                  >
                    <Copy size={15} />
                    <span>{t('Copy')}</span>
                  </button>
                )}
              </div>
            ))}
          </section>
        ) : null;
      })}
      {catalog && !items.length && <p>{t('No agents match your search.')}</p>}
    </section>
  );
}

export function ProjectAgentSelect({
  project,
  revision,
  busy,
  onChanged,
  onSavingChange,
}: {
  project: ProjectBinding;
  revision: number;
  busy: boolean;
  onChanged: () => void;
  onSavingChange: (saving: boolean) => void;
}) {
  const { t } = useDisplayText();
  const { catalog, setCatalog, error, setError } = useAgentCatalog(project.id, revision);
  const [saving, setSaving] = useState(false);
  const lock = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const id = useId();
  async function change(agentId: string) {
    if (lock.current || busy) return;
    lock.current = true;
    setSaving(true);
    onSavingChange(true);
    setError('');
    try {
      const next = await window.viewerHost!.projectAgentSet({ projectId: project.id, agentId });
      if (mounted.current) {
        setCatalog(next);
        onChanged();
      }
    } catch (reason) {
      if (mounted.current) setError(String(reason));
    } finally {
      lock.current = false;
      onSavingChange(false);
      if (mounted.current) setSaving(false);
    }
  }
  return (
    <div className="ia-project-agent">
      <div className="ia-project-property">
        <label htmlFor={id}>{t('Default agent')}</label>
        <select
          id={id}
          aria-label={t('Project default agent')}
          disabled={busy || saving || !catalog}
          value={catalog?.defaultAgentId || ''}
          onChange={event => void change(event.target.value)}
        >
          {!catalog && <option value="">{t('Loading agents…')}</option>}
          {catalog && !catalog.agents.some(agent => agent.id === catalog.defaultAgentId) && (
            <option value={catalog.defaultAgentId}>{t('Unavailable agent')}</option>
          )}
          {catalog?.agents.map(agent => (
            <option key={agent.id} value={agent.id}>
              {agent.source === 'builtin' ? t(agent.name) : agent.name}
            </option>
          ))}
        </select>
      </div>
      <p>{t('Used for new chats in this project. Existing chats keep their agent.')}</p>
      {catalog && !catalog.agents.some(agent => agent.id === catalog.defaultAgentId) && (
        <p role="alert" className="ia-project-error">
          {t('The default agent is unavailable. Choose another agent for new chats.')}
        </p>
      )}
      {error && (
        <p role="alert" className="ia-project-error">
          {t(error)}
        </p>
      )}
    </div>
  );
}

export function ChatAgentSelect({
  projectId,
  chat,
  busy,
  revision,
  onChanged,
  onSavingChange,
  onCreate,
  onAvailabilityChange,
}: {
  projectId: string;
  chat?: ChatSummary;
  busy: boolean;
  revision: number;
  onChanged: (chat: ChatSummary) => void;
  onSavingChange: (saving: boolean) => void;
  onCreate: (agentId: string) => Promise<ChatSummary>;
  onAvailabilityChange: (available: boolean) => void;
}) {
  const { t } = useDisplayText();
  const { catalog, error: loadError } = useAgentCatalog(projectId, revision);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const lock = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  async function change(agentId: string) {
    if (lock.current || busy || chat?.agentLocked) return;
    lock.current = true;
    setSaving(true);
    onSavingChange(true);
    setError('');
    try {
      const next = chat
        ? await window.viewerHost!.chatSetAgent({ chatId: chat.id, agentId })
        : await onCreate(agentId);
      if (mounted.current) onChanged(next);
    } catch (reason) {
      if (mounted.current) setError(String(reason));
    } finally {
      lock.current = false;
      onSavingChange(false);
      if (mounted.current) setSaving(false);
    }
  }
  const selected = chat?.agent?.id || catalog?.defaultAgentId || '';
  const missingDefault = Boolean(
    catalog && !chat?.agent && !catalog.agents.some(item => item.id === selected),
  );
  useEffect(() => {
    onAvailabilityChange(!missingDefault);
    return () => onAvailabilityChange(true);
  }, [missingDefault, onAvailabilityChange]);
  return (
    <div className="ia-chat-agent">
      <UserRound size={13} aria-hidden="true" />
      {chat?.agentLocked ? (
        <span title={t('This chat keeps the agent configuration it started with.')}>
          {chat.agent?.source === 'builtin'
            ? t(chat.agent.name)
            : chat.agent?.name || t('Default agent')}
        </span>
      ) : (
        <select
          aria-label={t('Agent for this chat')}
          title={t('Choose an agent before the first message.')}
          value={selected}
          disabled={busy || saving || !catalog}
          onChange={event => void change(event.target.value)}
        >
          {!catalog && (
            <option value={selected}>
              {chat?.agent?.source === 'builtin'
                ? t(chat.agent.name)
                : chat?.agent?.name || t('Loading agents…')}
            </option>
          )}
          {catalog && chat?.agent && !catalog.agents.some(item => item.id === selected) && (
            <option value={selected}>
              {t('{0} (saved configuration)', { '0': chat.agent.name })}
            </option>
          )}
          {missingDefault && (
            <option value={selected} disabled>
              {t('Unavailable agent')}
            </option>
          )}
          {catalog?.agents.map(agent => (
            <option key={agent.id} value={agent.id}>
              {agent.source === 'builtin' ? t(agent.name) : agent.name}
            </option>
          ))}
        </select>
      )}
      {(error || (!chat?.agentLocked && loadError) || missingDefault) && (
        <span role="alert" className="ia-chat-agent-error">
          {t(
            error ||
              loadError ||
              'The default agent is unavailable. Choose another agent for new chats.',
          )}
        </span>
      )}
    </div>
  );
}
