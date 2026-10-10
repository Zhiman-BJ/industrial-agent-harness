const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createClient, HarnessError } = require('../src/index.cjs');

function setup(t, extra = {}) {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'industrial-sdk-test-'));
  const client = createClient({
    projectDir,
    domain: 'chip',
    cliPath: path.join(__dirname, 'fixtures/cli.cjs'),
    cancelGraceMs: 100,
    ...extra,
  });
  t.after(async () => {
    await client.close();
    fs.rmSync(projectDir, { recursive: true, force: true });
  });
  return client;
}
const drain = async handle => {
  const rows = [];
  for await (const event of handle.events) rows.push(event);
  return rows;
};
async function assertStopped(pid) {
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
      // An orphaned Linux zombie is dead; PID 1 owns its eventual reaping.
      if (process.platform === 'linux') {
        const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
        if (/\) Z /.test(stat)) return;
      }
    } catch (error) {
      if (['ESRCH', 'ENOENT'].includes(error.code)) return;
      throw error;
    }
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.fail(`Tool descendant ${pid} is still running after cleanup.`);
}

test('SDK uses actual transport events, keeps chat/run identities, and passes task text without shell interpretation', async t => {
  const client = setup(t);
  const task = '--literal 中文 $(touch not-created) `echo bad`\n' + 'x'.repeat(140000);
  const handle = client.run({ task, chatId: 'prior-chat' });
  const rows = await drain(handle);
  assert.equal(rows.find(row => row.type === 'text').text, task);
  const result = await handle.result;
  assert.equal(result.runId, 'run-1');
  assert.equal(result.chatId, 'prior-chat');
  assert.equal(result.result.status, 'completed');
  assert.equal(fs.existsSync(path.join(client.project.projectDir, 'not-created')), false);
  assert.deepEqual(await client.chats(), [{ id: 'chat-1' }]);
});

test('nonzero exit and malformed events expose typed errors; stderr redacts environment secrets', async t => {
  const client = setup(t, { environment: { KIMI_API_KEY: 'private-test-key' } });
  for (const [task, code] of [
    ['failure', 'RUN_FAILED'],
    ['invalid', 'PROTOCOL_ERROR'],
  ]) {
    const handle = client.run({ task });
    await assert.rejects(
      drain(handle),
      error => error instanceof HarnessError && error.code === code,
    );
    await assert.rejects(handle.result, error => {
      assert.equal(error.code, code);
      assert.ok(!error.details.stderr.includes('private-test-key'));
      return true;
    });
  }
});

test('malformed output racing natural process exit always settles as a typed protocol error', async t => {
  const client = setup(t);
  for (let attempt = 0; attempt < 30; attempt++) {
    const handle = client.run({ task: 'invalid' });
    await assert.rejects(drain(handle), { code: 'PROTOCOL_ERROR' });
    await assert.rejects(handle.result, { code: 'PROTOCOL_ERROR' });
  }
});

test(
  'timeout and cancellation kill descendants and close the result promise',
  { skip: process.platform === 'win32' },
  async t => {
    const client = setup(t);
    for (const reason of ['cancel', 'timeout']) {
      const handle = client.run({
        task: 'hang',
        ...(reason === 'timeout' ? { timeoutMs: 500 } : {}),
      });
      let pid;
      const collecting = (async () => {
        try {
          for await (const event of handle.events)
            if (event.type === 'child') {
              pid = event.pid;
              if (reason === 'cancel') void handle.cancel();
            }
        } catch (_) {}
      })();
      await assert.rejects(handle.result, { code: reason === 'cancel' ? 'CANCELLED' : 'TIMEOUT' });
      await collecting;
      assert.ok(pid);
      await assertStopped(pid);
    }
  },
);

test(
  'natural parent exit also cleans up orphaned tools before close',
  { skip: process.platform === 'win32' },
  async t => {
    const client = setup(t);
    const handle = client.run({ task: 'orphan', timeoutMs: 2000 });
    const rows = await drain(handle);
    await handle.result;
    await assertStopped(rows.find(row => row.type === 'child').pid);
  },
);

test('slow consumers are bounded and client close forbids new work', async t => {
  const client = setup(t, { maxBufferedEvents: 2 });
  const handle = client.run({ task: 'overflow' });
  await assert.rejects(handle.result, { code: 'EVENT_OVERFLOW' });
  await client.close();
  assert.throws(() => client.run({ task: 'a' }), { code: 'CLIENT_CLOSED' });
});

test('real source CLI scope and project chat listing are headless SDK consumers', async t => {
  const client = setup(t, { cliPath: path.resolve(__dirname, '../../../apps/cli/src/main.cjs') });
  const handle = client.run({ task: 'Inspect netlist signals', scopeOnly: true });
  const rows = await drain(handle);
  assert.equal(rows[0].scope.domain, 'chip');
  assert.equal((await handle.result).result.status, 'scoped');
  assert.deepEqual(
    await client.chats({ chatDir: path.join(client.project.projectDir, '.chats') }),
    [],
  );
});

test('SDK agent selection reaches the shared CLI policy for a configured role', async t => {
  const { AgentProfiles } = require('../../harness-core/src/agent-profiles.cjs');
  const { loadRegistry } = require('../../domain-skills/src/index.cjs');
  const config = fs.mkdtempSync(path.join(os.tmpdir(), 'sdk-agent-config-'));
  t.after(() => fs.rmSync(config, { recursive: true, force: true }));
  const agent = new AgentProfiles(config).save(loadRegistry(), {
    name: 'SDK reviewer',
    description: 'Inspect with no domain skills',
    domain: '*',
    instructions: 'Report findings.',
    skills: [],
  });
  const client = setup(t, {
    cliPath: path.resolve(__dirname, '../../../apps/cli/src/main.cjs'),
    environment: { INDUSTRIAL_HARNESS_CONFIG_DIR: config },
  });
  const baseline = client.run({ task: 'Inspect netlist signals', scopeOnly: true });
  assert.ok((await drain(baseline))[0].scope.skills.length > 0);
  await baseline.result;
  const selected = client.run({
    task: 'Inspect netlist signals',
    scopeOnly: true,
    agentId: agent.id,
  });
  assert.deepEqual((await drain(selected))[0].scope.skills, []);
  assert.equal((await selected.result).result.status, 'scoped');
});
