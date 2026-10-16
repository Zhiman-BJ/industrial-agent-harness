import { useEffect, useId, useRef, useState } from 'react';
import {
  ArrowUpRight,
  Check,
  ChevronDown,
  ChevronRight,
  Circle,
  CircleDot,
  Cloud,
  ListChecks,
  LoaderCircle,
  Square,
} from 'lucide-react';
import { useDisplayText } from '@industrial-agent-harness/viewer-builtin/text';
import type {
  RemoteProjectState,
  RemoteTaskState,
  RemoteSessionState,
} from '@industrial-agent-harness/viewer-builtin/api';

import { summarizeRemote, summarizeTodos, type TodoItem } from './chat-status';

export type RemoteStatusProps = {
  projectId: string;
  domain: string;
  chatId: string | null;
  onReady: (ready: boolean) => void;
  onTools: (tools: string[]) => void;
  onConfigure: () => void;
};

// 合并状态卡：远程环境 + 任务。折叠时是右上角的一枚小药丸，对话流保持居中；
// 宽聊天栏展开为侧栏，窄栏在消息上方占位；设置页隐藏呈现但保留轮询。
// 远程轮询在折叠时也保持运行（composer 就绪门禁依赖它）。
export function ChatStatusCard({
  remote,
  todo,
  running,
  hidden = false,
}: {
  remote: RemoteStatusProps | null;
  todo: TodoItem[] | null;
  running: boolean;
  hidden?: boolean;
}) {
  const { t } = useDisplayText();
  const [open, setOpen] = useState(false);
  // 手风琴：两个区块互斥展开，卡片始终只多一层内容，避免薄区块和长列表
  // 同时摊开造成的密度失衡。
  const [openBlock, setOpenBlock] = useState<'remote' | 'todo' | null>(null);
  const [project, setProject] = useState<RemoteProjectState>();
  const [task, setTask] = useState<RemoteTaskState | null>(null);
  const [session, setSession] = useState<RemoteSessionState | null>(null);
  const [error, setError] = useState('');
  const [ending, setEnding] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const cardId = useId();
  const remoteBodyId = useId();
  const todoBodyId = useId();
  const remoteOpen = openBlock === 'remote';
  const todoOpen = openBlock === 'todo';

  useEffect(() => {
    if (open && !hidden) closeButton.current?.focus({ preventScroll: true });
  }, [open, hidden]);

  function collapse() {
    setOpen(false);
    requestAnimationFrame(() => trigger.current?.focus({ preventScroll: true }));
  }

  useEffect(() => {
    if (!remote) return;
    const { projectId, domain, chatId, onReady, onTools } = remote;
    let alive = true,
      timer: ReturnType<typeof setTimeout>;
    onReady(false);
    setProject(undefined);
    setTask(null);
    setSession(null);
    setError('');
    async function poll() {
      try {
        const state = await window.viewerHost!.remoteProject({ projectId });
        // Remote tool identities come from the service capability catalog; the
        // chat flow uses them to badge sandbox-executed tool calls.
        if (state.syncedAt && state.service.status === 'connected')
          void window
            .viewerHost!.remoteTools({ projectId })
            .then(tools => {
              if (alive) onTools(tools);
            })
            .catch(() => {});
        let remoteSession: RemoteSessionState | null = null,
          value: RemoteTaskState | null = null;
        if (chatId && state.syncedAt && state.service.status === 'connected') {
          [remoteSession, value] = await Promise.all([
            window.viewerHost!.remoteSession({ projectId, chatId }),
            window.viewerHost!.remoteTask({ projectId, chatId }),
          ]);
        }
        if (alive) {
          setProject(state);
          setSession(remoteSession);
          setTask(value);
          setError('');
          onReady(
            state.service.status === 'connected' &&
              Boolean(state.syncedAt) &&
              state.service.executableDomains?.includes(domain) === true &&
              !['stopped', 'expired', 'failed'].includes(remoteSession?.status || '') &&
              !['submitting', 'running', 'unknown'].includes(value?.status || ''),
          );
        }
      } catch (reason) {
        if (alive) {
          setError(String(reason));
          onReady(false);
        }
      }
      if (alive) timer = setTimeout(() => void poll(), 5000);
    }
    void poll();
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [remote?.projectId, remote?.chatId, remote?.domain]);

  const terminal = session && ['stopped', 'expired', 'failed'].includes(session.status);
  const { label: remoteLabel, tone: dotClass } = summarizeRemote({
    project,
    task,
    session,
    error,
    domain: remote?.domain || '',
  });
  const remoteSummary = t(remoteLabel);
  const tasks = summarizeTodos(todo, running);
  const { done } = tasks;
  const taskSummary = tasks.title || t(tasks.summary);
  const taskState = t(tasks.state);
  const progressLabel = t('{0} of {1} tasks completed', {
    '0': String(done),
    '1': String(todo?.length || 0),
  });
  if (!remote && !todo?.length) return null;

  return (
    <aside
      className={`ia-status-dock ${open ? 'open' : ''}`}
      hidden={hidden}
      aria-label={t('Execution status')}
      onKeyDown={event => {
        if (event.key === 'Escape' && open) {
          event.stopPropagation();
          collapse();
        }
      }}
    >
      <span className="ia-sr-only" role="status" aria-live="polite" aria-atomic="true">
        {[remote ? remoteSummary : '', todo?.length ? `${taskState}. ${progressLabel}` : '']
          .filter(Boolean)
          .join(' · ')}
      </span>
      <button
        ref={trigger}
        type="button"
        className="ia-status-pill"
        aria-expanded={open}
        aria-controls={cardId}
        aria-label={`${t('Expand status card')}: ${remote ? remoteSummary : taskState}${todo?.length ? ` · ${progressLabel}` : ''}`}
        title={remote ? remoteSummary : taskSummary}
        onClick={() => setOpen(true)}
      >
        {remote && (
          <>
            <Cloud size={14} aria-hidden="true" />
            <span className={`ia-status-dot ${dotClass}`} aria-hidden="true" />
          </>
        )}
        {!remote && <ListChecks size={14} aria-hidden="true" />}
        <span className="ia-status-summary">{remote ? remoteSummary : taskState}</span>
        {todo?.length ? (
          <span className="ia-status-count" aria-label={progressLabel}>
            {done}/{todo.length}
          </span>
        ) : null}
        <ChevronDown size={13} aria-hidden="true" />
      </button>
      <div className="ia-status-card" id={cardId} hidden={!open}>
        <div className="ia-status-card-head">
          <h2>{t('Execution status')}</h2>
          <button
            ref={closeButton}
            type="button"
            className="ia-icon"
            onClick={collapse}
            aria-label={t('Collapse status card')}
            title={t('Collapse status card')}
          >
            <ChevronRight size={14} aria-hidden="true" />
          </button>
        </div>
        <div className="ia-status-content">
          {remote && (
            <section className="ia-status-block">
              <button
                type="button"
                className="ia-status-head"
                aria-expanded={remoteOpen}
                aria-controls={remoteBodyId}
                aria-label={t(remoteOpen ? 'Collapse remote status' : 'Expand remote status')}
                onClick={() => setOpenBlock(remoteOpen ? null : 'remote')}
              >
                <Cloud size={16} aria-hidden="true" />
                <span className="ia-status-title">{t('Remote environment')}</span>
                <span className={`ia-status-dot ${dotClass}`} aria-hidden="true" />
                <ChevronDown
                  size={14}
                  className={remoteOpen ? 'expanded' : ''}
                  aria-hidden="true"
                />
                <span className={`ia-status-summary ia-status-remote-summary ${dotClass}`}>
                  {remoteSummary}
                </span>
              </button>
              <div className="ia-status-body" id={remoteBodyId} hidden={!remoteOpen}>
                {project?.syncedAt && (
                  <p className="ia-status-detail">
                    {t('{0} files synced', { '0': String(project.files.length) })}
                  </p>
                )}
                {project?.service.reason && (
                  <p className="ia-status-detail">{t(project.service.reason)}</p>
                )}
                <button
                  type="button"
                  className="ia-log-link ia-status-action"
                  onClick={remote.onConfigure}
                >
                  <span>{t('Files and execution settings')}</span>
                  <ArrowUpRight size={14} aria-hidden="true" />
                </button>
                {session && !terminal && !session.callLocked && remote.chatId && (
                  <div className="ia-status-row">
                    <button
                      type="button"
                      className="ia-status-action ia-status-end"
                      disabled={ending}
                      onClick={() => {
                        if (!remote.chatId || !session) return;
                        setEnding(true);
                        void window
                          .viewerHost!.remoteTerminate({
                            projectId: remote.projectId,
                            chatId: remote.chatId,
                            applicationSessionId: session.id,
                          })
                          .then(value => {
                            setSession(value);
                            remote.onReady(false);
                          })
                          .catch(reason => setError(String(reason)))
                          .finally(() => setEnding(false));
                      }}
                    >
                      <Square size={12} aria-hidden="true" />
                      {t(ending ? 'Ending remote session…' : 'End remote session')}
                    </button>
                  </div>
                )}
                {error && (
                  <div className="ia-status-error">
                    <p className="ia-status-error-message" role="alert">
                      {t('Could not update the remote status. Try again shortly.')}
                    </p>
                    <details className="ia-status-error-details">
                      <summary>{t('Error details')}</summary>
                      <pre className="ia-status-error-reason">{error}</pre>
                    </details>
                  </div>
                )}
              </div>
            </section>
          )}
          {todo?.length ? (
            <section className="ia-status-block">
              <button
                type="button"
                className="ia-status-head"
                aria-expanded={todoOpen}
                aria-controls={todoBodyId}
                aria-label={t(todoOpen ? 'Collapse task list' : 'Expand task list')}
                onClick={() => setOpenBlock(todoOpen ? null : 'todo')}
              >
                <ListChecks size={16} aria-hidden="true" />
                <span className="ia-status-title">{t('Tasks')}</span>
                <span className="ia-status-count" aria-label={progressLabel}>
                  {done}/{todo.length}
                </span>
                <ChevronDown size={14} className={todoOpen ? 'expanded' : ''} aria-hidden="true" />
                <span className="ia-status-current" title={taskSummary} hidden={todoOpen}>
                  {taskSummary}
                </span>
              </button>
              <div className="ia-status-progress">
                <progress value={done} max={todo.length} aria-label={progressLabel} />
                <span>{taskState}</span>
              </div>
              <ol className="ia-status-body ia-status-todo" id={todoBodyId} hidden={!todoOpen}>
                {todo.map((item, index) => (
                  <li key={`${item.title}:${index}`} data-status={item.status}>
                    <span
                      className={`ia-status-icon ${item.status === 'in_progress' && running ? 'ia-status-spin' : ''}`}
                    >
                      {item.status === 'done' ? (
                        <Check size={13} aria-hidden="true" />
                      ) : item.status === 'in_progress' && running ? (
                        <LoaderCircle size={13} aria-hidden="true" />
                      ) : item.status === 'in_progress' ? (
                        <CircleDot size={13} aria-hidden="true" />
                      ) : (
                        <Circle size={11} aria-hidden="true" />
                      )}
                    </span>
                    <span>
                      <span className="ia-sr-only">
                        {t(
                          item.status === 'done'
                            ? 'Completed'
                            : item.status === 'in_progress'
                              ? running
                                ? 'In progress'
                                : 'Not completed'
                              : 'Pending',
                        )}
                        :{' '}
                      </span>
                      {item.title}
                    </span>
                  </li>
                ))}
              </ol>
            </section>
          ) : null}
        </div>
      </div>
    </aside>
  );
}
