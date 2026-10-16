import { useEffect, useId, useState } from 'react';
import {
  Check,
  ChevronDown,
  ChevronRight,
  Circle,
  CircleDot,
  Cloud,
  ListChecks,
  LoaderCircle,
} from 'lucide-react';
import { useDisplayText } from '@industrial-agent-harness/viewer-builtin/text';
import type {
  RemoteProjectState,
  RemoteTaskState,
  RemoteSessionState,
} from '@industrial-agent-harness/viewer-builtin/api';

const serviceLabels = {
  not_configured: 'Not configured',
  credentials_missing: 'Connection credentials needed',
  unchecked: 'Not connected',
  connected: 'Connected',
  unavailable: 'Temporarily unavailable',
};
const taskLabels: Record<string, string> = {
  submitting: 'Preparing remote task…',
  running: 'Running remotely…',
  completed: 'Remote task completed',
  failed: 'Remote task failed',
  unknown: 'Remote outcome unknown; checking without replaying…',
};

export type RemoteStatusProps = {
  projectId: string;
  domain: string;
  chatId: string | null;
  onReady: (ready: boolean) => void;
  onTools: (tools: string[]) => void;
  onConfigure: () => void;
};

type TodoItem = { title: string; status: 'pending' | 'in_progress' | 'done' };

// 合并状态卡：远程环境 + 任务。折叠时是右上角的一枚小药丸，对话流保持居中；
// 展开时卡片占据右侧，对话与输入区经 CSS 让位整体居左，内容不被遮挡。
// 远程轮询在折叠时也保持运行（composer 就绪门禁依赖它）。
export function ChatStatusCard({
  remote,
  todo,
  running,
}: {
  remote: RemoteStatusProps | null;
  todo: TodoItem[] | null;
  running: boolean;
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
  const remoteBodyId = useId();
  const todoBodyId = useId();
  const remoteOpen = openBlock === 'remote';
  const todoOpen = openBlock === 'todo';

  useEffect(() => {
    if (!remote) return;
    const { projectId, domain, chatId, onReady, onTools } = remote;
    let alive = true,
      timer: ReturnType<typeof setTimeout>;
    onReady(false);
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
  const serviceStatus = project?.service.status;
  const dotClass =
    serviceStatus === 'connected' ? 'ok' : serviceStatus === 'unavailable' ? 'bad' : 'idle';
  const remoteSummary = !project
    ? t('Loading…')
    : serviceStatus !== 'connected'
      ? t(serviceLabels[serviceStatus!])
      : terminal
        ? t('Remote session ended. Start a new chat.')
        : task
          ? t(taskLabels[task.status] || 'Remote outcome unknown')
          : project.syncedAt
            ? t('Remote software and sandbox')
            : t('Choose files to sync');
  const done = (todo || []).filter(item => item.status === 'done').length;
  const current = (todo || []).find(item => item.status === 'in_progress');
  if (!remote && !todo?.length) return null;

  return (
    <aside className={`ia-status-dock ${open ? 'open' : ''}`} role="status">
      <button
        type="button"
        className="ia-status-pill"
        aria-expanded={open}
        aria-label={t('Expand status card')}
        onClick={() => setOpen(true)}
      >
        {remote && (
          <>
            <Cloud size={13} aria-hidden="true" />
            <span className={`ia-status-dot ${dotClass}`} aria-hidden="true" />
          </>
        )}
        {todo?.length ? (
          <>
            <ListChecks size={13} aria-hidden="true" />
            <span className="ia-status-count">
              {done}/{todo.length}
            </span>
          </>
        ) : null}
        <span className="ia-status-summary">{remote ? remoteSummary : ''}</span>
        <ChevronDown size={13} aria-hidden="true" />
      </button>
      <div className="ia-status-card" aria-label={t('Execution status')}>
        <div className="ia-status-card-head">
          <b>{t('Execution status')}</b>
          <button
            type="button"
            className="ia-status-collapse"
            onClick={() => setOpen(false)}
            aria-label={t('Collapse status card')}
            title={t('Collapse status card')}
          >
            <ChevronRight size={14} aria-hidden="true" />
          </button>
        </div>
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
              <Cloud size={14} aria-hidden="true" />
              <span className="ia-status-title">{t('Remote environment')}</span>
              <span className={`ia-status-dot ${dotClass}`} aria-hidden="true" />
              <span className="ia-status-summary">{remoteSummary}</span>
              <ChevronDown size={14} className={remoteOpen ? 'expanded' : ''} aria-hidden="true" />
            </button>
            {remoteOpen && (
              <div className="ia-status-body" id={remoteBodyId}>
                {project?.service.reason && (
                  <div className="ia-status-row">{t(project.service.reason)}</div>
                )}
                {session && !terminal && !session.callLocked && remote.chatId && (
                  <div className="ia-status-row">
                    <button
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
                      {t('End remote session')}
                    </button>
                  </div>
                )}
                <div className="ia-status-row">
                  <button className="ia-log-link" onClick={remote.onConfigure}>
                    {t('Files and execution settings')}
                  </button>
                </div>
                {error && (
                  <div className="ia-status-row" role="alert">
                    {error}
                  </div>
                )}
              </div>
            )}
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
              <ListChecks size={14} aria-hidden="true" />
              <span className="ia-status-title">{t('Tasks')}</span>
              <span className="ia-status-count">
                {done}/{todo.length}
              </span>
              <span className="ia-status-current" title={current?.title}>
                {current?.title || t('All tasks completed')}
              </span>
              <ChevronDown size={14} className={todoOpen ? 'expanded' : ''} aria-hidden="true" />
            </button>
            {todoOpen && (
              <ol className="ia-status-body ia-status-todo" id={todoBodyId}>
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
                    <span>{item.title}</span>
                  </li>
                ))}
              </ol>
            )}
          </section>
        ) : null}
      </div>
    </aside>
  );
}
