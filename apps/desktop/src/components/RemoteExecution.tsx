import { useEffect, useRef, useState } from 'react';
import { Cloud, Monitor } from 'lucide-react';
import { useDisplayText } from '@industrial-agent-harness/viewer-builtin/text';
import type {
  ProjectBinding,
  RemoteProjectState,
  RemoteServiceState,
  RemoteSyncReview,
  RemoteTaskState,
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
  queued: 'Waiting for an available sandbox…',
  provisioning: 'Preparing sandbox…',
  running: 'Running remotely…',
  collecting: 'Collecting results…',
  completed: 'Remote task completed',
  failed: 'Remote task failed',
  cancelled: 'Remote task cancelled',
  unknown: 'Checking remote task outcome…',
};

export function RemoteServiceSettings() {
  const { t } = useDisplayText();
  const [service, setService] = useState<RemoteServiceState>();
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    let alive = true;
    void window
      .viewerHost!.remoteService()
      .then(value => {
        if (alive) setService(value);
      })
      .catch(reason => {
        if (alive) setError(String(reason));
      });
    return () => {
      alive = false;
    };
  }, []);
  async function check() {
    setChecking(true);
    setError('');
    try {
      setService(await window.viewerHost!.remoteCheck());
    } catch (reason) {
      setError(String(reason));
    } finally {
      setChecking(false);
    }
  }
  return (
    <section className="ia-remote-service" aria-label={t('Zhiman Remote')}>
      <div className="ia-remote-heading">
        <Cloud size={18} />
        <b>{t('Zhiman Remote')}</b>
        <span role="status">{service ? t(serviceLabels[service.status]) : t('Loading…')}</span>
      </div>
      <p>{t('Run domain tools remotely without installing the toolchain on this computer.')}</p>
      {service?.status === 'not_configured' && (
        <p>
          {t(
            'The trial service address and sign-in settings will be supplied with the app. They are not configured yet.',
          )}
        </p>
      )}
      <button
        onClick={() => void check()}
        disabled={
          checking || !service || ['not_configured', 'credentials_missing'].includes(service.status)
        }
      >
        {checking ? t('Connecting…') : t('Check connection')}
      </button>
      {error && <p role="alert">{t(error)}</p>}
    </section>
  );
}

export function ProjectExecution({
  project,
  busy,
  onChanged,
  onReady,
}: {
  project: ProjectBinding;
  busy: boolean;
  onChanged: () => void;
  onReady: (ready: boolean) => void;
}) {
  const { t } = useDisplayText();
  const [state, setState] = useState<RemoteProjectState>();
  const [files, setFiles] = useState<string[] | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [review, setReview] = useState<RemoteSyncReview>();
  const [pending, setPending] = useState(false),
    [error, setError] = useState('');
  const lock = useRef(false);
  useEffect(() => {
    let alive = true;
    void window
      .viewerHost!.remoteProject({ projectId: project.id })
      .then(value => {
        if (alive) {
          setState(value);
          setSelected(value.files);
          onReady(
            value.location === 'local' ||
              (Boolean(value.syncedAt) &&
                value.service.status === 'connected' &&
                value.service.domains.includes(project.domain || '')),
          );
        }
      })
      .catch(reason => {
        if (alive) setError(String(reason));
      });
    return () => {
      alive = false;
    };
  }, [project.id, project.domain, project.executionLocation]);
  async function change(operation: () => Promise<unknown>, changed = false) {
    if (lock.current || busy) return;
    lock.current = true;
    setPending(true);
    setError('');
    try {
      await operation();
      const next = await window.viewerHost!.remoteProject({ projectId: project.id });
      setState(next);
      onReady(
        next.location === 'local' ||
          (Boolean(next.syncedAt) &&
            next.service.status === 'connected' &&
            next.service.domains.includes(project.domain || '')),
      );
      if (changed) onChanged();
    } catch (reason) {
      setError(String(reason));
    } finally {
      lock.current = false;
      setPending(false);
    }
  }
  async function chooseFiles() {
    const available = await window.viewerHost!.remoteFiles({ projectId: project.id });
    setFiles(available);
    setSelected(current => current.filter(file => available.includes(file)));
    setReview(undefined);
  }
  return (
    <section className="ia-project-execution" aria-label={t('Execution location')}>
      <div className="ia-project-property">
        <span>{t('Execution location')}</span>
        <div className="ia-execution-options">
          <button
            aria-pressed={state?.location === 'local'}
            disabled={busy || pending}
            onClick={() =>
              void change(
                () =>
                  window.viewerHost!.remoteSetLocation({
                    projectId: project.id,
                    location: 'local',
                  }),
                true,
              )
            }
          >
            <Monitor size={15} />
            {t('This computer')}
          </button>
          <button
            aria-pressed={state?.location === 'remote'}
            disabled={busy || pending}
            onClick={() =>
              void change(
                () =>
                  window.viewerHost!.remoteSetLocation({
                    projectId: project.id,
                    location: 'remote',
                  }),
                true,
              )
            }
          >
            <Cloud size={15} />
            {t('Zhiman Remote (trial)')}
          </button>
        </div>
      </div>
      {state?.location === 'remote' && (
        <div className="ia-remote-project-body">
          <p role="status">
            {t(serviceLabels[state.service.status])}
            {state.syncedAt && ` · ${t('Approved files synced')}`}
          </p>
          {state.service.status === 'not_configured' && (
            <p>
              {t(
                'The trial service is not configured yet. You can save this choice and connect when it is available.',
              )}
            </p>
          )}
          {state.service.status === 'unchecked' && (
            <button
              disabled={busy || pending}
              onClick={() => void change(() => window.viewerHost!.remoteCheck())}
            >
              {t('Connect')}
            </button>
          )}
          {state.service.status === 'connected' &&
            !state.service.domains.includes(project.domain || '') && (
              <p>{t('This domain is not available remotely yet.')}</p>
            )}
          {state.service.status === 'connected' &&
            state.service.domains.includes(project.domain || '') && (
              <>
                <p>
                  {t(
                    'Only files you confirm below will be uploaded. Changes to these files sync before the next task; adding files requires another confirmation.',
                  )}
                </p>
                {!files && (
                  <button disabled={busy || pending} onClick={() => void change(chooseFiles)}>
                    {state.files.length ? t('Manage synced files') : t('Choose files to sync')}
                  </button>
                )}
                {files && !review && (
                  <div className="ia-remote-file-picker">
                    {files.map(file => (
                      <label key={file}>
                        <input
                          type="checkbox"
                          checked={selected.includes(file)}
                          disabled={busy || pending}
                          onChange={event =>
                            setSelected(current =>
                              event.target.checked
                                ? [...current, file]
                                : current.filter(value => value !== file),
                            )
                          }
                        />
                        <code>{file}</code>
                      </label>
                    ))}
                    {!files.length && <p>{t('No eligible files found.')}</p>}
                    <button
                      disabled={busy || pending || !selected.length}
                      onClick={() =>
                        void change(async () =>
                          setReview(
                            await window.viewerHost!.remoteReview({
                              projectId: project.id,
                              files: selected,
                            }),
                          ),
                        )
                      }
                    >
                      {t('Review upload')}
                    </button>
                    <button disabled={pending} onClick={() => setFiles(null)}>
                      {t('Cancel')}
                    </button>
                  </div>
                )}
                {review && (
                  <div className="ia-remote-sync-review">
                    <b>{t('Confirm file upload')}</b>
                    <p>{t('Destination: {0}', { '0': review.destination })}</p>
                    <ul>
                      {review.files.map(file => (
                        <li key={file.path}>
                          <code>{file.path}</code>
                          <span>{file.sizeBytes} B</span>
                        </li>
                      ))}
                    </ul>
                    <p>
                      {t('Total: {0} files · {1} bytes', {
                        '0': String(review.files.length),
                        '1': String(review.totalBytes),
                      })}
                    </p>
                    <button
                      disabled={busy || pending}
                      onClick={() =>
                        void change(async () => {
                          await window.viewerHost!.remoteSync({
                            projectId: project.id,
                            reviewId: review.id,
                          });
                          setReview(undefined);
                          setFiles(null);
                        }, true)
                      }
                    >
                      {pending ? t('Syncing…') : t('Confirm and sync')}
                    </button>
                    <button disabled={pending} onClick={() => setReview(undefined)}>
                      {t('Back')}
                    </button>
                  </div>
                )}
              </>
            )}
        </div>
      )}
      {error && (
        <p role="alert" className="ia-project-error">
          {t(error)}
        </p>
      )}
    </section>
  );
}

export function RemoteTaskStatus({
  projectId,
  onReady,
  onConfigure,
}: {
  projectId: string;
  onReady: (ready: boolean) => void;
  onConfigure: () => void;
}) {
  const { t } = useDisplayText();
  const [project, setProject] = useState<RemoteProjectState>();
  const [task, setTask] = useState<RemoteTaskState | null>(null),
    [error, setError] = useState('');
  useEffect(() => {
    let alive = true,
      timer: ReturnType<typeof setTimeout>;
    onReady(false);
    async function poll() {
      try {
        const state = await window.viewerHost!.remoteProject({ projectId });
        const ready = state.service.status === 'connected' && Boolean(state.syncedAt);
        const value = state.task ? await window.viewerHost!.remoteTask({ projectId }) : null;
        if (alive) {
          setProject(state);
          onReady(ready);
          setTask(value);
          setError('');
        }
      } catch (reason) {
        if (alive) {
          setError(String(reason));
          onReady(false);
        }
      }
      if (alive) timer = setTimeout(() => void poll(), 2000);
    }
    void poll();
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [projectId]);
  return (
    <div className="ia-remote-task-status" role="status">
      <Cloud size={14} />
      <span>
        {t(
          task
            ? taskLabels[task.status] || 'Checking remote task outcome…'
            : project?.service.status === 'connected'
              ? project.syncedAt
                ? 'Zhiman Remote (trial)'
                : 'Choose files to sync'
              : project
                ? serviceLabels[project.service.status]
                : 'Loading…',
        )}
        {task?.status === 'queued' && task.queuePosition
          ? ` · ${t('Queue position {0}', { '0': String(task.queuePosition) })}`
          : ''}
      </span>
      {task?.jobId && ['queued', 'provisioning', 'running', 'collecting'].includes(task.status) && (
        <button
          onClick={() =>
            void window
              .viewerHost!.remoteCancel({
                projectId,
                requestId: task.requestId,
                jobId: task.jobId!,
              })
              .then(setTask)
              .catch(reason => setError(String(reason)))
          }
        >
          {t('Cancel task')}
        </button>
      )}
      {project && (!project.syncedAt || project.service.status !== 'connected') && (
        <button onClick={onConfigure}>{t('Project details')}</button>
      )}
      {error && <span>{t('Could not refresh task status. Check the connection.')}</span>}
    </div>
  );
}
