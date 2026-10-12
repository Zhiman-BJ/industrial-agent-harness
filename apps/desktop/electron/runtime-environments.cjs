const path = require('node:path');
const { RuntimeEnvironmentManager } = require('@industrial-agent-harness/pack-manager');

// Desktop translates trusted application context only; all probes and preparation
// remain in the shared environment manager used by the headless adapter.
function registerRuntimeEnvironments({
  ipcMain,
  manager,
  connectionStore,
  resourceProject,
  sessions,
  projectRuntimes,
  dialog,
  shell,
  domainBusy = () => false,
}) {
  const environments = new RuntimeEnvironmentManager({ manager, connectionStore });
  let controller;
  let done;
  let owner;
  const identifier = value => typeof value === 'string' && /^[a-z][a-z0-9._-]{0,127}$/.test(value);
  function context(event, request) {
    if (!request || !identifier(request.domain)) throw Error('Invalid environment request.');
    const project = resourceProject(event, request);
    if (project && project.domain !== request.domain)
      throw Error('Environment belongs to another project domain.');
    const bundle = manager.list().find(item => item.domain === request.domain);
    if (!bundle) throw Error('Domain Pack is not installed.');
    const profile =
      request.profileId === undefined
        ? undefined
        : bundle.executionProfiles?.find(item => item.id === request.profileId);
    if (request.profileId !== undefined && !profile) throw Error('Unknown execution profile.');
    if (
      request.paths !== undefined &&
      (!request.paths ||
        Array.isArray(request.paths) ||
        typeof request.paths !== 'object' ||
        Object.entries(request.paths).some(
          ([key, value]) =>
            !profile?.assetIds.includes(key) ||
            typeof value !== 'string' ||
            value.length > 4096 ||
            !path.isAbsolute(value),
        ))
    )
      throw Error('Invalid application paths.');
    return {
      project,
      bundle,
      profile,
      options: {
        profileId: request.profileId,
        paths: request.paths,
        ...(project ? { projectDir: project.path } : {}),
      },
    };
  }
  ipcMain.handle('environment:describe', (event, request) => {
    const { options } = context(event, request);
    return environments.describe(request.domain, options);
  });
  ipcMain.handle('environment:connection-view', (event, request) => {
    const { profile, options } = context(event, request);
    if (profile?.connection?.kind !== 'runtime-managed') throw Error('Unknown service connection.');
    return environments.connectionView(request.domain, options);
  });
  ipcMain.handle('environment:connection-reset', async (event, request) => {
    const { profile, options } = context(event, request);
    if (profile?.connection?.kind !== 'runtime-managed') throw Error('Unknown service connection.');
    if (controller || domainBusy()) throw Error('An environment operation is already in progress.');
    sessions.assertIdle();
    const result = await environments.resetConnection(request.domain, options);
    await sessions.reset();
    await projectRuntimes.close();
    return result;
  });
  ipcMain.handle('environment:connection-save', async (event, request) => {
    const { profile, options } = context(event, request);
    if (profile?.connection?.kind !== 'runtime-managed') throw Error('Unknown service connection.');
    if (controller || domainBusy()) throw Error('An environment operation is already in progress.');
    const fields = new Set(profile.connection.environment.map(field => field.name));
    if (
      !request.values ||
      typeof request.values !== 'object' ||
      Array.isArray(request.values) ||
      Object.entries(request.values).some(
        ([name, value]) =>
          !fields.has(name) ||
          (value !== null && (typeof value !== 'string' || value.length > 16384)),
      )
    )
      throw Error('Invalid service connection fields.');
    sessions.assertIdle();
    const result = await environments.configureConnection(request.domain, {
      ...options,
      values: request.values,
    });
    await sessions.reset();
    await projectRuntimes.close();
    return result;
  });
  ipcMain.handle('environment:cancel', async (event, request) => {
    context(event, request);
    if (owner && (owner.domain !== request.domain || owner.projectId !== request.projectId))
      throw Error('Cancel the environment operation from its owning context.');
    controller?.abort(Error('Environment operation cancelled.'));
    await done;
    return { cancelled: true };
  });
  ipcMain.handle('environment:choose-app', async (event, request) => {
    const { bundle, profile } = context(event, request);
    if (
      profile?.kind !== 'native' ||
      !profile.assetIds.includes(request.assetId) ||
      !bundle.runtimeAssets.some(item => item.id === request.assetId)
    )
      throw Error('Unknown application dependency.');
    const asset = bundle.runtimeAssets.find(item => item.id === request.assetId);
    const options =
      asset.type === 'native-executable'
        ? { properties: ['openFile'] }
        : asset.type === 'native-runtime-zip'
          ? { properties: ['openDirectory'] }
          : {
              properties: ['openDirectory', 'openFile'],
              filters: [{ name: 'Application', extensions: ['app'] }],
            };
    const result = await dialog.showOpenDialog(options);
    return result.canceled ? null : result.filePaths[0] || null;
  });
  ipcMain.handle('environment:official', async (event, request) => {
    const { bundle, profile } = context(event, request);
    const asset = bundle.runtimeAssets?.find(
      item => item.id === request.assetId && profile?.assetIds.includes(item.id),
    );
    if (!asset?.installUrl || new URL(asset.installUrl).protocol !== 'https:')
      throw Error('Official installation link is unavailable.');
    await shell.openExternal(asset.installUrl);
  });
  for (const operation of ['detect', 'associate', 'prepare', 'clear'])
    ipcMain.handle(`environment:${operation}`, async (event, request) => {
      const { project, profile, options } = context(event, request);
      if (operation === 'prepare' && profile?.kind !== 'container')
        throw Error(
          'Install missing software from its official source, then detect and save its location.',
        );
      if (domainBusy()) throw Error('Domain preparation is already in progress.');
      if (controller) throw Error('An environment operation is already in progress.');
      if (operation !== 'clear' && !options.profileId) throw Error('Choose an execution profile.');
      if (operation !== 'detect') sessions.assertIdle(project?.id);
      controller = new AbortController();
      owner = { domain: request.domain, projectId: request.projectId };
      let finish;
      done = new Promise(resolve => {
        finish = resolve;
      });
      try {
        if (operation !== 'detect') {
          await sessions.reset(project?.id);
          if (project) await projectRuntimes.reset(project);
          else await projectRuntimes.close();
        }
        const result = await environments[operation](request.domain, {
          ...options,
          signal: controller.signal,
          onProgress: progress => {
            if (!event.sender.isDestroyed())
              event.sender.send('environment:progress', {
                domain: request.domain,
                projectId: request.projectId,
                ...progress,
              });
          },
        });
        return result;
      } finally {
        controller = undefined;
        owner = undefined;
        finish();
        done = undefined;
      }
    });
  return {
    environments,
    get active() {
      return Boolean(controller);
    },
    async close() {
      controller?.abort(Error('Application is shutting down.'));
      await done;
    },
  };
}
module.exports = { registerRuntimeEnvironments };
