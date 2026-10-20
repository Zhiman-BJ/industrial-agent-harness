import { useState, useRef } from 'react';
import { ArrowUpRight, Eye, FileText, FolderOpen } from 'lucide-react';
import type {
  TaskResultView,
  ResultOpenRequest,
} from '@industrial-agent-harness/viewer-builtin/api';
import { useDisplayText } from '@industrial-agent-harness/viewer-builtin/text';
import { partitionResultGroups } from '../result-layout';
import { evidenceLabel } from '../evidence-refresh';

export function TaskResults({
  results,
  onOpen,
}: {
  results: TaskResultView;
  onOpen?: (request: ResultOpenRequest) => Promise<void>;
}) {
  const { t } = useDisplayText();
  const [opening, setOpening] = useState('');
  const [error, setError] = useState('');
  const pending = useRef(false);
  async function open(groupId: string, artifactId: string, reveal = false) {
    if (!onOpen || pending.current) return;
    pending.current = true;
    setOpening(artifactId);
    setError('');
    try {
      const request = { chatId: results.chatId, turnId: results.turnId, groupId, artifactId };
      await onOpen({ ...request, revealOnly: reveal });
    } catch (reason) {
      setError(String(reason));
    } finally {
      pending.current = false;
      setOpening('');
    }
  }
  function card(group: TaskResultView['groups'][number]) {
    const primary = group.artifacts.find(artifact => artifact.id === group.primaryArtifactId);
    const step = results.actionIds.indexOf(group.actionId);
    const statuses = group.verifications.map(verification => verification.status);
    const inputs = group.verifications.map(verification => verification.inputStatus);
    const inputStatus =
      inputs.find(input => input?.status === 'changed') ||
      inputs.find(input => input?.status === 'unavailable') ||
      (inputs.every(input => input?.status === 'matches') ? inputs[0] : undefined);
    const checkLabel = statuses.includes('failed')
      ? 'Checks failed'
      : statuses.includes('insufficient_evidence')
        ? 'Insufficient evidence'
        : statuses.includes('not_run') && statuses.includes('passed')
          ? 'Checks incomplete'
          : !statuses.length || statuses.includes('not_run')
            ? 'Not checked'
            : 'Checks passed';
    const entryLabel = group.previewArtifactId ? 'Preview result' : 'Open result';
    const isOpening = opening === (group.previewArtifactId || group.primaryArtifactId);
    return (
      <article
        className={`ia-result-card ${group.selected ? 'selected' : ''}`}
        key={group.id}
        data-result-id={group.id}
      >
        <div className="ia-result-main">
          <FileText size={15} aria-hidden="true" className="ia-result-icon" />
          <b className="ia-result-title" title={t(group.title)}>
            {t(group.title)}
          </b>
          {group.selected ? (
            <small className="ia-result-badge">{t('Selected result')}</small>
          ) : null}
          {group.historical ? (
            <small className="ia-result-badge">{t('Historical version')}</small>
          ) : null}
          <div className="ia-result-actions">
            <button
              className="ia-result-open"
              aria-label={t(entryLabel)}
              title={t(entryLabel)}
              disabled={!onOpen || Boolean(opening) || !primary}
              onClick={() =>
                void open(group.id, group.previewArtifactId || group.primaryArtifactId)
              }
            >
              {group.previewArtifactId ? (
                <Eye size={14} aria-hidden="true" />
              ) : (
                <ArrowUpRight size={14} aria-hidden="true" />
              )}
              <span>{t(isOpening ? 'Opening…' : 'Open')}</span>
            </button>
            <button
              className="ia-result-reveal"
              aria-label={t('Show native file')}
              title={t('Show native file')}
              disabled={!onOpen || Boolean(opening) || !primary}
              onClick={() => void open(group.id, group.primaryArtifactId, true)}
            >
              <FolderOpen size={14} aria-hidden="true" />
            </button>
          </div>
        </div>
        <div className="ia-result-meta">
          {step >= 0 && results.actionIds.length > 1 ? (
            <span className="ia-result-source">{t('Step {0}', { '0': String(step + 1) })}</span>
          ) : null}
          <span
            className={`ia-result-status ${group.executionStatus === 'completed' ? '' : 'failed'}`}
          >
            {t(
              group.executionStatus === 'completed'
                ? 'Execution completed'
                : 'Partial result · execution failed',
            )}
          </span>
          <details className="ia-result-files">
            <summary>{t('Files ({0})', { '0': String(group.artifacts.length) })}</summary>
            <div className="ia-result-file-list">
              {group.artifacts.map(artifact => (
                <button
                  className="ia-result-file"
                  title={artifact.relativePath}
                  key={artifact.id}
                  disabled={!onOpen || Boolean(opening)}
                  onClick={() => void open(group.id, artifact.id)}
                >
                  <FileText size={13} aria-hidden="true" />
                  <span>{artifact.relativePath.split('/').at(-1)}</span>
                </button>
              ))}
            </div>
          </details>
          {group.verifications.length ? (
            <details className={`ia-result-checks ${statuses.includes('failed') ? 'failed' : ''}`}>
              <summary title={t('Verification applies to the recorded version.')}>
                {t(checkLabel)}{' '}
                <span className="ia-result-count">{group.verifications.length}</span>
              </summary>
              <div className="ia-result-check-list">
                {group.verifications.map(verification => (
                  <div key={verification.id}>
                    <b>
                      {t(
                        verification.status === 'passed'
                          ? 'Recorded version passed verification'
                          : verification.status === 'failed'
                            ? 'Engineering verification failed'
                            : verification.status === 'not_run'
                              ? 'Engineering verification was not run'
                              : 'Engineering evidence is insufficient',
                      )}
                    </b>
                    <p>{verification.reason}</p>
                    <small>{t(evidenceLabel(verification.inputStatus))}</small>
                  </div>
                ))}
                <small>{t('Verification applies to the recorded version.')}</small>
              </div>
            </details>
          ) : (
            <span className="ia-result-checks">{t('Not checked')}</span>
          )}
        </div>
        {group.verifications.length ? (
          <small
            className="ia-result-inputs"
            data-input-status={inputStatus?.status || 'unchecked'}
          >
            {t('Recorded version')} · {t(evidenceLabel(inputStatus))}
          </small>
        ) : null}
        {group.contentStatus !== 'recorded' ? (
          <p className="ia-flow-error ia-result-warning">
            {t(
              group.contentStatus === 'changed'
                ? 'Recorded content changed · checks apply to the previous bytes'
                : group.contentStatus === 'unchecked'
                  ? 'Recorded content has not been checked'
                  : 'Recorded file is unavailable',
            )}
          </p>
        ) : null}
      </article>
    );
  }
  const { main, supporting, previous } = partitionResultGroups(results.groups);
  if (!results.groups.length && !results.actionIds.length && !results.diagnostics?.length)
    return null;
  return (
    <section
      className="ia-task-results"
      aria-label={t('Task results')}
      data-result-turn={results.turnId}
    >
      <div className="ia-result-heading">
        <b>{t('Task results')}</b>
        <small role="status">
          {t(
            results.phase === 'background'
              ? 'Background work is still running'
              : results.executionStatus === 'completed'
                ? 'Results ready'
                : results.phase === 'running'
                  ? 'Results so far'
                  : ['completed', 'finished'].includes(results.requestStatus)
                    ? 'Partial results · some operations failed'
                    : 'Partial results · request not completed',
          )}
        </small>
      </div>
      {main.map(card)}
      {supporting.length ? (
        <details className="ia-result-supporting">
          <summary>{t('Supporting results ({0})', { '0': String(supporting.length) })}</summary>
          {supporting.map(card)}
        </details>
      ) : null}
      {previous.length ? (
        <details className="ia-result-previous">
          <summary>
            {t('Previous versions')} <span className="ia-result-count">{previous.length}</span>
          </summary>
          {previous.map(card)}
        </details>
      ) : null}
      {(results.diagnostics || []).map(message => (
        <p key={message}>{message}</p>
      ))}
      {error ? (
        <p className="ia-flow-error" role="alert">
          {t(error)}
        </p>
      ) : null}
    </section>
  );
}
