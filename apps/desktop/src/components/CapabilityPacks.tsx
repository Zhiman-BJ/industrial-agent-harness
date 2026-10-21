import { DomainIcon } from '@industrial-agent-harness/viewer-builtin/domain-icon';
import { useDisplayText } from '@industrial-agent-harness/viewer-builtin/text';
import { useEffect, useState } from 'react';
import type {
  AvailableDomainPack,
  DomainInstallationStatus,
  DomainInstallProgress,
  DomainOption,
} from '@industrial-agent-harness/viewer-builtin/api';
import {
  cancelInstallation,
  CatalogEmpty,
  CatalogNotice,
  InstallationOutcome,
  InstallationProgress,
  InstallationSize,
  RuntimeReadiness,
  DomainPreparationActions,
  UnavailableDomains,
} from './DomainInstallation';

export type DomainStatus = DomainInstallationStatus;
export type AvailablePack = AvailableDomainPack;
export type DomainProgress = DomainInstallProgress;

export function PacksSection({
  status,
  statusError,
  progress,
  busy,
  revision,
  onChanged,
  onRefresh,
  onStatus,
}: {
  status?: DomainStatus;
  statusError: string;
  progress: DomainProgress | null;
  busy: boolean;
  revision: number;
  onChanged: (installed: DomainOption[]) => void;
  onRefresh: () => void;
  onStatus: (status: DomainStatus) => void;
}) {
  const { t } = useDisplayText();
  const [available, setAvailable] = useState<AvailablePack[]>([]);
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [error, setError] = useState('');
  const [feedError, setFeedError] = useState('');
  useEffect(() => {
    if (!status?.managed) {
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setFeedError('');
    void (async () => {
      try {
        const items = await window.viewerHost!.domainAvailable();
        const next = await window.viewerHost!.domainStatus();
        if (!cancelled) {
          setAvailable(items);
          onStatus(next);
        }
      } catch (reason) {
        if (!cancelled) {
          setFeedError(String(reason));
          setAvailable([]);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [status?.managed, revision]);
  const installing = Boolean(progress) || Boolean(status?.operation?.active);
  const disabled = busy || pending || installing || cancelling;
  async function change(
    action: 'install' | 'remove' | 'repair',
    domain: string,
    options?: { scope: 'viewer' },
  ) {
    if (disabled) return;
    setPending(true);
    setError('');
    try {
      const host = window.viewerHost!;
      const result = await (action === 'install'
        ? host.domainInstall([domain], options)
        : action === 'remove'
          ? host.domainRemove(domain)
          : host.domainRepair(domain, options));
      onChanged(result.installed);
    } catch (reason) {
      try {
        const next = await window.viewerHost!.domainStatus();
        onStatus(next);
        if (
          next.lastOperation?.outcome !== 'cancelled' ||
          !String(reason).includes('Domain preparation cancelled.')
        )
          setError(String(reason));
      } catch {
        setError(String(reason));
      }
    } finally {
      setPending(false);
      onRefresh();
    }
  }
  async function cancel() {
    if (cancelling) return;
    setCancelling(true);
    try {
      await cancelInstallation();
    } catch (reason) {
      setError(String(reason));
    } finally {
      setCancelling(false);
      onRefresh();
    }
  }
  const installed = status?.installed || [];
  const installedIds = new Set(installed.map(item => item.domain));
  const installable = available.filter(item => !installedIds.has(item.domain));
  const hasUpdates = available.some(item => item.updateAvailable);
  return (
    <section className="ia-capability-section ia-packs-section" aria-label={t('Domain packs')}>
      <div className="ia-pack-section-heading">
        <h2>{t('Domain packs')}</h2>
        <button className="ia-pack-action" onClick={onRefresh} disabled={loading || disabled}>
          {t('Check updates')}
        </button>
      </div>
      <p>{t('Each pack bundles the skills, MCP servers and runtime for one domain.')}</p>
      {statusError && (
        <p role="alert" className="ia-project-error">
          {t(statusError)}
        </p>
      )}
      <CatalogNotice status={status} loading={loading} />
      {!status && !statusError && <p role="status">{t('Checking domains…')}</p>}
      {!installing && <InstallationOutcome status={status} error={error} />}
      {installing && error && (
        <p role="alert" className="ia-project-error">
          {t(error)}
        </p>
      )}
      {feedError && (
        <p role="alert" className="ia-project-error">
          {t('Catalog unavailable:')} {feedError}
        </p>
      )}
      {installing && (
        <InstallationProgress
          progress={progress || status?.operation?.progress || null}
          cancelling={cancelling}
          onCancel={() => void cancel()}
          background
          operation={status?.operation}
        />
      )}
      {busy && <p role="status">{t('Finish the current task before changing domains.')}</p>}
      {status && !status.managed && !statusError && (
        <p className="ia-capability-note">
          {t(
            'Domain installation is available in packaged builds. Development resources are loaded from this repository.',
          )}
        </p>
      )}
      {status?.managed && (
        <>
          {installable.length > 0 && (
            <>
              <h3>
                {t('Available')} · {installable.length}
              </h3>
              <div className="ia-pack-grid">
                {installable.map(item => (
                  <div key={item.domain} className="ia-pack-card" data-domain={item.domain}>
                    <span className="ia-pack-icon" aria-hidden="true">
                      <DomainIcon domain={item.domain} size={18} />
                    </span>
                    <div className="ia-pack-body">
                      <div className="ia-pack-title">
                        <b>{t(item.label || item.domain)}</b>
                        <small>v{item.version}</small>
                      </div>
                      {item.summary && <p className="ia-pack-summary">{t(item.summary)}</p>}
                      <InstallationSize pack={item} />
                      {item.prerequisites?.length ? (
                        <small className="ia-pack-meta">
                          {t('Needs:')} {item.prerequisites.map(text => t(text)).join('; ')}
                        </small>
                      ) : null}
                    </div>
                    <div className="ia-pack-actions">
                      <button
                        className="ia-pack-action"
                        disabled={disabled || loading}
                        onClick={() => void change('install', item.domain)}
                      >
                        {t('Install')}
                      </button>
                      {item.viewerAvailable && (
                        <button
                          className="ia-pack-action"
                          data-action="install-viewer"
                          disabled={disabled || loading}
                          onClick={() => void change('install', item.domain, { scope: 'viewer' })}
                        >
                          {t('Install viewer support')}
                        </button>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </>
          )}
          {!loading && !installable.length && !hasUpdates && !feedError && (
            <CatalogEmpty status={status} available={available} />
          )}
          {Boolean(status.catalog?.unavailableDomains?.length) && (
            <>
              <h3>{t('Not available to install')}</h3>
              <div className="ia-pack-grid">
                <UnavailableDomains status={status} />
              </div>
            </>
          )}
          {installed.length > 0 && (
            <>
              <h3>
                {t('Installed')} · {installed.length}
              </h3>
              <div className="ia-pack-grid">
                {installed.map(item => {
                  const update = available.find(entry => entry.domain === item.domain);
                  const problems = (status.errors || []).filter(
                    problem => problem.domain === item.domain,
                  );
                  return (
                    <div key={item.domain} className="ia-pack-card" data-domain={item.domain}>
                      <span className="ia-pack-icon" aria-hidden="true">
                        <DomainIcon domain={item.domain} size={18} />
                      </span>
                      <div className="ia-pack-body">
                        <div className="ia-pack-title">
                          <b>{t(item.label)}</b>
                          <small>
                            {update?.updateAvailable
                              ? t('Version {0} → {1}', { '0': item.version, '1': update.version })
                              : `v${item.version}`}
                          </small>
                        </div>
                        {item.summary && <p className="ia-pack-summary">{t(item.summary)}</p>}
                        {problems.map(problem => (
                          <small key={problem.message} role="alert" className="ia-pack-error">
                            {problem.message}
                          </small>
                        ))}
                        <RuntimeReadiness item={item} />
                        {update?.updateAvailable && <InstallationSize pack={update} />}
                      </div>
                      <div className="ia-pack-actions">
                        {update?.updateAvailable && (
                          <button
                            className="ia-pack-action primary"
                            disabled={disabled}
                            onClick={() => void change('install', item.domain)}
                          >
                            {t('Update')}
                          </button>
                        )}
                        {update?.viewerAvailable && !item.viewerAssets?.length && (
                          <button
                            className="ia-pack-action"
                            data-action="install-viewer"
                            disabled={disabled}
                            onClick={() => void change('install', item.domain, { scope: 'viewer' })}
                          >
                            {t('Install viewer support')}
                          </button>
                        )}
                        <DomainPreparationActions
                          item={item}
                          disabled={disabled}
                          onRepair={(domain, options) => void change('repair', domain, options)}
                        />
                        <button
                          className="ia-pack-action"
                          disabled={disabled}
                          onClick={() => void change('remove', item.domain)}
                        >
                          {t('Remove')}
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            </>
          )}
        </>
      )}
    </section>
  );
}
