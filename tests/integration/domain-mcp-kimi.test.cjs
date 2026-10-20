const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { startModel } = require('./fixtures/domain-mcp-model.cjs');
const { boundaryMatches } = require('./fixtures/execution-boundary.cjs');
const execute = promisify(execFile);
const root = path.resolve(__dirname, '../..');
const entry = process.env.INDUSTRIAL_HARNESS_TEST_CLI || path.join(root, 'apps/cli/src/main.cjs');
const kimi =
  process.env.KIMI_EXECUTABLE ||
  require('../../packages/agent-kimi/src/code-session.cjs').bundledExecutable();
test(
  'real CLI + pinned Kimi honors approval for current-user native writes without disclosing legacy tools or inventing engineering acceptance',
  { timeout: 90000, skip: !fs.existsSync(kimi) },
  async t => {
    let activeProject;
    const fixture = await startModel({
      calls: () => {
        const script =
          `require('node:fs').writeFileSync(${JSON.stringify(path.join(activeProject, 'native-agent-marker.txt'))}, 'NATIVE_FIXTURE_WRITE_OK');` +
          "console.log('NATIVE_FIXTURE_WRITE_OK')";
        return [
          {
            name: 'Bash',
            arguments: {
              command: `node -e "eval(Buffer.from('${Buffer.from(script).toString('base64')}', 'base64').toString())"`,
              description: 'Write a synthetic marker in this temporary test project',
            },
          },
        ];
      },
    });
    t.after(fixture.close);
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'industrial-kimi-mcp-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    for (const approval of ['reject', 'approve']) {
      const project = path.join(directory, approval);
      activeProject = project;
      fs.mkdirSync(project);
      fs.writeFileSync(
        path.join(project, 'eda.yaml'),
        'name: mcp-test\ntop: top\nruntime:\n  kind: local\ninputs: {}\nactions: {}\nrequired_verification: []\n',
      );
      const before = fixture.requests.length;
      const args = [
        entry,
        'run',
        '--project-dir',
        project,
        '--domain',
        'chip',
        '--task',
        'Write the synthetic native-agent-marker.txt fixture file',
        '--approval',
        approval,
        '--provider',
        'openai_legacy',
        '--endpoint',
        fixture.endpoint,
        '--model',
        'controlled-mcp',
        '--no-thinking',
        '--kimi-executable',
        kimi,
        '--timeout-ms',
        '25000',
        '--chat-dir',
        path.join(directory, 'chats'),
        '--state-dir',
        path.join(directory, 'state'),
        '--log-dir',
        path.join(directory, 'logs'),
      ];
      const { stdout, stderr } = await execute(process.execPath, args, {
        cwd: root,
        env: {
          ...process.env,
          OPENAI_API_KEY: 'local-fixture-key',
          INDUSTRIAL_HARNESS_CONFIG_DIR: path.join(directory, 'resources'),
        },
        timeout: 40000,
        maxBuffer: 4 * 1024 * 1024,
      });
      const rows = stdout.trim().split('\n').map(JSON.parse);
      assert.equal(rows.at(-1).status, 'finished', stderr + stdout);
      assert.ok(
        rows.some(row => row.type === 'approval_decision' && row.decision === approval),
        stdout,
      );
      const requests = fixture.requests.slice(before);
      const tools = requests[0].tools.map(tool => tool.function.name);
      assert.ok(!tools.includes('domain_tool_call'));
      assert.ok(!tools.includes('run_action'));
      if (approval === 'approve') {
        const output = JSON.stringify(
          requests.at(-1).messages.filter(message => message.role === 'tool'),
        );
        assert.match(output, /NATIVE_FIXTURE_WRITE_OK/);
        assert.equal(
          fs.readFileSync(path.join(project, 'native-agent-marker.txt'), 'utf8'),
          'NATIVE_FIXTURE_WRITE_OK',
        );
        assert.ok(rows.some(boundaryMatches), stdout);
      } else assert.equal(fs.existsSync(path.join(project, 'native-agent-marker.txt')), false);
      assert.ok(!fs.existsSync(path.join(project, '.eda')));
      assert.ok(
        !rows.some(row => row.type === 'industrial_result' && row.verification.status === 'passed'),
      );
    }
  },
);
