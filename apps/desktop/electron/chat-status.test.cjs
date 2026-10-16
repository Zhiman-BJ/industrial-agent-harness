const test = require('node:test');
const assert = require('node:assert/strict');
const model = import('../src/components/chat-status.ts');

const pending = { title: 'Review timing', status: 'pending' };
const active = { title: 'Run checks', status: 'in_progress' };
const complete = { title: 'Read sources', status: 'done' };
const ready = {
  project: {
    location: 'remote',
    files: ['rtl/top.v'],
    syncedAt: '2026-10-16T00:00:00Z',
    task: null,
    service: { status: 'connected', domains: ['fixture'], executableDomains: ['fixture'] },
  },
  domain: 'fixture',
  task: null,
  session: null,
  error: '',
};

test('pending and interrupted task lists never claim completion', async () => {
  const { summarizeTodos } = await model;
  for (const items of [null, [], [pending], [complete, pending]]) {
    const summary = summarizeTodos(items, false);
    assert.equal(summary.state, 'Pending');
    assert.notEqual(summary.summary, 'All tasks completed');
  }
  assert.equal(summarizeTodos([complete, pending], false).title, pending.title);
  assert.equal(summarizeTodos([active, pending], false).state, 'Not completed');
  assert.equal(summarizeTodos([active, pending], true).state, 'In progress');
});

test('task summaries preserve supplied titles and count only completed work', async () => {
  const { summarizeTodos } = await model;
  const title = '<script>user supplied {0}</script> / ' + 'very-long-path/'.repeat(30);
  const summary = summarizeTodos([complete, { ...active, title }, pending], true);
  assert.equal(summary.done, 1);
  assert.equal(summary.title, title);
  assert.deepEqual(summarizeTodos([complete], false), {
    done: 1,
    state: 'Completed',
    title: null,
    summary: 'All tasks completed',
  });
});

test('remote query errors override stale healthy state, including the first failed load', async () => {
  const { summarizeRemote } = await model;
  for (const project of [undefined, ready.project]) {
    assert.deepEqual(summarizeRemote({ ...ready, project, error: 'Network unavailable' }), {
      label: 'Remote request failed',
      tone: 'bad',
    });
  }
  assert.deepEqual(summarizeRemote(ready), { label: 'Remote ready', tone: 'ok' });
});

test('configuration, qualification and file-sync prerequisites remain distinct', async () => {
  const { summarizeRemote } = await model;
  const cases = [
    ['not_configured', 'Not configured'],
    ['credentials_missing', 'Connection credentials needed'],
    ['unchecked', 'Not connected'],
    ['unavailable', 'Temporarily unavailable'],
  ];
  for (const [status, label] of cases) {
    const summary = summarizeRemote({
      ...ready,
      project: { ...ready.project, service: { ...ready.project.service, status } },
    });
    assert.equal(summary.label, label);
    assert.notEqual(summary.tone, 'ok');
  }
  assert.equal(summarizeRemote({ ...ready, project: undefined }).label, 'Loading…');
  assert.equal(
    summarizeRemote({ ...ready, project: { ...ready.project, syncedAt: null } }).label,
    'Choose files to sync',
  );
  assert.equal(
    summarizeRemote({ ...ready, domain: 'absent' }).label,
    'This domain is not available remotely yet.',
  );
  assert.equal(
    summarizeRemote({
      ...ready,
      project: { ...ready.project, service: { ...ready.project.service, executableDomains: [] } },
    }).label,
    'This remote domain is available for testing only.',
  );
});

test('failed, unknown and ended remote work cannot appear healthy', async () => {
  const { summarizeRemote } = await model;
  for (const status of ['failed', 'unknown', 'future-status']) {
    assert.notEqual(summarizeRemote({ ...ready, task: { invocationId: 'i', status } }).tone, 'ok');
  }
  for (const status of ['stopped', 'expired', 'failed']) {
    const summary = summarizeRemote({ ...ready, session: { id: 's', status } });
    assert.equal(summary.label, 'Remote session ended. Start a new chat.');
    assert.notEqual(summary.tone, 'ok');
  }
  for (const [status, label] of [
    ['submitting', 'Preparing remote task…'],
    ['running', 'Running remotely…'],
    ['completed', 'Remote task completed'],
  ]) {
    assert.equal(summarizeRemote({ ...ready, task: { invocationId: 'i', status } }).label, label);
  }
});

test('status-card summaries and accessible progress text have both UI translations', async () => {
  const { summarizeRemote, summarizeTodos } = await model;
  const { messages } = require('../i18n.config.json');
  const labels = [
    summarizeRemote(ready).label,
    summarizeRemote({ ...ready, error: 'failed' }).label,
    ...[null, [pending], [active], [complete]].flatMap(todo =>
      [false, true].flatMap(running => {
        const summary = summarizeTodos(todo, running);
        return [summary.state, summary.summary];
      }),
    ),
    '{0} of {1} tasks completed',
    '{0} files synced',
    'Ending remote session…',
  ];
  for (const key of labels)
    for (const locale of ['en', 'zh-CN']) assert.ok(messages[key]?.[locale], `${key}: ${locale}`);
});
