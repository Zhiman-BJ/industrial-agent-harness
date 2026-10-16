import type {
  RemoteProjectState,
  RemoteSessionState,
  RemoteTaskState,
} from '@industrial-agent-harness/viewer-builtin/api';

export type TodoItem = { title: string; status: 'pending' | 'in_progress' | 'done' };

// Display summaries only. Readiness remains owned by the existing remote path.
export function summarizeTodos(todo: TodoItem[] | null, running: boolean) {
  const items = todo || [];
  const done = items.filter(item => item.status === 'done').length;
  const current = items.find(item => item.status === 'in_progress');
  const next = items.find(item => item.status === 'pending');
  const allDone = items.length > 0 && done === items.length;
  return {
    done,
    state: allDone
      ? 'Completed'
      : current
        ? running
          ? 'In progress'
          : 'Not completed'
        : 'Pending',
    title: allDone ? null : current?.title || next?.title || null,
    summary: allDone ? 'All tasks completed' : 'Pending',
  };
}

export function summarizeRemote({
  project,
  task,
  session,
  error,
  domain,
}: {
  project?: RemoteProjectState;
  task: RemoteTaskState | null;
  session: RemoteSessionState | null;
  error: string;
  domain: string;
}): { label: string; tone: 'ok' | 'idle' | 'bad' } {
  if (error) return { label: 'Remote request failed', tone: 'bad' };
  if (!project) return { label: 'Loading…', tone: 'idle' };
  const { service } = project;
  const serviceLabels = {
    not_configured: 'Not configured',
    credentials_missing: 'Connection credentials needed',
    unchecked: 'Not connected',
    connected: 'Connected',
    unavailable: 'Temporarily unavailable',
  };
  if (service.status !== 'connected')
    return {
      label: serviceLabels[service.status],
      tone: service.status === 'unavailable' ? 'bad' : 'idle',
    };
  if (session && ['stopped', 'expired', 'failed'].includes(session.status))
    return {
      label: 'Remote session ended. Start a new chat.',
      tone: session.status === 'failed' ? 'bad' : 'idle',
    };
  if (!service.domains.includes(domain))
    return { label: 'This domain is not available remotely yet.', tone: 'idle' };
  if (!service.executableDomains?.includes(domain) && !service.capabilities?.runtimeDiscovery)
    return { label: 'This remote domain is available for testing only.', tone: 'idle' };
  if (task) {
    const labels: Record<string, string> = {
      submitting: 'Preparing remote task…',
      running: 'Running remotely…',
      completed: 'Remote task completed',
      failed: 'Remote task failed',
      unknown: 'Remote outcome unknown; checking without replaying…',
    };
    return {
      label: labels[task.status] || 'Remote outcome unknown',
      tone:
        task.status === 'failed'
          ? 'bad'
          : !labels[task.status] || task.status === 'unknown'
            ? 'idle'
            : 'ok',
    };
  }
  return project.syncedAt
    ? { label: 'Remote ready', tone: 'ok' }
    : { label: 'Choose files to sync', tone: 'idle' };
}
