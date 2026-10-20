import type { AgentEvent } from '@industrial-agent-harness/viewer-builtin/api';
import { useDisplayText } from '@industrial-agent-harness/viewer-builtin/text';
import { useRef, useState } from 'react';
import { evidenceLabel } from '../evidence-refresh';

type ResultEvent = Extract<AgentEvent, { type: 'industrial-result' }>;

export function IndustrialResult({
  event,
  debug,
  onOpenArtifact,
}: {
  event: ResultEvent;
  debug: boolean;
  onOpenArtifact?: (actionId: string, artifactId: string) => Promise<void>;
}) {
  const { t } = useDisplayText();
  const submitting = useRef(false);
  const [opening, setOpening] = useState<string | null>(null);
  const [error, setError] = useState('');
  const verified = event.action.status === 'completed' && event.verification.status === 'passed';
  const title = verified
    ? 'Recorded version passed verification'
    : event.verification.status === 'failed'
      ? 'Engineering verification failed'
      : event.verification.status === 'not_run'
        ? 'Engineering verification was not run'
        : 'Engineering evidence is insufficient';
  const execution =
    event.action.status === 'completed'
      ? 'Execution completed'
      : event.action.status === 'failed'
        ? 'Execution failed'
        : 'Execution in progress';
  async function open(artifactId: string) {
    if (!onOpenArtifact || submitting.current) return;
    submitting.current = true;
    setOpening(artifactId);
    setError('');
    try {
      await onOpenArtifact(event.action.id, artifactId);
    } catch (reason) {
      setError(String(reason));
    } finally {
      submitting.current = false;
      setOpening(null);
    }
  }
  return (
    <details
      className={`ia-agent-tool ia-industrial-result ${event.action.status === 'failed' || event.verification.status === 'failed' ? 'error' : ''}`}
      data-action-id={event.action.id}
    >
      <summary>
        {t(title)} · {t(evidenceLabel(event.inputStatus))}
      </summary>
      <p className="ia-result-execution">{t(execution)}</p>
      <p>{event.verification.reason}</p>
      <small>{t('Verification applies to the inputs recorded for this action.')}</small>
      {Boolean(event.artifacts?.length) && (
        <div className="ia-result-artifacts">
          <b>{t('Outputs from this action')}</b>
          {event.artifacts!.map(artifact => (
            <button
              key={artifact.id}
              className="ia-result-artifact"
              data-artifact-id={artifact.id}
              disabled={opening !== null || !onOpenArtifact}
              onClick={() => void open(artifact.id)}
              title={artifact.relativePath}
            >
              <span>{artifact.relativePath.split('/').at(-1)}</span>
              <small>
                {opening === artifact.id
                  ? t('Opening…')
                  : event.verification.evidence?.artifactIds.includes(artifact.id)
                    ? t('Verification evidence')
                    : t('Open output')}
              </small>
            </button>
          ))}
        </div>
      )}
      {error && (
        <p role="alert" className="ia-flow-error">
          {t(error)}
        </p>
      )}
      {debug && (
        <small>
          {t('Action')} {event.action.id} {t('· Checkpoint')} {event.checkpoint.id}
        </small>
      )}
    </details>
  );
}
