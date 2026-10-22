const test = require('node:test');
const { taskArguments } = require('./fixtures/task-service-process.cjs');
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
const kimi =
  process.env.KIMI_EXECUTABLE ||
  require('../../packages/agent-kimi/src/code-session.cjs').bundledExecutable();

test(
  'real PCB TaskService keeps the shared Runtime scope and requires approval for current-user native fixture writes',
  { timeout: 90000 },
  async t => {
    assert.ok(fs.existsSync(kimi), 'The pinned native Kimi executable is required.');
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pcb-kimi-boundary-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    let project;
    const model = await startModel({
      calls: () => {
        const script =
          `require('node:fs').writeFileSync(${JSON.stringify(path.join(project, 'native-agent-marker.txt'))}, 'PCB_NATIVE_FIXTURE_WRITE_OK');` +
          "console.log('PCB_NATIVE_FIXTURE_WRITE_OK')";
        return [
          {
            name: 'Bash',
            arguments: {
              command: `node -e "eval(Buffer.from('${Buffer.from(script).toString('base64')}', 'base64').toString())"`,
              description: 'Write a synthetic marker in this temporary PCB project',
            },
          },
        ];
      },
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
        taskArguments({
          projectDir: project,
          domain: 'pcb',
          task: 'pcb mcp 写入 native-agent-marker.txt 合成测试标记',
          approval: approval,
          provider: 'openai_legacy',
          endpoint: model.endpoint,
          model: 'controlled-pcb',
          thinking: false,
          kimiExecutable: kimi,
          timeoutMs: 25000,
          chatDir: path.join(directory, 'chats'),
          stateDir: path.join(directory, 'state'),
          logDir: path.join(directory, 'logs'),
        }),
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
      assert.ok(
        initial.includes('pcb-design-e2e'),
        'The public board Runtime discloses its local Skill without private actor setup',
      );
      if (approval === 'approve') {
        assert.match(
          JSON.stringify(requests.at(-1).messages.filter(message => message.role === 'tool')),
          /PCB_NATIVE_FIXTURE_WRITE_OK/,
        );
        assert.equal(
          fs.readFileSync(path.join(project, 'native-agent-marker.txt'), 'utf8'),
          'PCB_NATIVE_FIXTURE_WRITE_OK',
        );
        assert.ok(rows.some(boundaryMatches), stdout);
      } else assert.equal(fs.existsSync(path.join(project, 'native-agent-marker.txt')), false);
      assert.equal(fs.readFileSync(path.join(project, 'spec.json'), 'utf8'), spec);
      assert.ok(
        !rows.some(row => row.type === 'industrial_result' && row.verification.status === 'passed'),
      );
    }
  },
);
