const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { buildHeadlessPackage } = require('./fixtures/headless-package.cjs');
const { startModel } = require('./fixtures/domain-mcp-model.cjs');
const execute = promisify(execFile);

// This gate requires the production process boundary. Run it on the declared
// native platforms, separately from portable packaging and other pnpm deploys.
test('packaged headless Agent completes a real protected Kimi Code turn outside the workspace', async t => {
  const { directory, target } = buildHeadlessPackage(t);
  const isFollowup = body =>
    JSON.stringify(body.messages.findLast(m => m.role === 'user')?.content).includes(
      'background_task',
    );
  const model = await startModel({
    perPrompt: true,
    calls: body => [
      {
        name: 'Bash',
        arguments: isFollowup(body)
          ? { command: 'echo PACKAGED_FOLLOWUP_TOOL', description: 'Follow-up read-only marker' }
          : {
              command: 'sleep 1; echo PACKAGED_BACKGROUND_OUTPUT',
              description: 'Packaged background marker',
              run_in_background: true,
            },
      },
    ],
    success: body => (isFollowup(body) ? 'PACKAGED_CODE_OK' : 'PACKAGED_STARTED'),
  });
  t.after(model.close);
  const project = path.join(directory, 'project');
  fs.mkdirSync(project);
  const { stdout } = await execute(
    process.execPath,
    [
      path.join(target, 'industrial-harness.cjs'),
      'run',
      '--project-dir',
      project,
      '--domain',
      'godot',
      '--task',
      'Run the background marker and report its completion.',
      '--approval',
      'approve',
      '--provider',
      'openai_legacy',
      '--endpoint',
      model.endpoint,
      '--model',
      'controlled',
      '--no-thinking',
      '--chat-dir',
      path.join(directory, 'chats'),
      '--state-dir',
      path.join(directory, 'state'),
      '--log-dir',
      path.join(directory, 'logs'),
    ],
    {
      cwd: os.tmpdir(),
      timeout: 30000,
      env: {
        ...process.env,
        KIMI_EXECUTABLE: '',
        OPENAI_API_KEY: 'package-local-fixture',
        INDUSTRIAL_HARNESS_CONFIG_DIR: path.join(directory, 'settings'),
      },
    },
  );
  const rows = stdout.trim().split('\n').map(JSON.parse);
  assert.equal(rows.at(-1).status, 'finished');
  assert.ok(
    rows.some(
      row => row.event?.type === 'execution-boundary' && row.event.projectWritable === false,
    ),
  );
  assert.ok(rows.some(row => row.event?.text === 'PACKAGED_CODE_OK'));
  assert.ok(rows.some(row => row.event?.text === 'PACKAGED_STARTED'));
  assert.ok(rows.some(row => row.event?.type === 'background-state' && row.event.running));
  assert.equal(model.requests.length, 4);
  assert.equal(rows.filter(row => row.event?.type === 'approval').length, 2);
  const finished = rows.findIndex(row => row.event?.text === 'PACKAGED_CODE_OK');
  assert.ok(
    rows.findIndex(row => row.type === 'result') > finished,
    'final result follows native background continuation',
  );
  assert.equal(
    JSON.parse(fs.readFileSync(path.join(target, 'HARNESS-PACKAGE.json'))).agentRuntime.version,
    '2.1.1',
  );
});

test('packaged native Agent accepts long deadlines without immediate timer overflow', async t => {
  const { directory, target } = buildHeadlessPackage(t);
  for (const timeoutMs of ['7200001', '2592000000', '9007199254740993']) {
    const project = path.join(directory, 'project-' + timeoutMs);
    fs.mkdirSync(project);
    const model = await startModel({ calls: [], success: 'LONG_TIMEOUT_OK' });
    try {
      const { stdout, stderr } = await execute(
        process.execPath,
        [
          path.join(target, 'industrial-harness.cjs'),
          'run',
          '--project-dir',
          project,
          '--domain',
          'chip',
          '--task',
          'Report the marker.',
          '--provider',
          'openai_legacy',
          '--endpoint',
          model.endpoint,
          '--model',
          'controlled',
          '--no-thinking',
          '--timeout-ms',
          timeoutMs,
          '--chat-dir',
          path.join(directory, 'chats-' + timeoutMs),
          '--state-dir',
          path.join(directory, 'state-' + timeoutMs),
          '--log-dir',
          path.join(directory, 'logs-' + timeoutMs),
        ],
        {
          cwd: os.tmpdir(),
          timeout: 30000,
          env: {
            ...process.env,
            KIMI_EXECUTABLE: '',
            OPENAI_API_KEY: 'package-local-fixture',
            INDUSTRIAL_HARNESS_CONFIG_DIR: path.join(directory, 'settings-' + timeoutMs),
          },
        },
      );
      const rows = stdout.trim().split('\n').map(JSON.parse);
      assert.equal(rows.at(-1).status, 'finished');
      assert.ok(rows.some(row => row.event?.text === 'LONG_TIMEOUT_OK'));
      assert.ok(!rows.some(row => row.type === 'timeout'));
      assert.doesNotMatch(stderr, /TimeoutOverflowWarning/);
    } finally {
      await model.close();
    }
  }
});
