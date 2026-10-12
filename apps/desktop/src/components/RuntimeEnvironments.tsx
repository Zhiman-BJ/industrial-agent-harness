import { useEffect, useRef, useState } from 'react';
import { useDisplayText } from '@industrial-agent-harness/viewer-builtin/text';

type Reason = { code: string; message: string };
type Asset = {
  id: string;
  label?: string;
  status: string;
  reasons?: Reason[];
  appPath?: string;
  source?: string;
  installUrl?: string;
  discoveryPaths?: string[];
  candidates?: { appPath: string; status: string }[];
};
type ConnectionField = {
  name: string;
  type: 'endpoint' | 'secret' | 'sha256';
  configured?: boolean;
  value?: string;
};
type Profile = {
  connection?: { kind: string; verification: string; environment: ConnectionField[] };
  connectionFields?: ConnectionField[];
  configured?: boolean;
  executable?: boolean;
  id: string;
  label: string;
  description?: string;
  kind: 'native' | 'container' | 'remote';
  qualified: boolean;
  status: string;
  selected?: boolean;
  toolIds: string[];
  assets: Asset[];
  reasons: Reason[];
  checkedAt?: string;
};
export type EnvironmentView = {
  domain: string;
  profiles: Profile[];
  binding?: { profileId: string } | null;
  readyToolIds: string[];
  status: string;
  executable?: boolean;
  executableToolIds?: string[];
  lastCheck?: Detection;
  legacy?: boolean;
};
type Request = {
  domain: string;
  projectId?: string;
  profileId?: string;
  paths?: Record<string, string>;
  assetId?: string;
};
type Detection = {
  configured?: boolean;
  executable?: boolean;
  connectionFields?: ConnectionField[];
  profileId: string;
  status: string;
  reasons: Reason[];
  assets: Asset[];
  checkedAt?: string;
};
type Progress = {
  domain: string;
  projectId?: string;
  phase?: string;
  downloaded?: number;
  total?: number;
  status?: string;
};
export interface EnvironmentHost {
  onEnvironmentProgress(callback: (progress: Progress) => void): () => void;
  environmentConnectionReset(request: Request): Promise<Detection & { canPersist: boolean }>;
  environmentConnectionView(request: Request): Promise<Detection & { canPersist: boolean }>;
  environmentConnectionSave(
    request: Request & { values: Record<string, string | null> },
  ): Promise<Detection & { canPersist: boolean }>;
  environmentDescribe(request: Request): Promise<EnvironmentView>;
  environmentDetect(request: Request): Promise<Detection>;
  environmentAssociate(request: Request): Promise<EnvironmentView | Detection>;
  environmentPrepare(request: Request): Promise<EnvironmentView>;
  environmentClear(request: Request): Promise<EnvironmentView>;
  environmentCancel(request: Request): Promise<unknown>;
  environmentChooseApp(request: Request): Promise<string | null>;
  environmentOfficial(request: Request): Promise<void>;
}
const progressLabels: Record<string, string> = {
  downloading: 'Downloading…',
  verifying: 'Verifying download…',
  extracting: 'Extracting files…',
  checking: 'Checking installation…',
  installing: 'Preparing files…',
  ready: 'Preparation finished',
};
const host = () => window.viewerHost as unknown as EnvironmentHost;
const statusLabels: Record<string, string> = {
  ready: 'Ready',
  missing: 'Needs preparation',
  unchecked: 'Not checked',
  unsupported: 'Not supported',
  stale: 'Check again',
  failed: 'Check failed',
  invalid: 'Incompatible',
  incompatible: 'Incompatible',
  ambiguous: 'Choose an application',
  cancelled: 'Cancelled',
};

function statusTone(status: string) {
  if (status === 'ready') return 'ok';
  if (['failed', 'invalid', 'incompatible'].includes(status)) return 'error';
  if (['missing', 'stale', 'ambiguous'].includes(status)) return 'warn';
  return 'neutral';
}

export function RuntimeEnvironments({
  domain,
  projectId,
  busy = false,
  revision = 0,
  onChanged,
}: {
  domain: string;
  projectId?: string;
  busy?: boolean;
  revision?: number;
  onChanged?: () => void;
}) {
  const { t } = useDisplayText();
  const [view, setView] = useState<EnvironmentView>();
  const [selected, setSelected] = useState('');
  const [paths, setPaths] = useState<Record<string, string>>({});
  const [detected, setDetected] = useState<Detection>();
  const [pending, setPending] = useState('');
  const [progress, setProgress] = useState<Progress>();
  const [connection, setConnection] = useState<Detection & { canPersist: boolean }>();
  const [connectionValues, setConnectionValues] = useState<Record<string, string | null>>({});
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const generation = useRef(0);
  const context = { domain, ...(projectId ? { projectId } : {}) };
  useEffect(() => {
    const current = ++generation.current;
    setView(undefined);
    setPending('');
    setProgress(undefined);
    setSelected('');
    setConnection(undefined);
    setConnectionValues({});
    setError('');
    setNotice('');
    setPaths({});
    setDetected(undefined);
    void host()
      .environmentDescribe(context)
      .then(next => {
        if (generation.current !== current) return;
        setView(next);
        setSelected(
          next.binding?.profileId ||
            next.profiles.find(item => item.kind !== 'remote')?.id ||
            next.profiles[0]?.id ||
            '',
        );
      })
      .catch(reason => {
        if (generation.current === current) setError(String(reason));
      });
    return () => {
      generation.current++;
    };
  }, [domain, projectId, revision]);
  useEffect(
    () =>
      host().onEnvironmentProgress(value => {
        if (value.domain === domain && value.projectId === projectId) setProgress(value);
      }),
    [domain, projectId],
  );
  const profile = view?.profiles.find(item => item.id === selected);
  // A binding records a choice; a newer check is the current readiness evidence.
  const latestCheck = detected || view?.lastCheck;
  const activeCheck = latestCheck?.profileId === selected ? latestCheck : undefined;
  const currentStatus = activeCheck?.status || profile?.status || 'unchecked';
  const currentAssets =
    profile?.assets.map(asset => {
      if (!activeCheck) return asset;
      const check = activeCheck.assets.find(item => item.id === asset.id);
      return {
        ...asset,
        status: 'unchecked',
        reasons: [],
        candidates: [],
        appPath: undefined,
        source: undefined,
        ...check,
      };
    }) || [];
  const missingAssets = currentAssets.filter(asset => asset.status !== 'ready');
  const remote = profile?.kind === 'remote';
  const managedRemote = remote && profile.connection?.kind === 'runtime-managed';
  useEffect(() => {
    let active = true;
    const current = generation.current;
    setConnection(undefined);
    setConnectionValues({});
    if (managedRemote)
      void host()
        .environmentConnectionView({ ...context, profileId: selected })
        .then(value => {
          if (active && current === generation.current) setConnection(value);
        })
        .catch(reason => {
          if (active && current === generation.current) setError(String(reason));
        });
    return () => {
      active = false;
    };
  }, [domain, projectId, revision, selected, managedRemote]);
  const connectionConfigured =
    connection?.configured ?? activeCheck?.configured ?? profile?.configured;
  const connectionFields =
    connection?.connectionFields ||
    activeCheck?.connectionFields ||
    profile?.connectionFields ||
    profile?.connection?.environment ||
    [];
  const unsupported = !profile?.qualified || profile?.status === 'unsupported';
  const locked = busy || Boolean(pending);
  async function perform(operation: 'detect' | 'associate' | 'prepare' | 'clear') {
    if (locked) return;
    const current = generation.current;
    setPending(operation);
    setProgress(undefined);
    setError('');
    setNotice('');
    try {
      const request = { ...context, profileId: selected, paths };
      if (operation === 'detect') {
        const result = await host().environmentDetect(request);
        if (current === generation.current) {
          setDetected(result);
          if (managedRemote) {
            const nextConnection = await host().environmentConnectionView(request);
            if (current !== generation.current) return;
            setConnection(nextConnection);
          }
          setNotice('Detection does not select an environment. Save to use it.');
        }
      } else {
        const next = await (operation === 'associate'
          ? host().environmentAssociate(request)
          : operation === 'prepare'
            ? host().environmentPrepare(request)
            : host().environmentClear(context));
        if (current === generation.current && !('profiles' in next)) {
          setDetected(next);
          return;
        }
        if (
          current === generation.current &&
          'profiles' in next &&
          next.lastCheck?.status !== undefined &&
          next.lastCheck.status !== 'ready' &&
          !next.lastCheck.executable
        ) {
          setView(next);
          setDetected(next.lastCheck);
          return;
        }
        if (current === generation.current && 'profiles' in next) {
          setView(next);
          setDetected(undefined);
          setNotice(
            operation === 'clear'
              ? 'Using the default environment.'
              : 'Execution environment saved.',
          );
          onChanged?.();
        }
      }
    } catch (reason) {
      if (current === generation.current && !String(reason).includes('cancelled')) {
        setError(String(reason));
        if (operation !== 'clear') {
          setDetected({
            profileId: selected,
            status: 'failed',
            reasons: [],
            assets: [],
            checkedAt: new Date().toISOString(),
          });
        }
      }
    } finally {
      if (current === generation.current) setPending('');
    }
  }
  async function saveConnection(reset = false) {
    if (locked || (!reset && !connection?.canPersist)) return;
    const current = generation.current;
    setPending('connection');
    setError('');
    try {
      const next = reset
        ? await host().environmentConnectionReset({ ...context, profileId: selected })
        : await host().environmentConnectionSave({
            ...context,
            profileId: selected,
            values: connectionValues,
          });
      if (current !== generation.current) return;
      setConnection(next);
      setConnectionValues({});
      setDetected(next);
      const nextView = await host().environmentDescribe(context);
      if (current !== generation.current) return;
      setView(nextView);
      setNotice(
        reset
          ? 'Saved connection cleared. Enter the service settings again.'
          : 'Connection settings saved securely. Check and save the execution environment next.',
      );
    } catch (reason) {
      if (current === generation.current) setError(String(reason));
    } finally {
      if (current === generation.current) setPending('');
    }
  }
  async function choose(assetId: string) {
    if (locked) return;
    setPending('choosing');
    const current = generation.current;
    setError('');
    try {
      const value = await host().environmentChooseApp({ ...context, profileId: selected, assetId });
      if (value && current === generation.current) {
        setPaths(old => ({ ...old, [assetId]: value }));
        setDetected(undefined);
      }
    } catch (reason) {
      if (current === generation.current) setError(String(reason));
    } finally {
      if (current === generation.current) setPending('');
    }
  }
  async function official(assetId: string) {
    const current = generation.current;
    try {
      await host().environmentOfficial({ ...context, profileId: selected, assetId });
    } catch (reason) {
      if (current === generation.current) setError(String(reason));
    }
  }
  async function cancel() {
    const current = generation.current;
    setPending('cancelling');
    try {
      await host().environmentCancel(context);
      if (current === generation.current) setNotice('Cancelled');
    } catch (reason) {
      if (current === generation.current) setError(String(reason));
    } finally {
      if (current === generation.current) setPending('');
    }
  }
  return (
    <section
      className="ia-runtime-environments"
      data-domain={domain}
      aria-label={t('Execution environments')}
    >
      <h3>{t(projectId ? 'Project execution environment' : 'Execution environments')}</h3>
      {!view && !error && <p role="status">{t('Loading…')}</p>}
      {view?.legacy && <p>{t('This pack has no selectable execution profiles.')}</p>}
      {Boolean(view?.profiles.length) && (
        <>
          <label>
            {t('Execution profile')}{' '}
            <select
              aria-label={t('Execution profile')}
              value={selected}
              disabled={locked}
              onChange={event => {
                setSelected(event.target.value);
                setPaths({});
                setDetected(undefined);
                setError('');
                setNotice('');
              }}
            >
              {view!.profiles.map(item => (
                <option key={item.id} value={item.id}>
                  {t(item.label)} ·{' '}
                  {t(
                    item.kind === 'native'
                      ? 'Native on this computer'
                      : item.kind === 'container'
                        ? 'Container on this computer'
                        : 'Remote',
                  )}{' '}
                  ·{' '}
                  {t(
                    statusLabels[
                      latestCheck?.profileId === item.id ? latestCheck.status : item.status
                    ] || item.status,
                  )}
                  {item.selected ? ` · ${t('Selected')}` : ''}
                </option>
              ))}
            </select>
          </label>
          {profile && (
            <div className="ia-runtime-profile" data-profile={profile.id}>
              <p
                role="status"
                className={`ia-runtime-status ${statusTone(currentStatus)}`}
                data-environment-status={currentStatus}
              >
                {t(
                  managedRemote &&
                    connectionConfigured &&
                    !activeCheck?.reasons.length &&
                    currentStatus !== 'failed'
                    ? 'Configured; verified when executing'
                    : statusLabels[currentStatus] || currentStatus,
                )}
              </p>
              {!remote && missingAssets.length > 0 && (
                <p className={`ia-runtime-status ${statusTone(currentStatus)}`}>
                  {t('Needs attention: {0}', {
                    '0': missingAssets.map(asset => t(asset.label || asset.id)).join(', '),
                  })}
                </p>
              )}
              {view?.binding?.profileId === profile.id &&
                activeCheck &&
                activeCheck.status !== 'ready' &&
                !activeCheck.executable && (
                  <p className="ia-capability-note">
                    {t('Saved choice retained. Latest check is not ready.')}
                  </p>
                )}
              {(!remote || managedRemote) &&
                (activeCheck?.reasons || connection?.reasons || profile.reasons)
                  .filter(
                    reason =>
                      remote ||
                      !currentAssets.some(asset =>
                        asset.reasons?.some(
                          item => item.code === reason.code && item.message === reason.message,
                        ),
                      ),
                  )
                  .map(reason => (
                    <p key={`${reason.code}:${reason.message}`} className="ia-capability-note">
                      {t(reason.message)}
                    </p>
                  ))}
              {remote ? (
                <>
                  {managedRemote ? (
                    <>
                      <p role="status">
                        {t(
                          connectionConfigured
                            ? 'Connection configured. Service and project verification runs with the task.'
                            : 'Configure the declared service settings, then check and save this environment.',
                        )}
                      </p>
                      <div className="ia-runtime-connections">
                        {connectionFields.map(field => (
                          <div
                            className="ia-runtime-asset"
                            key={field.name}
                            data-connection-field={field.name}
                          >
                            <code>{field.name}</code>
                            <span>
                              {t(
                                field.type === 'secret'
                                  ? 'Credential'
                                  : field.type === 'endpoint'
                                    ? 'Service endpoint'
                                    : 'Expected service identity',
                              )}
                            </span>
                            <span>
                              {t(
                                field.configured === undefined
                                  ? 'Not checked'
                                  : field.configured
                                    ? 'Configured'
                                    : 'Not configured',
                              )}
                            </span>
                            <label>
                              <input
                                aria-label={field.name}
                                type={field.type === 'secret' ? 'password' : 'text'}
                                autoComplete="off"
                                spellCheck={false}
                                disabled={locked || !connection?.canPersist}
                                value={
                                  field.name in connectionValues
                                    ? connectionValues[field.name] || ''
                                    : field.type === 'secret'
                                      ? ''
                                      : field.value || ''
                                }
                                placeholder={
                                  field.type === 'secret' && field.configured
                                    ? t('Leave empty to keep the saved credential')
                                    : ''
                                }
                                onChange={event =>
                                  setConnectionValues(old => ({
                                    ...old,
                                    [field.name]: event.target.value,
                                  }))
                                }
                              />
                            </label>
                            {field.type === 'secret' && field.configured && (
                              <button
                                disabled={locked || !connection?.canPersist}
                                onClick={() =>
                                  setConnectionValues(old => ({ ...old, [field.name]: null }))
                                }
                              >
                                {t('Remove saved credential')}
                              </button>
                            )}
                          </div>
                        ))}
                      </div>
                      <p className="ia-capability-note">
                        {t(
                          'Credentials stay on the trusted host. This connection is independent of the project remote coordinator.',
                        )}
                      </p>
                      {connection && !connection.canPersist && (
                        <p role="status">
                          {t(
                            'System secure storage is unavailable. Configure the trusted host environment to use this connection.',
                          )}
                        </p>
                      )}
                      {connection?.reasons.some(
                        reason => reason.code === 'CONNECTION_STORAGE_UNAVAILABLE',
                      ) && (
                        <p role="alert">
                          {t(
                            'Saved connection cannot be read. Clear the saved connection to configure it again; this removes its stored credentials.',
                          )}{' '}
                          <button disabled={locked} onClick={() => void saveConnection(true)}>
                            {t('Clear damaged saved connection')}
                          </button>
                        </p>
                      )}
                      <div className="ia-runtime-actions">
                        <button
                          disabled={locked || unsupported || !connection?.canPersist}
                          onClick={() => void saveConnection()}
                        >
                          {t('Save connection securely')}
                        </button>
                        <button
                          disabled={locked || unsupported}
                          onClick={() => void perform('detect')}
                        >
                          {t('Detect connection configuration')}
                        </button>
                        <button
                          disabled={locked || unsupported}
                          onClick={() => void perform('associate')}
                        >
                          {t('Check and save environment')}
                        </button>
                        {projectId && view?.binding && (
                          <button disabled={locked} onClick={() => void perform('clear')}>
                            {t('Use default environment')}
                          </button>
                        )}
                      </div>
                      <p>
                        {t(
                          'Remote services are deployed by their administrator. Connecting does not upload project files.',
                        )}
                      </p>
                      <ul className="ia-runtime-tools">
                        {profile.toolIds.map(tool => (
                          <li key={tool}>
                            <code>{tool}</code>
                          </li>
                        ))}
                      </ul>
                    </>
                  ) : (
                    <p>
                      {t(
                        'This remote profile needs a compatible service connection. Its configuration entry is not available yet, so it cannot be selected for execution.',
                      )}
                    </p>
                  )}
                </>
              ) : (
                <>
                  {profile.assets.map(asset => {
                    const check = currentAssets.find(item => item.id === asset.id) || asset;
                    return (
                      <div
                        className="ia-runtime-asset"
                        key={asset.id}
                        data-asset={asset.id}
                        data-dependency-status={check.status}
                      >
                        <b>{t(asset.label || asset.id)}</b>
                        <span className={`ia-runtime-status ${statusTone(check.status)}`}>
                          {t(statusLabels[check.status] || check.status)}
                        </span>
                        {(paths[asset.id] || check.appPath) && (
                          <code>{paths[asset.id] || check.appPath}</code>
                        )}
                        {asset.discoveryPaths?.length ? (
                          <small>
                            {t('Known application locations:')} {asset.discoveryPaths.join(', ')}
                          </small>
                        ) : null}
                        {check.reasons?.map(reason => (
                          <small key={`${reason.code}:${reason.message}`}>
                            {t(reason.message)}
                          </small>
                        ))}
                        {check.candidates && check.candidates.length > 1 && (
                          <label>
                            {t('Choose an application')}
                            <select
                              aria-label={t('Choose an application')}
                              value={paths[asset.id] || ''}
                              disabled={locked}
                              onChange={event => {
                                setPaths(old => ({ ...old, [asset.id]: event.target.value }));
                                setDetected(undefined);
                              }}
                            >
                              <option value="">{t('Choose an application')}</option>
                              {check.candidates.map(candidate => (
                                <option key={candidate.appPath} value={candidate.appPath}>
                                  {candidate.appPath} ·{' '}
                                  {t(statusLabels[candidate.status] || candidate.status)}
                                </option>
                              ))}
                            </select>
                          </label>
                        )}
                        {profile.kind === 'native' && (
                          <div className="ia-runtime-actions">
                            <button
                              disabled={locked || unsupported}
                              onClick={() => void choose(asset.id)}
                            >
                              {t('Choose installed application')}
                            </button>
                            {asset.installUrl && (
                              <button disabled={locked} onClick={() => void official(asset.id)}>
                                {t('Official installation page')}
                              </button>
                            )}
                          </div>
                        )}
                      </div>
                    );
                  })}
                  <details className="ia-domain-requirements">
                    <summary>{t('Environment details')}</summary>
                    {profile.description && <p>{t(profile.description)}</p>}
                    <p className="ia-capability-note">
                      {t(
                        'Only the listed capabilities are enabled when this environment is ready.',
                      )}
                    </p>
                    <ul className="ia-runtime-tools">
                      {profile.toolIds.map(tool => (
                        <li key={tool}>
                          <code>{tool}</code>
                        </li>
                      ))}
                    </ul>
                    {!profile.toolIds.length && (
                      <p>{t('No supported execution capabilities in this profile.')}</p>
                    )}
                  </details>
                  <div className="ia-runtime-actions">
                    <button disabled={locked || unsupported} onClick={() => void perform('detect')}>
                      {t('Detect environment')}
                    </button>
                    <button
                      disabled={locked || unsupported}
                      onClick={() => void perform('associate')}
                    >
                      {t('Check and save environment')}
                    </button>
                    <button
                      disabled={locked || unsupported}
                      onClick={() => void perform('prepare')}
                    >
                      {t('Prepare managed environment')}
                    </button>
                    {projectId && view?.binding && (
                      <button disabled={locked} onClick={() => void perform('clear')}>
                        {t('Use default environment')}
                      </button>
                    )}
                  </div>
                </>
              )}
              {(activeCheck?.checkedAt || profile.checkedAt) && (
                <small>
                  {t('Last checked:')}{' '}
                  {new Date((activeCheck?.checkedAt || profile.checkedAt)!).toLocaleString()}
                </small>
              )}
            </div>
          )}
        </>
      )}
      {pending && (
        <div role="status">
          {t(
            pending === 'connection'
              ? 'Saving connection…'
              : pending === 'choosing'
                ? 'Choosing application…'
                : pending === 'cancelling'
                  ? 'Cancelling…'
                  : pending === 'detect'
                    ? 'Detecting environment…'
                    : 'Preparing environment…',
          )}{' '}
          {pending !== 'connection' && pending !== 'choosing' && (
            <button disabled={pending === 'cancelling'} onClick={() => void cancel()}>
              {t('Cancel')}
            </button>
          )}
        </div>
      )}
      {pending && progress?.phase && (
        <p role="status">
          {t(progressLabels[progress.phase] || 'Preparing environment…')}
          {progress.total
            ? ` · ${Math.round((100 * (progress.downloaded || 0)) / progress.total)}%`
            : ''}
        </p>
      )}
      {notice && <p role="status">{t(notice)}</p>}
      {error && (
        <p className="ia-project-error" role="alert">
          {t(error)}
        </p>
      )}
    </section>
  );
}
