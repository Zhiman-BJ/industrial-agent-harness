// Source-workspace diagnostic: requires installed development dependencies and
// a supported Kimi platform. The provider is controlled; the current-user launcher,
// background process, format/type checks, build and artifact reads are real.
// Run without arguments for automatic notification, or with `wait` for WaitFor.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { assertAgentBoundary } = require('./assert-agent-boundary.cjs');

async function main() {
  const project = path.resolve(__dirname, '..');
  const automatic = process.argv[2] !== 'wait';
  const { startModel } = require(
    path.join(project, 'tests/integration/fixtures/domain-mcp-model.cjs'),
  );
  const evidence = fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-real-build-'));
  const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
  const desktop = path.join(project, 'apps/desktop');
  const build = [
    `task_scratch="$PWD"; cd ${quote(project)} && ${quote(process.execPath)} ${quote(path.join(project, 'node_modules/prettier/bin/prettier.cjs'))} --check ${quote('{apps,packages,scripts,tests}/**/*.{cjs,mjs,js,ts,tsx,css}')}`,
    `${quote(process.execPath)} ${quote(path.join(desktop, 'node_modules/typescript/bin/tsc'))} --noEmit -p ${quote(path.join(desktop, 'tsconfig.json'))}`,
    `${quote(process.execPath)} ${quote(path.join(desktop, 'node_modules/vite/bin/vite.js'))} build ${quote(desktop)} --configLoader runner --outDir "$task_scratch/build-output" --emptyOutDir`,
  ].join(' && ');
  const times = [];
  const rows = [];
  let taskId;
  const model = await startModel({
    perPrompt: true,
    calls: body => {
      times.push(Date.now());
      const content = JSON.stringify(body.messages.find(m => m.role === 'tool')?.content);
      taskId ||= /task_id: (\S+)/.exec(content)?.[1]?.replace(/\\n.*/, '');
      const start = {
        name: 'Bash',
        arguments: {
          command: build,
          description: 'Check and build the actual Harness Desktop',
          run_in_background: true,
        },
      };
      const check = {
        name: 'Bash',
        arguments: {
          command:
            'test -s "$PWD/build-output/index.html" && test -d "$PWD/build-output/assets" && printf "REAL_BUILD_ARTIFACTS_OK\\n" && du -sh "$PWD/build-output" && printf "REAL_BUILD_ASSET_COUNT=" && ls "$PWD/build-output/assets" | wc -l',
          description: 'Verify real build artifacts',
        },
      };
      if (automatic) {
        const content = body.messages.findLast(m => m.role === 'user')?.content;
        const text = typeof content === 'string' ? content : JSON.stringify(content);
        const notified = text.includes('background_task');
        const outputPath = /<output-file path="([^"]+)"/.exec(text)?.[1];
        return notified
          ? [{ name: 'Read', arguments: { path: outputPath, line_offset: 1, n_lines: 300 } }, check]
          : [start];
      }
      return [
        start,
        { name: 'WaitFor', arguments: { task_id: taskId || 'unknown', timeout: 60 } },
        check,
      ];
    },
    success: body =>
      automatic &&
      !JSON.stringify(body.messages.findLast(m => m.role === 'user')?.content).includes(
        'background_task',
      )
        ? 'REAL_BUILD_STARTED'
        : 'REAL_BUILD_COMPLETE',
  });
  let stderr = '';
  try {
    const args = [
      path.join(project, 'apps/cli/src/main.cjs'),
      'run',
      '--project-dir',
      project,
      '--domain',
      'godot',
      '--task',
      'Build the actual Harness Desktop in the background, wait using native WaitFor, then inspect the real output artifacts.',
      '--approval',
      'approve',
      '--provider',
      'openai_legacy',
      '--endpoint',
      model.endpoint,
      '--model',
      'real-build-controlled',
      '--no-thinking',
      '--timeout-ms',
      '90000',
      '--chat-dir',
      path.join(evidence, 'chats'),
      '--state-dir',
      path.join(evidence, 'state'),
      '--log-dir',
      path.join(evidence, 'logs'),
    ];
    const child = spawn(process.execPath, args, {
      cwd: os.tmpdir(),
      env: {
        ...process.env,
        KIMI_EXECUTABLE: '',
        OPENAI_API_KEY: 'local-real-build',
        INDUSTRIAL_HARNESS_CONFIG_DIR: path.join(evidence, 'settings'),
      },
    });
    let pending = '';
    child.stdout.on('data', chunk => {
      pending += chunk;
      const lines = pending.split('\n');
      pending = lines.pop();
      for (const line of lines)
        if (line.trim()) rows.push({ time: Date.now(), row: JSON.parse(line) });
    });
    child.stderr.on('data', chunk => {
      stderr += chunk;
    });
    const exit = await new Promise((resolve, reject) => {
      child.on('error', reject);
      child.on('close', (code, signal) => resolve({ code, signal }));
    });
    fs.writeFileSync(path.join(evidence, 'events.json'), JSON.stringify(rows, null, 2));
    fs.writeFileSync(
      path.join(evidence, 'model-requests.json'),
      JSON.stringify(model.requests, null, 2),
    );
    fs.writeFileSync(path.join(evidence, 'stderr.log'), stderr);
    const events = rows.filter(item => item.row.event);
    assert.equal(exit.code, 0, stderr || JSON.stringify(rows.at(-1)));
    assert.equal(rows.at(-1).row.status, 'finished');
    assertAgentBoundary(
      events.find(item => item.row.event.type === 'execution-boundary')?.row.event,
    );
    const waitStart = events.find(
      item => item.row.event.type === 'tool' && item.row.event.name === 'WaitFor',
    );
    const waitEnd = events.find(
      item =>
        item.row.event.type === 'tool-result' &&
        /wait_status: completed/.test(item.row.event.output),
    );
    if (!automatic) {
      assert.ok(
        waitStart && waitEnd,
        'Native WaitFor must deliver the actual background build result',
      );
      assert.match(waitEnd.row.event.output, /exit_code: 0/);
      assert.match(waitEnd.row.event.output, /built in/);
    }
    assert.ok(
      events.some(
        item =>
          item.row.event.type === 'tool-result' &&
          /REAL_BUILD_ARTIFACTS_OK/.test(item.row.event.output),
      ),
    );
    assert.ok(events.some(item => item.row.event.text === 'REAL_BUILD_COMPLETE'));
    assert.ok(
      !events.some(item => item.row.event.type === 'tool-result' && item.row.event.error),
      'All real build tools must succeed',
    );
    // Stdout delivery can lag the native model request after completion. Verify
    // the actual request sequence, rather than treating pipe timestamps as the
    // time Kimi received its tool result.
    assert.equal(
      model.requests.length,
      automatic ? 5 : 4,
      'No requests beyond task execution, result retrieval and final answer',
    );
    assert.equal(model.requests[1].messages.filter(m => m.role === 'tool').length, 1);
    const returned = model.requests[2].messages.filter(m => m.role === 'tool');
    if (!automatic) {
      assert.equal(returned.length, 2);
      assert.match(JSON.stringify(returned[1].content), /wait_status: completed/);
    } else {
      const notification = JSON.stringify(
        model.requests[2].messages.findLast(m => m.role === 'user')?.content,
      );
      assert.match(notification, /background_task/);
      assert.match(notification, /task.completed/);
      assert.ok(
        events.some(item => item.row.event.type === 'tool' && item.row.event.name === 'Read'),
      );
      assert.ok(
        events.some(
          item => item.row.event.type === 'tool-result' && /built in/.test(item.row.event.output),
        ),
      );
      assert.ok(events.some(item => item.row.event.text === 'REAL_BUILD_STARTED'));
      assert.ok(!waitStart, 'Automatic continuation must not introduce a host WaitFor call');
    }
    const summary = {
      evidence,
      taskId,
      exit,
      automatic,
      waitMs: automatic
        ? times[2] - times[1]
        : Number(/waited_ms: (\d+)/.exec(waitEnd.row.event.output)[1]),
      modelRequests: times.length,
      modelRequestsWhileWaiting: 0,
      waitOutput: waitEnd?.row.event.output,
      artifactOutput: events.find(
        item =>
          item.row.event.type === 'tool-result' &&
          /REAL_BUILD_ARTIFACTS_OK/.test(item.row.event.output),
      ).row.event.output,
    };
    fs.writeFileSync(path.join(evidence, 'summary.json'), JSON.stringify(summary, null, 2));
    console.log(JSON.stringify(summary, null, 2));
  } catch (error) {
    console.error('Evidence: ' + evidence);
    throw error;
  } finally {
    model.close();
  }
}
main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
