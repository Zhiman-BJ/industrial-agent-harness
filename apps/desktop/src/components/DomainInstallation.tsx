import { useDisplayText } from '@industrial-agent-harness/viewer-builtin/text';
import { DomainIcon } from '@industrial-agent-harness/viewer-builtin/domain-icon';
import type {
  AvailableDomainPack,
  DomainInstallationStatus,
  DomainInstallProgress,
  InstalledDomainPack,
  InstallationFootprint,
} from '@industrial-agent-harness/viewer-builtin/api';

export function formatBytes(bytes: number, locale: string) {
  const value = Number.isFinite(bytes) ? Math.max(0, bytes) : 0;
  const scale = value >= 1024 ** 3 ? 3 : value >= 1024 ** 2 ? 2 : value >= 1024 ? 1 : 0;
  return `${new Intl.NumberFormat(locale, { maximumFractionDigits: scale ? 1 : 0 }).format(value / 1024 ** scale)} ${['B', 'KiB', 'MiB', 'GiB'][scale]}`;
}

function packOnlyFootprint(pack: AvailableDomainPack): InstallationFootprint {
  const installedBytes =
    (pack as AvailableDomainPack & { installedSize?: number }).installedSize ?? pack.size * 8;
  return {
    downloadBytes: pack.size,
    installedBytes,
    requiredBytes: pack.size + installedBytes * 2,
    availableBytes: pack.installation?.availableBytes,
    estimated: true,
    cacheReused: false,
  };
}

export function selectedFootprint(packs: AvailableDomainPack[]): InstallationFootprint | undefined {
  if (!packs.length) return undefined;
  const values = packs.map(packOnlyFootprint);
  const available = values
    .map(value => value.availableBytes)
    .filter((value): value is number => value !== undefined);
  return {
    downloadBytes: values.reduce((sum, value) => sum + value.downloadBytes, 0),
    installedBytes: values.reduce((sum, value) => sum + value.installedBytes, 0),
    requiredBytes: values.reduce((sum, value) => sum + value.requiredBytes, 0),
    availableBytes: available.length ? Math.min(...available) : undefined,
    cacheReused: values.some(value => value.cacheReused),
    estimated: values.some(value => value.estimated),
  };
}

export function InstallationSize({
  pack,
  footprint,
  compact = false,
}: {
  pack?: AvailableDomainPack;
  footprint?: InstallationFootprint;
  compact?: boolean;
}) {
  const { t, locale } = useDisplayText();
  const value = footprint || (pack ? packOnlyFootprint(pack) : undefined);
  const download = value?.downloadBytes ?? (pack ? pack.size : undefined);
  if (download === undefined) return null;
  return (
    <small className="ia-pack-meta ia-install-size">
      <span>{t('{0} download', { '0': formatBytes(download, locale) })}</span>
      {!compact && value && (
        <span>
          {t(value.estimated ? 'About {0} installed' : '{0} installed', {
            '0': formatBytes(value.installedBytes, locale),
          })}
        </span>
      )}
      {!compact && value && (
        <span>{t('{0} free space needed', { '0': formatBytes(value.requiredBytes, locale) })}</span>
      )}
      {!compact && value?.cacheReused && <span>{t('Reusing downloaded files')}</span>}
    </small>
  );
}

export function CatalogNotice({
  status,
  loading,
}: {
  status?: DomainInstallationStatus;
  loading: boolean;
}) {
  const { t } = useDisplayText();
  if (!status?.managed) return null;
  const state = status.catalog?.state ?? (status.catalogWarning ? 'unavailable' : 'not-checked');
  const message = {
    unconfigured: status.catalog?.bundledDomains
      ? 'Online catalog is not configured. Bundled domains can be installed.'
      : 'Online catalog is not configured. No domains are bundled for this computer.',
    'not-checked': 'The online catalog has not been checked yet.',
    connected: 'Online catalog connected. Choose domains available for this computer.',
    unavailable: status.catalog?.bundledDomains
      ? 'The online catalog is unavailable. Bundled domains can still be installed.'
      : 'Online catalog is unavailable. Check your connection and try again.',
  }[state];
  return (
    <p className="ia-capability-note ia-catalog-status" role="status" data-catalog-state={state}>
      {loading ? t('Checking available domains…') : t(message)}
    </p>
  );
}

export function CatalogEmpty({
  status,
  available,
}: {
  status?: DomainInstallationStatus;
  available: AvailableDomainPack[];
}) {
  const { t } = useDisplayText();
  const connected = status?.catalog?.state === 'connected';
  return (
    <p className="ia-capability-note">
      {t(
        !available.length
          ? 'No compatible domains are available from the current sources.'
          : connected
            ? 'All compatible domains in the connected catalog are installed and up to date.'
            : 'All currently installable domains are installed. Online availability has not been confirmed.',
      )}
    </p>
  );
}

export function RuntimeReadiness({ item }: { item: InstalledDomainPack }) {
  const { t } = useDisplayText();
  const state = item.runtimeState || 'installed';
  const label = {
    ready: 'Ready to use',
    'needs-preparation': 'Needs preparation',
    'external-dependencies': 'External tools need setup',
    installed: 'Pack installed',
  }[state];
  return (
    <>
      <small
        className={`ia-pack-badge ${state === 'ready' ? 'ok' : state === 'installed' ? '' : 'warn'}`}
      >
        {t(label)}
      </small>
      {item.prerequisites?.length ? (
        <small className="ia-pack-meta">
          {t('Needs:')} {item.prerequisites.map(text => t(text)).join('; ')}
        </small>
      ) : null}
    </>
  );
}

export function UnavailableDomains({
  status,
  selection = false,
}: {
  status?: DomainInstallationStatus;
  selection?: boolean;
}) {
  const { t } = useDisplayText();
  const reasons = {
    'not-distributed': 'Not installable in this release',
    'platform-unsupported': 'Unavailable on this platform',
    'catalog-unavailable': 'Not offered by the current catalog',
  };
  return (status?.catalog?.unavailableDomains || []).map(item => (
    <div
      key={item.domain}
      className={selection ? 'ia-domain-install-row' : 'ia-pack-card'}
      data-domain={item.domain}
      data-unavailable="true"
    >
      {selection && <input type="checkbox" disabled aria-label={t(item.label)} />}
      <DomainIcon domain={item.domain} size={18} />
      <span className={selection ? undefined : 'ia-pack-body'}>
        <span className={selection ? 'ia-domain-install-title' : 'ia-pack-title'}>
          <b>{t(item.label)}</b>
          <small>{t(reasons[item.reason])}</small>
        </span>
        {item.summary && <small className="ia-pack-meta">{t(item.summary)}</small>}
        {item.prerequisites?.length ? (
          <small className="ia-pack-meta">
            {t('Needs:')} {item.prerequisites.map(text => t(text)).join('; ')}
          </small>
        ) : null}
      </span>
    </div>
  ));
}

export function InstallationOutcome({
  status,
  error,
}: {
  status?: DomainInstallationStatus;
  error?: string;
}) {
  const { t } = useDisplayText();
  if (status?.operation?.active) return null;
  const last = status?.lastOperation;
  const failed = last?.outcome === 'failed';
  const detail = error || (failed || last?.outcome === 'interrupted' ? last?.error : undefined);
  const cleanDetail = detail?.replace(
    /^Error: (?:Error invoking remote method '[^']+': Error: )?/,
    '',
  );
  const message =
    last &&
    {
      completed:
        last.operation === 'remove'
          ? 'Domain removed. Existing project files and history are kept.'
          : 'Installation finished. Review each domain’s readiness below.',
      cancelled: 'Installation cancelled. You can retry; completed domains are kept.',
      failed: 'Installation could not finish. Review the error and try again.',
      interrupted: 'The previous installation was interrupted. Check or retry the affected domain.',
    }[last.outcome];
  if (!message && !error) return null;
  return (
    <div
      className={`ia-install-outcome ${failed || error ? 'ia-project-error' : ''}`}
      role={failed || error ? 'alert' : 'status'}
    >
      {message && <p>{t(message)}</p>}
      {cleanDetail && <p className="ia-install-error-detail">{t(cleanDetail)}</p>}
      {last?.statusWarning && <p className="ia-install-error-detail">{t(last.statusWarning)}</p>}
    </div>
  );
}

const phaseLabels: Record<string, string> = {
  'checking-space': 'Checking available space…',
  downloading: 'Downloading files…',
  verifying: 'Verifying downloaded files…',
  mounting: 'Opening the installer…',
  extracting: 'Extracting files…',
  copying: 'Copying application files…',
  installing: 'Preparing files…',
  checking: 'Checking executable readiness…',
  activating: 'Activating the domain…',
  ready: 'Preparation finished',
};

export function InstallationProgress({
  progress,
  cancelling,
  onCancel,
  background = false,
  operation,
}: {
  progress: DomainInstallProgress | null;
  cancelling: boolean;
  onCancel: () => void;
  background?: boolean;
  operation?: DomainInstallationStatus['operation'];
}) {
  const { t, locale } = useDisplayText();
  const downloading = progress?.phase === 'downloading';
  const determinate = downloading && typeof progress.total === 'number' && progress.total > 0;
  const rate = progress?.bytesPerSecond;
  const eta = progress?.etaSeconds;
  return (
    <div
      className="ia-domain-progress"
      role="status"
      aria-live="polite"
      aria-busy="true"
      data-phase={cancelling ? 'cancelling' : progress?.phase || 'starting'}
    >
      <div className="ia-domain-progress-heading">
        <span>
          {progress?.label && <b>{progress.label} · </b>}
          {t(
            cancelling
              ? 'Cancelling and cleaning up…'
              : phaseLabels[progress?.phase || ''] || 'Starting installation…',
          )}
        </span>
        {operation?.cancellable !== false && (
          <button type="button" disabled={cancelling} onClick={onCancel}>
            {t(cancelling ? 'Cancelling…' : 'Cancel installation')}
          </button>
        )}
      </div>
      <progress
        aria-label={t('Installation progress')}
        max={determinate ? progress.total : undefined}
        value={determinate ? Math.min(progress.received || 0, progress.total!) : undefined}
      />
      {downloading && (
        <small className="ia-install-transfer">
          <span>
            {progress.received !== undefined
              ? formatBytes(progress.received, locale)
              : t('Waiting for download…')}
            {determinate && ` / ${formatBytes(progress.total!, locale)}`}
          </span>
          {rate !== undefined && rate > 0 && (
            <span>{t('{0}/s', { '0': formatBytes(rate, locale) })}</span>
          )}
          {eta !== undefined && Number.isFinite(eta) && eta >= 0 && (
            <span>
              {eta < 60
                ? t('About {0} sec remaining', { '0': Math.max(1, Math.ceil(eta)) })
                : t('About {0} min remaining', { '0': Math.ceil(eta / 60) })}
            </span>
          )}
        </small>
      )}
      {operation?.source === 'external' && (
        <small>
          {t(
            'Another process is preparing domains. This page updates automatically; you can close it. Cancel from the process that started installation.',
          )}
        </small>
      )}
      {!downloading && !cancelling && operation?.source !== 'external' && (
        <small>{t('Preparation may take several minutes. Keep the app open.')}</small>
      )}
      {background && operation?.source !== 'external' && (
        <small>{t('You can leave this page. Installation continues while the app is open.')}</small>
      )}
      {progress?.phase === 'checking-space' && progress.availableBytes !== undefined && (
        <small>
          {t('{0} available on disk', { '0': formatBytes(progress.availableBytes, locale) })}
        </small>
      )}
    </div>
  );
}

// IPC settles after this operation's cleanup. Do not wait on a later operation
// another process may start once the shared store becomes idle.
export async function cancelInstallation() {
  const result = await window.viewerHost!.domainCancel();
  if (!result.cancelled && (await window.viewerHost!.domainStatus()).operation?.active)
    throw Error(
      'This installation cannot be cancelled here. Cancel from the process that started it.',
    );
}
