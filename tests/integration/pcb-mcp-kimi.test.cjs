const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { startModel } = require('./fixtures/domain-mcp-model.cjs');
const execute = promisify(execFile);
const root = path.resolve(__dirname, '../..');
const kimi =
  process.env.KIMI_EXECUTABLE ||
  require('../../packages/agent-kimi/src/code-session.cjs').bundledExecutable();

test(
  'real PCB CLI keeps the shared Runtime scope and refuses native Bash mutation even after approval',
  { timeout: 90000 },
  async t => {
    assert.ok(fs.existsSync(kimi), 'The pinned native Kimi executable is required.');
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pcb-kimi-boundary-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    let project;
    const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
    const model = await startModel({
      calls: () => [
        {
          name: 'Bash',
          arguments: {
            command: `${quote(process.execPath)} -e ${quote('require("node:fs").writeFileSync(process.argv[1],"UNAUTHORIZED_BOARD_CHANGE")')} ${quote(path.join(project, 'spec.json'))}`,
            description: 'Attempt a PCB project write outside Domain Runtime',
          },
        },
      ],
    });
    t.after(model.close);
    for (const approval of ['reject', 'approve']) {
      project = path.join(directory, approval);
      fs.mkdirSync(project);
      const spec = JSON.stringify({ width_mm: 20, height_mm: 15 });
      fs.writeFileSync(path.join(project, 'spec.json'), spec);
      const before = model.requests.length;
      const { stdout, stderr } = await execute(
        process.execPath,
        [
          path.join(root, 'apps/cli/src/main.cjs'),
          'run',
          '--project-dir',
          project,
          '--domain',
          'pcb',
          '--task',
          'pcb mcp 修改板尺寸',
          '--approval',
          approval,
          '--provider',
          'openai_legacy',
          '--endpoint',
          model.endpoint,
          '--model',
          'controlled-pcb',
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
        ],
        {
          cwd: root,
          timeout: 40000,
          maxBuffer: 4 * 1024 * 1024,
          env: {
            ...process.env,
            OPENAI_API_KEY: 'local-fixture-key',
            INDUSTRIAL_HARNESS_CONFIG_DIR: path.join(directory, 'resources'),
          },
        },
      );
      const rows = stdout.trim().split('\n').map(JSON.parse);
      assert.equal(rows.at(-1).status, 'finished', stdout + stderr);
      assert.ok(rows.some(row => row.type === 'approval_decision' && row.decision === approval));
      const requests = model.requests.slice(before);
      const names = requests[0].tools.map(tool => tool.function.name);
      assert.ok(
        names.some(name => name.endsWith('__industrial_action_call')),
        'Shared Runtime remains available',
      );
      assert.ok(!names.some(name => name === 'domain_tool_call' || name === 'new_project'));
      const initial = JSON.stringify(requests[0].messages);
      assert.ok(initial.includes('project.work'));
      // Skills are disclosed through the Kimi skill surface (pcb-design) and
      // the Broker scope carries the canonical dotted id.
      assert.ok(
        initial.includes('pcb.design.e2e') && initial.includes('pcb-design'),
        'The public board Runtime discloses its local Skill without private actor setup',
      );

      if (approval === 'approve') {
        assert.match(
          JSON.stringify(requests.at(-1).messages.filter(message => message.role === 'tool')),
          /Operation not permitted|EACCES|EPERM|EROFS|read-only file system/i,
        );
        assert.ok(
          rows.some(
            row => row.event?.type === 'execution-boundary' && row.event.projectWritable === false,
          ),
        );
      }
      assert.equal(fs.readFileSync(path.join(project, 'spec.json'), 'utf8'), spec);
      assert.ok(
        !rows.some(row => row.type === 'industrial_result' && row.verification.status === 'passed'),
      );
    }
  },
);
