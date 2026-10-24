'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createProductReplayBackend, HISTORY_PAGE_SIZE } = require('./product-backend.cjs');

function fixture(count = 39940) {
  const events = [];
  for (let index = 0; index < count; index++) {
    const agent = `agent-${index % 6}`;
    const turn = `turn-${Math.floor(index / 300)}`;
    const pair = Math.floor(index / 2);
    const event =
      index < 8720
        ? index % 2
          ? {
              type: 'tool-result',
              id: `tool-${pair}`,
              output: `原始失败结果 ${pair}`,
              isError: pair % 17 === 0,
            }
          : {
              type: 'tool',
              id: `tool-${pair}`,
              name: 'recorded.tool.inspect',
              arguments: JSON.stringify({ original: pair }),
            }
        : {
            type: 'text',
            text: `original text ${index}\n`,
            replayRole: index % 300 < 6 ? 'user' : 'assistant',
          };
    // Tool start/result share an actor, including collisions across agents.
    const agentId = index < 8720 ? `agent-${pair % 6}` : agent;
    events.push({
      seq: index + 1,
      at: new Date(1700000000000 + index).toISOString(),
      relMs: index,
      origin: { agentId, turnId: turn },
      event,
      source: {
        type: event.type,
        sourceLine: index + 1,
        raw: { original: index, unicode: '原始记录' },
      },
    });
  }
  return {
    manifest: {
      recordingId: 'full-recording',
      createdAt: events[0].at,
      chat: { chatId: 'recorded-chat', displayName: 'Recorded project' },
      assets: [],
    },
    events,
    warnings: [],
    missingAssets: [],
  };
}

test('production history retains all 39940 source records, six actors and 4360 tool pairs through normal turn paging', async () => {
  const bundle = fixture();
  const backend = createProductReplayBackend(bundle);
  backend.control({ action: 'seek', value: bundle.events.length });
  const chats = await backend.invoke('chat:list');
  assert.equal(chats.chats.length, 6);
  assert.deepEqual(chats.sessions, []);
  const found = [];
  let tools = 0;
  let results = 0;
  for (const chat of chats.chats) {
    let before = null;
    for (;;) {
      const page = await backend.invoke('chat:history', { id: chat.id, before });
      assert.ok(page.turns.length <= HISTORY_PAGE_SIZE);
      for (const turn of page.turns) {
        assert.equal(turn.sourceCount, turn.sourceSequences.length);
        found.push(...turn.sourceSequences.map(sequence => bundle.events[sequence - 1]));
        tools += turn.events.filter(event => event.type === 'tool').length;
        results += turn.events.filter(event => event.type === 'tool-result').length;
        for (const event of turn.events) {
          assert.equal(event.chatId, chat.id);
          assert.equal(event.turnId, turn.id);
          assert.equal(event.recordedAt, bundle.events[event.recordingSequence - 1].at);
        }
      }
      if (!page.hasMore) break;
      assert.notEqual(page.before, before);
      before = page.before;
    }
  }
  assert.equal(tools, 4360);
  assert.equal(results, 4360);
  assert.deepEqual(
    found.sort((a, b) => a.seq - b.seq),
    bundle.events,
  );
  const detached = await backend.invoke('chat:history', { id: chats.chats[0].id });
  detached.turns[0].events[0].type = 'caller-mutation';
  assert.notEqual(
    bundle.events[detached.turns[0].events[0].recordingSequence - 1].event.type,
    'caller-mutation',
  );
  backend.close();
});

test('same-turn playback publishes production envelopes with monotonic revisions; seek requests a history refresh', async () => {
  const bundle = fixture(30);
  const backend = createProductReplayBackend(bundle);
  const emitted = [];
  const unsubscribe = backend.subscribe(event => emitted.push(event));
  backend.control({ action: 'seek', value: 12 });
  assert.ok(emitted.some(event => event.channel === 'replay:history-invalidated'));
  emitted.length = 0;
  backend.control({ action: 'play' });
  backend.tick(4);
  const incoming = emitted.filter(event => event.channel === 'agent:event');
  assert.ok(incoming.length);
  assert.equal(
    emitted.some(event => event.channel === 'replay:history-invalidated'),
    false,
  );
  for (const [index, envelope] of incoming.entries()) {
    assert.ok(envelope.payload.chatId);
    assert.ok(envelope.payload.projectId);
    assert.ok(envelope.payload.turnId);
    assert.ok(envelope.payload.recordedAt);
    if (index)
      assert.ok(envelope.payload.eventRevision > incoming[index - 1].payload.eventRevision);
  }
  const revision = incoming.at(-1).payload.eventRevision;
  backend.control({ action: 'seek', value: 1 });
  const state = await backend.invoke('chat:list');
  const history = await backend.invoke('chat:history', { id: state.activeId });
  assert.ok(history.eventRevision > revision, 'revision never rewinds with source time');
  assert.equal(history.turns[0].sourceCount, 1);
  unsubscribe();
  backend.close();
});

test('source details preserve complete raw UTF-8 data across diagnostic pages', async () => {
  const bundle = fixture(1);
  bundle.events[0].source.raw.long = '原始结果'.repeat(30000);
  const backend = createProductReplayBackend(bundle);
  backend.control({ action: 'seek', value: 1 });
  let offset = 0;
  let source = '';
  for (;;) {
    const page = await backend.invoke('agent:log-record', {
      runId: 'full-recording',
      sequence: 1,
      offset,
    });
    source += page.text;
    if (page.nextOffset === null) break;
    assert.ok(page.nextOffset > offset);
    offset = page.nextOffset;
  }
  assert.deepEqual(JSON.parse(source), bundle.events[0]);
  const view = await backend.invoke('agent:log-view', { view: 'tools' });
  assert.equal(view.counts.tools, 1);
  assert.equal(view.totalRecords, 1);
  backend.close();
});

test('recording exposes no fake account or running model and rejects all mutating channels', async () => {
  const backend = createProductReplayBackend(fixture(4));
  const account = await backend.invoke('account:get');
  assert.equal(account.status, 'not_configured');
  assert.equal(account.user, null);
  assert.equal((await backend.invoke('agent:status')).configured, false);
  assert.equal((await backend.invoke('model:get')).hasApiKey, false);
  for (const channel of [
    'agent:run',
    'agent:new',
    'agent:approve',
    'agent:answer-question',
    'agent:interrupt',
    'broker:resolve',
    'account:login',
    'account:configure',
    'model:save',
    'chat:rename',
    'chat:delete',
    'project:create',
    'project:set-domain',
    'resource:set',
    'remote:sync',
    'domains:install',
    'viewer:external-open',
    'viewer:resources-prepare',
    'settings:set-gui',
    'update:install',
  ]) {
    await assert.rejects(
      backend.invoke(channel, {}),
      error => error.code === 'REPLAY_READ_ONLY' && /Read-only recording/.test(error.message),
      channel,
    );
  }
  await assert.rejects(backend.invoke('chat:history', { id: 'unknown' }), /Unknown recorded chat/);
  await assert.rejects(
    backend.invoke('project:bindings', { projectId: 'foreign' }),
    /Unknown recorded project/,
  );
  backend.close();
  await assert.rejects(backend.invoke('chat:list'), /closed/);
});

test('domain comes only from explicit source fields and no terminal events are fabricated', async () => {
  const bundle = fixture(20);
  bundle.events[0].event.name = 'pcb.design.inspect_board';
  const backend = createProductReplayBackend(bundle);
  backend.control({ action: 'seek', value: 20 });
  assert.equal((await backend.invoke('project:bindings')).projects[0].domain, 'general');
  for (const chat of (await backend.invoke('chat:list')).chats) {
    const history = await backend.invoke('chat:history', { id: chat.id });
    for (const turn of history.turns) {
      assert.equal(turn.status, 'recorded');
      assert.equal(
        turn.events.some(event => event.type === 'done' || event.type === 'status'),
        false,
      );
      assert.deepEqual(
        turn.events.map(event => [event.type, event.id]),
        turn.sourceSequences.map(sequence => {
          const event = bundle.events[sequence - 1].event;
          return [event.type, event.id];
        }),
      );
    }
  }
  backend.close();
  bundle.manifest.chat.domain = 'pcb';
  const explicit = createProductReplayBackend(bundle);
  assert.equal((await explicit.invoke('project:bindings')).projects[0].domain, 'pcb');
  explicit.close();
});

test('idle ticks and sidebar refreshes do not rescan or fold event payloads', async () => {
  const bundle = fixture(39940);
  const backend = createProductReplayBackend(bundle);
  backend.control({ action: 'seek', value: bundle.events.length });
  let inspected = 0;
  for (const record of bundle.events) {
    const event = record.event;
    Object.defineProperty(record, 'event', {
      get() {
        inspected++;
        return event;
      },
    });
  }
  for (let index = 0; index < 100; index++) {
    backend.tick(100);
    await backend.invoke('chat:list');
    await backend.invoke('broker:trace');
  }
  assert.equal(inspected, 0);
  backend.close();
});
