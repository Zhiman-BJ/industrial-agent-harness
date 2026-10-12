import { RuntimeEnvironments } from './RuntimeEnvironments';
import { DomainIcon } from '@industrial-agent-harness/viewer-builtin/domain-icon';
import { useDisplayText } from '@industrial-agent-harness/viewer-builtin/text';
import { useEffect, useRef, useState } from 'react';
import { X } from 'lucide-react';
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
  formatBytes,
  InstallationOutcome,
  InstallationProgress,
  InstallationSize,
  UnavailableDomains,
  selectedFootprint,
} from './DomainInstallation';

export function DomainManager({
  onClose,
  onChanged,
  onSetupNext,
  firstRun,
  busy,
}: {
  onClose: () => void;
  onChanged: (domains: DomainOption[]) => void;
  onSetupNext?: (action: 'model' | 'project') => void;
  firstRun: boolean;
  busy: boolean;
}) {
  const { t, locale } = useDisplayText();
  const dialog = useRef<HTMLDialogElement>(null);
  const refreshId = useRef(0);
  const [status, setStatus] = useState<DomainInstallationStatus>();
  const [available, setAvailable] = useState<AvailableDomainPack[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [complete, setComplete] = useState(false);
  const [error, setError] = useState('');
  const [feedError, setFeedError] = useState('');
  const [progress, setProgress] = useState<DomainInstallProgress | null>(null);
  useEffect(() => {
    dialog.current?.showModal();
    dialog.current?.querySelector<HTMLHeadingElement>('header h2')?.focus();
    void refresh();
    const unsubscribe = window.viewerHost!.onDomainProgress(next => {
      setProgress(next.active === false ? null : next);
      if (next.active === false) void refresh();
    });
    return () => {
      refreshId.current++;
      unsubscribe();
    };
  }, []);
  useEffect(() => {
    if (!status?.operation?.active || status.operation.source !== 'external') return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      try {
        const next = await window.viewerHost!.domainStatus();
        if (stopped) return;
        setStatus(next);
        setProgress(next.operation?.active ? next.operation.progress : null);
        if (!next.operation?.active) {
          void refresh();
          return;
        }
      } catch (reason) {
        if (!stopped) setError(String(reason));
      }
      if (!stopped) timer = setTimeout(poll, 800);
    }
    timer = setTimeout(poll, 800);
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [status?.operation?.active, status?.operation?.source]);
  async function refresh() {
    const id = ++refreshId.current;
    setLoading(true);
    setFeedError('');
    try {
      let next = await window.viewerHost!.domainStatus();
      if (id !== refreshId.current) return next;
      setStatus(next);
      setProgress(next.operation?.active ? next.operation.progress : null);
      if (next.managed) {
        onChanged(await window.viewerHost!.domains());
        try {
          const entries = await window.viewerHost!.domainAvailable();
          next = await window.viewerHost!.domainStatus();
          if (id !== refreshId.current) return next;
          setAvailable(entries);
          setStatus(next);
        } catch (reason) {
          if (id !== refreshId.current) return next;
          setFeedError(String(reason));
          setAvailable([]);
        }
      }
      return next;
    } catch (reason) {
      if (id === refreshId.current) setError(String(reason));
    } finally {
      if (id === refreshId.current) setLoading(false);
    }
  }
  const installing = saving || Boolean(status?.operation?.active) || Boolean(progress);
  const disabled = busy || installing || cancelling;
  async function install() {
    if (!selected.length || disabled || loading) return;
    setSaving(true);
    setError('');
    setComplete(false);
    try {
      const result = await window.viewerHost!.domainInstall(selected);
      onChanged(result.installed);
      setSelected([]);
      await refresh();
      if (firstRun) setComplete(true);
    } catch (reason) {
      const next = await refresh();
      if (
        next?.lastOperation?.outcome !== 'cancelled' ||
        !String(reason).includes('Domain preparation cancelled.')
      )
        setError(String(reason));
    } finally {
      setSaving(false);
      setProgress(null);
    }
  }
  async function remove(domain: string) {
    if (disabled) return;
    setSaving(true);
    setError('');
    setComplete(false);
    try {
      onChanged((await window.viewerHost!.domainRemove(domain)).installed);
      await refresh();
    } catch (reason) {
      setError(String(reason));
    } finally {
      setSaving(false);
    }
  }
  async function cancel(closeAfter = false) {
    if (cancelling) return;
    setCancelling(true);
    setError('');
    try {
      await cancelInstallation();
      await refresh();
      if (closeAfter) onClose();
    } catch (reason) {
      setError(String(reason));
    } finally {
      setCancelling(false);
    }
  }
  function close() {
    if (installing && status?.operation?.cancellable !== false) void cancel(true);
    else onClose();
  }
  const installed = status?.installed || [];
  const installedById = new Map(installed.map(item => [item.domain, item]));
  const selectable = available.filter(
    item => !installedById.has(item.domain) || item.updateAvailable === true,
  );
  const footprint = selectedFootprint(selectable.filter(item => selected.includes(item.domain)));
  const insufficient =
    footprint?.availableBytes !== undefined && footprint.availableBytes < footprint.requiredBytes;
  return (
    <dialog
      ref={dialog}
      className="ia-model-modal ia-domains-modal"
      aria-label={t('Manage domains')}
      onCancel={event => {
        event.preventDefault();
        close();
      }}
    >
      <header>
        <div>
          <h2 tabIndex={-1}>{firstRun ? t('Choose your domains') : t('Domains')}</h2>
          <p>
            {firstRun
              ? t('Select one or more domains to prepare the workspace.')
              : t('Add missing domains and install available updates.')}
          </p>
        </div>
        <button
          className="ia-icon"
          aria-label={t(
            installing && status?.operation?.cancellable !== false
              ? 'Cancel installation and close'
              : 'Close domain manager',
          )}
          disabled={cancelling}
          onClick={close}
        >
          <X size={17} />
        </button>
      </header>
      <div className="ia-domains-content">
        <CatalogNotice status={status} loading={loading} />
        {loading && !status && <p role="status">{t('Checking domains…')}</p>}
        {installing && (
          <InstallationProgress
            progress={progress}
            cancelling={cancelling}
            onCancel={() => void cancel()}
            operation={status?.operation}
          />
        )}
        {!installing &&
          (!complete ||
            status?.lastOperation?.outcome !== 'completed' ||
            status?.lastOperation?.statusWarning ||
            error) && <InstallationOutcome status={status} error={error} />}
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
        {(status?.errors || []).map(item => (
          <p key={`${item.domain}:${item.message}`} role="alert" className="ia-project-error">
            {installedById.get(item.domain)?.label || item.domain}: {item.message}
          </p>
        ))}
        {!status?.managed && !loading && !error && (
          <p>
            {t(
              'Domain installation is available in packaged builds. Development resources are loaded from this repository.',
            )}
          </p>
        )}
        {complete && !installing && (
          <div className="ia-domain-setup" role="status">
            <h2>{t('Your selected domains are installed')}</h2>
            <p>
              {t(
                'Packs are installed. Configure software in the capability center, then create a project.',
              )}
            </p>
            <div className="ia-domain-setup-actions">
              {onSetupNext && (
                <>
                  <button data-action="model" onClick={() => onSetupNext('model')}>
                    {t('Configure model')}
                  </button>
                  <button data-action="project" onClick={() => onSetupNext('project')}>
                    {t('Create project')}
                  </button>
                </>
              )}
              <button data-action="done" onClick={onClose}>
                {t('Done')}
              </button>
            </div>
          </div>
        )}
        {status?.managed && (
          <>
            <div className="ia-domains-list">
              {selectable.map(item => {
                const current = installedById.get(item.domain);
                return (
                  <label
                    key={item.domain}
                    className="ia-domain-install-row"
                    data-domain={item.domain}
                  >
                    <input
                      type="checkbox"
                      checked={selected.includes(item.domain)}
                      disabled={disabled || loading}
                      onChange={() =>
                        setSelected(value =>
                          value.includes(item.domain)
                            ? value.filter(id => id !== item.domain)
                            : [...value, item.domain],
                        )
                      }
                    />
                    <DomainIcon domain={item.domain} size={18} />
                    <span>
                      <span className="ia-domain-install-title">
                        <b>{t(item.label || current?.label || item.domain)}</b>
                        <small>
                          {current ? `${current.version} → ${item.version}` : `v${item.version}`}
                        </small>
                        <InstallationSize pack={item} compact />
                      </span>
                      {item.summary && <small>{t(item.summary)}</small>}
                      {item.prerequisites?.length ? (
                        <small>
                          {t('Needs:')} {item.prerequisites.map(text => t(text)).join('; ')}
                        </small>
                      ) : null}
                    </span>
                  </label>
                );
              })}
              <UnavailableDomains status={status} selection />
            </div>
            {!loading && !selectable.length && !feedError && (
              <CatalogEmpty status={status} available={available} />
            )}
            {selected.length > 0 && (
              <div className="ia-install-selection" role="status">
                <b>{t('{0} domains selected', { '0': selected.length })}</b>
                <InstallationSize footprint={footprint} />
                {footprint?.availableBytes !== undefined && (
                  <small className={insufficient ? 'ia-project-error' : ''}>
                    {t(
                      insufficient
                        ? 'Only {0} is free. Installation will check reusable files before deciding if more space is needed.'
                        : '{0} available on disk',
                      { '0': formatBytes(footprint.availableBytes, locale) },
                    )}
                  </small>
                )}
              </div>
            )}
            {installed.length > 0 && (
              <div className="ia-domains-installed">
                <h2>{t('Installed')}</h2>
                {installed.map(item => (
                  <div key={item.domain} className="ia-domains-installed-row">
                    <span>
                      <DomainIcon domain={item.domain} /> {t(item.label)} · {item.version}
                      <RuntimeEnvironments domain={item.domain} busy={disabled} />
                    </span>
                    <div className="ia-pack-actions">
                      <button disabled={disabled} onClick={() => void remove(item.domain)}>
                        {t('Remove')}
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
            {busy && <p role="status">{t('Finish the current task before changing domains.')}</p>}
          </>
        )}
      </div>
      <footer className="ia-domains-actions">
        <button onClick={() => void refresh()} disabled={loading || installing || cancelling}>
          {t('Check updates')}
        </button>
        <button disabled={cancelling} onClick={close}>
          {t(
            installing && status?.operation?.cancellable !== false
              ? 'Cancel installation and close'
              : firstRun && !complete
                ? 'Skip for now'
                : 'Close',
          )}
        </button>
        {status?.managed && selectable.length > 0 && (
          <button
            className="ia-domains-primary"
            disabled={!selected.length || disabled || loading}
            onClick={() => void install()}
          >
            {installing ? t('Installing…') : t('Install {0}', { '0': selected.length || '' })}
          </button>
        )}
      </footer>
    </dialog>
  );
}
