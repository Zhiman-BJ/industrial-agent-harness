const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { run } = require('../src/main.cjs');
const { KimiSession } = require('@industrial-agent-harness/agent-kimi');
const { ChatStore } = require('@industrial-agent-harness/harness-core');

async function forcedApprovalRun(t, approval) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-explicit-approval-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const projectDir = path.join(root, 'project');
  fs.mkdirSync(projectDir);
  const rows = [],
    decisions = [];
  let session;
  const preview = {
    title: 'Approve remote task',
    text: 'Destination: https://remote.example\nFiles: input.txt\nTools: test.run',
    truncated: false,
  };
  class ForcedApprovalSession extends KimiSession {
    constructor(...args) {
      super(...args);
      session = this;
      // Replace only the consent source and model execution. CLI, TaskService,
      // approval promises, interruption, persistence and cleanup are production paths.
      this.diagnostics.industrialRuntime.requiresExplicitApproval = () => true;
      this.diagnostics.industrialRuntime.approvalPreview = () => preview;
    }
    async run() {
      this.running = true;
      this.lastApprovalMode = this.getRuntime().approvalMode;
      try {
        this.allowed = await this.requestRuntimeApproval(
          { id: 'project.remote.prepare', risk: 'mutating' },
          { expectedStateId: this.getScope().stateId, inputs: { reviewId: 'reviewed-batch' } },
          this.diagnostics.getApplicationContext(),
        );
        this.emitAgent({ type: 'done', result: { status: 'completed' } });
      } finally {
        this.running = false;
      }
    }
    approve(id, response) {
      decisions.push(response);
      return super.approve(id, response);
    }
    async close() {
      await super.close();
      this.closed = true;
    }
  }
  const chatDir = path.join(root, 'chats');
  const code = await run(
    {
      projectDir,
      domain: 'general',
      task: 'Prepare one reviewed remote task',
      approval,
      chatDir,
      stateDir: path.join(root, 'state'),
      timeoutMs: 2000,
    },
    { write: line => rows.push(JSON.parse(line)) },
    { KIMI_API_KEY: 'test-key', INDUSTRIAL_HARNESS_CONFIG_DIR: path.join(root, 'config') },
    ForcedApprovalSession,
  );
  assert.equal(session.closed, true);
  assert.equal(session.pendingApprovals.size, 0);
  assert.equal(session.runtimeApprovals.size, 0);
  assert.equal(session.session, undefined);
  assert.equal(
    rows.some(row => row.type === 'approval_error'),
    false,
  );
  assert.equal(
    rows.some(row => row.type === 'timeout'),
    false,
  );
  return { code, rows, decisions, session, preview, chatDir, projectDir };
}

test('CLI auto mode preserves a mandatory batch preview and exits needs_input without approving', async t => {
  const f = await forcedApprovalRun(t, 'auto');
  assert.equal(f.code, 2);
  assert.equal(f.session.allowed, false);
  assert.deepEqual(f.decisions, []);
  assert.equal(
    f.rows.some(row => row.type === 'approval_decision'),
    false,
  );
  const pending = f.rows.find(row => row.type === 'needs_input');
  assert.equal(pending.reason, 'explicit_approval_required');
  assert.equal(pending.action, 'project.remote.prepare');
  assert.deepEqual(pending.preview, f.preview);
  assert.equal(f.rows.at(-1).status, 'needs_input');
  const resolved = f.rows.find(
    row => row.type === 'agent_event' && row.event.type === 'approval-resolved',
  );
  assert.equal(resolved.event.decision, 'expired');
  const chats = new ChatStore(f.chatDir);
  try {
    const history = chats.history(f.rows.at(-1).chatId, f.projectDir, 'general');
    assert.equal(history.turns[0].status, 'needs_input');
    assert.ok(history.turns[0].events.some(event => event.type === 'approval'));
    const release = chats.acquire(history.chat.id);
    assert.equal(typeof release, 'function');
    release();
  } finally {
    chats.close();
  }
});

for (const approval of ['approve', 'approve_for_session', 'reject'])
  test(`CLI explicit ${approval} policy keeps its existing mandatory approval behavior`, async t => {
    const f = await forcedApprovalRun(t, approval);
    assert.equal(f.code, 0);
    assert.equal(f.session.allowed, approval !== 'reject');
    assert.deepEqual(f.decisions, [approval]);
    assert.equal(
      f.rows.some(row => row.type === 'needs_input'),
      false,
    );
    assert.equal(f.rows.find(row => row.type === 'approval_decision').decision, approval);
    assert.equal(f.rows.at(-1).status, 'completed');
  });
