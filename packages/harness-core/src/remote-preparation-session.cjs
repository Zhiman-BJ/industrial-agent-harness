const { boundedIdentity } = require('@industrial-agent-harness/domain-runtime');

// Protected discovery can allocate a sandbox before there is an invocation to
// journal. Release that idle sandbox independently of the cancelled task signal.
async function releasePreparedSession(
  settings,
  projectDir,
  domain,
  chatId,
  { expectedClientSessionId } = {},
) {
  const binding = settings.sessionBinding(projectDir, domain, chatId);
  if (!expectedClientSessionId || binding.clientSessionId !== expectedClientSessionId)
    throw Error('Prepared remote session binding changed. Refresh before releasing it.');
  const identity = settings.identity();
  const signal = AbortSignal.timeout(10000);
  const assertCurrent = () => {
    signal.throwIfAborted();
    settings.assertTaskIdle(projectDir, domain);
    const current = settings.sessionBinding(projectDir, domain, chatId);
    if (
      settings.identity() !== identity ||
      current.key !== binding.key ||
      current.clientSessionId !== binding.clientSessionId ||
      current.remoteProjectId !== binding.remoteProjectId ||
      settings.project(projectDir, domain).location !== 'remote'
    )
      throw Error('Prepared remote session binding changed. Refresh before releasing it.');
  };
  assertCurrent();
  const client = settings.client(
    {
      remoteProjectId: binding.remoteProjectId,
      clientSessionId: binding.clientSessionId,
      domain,
    },
    { signal, identity, assertCurrent },
  );
  try {
    let current;
    try {
      current = await client.currentSession({ signal });
    } catch (error) {
      if (error.code !== 'SESSION_NOT_FOUND') throw error;
      assertCurrent();
      return { status: 'absent' };
    }
    assertCurrent();
    boundedIdentity(current?.id, 'application session identity');
    if (
      current.projectId !== binding.remoteProjectId ||
      current.domain !== domain ||
      current.clientSessionId !== binding.clientSessionId ||
      current.callLocked !== false
    )
      throw Error('Prepared remote session identity changed or is busy; release deferred.');
    const stopped =
      current.status === 'stopped'
        ? current
        : await client.terminateSession(current.id, { signal });
    assertCurrent();
    if (
      stopped?.id !== current.id ||
      stopped.status !== 'stopped' ||
      stopped.projectId !== binding.remoteProjectId ||
      stopped.domain !== domain ||
      stopped.clientSessionId !== binding.clientSessionId ||
      stopped.callLocked !== false
    )
      throw Error('Prepared remote sandbox release was not confirmed. Retry preparation.');
    const observed = settings.sessions.update(binding, {
      applicationSessionId: current.id,
      status: 'stopped',
    });
    settings.sessions.renewReleased(observed, current.id);
    return { status: 'released', sessionId: current.id };
  } finally {
    await client.close().catch(() => {});
  }
}

module.exports = { releasePreparedSession };
