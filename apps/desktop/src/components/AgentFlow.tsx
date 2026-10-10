import { useDisplayText } from '@industrial-agent-harness/viewer-builtin/text';
import type { AgentEvent } from '@industrial-agent-harness/viewer-builtin/api';
import { SubagentCard, AgentGlyph, agentGlyphSeed } from './SubagentCard';
import { TaskResults } from './TaskResults';
import { IndustrialResult } from './IndustrialResult';
import type { ResultOpenRequest } from '@industrial-agent-harness/viewer-builtin/api';
import { AnswerMarkdown } from './AnswerMarkdown';
import { ThinkingPreview } from './ThinkingPreview';
import { MessageActions } from './MessageActions';
import { splitLeadingThinking } from '../message-content';
import { memo, useRef, useState } from 'react';

type ToolResult = Extract<AgentEvent, { type: 'tool-result' }>;

function ApprovalCard({
  event,
  decision,
  resolutionOrigin,
  approve,
}: {
  event: Extract<AgentEvent, { type: 'approval' }>;
  decision?: string;
  resolutionOrigin?: 'user' | 'runtime';
  approve: (id: string, decision: 'approve' | 'reject') => Promise<void>;
}) {
  const { t, locale } = useDisplayText();
  const submitting = useRef(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function respond(value: 'approve' | 'reject') {
    if (submitting.current) return;
    submitting.current = true;
    setBusy(true);
    setError('');
    try {
      await approve(event.id, value);
    } catch (reason) {
      setError(String(reason));
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  }
  // A 'reject' that the user in this window never clicked is a system
  // cancellation (turn interrupted, session replaced), not a user decision.
  const userRejected = decision === 'reject' && (!resolutionOrigin || resolutionOrigin === 'user');
  const resolvedLabel =
    decision === 'reject'
      ? userRejected
        ? t('Rejected')
        : t('Cancelled without running')
      : decision === 'expired'
        ? t('Approval expired')
        : t('Approved');
  let structured: { command: string; cwd: string; language?: string } | null = null;
  if (event.preview) {
    try {
      const parsed = JSON.parse(event.preview.text);
      if (parsed && typeof parsed.command === 'string')
        structured = {
          command: parsed.command,
          cwd: typeof parsed.cwd === 'string' ? parsed.cwd : '',
          language: typeof parsed.language === 'string' ? parsed.language : undefined,
        };
    } catch {
      structured = null;
    }
  }
  if (decision)
    return (
      <details className="ia-agent-tool ia-approval-resolved">
        <summary>
          {resolvedLabel} · {event.action}
        </summary>
        <p>{event.description}</p>
        {event.preview && <pre className="ia-approval-preview">{event.preview.text}</pre>}
      </details>
    );
  return (
    <div className="ia-approval" data-approval-id={event.id}>
      <b>
        {t('Approval requested ·')} {event.action}
      </b>
      {event.agentId && (
        <small className="ia-approval-source">
          {t('Subtask')} · {event.agentId}
        </small>
      )}
      <p>{event.description}</p>
      {event.agentId && event.agentId !== 'main' && <p>{event.agentId}</p>}
      {event.preview && structured ? (
        <div className="ia-approval-operation">
          <b>{event.preview.title}</b>
          <dl className="ia-approval-fields">
            <div>
              <dt>{t('Command')}</dt>
              <dd>
                <code>{structured.command}</code>
              </dd>
            </div>
            {structured.cwd && (
              <div>
                <dt>{t('Working directory')}</dt>
                <dd>
                  <code>{structured.cwd}</code>
                  <small>
                    {t('Isolated session workspace; project files are read via project/.')}
                  </small>
                </dd>
              </div>
            )}
            {structured.language && (
              <div>
                <dt>{t('Language')}</dt>
                <dd>
                  <code>{structured.language}</code>
                </dd>
              </div>
            )}
          </dl>
        </div>
      ) : (
        event.preview && (
          <div className="ia-approval-operation">
            <b>{event.preview.title}</b>
            <pre className="ia-approval-preview">{event.preview.text}</pre>
          </div>
        )
      )}
      <button disabled={busy} onClick={() => void respond('approve')}>
        {busy ? t('Submitting…') : t('Approve')}
      </button>
      <button disabled={busy} onClick={() => void respond('reject')}>
        {t('Reject')}
      </button>
      {error && (
        <p role="alert" className="ia-flow-error">
          {t(error)}
        </p>
      )}
    </div>
  );
}

function QuestionCard({
  event,
  resolved,
  answer,
}: {
  event: Extract<AgentEvent, { type: 'question' }>;
  resolved?: Extract<AgentEvent, { type: 'question-resolved' }>;
  answer: (id: string, answers: Record<string, string>) => Promise<void>;
}) {
  const { t, locale } = useDisplayText();
  const submitting = useRef(false);
  const [selected, setSelected] = useState<Record<string, string[]>>({});
  const [other, setOther] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  if (resolved)
    return (
      <details className="ia-agent-tool ia-question-resolved">
        <summary>
          {resolved.decision === 'expired'
            ? t('Question expired')
            : resolved.decision === 'skipped'
              ? t('Question skipped')
              : t('Question answered')}
        </summary>
        {event.questions.map(item => (
          <p key={item.question}>
            {item.question} {resolved.answers?.[item.question] || ''}
          </p>
        ))}
      </details>
    );
  const values = event.questions.map(item => {
    const choices = selected[item.question] || [];
    return choices
      .map(label => (label === '__other__' ? other[item.question]?.trim() || '' : label))
      .filter(Boolean)
      .join(', ');
  });
  async function submit() {
    if (submitting.current || values.some(value => !value)) return;
    submitting.current = true;
    setBusy(true);
    setError('');
    try {
      await answer(
        event.id,
        Object.fromEntries(event.questions.map((item, index) => [item.question, values[index]])),
      );
    } catch (reason) {
      setError(String(reason));
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  }
  return (
    <form
      className="ia-question"
      onSubmit={event => {
        event.preventDefault();
        void submit();
      }}
    >
      <b>
        {t('Agent asks you')}
        {event.agentId ? ` · ${t('Subtask')} ${event.agentId}` : ''}
      </b>
      {event.questions.map((item, index) => (
        <fieldset key={index}>
          <legend>
            {item.header && <small>{item.header} · </small>}
            {item.question}
          </legend>
          {item.options.map(option => (
            <label key={option.label}>
              <input
                type={item.multi_select ? 'checkbox' : 'radio'}
                name={`${event.id}-${index}`}
                checked={(selected[item.question] || []).includes(option.label)}
                onChange={() =>
                  setSelected(current => {
                    const values = current[item.question] || [];
                    return {
                      ...current,
                      [item.question]: item.multi_select
                        ? values.includes(option.label)
                          ? values.filter(value => value !== option.label)
                          : [...values, option.label]
                        : [option.label],
                    };
                  })
                }
              />
              <span>
                {option.label}
                {option.description && <small>{option.description}</small>}
              </span>
            </label>
          ))}
          <label>
            <input
              type={item.multi_select ? 'checkbox' : 'radio'}
              name={`${event.id}-${index}`}
              checked={(selected[item.question] || []).includes('__other__')}
              onChange={() =>
                setSelected(current => {
                  const values = current[item.question] || [];
                  return {
                    ...current,
                    [item.question]: item.multi_select
                      ? values.includes('__other__')
                        ? values.filter(value => value !== '__other__')
                        : [...values, '__other__']
                      : ['__other__'],
                  };
                })
              }
            />
            <span>{t('Other')}</span>
          </label>
          {(selected[item.question] || []).includes('__other__') && (
            <input
              aria-label={t('Other answer for {0}', { '0': item.question })}
              value={other[item.question] || ''}
              onChange={change =>
                setOther(current => ({ ...current, [item.question]: change.target.value }))
              }
              maxLength={4096}
            />
          )}
        </fieldset>
      ))}
      <button type="submit" disabled={busy || values.some(value => !value)}>
        {busy ? t('Submitting…') : t('Send answer')}
      </button>
      <button
        type="button"
        disabled={busy}
        onClick={() => {
          if (submitting.current) return;
          submitting.current = true;
          setBusy(true);
          setError('');
          void answer(event.id, {})
            .catch(reason => setError(String(reason)))
            .finally(() => {
              submitting.current = false;
              setBusy(false);
            });
        }}
      >
        {t('Skip')}
      </button>
      {error && (
        <p role="alert" className="ia-flow-error">
          {t(error)}
        </p>
      )}
    </form>
  );
}

export const AgentFlow = memo(function AgentFlow({
  events,
  running,
  debug,
  approve,
  answer,
  onLog,
  onOpenResult,
  onRetry,
  onOpenModelSettings,
  turnId,
  chatId,
}: {
  events: AgentEvent[];
  running: boolean;
  debug: boolean;
  approve: (id: string, decision: 'approve' | 'reject') => Promise<void>;
  answer: (id: string, answers: Record<string, string>) => Promise<void>;
  onLog?: (traceId?: string) => void;
  onOpenResult?: (request: ResultOpenRequest) => Promise<void>;
  onRetry?: () => void;
  onOpenModelSettings?: () => void;
  turnId?: string;
  chatId?: string;
}) {
  const { t, locale } = useDisplayText();
  const results = new Map<string, ToolResult>();
  const children = new Map<string, Extract<AgentEvent, { type: 'subagent-state' }>>();
  const firstChildIndex = new Map<string, number>();
  const toolIds = new Set<string>();
  const decisions = new Map<string, Extract<AgentEvent, { type: 'approval-resolved' }>>();
  const answered = new Map<string, Extract<AgentEvent, { type: 'question-resolved' }>>();
  // A tool call can emit more than one 'tool' event under the same id: the
  // initial frame has empty arguments, then a later frame arrives once the
  // streamed ToolCallPart arguments are assembled. Render only the last one
  // per id so the Input shows the complete arguments without duplication.
  const lastToolIndex = new Map<string, number>();
  for (const [index, event] of events.entries()) {
    if (event.type === 'subagent-state') {
      children.set(event.id, event);
      if (!firstChildIndex.has(event.id)) firstChildIndex.set(event.id, index);
    }
    if (event.type === 'tool') {
      toolIds.add(event.id);
      lastToolIndex.set(event.id, index);
    }
    if (event.type === 'tool-result') results.set(event.id, event);
    if (event.type === 'approval-resolved') decisions.set(event.id, event);
    if (event.type === 'question-resolved') answered.set(event.id, event);
  }
  let latestResults = -1;
  events.forEach((event, index) => {
    if (event.type === 'results-changed') latestResults = index;
  });
  let lastActivity = -1;
  for (let index = events.length - 1; index >= 0; index--) {
    if (
      ['thinking', 'text', 'tool', 'tool-result', 'approval', 'question', 'done', 'error'].includes(
        events[index].type,
      )
    ) {
      lastActivity = index;
      break;
    }
  }

  return (
    <section className="ia-agent-flow">
      {events.map((event, index) => {
        if (event.type === 'subagent-state')
          return firstChildIndex.get(event.id) === index ? (
            <SubagentCard key={event.id} state={children.get(event.id)!} />
          ) : null;
        if (event.type === 'results-changed')
          return index === latestResults ? (
            <TaskResults key="task-results" results={event.results} onOpen={onOpenResult} />
          ) : null;
        if (event.type === 'results-ready') return null;
        if (event.type === 'industrial-result')
          return (
            <IndustrialResult
              key={event.action.id}
              event={event}
              debug={debug}
              onOpenArtifact={
                onOpenResult && turnId && chatId
                  ? (actionId, artifactId) => onOpenResult({ chatId, turnId, actionId, artifactId })
                  : undefined
              }
            />
          );
        if (event.type === 'diagnostic-log')
          return (
            <div className="ia-agent-minor" key={index}>
              <button className="ia-log-link" onClick={() => onLog?.(event.traceId)}>
                {t('View agent log ·')} {event.traceId.slice(0, 8)}
              </button>
              {debug && <span title={event.path}>{t('· Full recorded events')}</span>}
            </div>
          );
        if (event.type === 'context-reset')
          return (
            <div className="ia-agent-minor" key={index}>
              {t(event.message)}
            </div>
          );
        if (event.type === 'resources-filtered') {
          const names = [
            ...event.externalMcp.map(id => `${id} · MCP`),
            ...event.plugins.map(name => `${name} · plugin`),
          ];
          return (
            <div className="ia-agent-minor" key={index} title={names.join('\n')}>
              {t(
                'Industrial boundary: {0} external resources are excluded from this turn. Project tools stay available.',
                { '0': names.length },
              )}
            </div>
          );
        }
        if (event.type === 'text') {
          const body = splitLeadingThinking(event.text).body;
          return (
            <article className="ia-agent-text ia-message" key={index}>
              <AnswerMarkdown text={event.text} active={running && index === lastActivity} />
              {body && <MessageActions text={body} recordedAt={event.recordedAt} />}
            </article>
          );
        }
        if (event.type === 'thinking')
          return (
            <ThinkingPreview
              key={index}
              text={event.text}
              active={running && index === lastActivity}
            />
          );
        if (event.type === 'approval')
          return (
            <ApprovalCard
              key={index}
              event={event}
              decision={
                decisions.get(event.id)?.decision ||
                (!running && !event.background ? 'expired' : undefined)
              }
              resolutionOrigin={decisions.get(event.id)?.origin}
              approve={approve}
            />
          );
        if (event.type === 'question')
          return (
            <QuestionCard
              key={index}
              event={event}
              resolved={
                answered.get(event.id) ||
                (!running && !event.background
                  ? { type: 'question-resolved', id: event.id, decision: 'expired' }
                  : undefined)
              }
              answer={answer}
            />
          );
        if (event.type === 'tool') {
          if (lastToolIndex.get(event.id) !== index) return null;
          const result = results.get(event.id);
          const childStates = [...children.values()].filter(c => c.parentToolCallId === event.id);
          return (
            <details className={`ia-agent-tool ${result?.error ? 'error' : ''}`} key={index}>
              <summary>
                {childStates.map(child => (
                  <AgentGlyph key={child.id} seed={agentGlyphSeed(child)} className="mini" />
                ))}
                {result?.error ? t('Tool failed') : result ? t('Tool finished') : t('Using tool')} ·{' '}
                {event.name}
              </summary>
              <div className="ia-tool-detail">
                <small>{t('Input')}</small>
                <pre>{event.arguments || t('No arguments.')}</pre>
                {result && (
                  <>
                    <small>{t('Result')}</small>
                    <pre>
                      {result.output || result.message}
                      {result.imageCount
                        ? `\n[${t('Images sent to the model: {0}', { '0': result.imageCount })}]`
                        : ''}
                    </pre>
                    {result.outputTruncated && (
                      <small>
                        {t('Display shortened; full result was')}{' '}
                        {result.outputBytes?.toLocaleString(locale)} {t('bytes.')}{' '}
                        {onLog && (
                          <button className="ia-log-link" onClick={() => onLog()}>
                            {t('View full result in agent logs')}
                          </button>
                        )}
                      </small>
                    )}
                  </>
                )}
              </div>
            </details>
          );
        }
        if (event.type === 'tool-result')
          return toolIds.has(event.id) ? null : (
            <details className={`ia-agent-tool ${event.error ? 'error' : ''}`} key={index}>
              <summary>
                {event.error ? t('Tool failed') : t('Tool finished')} · {event.message}
              </summary>
              <div className="ia-tool-detail">
                <pre>{event.output || event.message}</pre>
                {event.outputTruncated && (
                  <small>
                    {t('Display shortened; full result was')}{' '}
                    {event.outputBytes?.toLocaleString(locale)} {t('bytes.')}{' '}
                    {onLog && (
                      <button className="ia-log-link" onClick={() => onLog()}>
                        {t('View full result in agent logs')}
                      </button>
                    )}
                  </small>
                )}
              </div>
            </details>
          );
        if (event.type === 'error') {
          const authFailure =
            /(^|\W)(401|unauthorized|invalid authentication|authorization failed)/i.test(
              event.message,
            );
          return (
            <div className="ia-flow-error-card" role="alert" key={index}>
              {authFailure && <b>{t('The model service rejected this API key.')}</b>}
              <span className="ia-flow-error">{event.message}</span>
              {(onRetry || onOpenModelSettings) && authFailure && (
                <div className="ia-flow-error-actions">
                  {onOpenModelSettings && (
                    <button onClick={onOpenModelSettings}>{t('Open model settings')}</button>
                  )}
                  {onRetry && <button onClick={onRetry}>{t('Retry task')}</button>}
                </div>
              )}
            </div>
          );
        }
        if (event.type === 'compaction')
          return (
            <div className="ia-agent-minor" key={index}>
              {t('Context')} {t(event.state === 'begin' ? 'compacting…' : 'compacted')}
            </div>
          );
        if (event.type === 'done')
          return (
            <div className="ia-agent-minor" key={index}>
              {t('Turn')} {t(event.result.status)}
            </div>
          );
        if (event.type === 'status' && debug)
          return (
            <div className="ia-agent-minor" key={index}>
              {t('Context')}{' '}
              {event.contextUsage == null ? '—' : `${Math.round(event.contextUsage * 100)}%`}{' '}
              {t('· Output')} {event.tokenUsage?.output ?? '—'} {t('tokens')}
            </div>
          );
        if (event.type === 'context-metrics' && debug)
          return (
            <div className="ia-agent-minor" key={index}>
              {t('Peak context')}{' '}
              {event.peakContextUsage == null
                ? '—'
                : `${Math.round(event.peakContextUsage * 100)}%`}{' '}
              {t('· Compressions')} {event.compactions} {t('· Tool results')} {event.toolResults}{' '}
              {t('· Largest result')} {event.peakToolResultBytes.toLocaleString(locale)}{' '}
              {t('bytes')}
            </div>
          );
        if (event.type === 'step' && debug)
          return (
            <div className="ia-agent-minor" key={index}>
              {t('Step')} {event.number}
            </div>
          );
        return null;
      })}
    </section>
  );
});
