const test = require('node:test'),
  assert = require('node:assert/strict');
const fs = require('node:fs'),
  os = require('node:os'),
  path = require('node:path');
const { createRequire } = require('node:module');
const { execFile } = require('node:child_process'),
  { promisify } = require('node:util');
const { ExternalMcpRegistry } = require('../../packages/domain-mcp/src/index.cjs');
const { startModel } = require('./fixtures/domain-mcp-model.cjs');
const { image } = require('./fixtures/external-mcp-server.cjs');
const execute = promisify(execFile),
  root = path.resolve(__dirname, '../..');
const entry = process.env.INDUSTRIAL_HARNESS_TEST_CLI || path.join(root, 'apps/cli/src/main.cjs');
const kimi =
  process.env.KIMI_EXECUTABLE ||
  createRequire(fs.realpathSync(entry))('@industrial-agent-harness/agent-kimi').bundledExecutable();
const server = path.join(__dirname, 'fixtures/external-mcp-server.cjs');
test(
  'real CLI and pinned Kimi: registered external MCP is discoverable in current-user execution; approvals, images, durable Actions and disable policy work',
  { timeout: 90000 },
  async t => {
    assert.ok(fs.existsSync(kimi), 'The native MCP gate requires the pinned Kimi runtime.');
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-hosted-mcp-')),
      project = path.join(directory, 'project');
    fs.mkdirSync(project);
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const configs = path.join(directory, 'config'),
      marker = path.join(directory, 'host-click.json'),
      file = path.join(directory, 'mcp.json');
    fs.writeFileSync(
      file,
      JSON.stringify({
        mcpServers: {
          host: {
            command: process.execPath,
            args: [server],
            env: { FIXTURE_CLICK_MARKER: marker },
          },
        },
      }),
    );
    const env = {
      ...process.env,
      INDUSTRIAL_HARNESS_CONFIG_DIR: configs,
      OPENAI_API_KEY: 'local-hosted-mcp',
    };
    const invoke = args =>
      execute(process.execPath, [entry, ...args], {
        cwd: os.tmpdir(),
        env,
        timeout: 45000,
        maxBuffer: 8 * 1024 * 1024,
      });
    const added = await invoke(['mcp', 'add', '--file', file]);
    assert.equal(JSON.parse(added.stdout).servers[0].id, 'external.host');
    const tools = new ExternalMcpRegistry(configs).records()[0].tools;
    const click = tools.find(tool => tool.name === 'click').id,
      screenshot = tools.find(tool => tool.name === 'screenshot').id;
    for (const approval of ['reject', 'approve']) {
      const model = await startModel({
        success: 'HOST_MCP_RECORDED',
        calls: [
          { name: 'external_tool_list', arguments: {} },
          { name: 'external_tool_describe', arguments: { toolId: click } },
          {
            name: 'external_tool_call',
            arguments: { toolId: click, argumentsJson: JSON.stringify({ x: 12, y: 24 }) },
          },
          {
            name: 'external_tool_call',
            arguments: { toolId: click, argumentsJson: JSON.stringify({ x: 13, y: 25 }) },
          },
          { name: 'external_tool_call', arguments: { toolId: screenshot, argumentsJson: '{}' } },
        ],
      });
      t.after(model.close);
      const { stdout, stderr } = await invoke([
        'run',
        '--project-dir',
        project,
        '--domain',
        'chip',
        '--task',
        'Use the registered host service',
        '--provider',
        'openai_legacy',
        '--endpoint',
        model.endpoint,
        '--model',
        'controlled-host',
        '--no-thinking',
        '--image-input',
        '--approval',
        approval,
        '--kimi-executable',
        kimi,
        '--timeout-ms',
        '30000',
        '--chat-dir',
        path.join(directory, 'chats'),
        '--state-dir',
        path.join(directory, 'state'),
        '--log-dir',
        path.join(directory, 'logs'),
      ]);
      const rows = stdout.trim().split('\n').map(JSON.parse),
        results = rows.filter(row => row.type === 'industrial_result');
      assert.equal(rows.at(-1).status, 'finished', stderr + stdout);
      assert.equal(results.length, 3);
      assert.ok(
        model.requests.some(request =>
          request.messages.some(message =>
            (typeof message.content === 'string'
              ? message.content
              : message.content?.map(part => part.text || '').join('\n') || ''
            ).includes('"total":3'),
          ),
        ),
        'Empty discovery arguments must work in the actual pinned SDK, including pagination defaults.',
      );
      assert.ok(results.every(result => result.state.status === 'unverified'));
      if (approval === 'reject') {
        assert.equal(fs.existsSync(marker), false);
        assert.ok(results.every(result => result.action.status === 'failed'));
      } else {
        const clickResult = JSON.parse(fs.readFileSync(marker));
        assert.deepEqual(clickResult.arguments, { x: 13, y: 25 });
        assert.equal(
          clickResult.count,
          2,
          'Actual installed CLI must retain the MCP process across approved calls.',
        );
        assert.ok(
          results.every(
            result =>
              result.action.status === 'completed' && result.verification.status === 'not_run',
          ),
        );
        assert.ok(
          results.every(result => result.artifacts.some(a => a.kind === 'report.external')),
        );
        assert.ok(
          JSON.stringify(model.requests).includes(`data:${image.mimeType};base64,${image.data}`),
          'Native MCP image must reach the vision model request.',
        );
        assert.ok(
          rows.some(
            row =>
              row.event?.type === 'execution-boundary' &&
              row.event.mechanism === 'current-user' &&
              row.event.osIsolation === false &&
              row.event.projectWritable === true,
          ),
        );
      }
    }
    await invoke(['mcp', 'disable', 'external.host', '--project-dir', project]);
    const model = await startModel({ calls: [], success: 'MCP_DISABLED' });
    t.after(model.close);
    const { stdout } = await invoke([
      'run',
      '--project-dir',
      project,
      '--domain',
      'chip',
      '--task',
      'Work on the project',
      '--provider',
      'openai_legacy',
      '--endpoint',
      model.endpoint,
      '--model',
      'controlled-host',
      '--no-thinking',
      '--approval',
      'approve',
      '--kimi-executable',
      kimi,
      '--timeout-ms',
      '30000',
      '--chat-dir',
      path.join(directory, 'chats'),
      '--state-dir',
      path.join(directory, 'state'),
      '--log-dir',
      path.join(directory, 'logs'),
    ]);
    const rows = stdout.trim().split('\n').map(JSON.parse);
    assert.equal(rows.at(-1).status, 'finished');
    assert.ok(!rows[0].scope.tools.some(id => id.startsWith('external.')));
    assert.ok(!model.requests[0].tools.some(tool => tool.function.name === 'external_tool_call'));
  },
);
