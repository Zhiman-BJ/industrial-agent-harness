'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const { loadReplayInput, validateManifest, validateEventStream } = require('../src/index.cjs');

function fixture() {
  const raw = [
    { type: 'turn.prompt' },
    {
      type: 'context.append_message',
      message: { role: 'user', content: [{ type: 'text', text: 'historical instruction' }] },
    },
    { type: 'context.append_loop_event', event: { type: 'step.begin', step: 1, turnId: '0' } },
    {
      type: 'context.append_loop_event',
      event: { type: 'content.part', part: { type: 'think', think: 'recorded thinking' } },
    },
    {
      type: 'context.append_loop_event',
      event: {
        type: 'tool.call',
        toolCallId: 'call-1',
        name: 'Read',
        args: { path: '/unavailable/project' },
      },
    },
    {
      type: 'context.append_loop_event',
      event: {
        type: 'tool.result',
        toolCallId: 'call-1',
        result: { isError: true, output: 'recorded failure', note: 'original note' },
      },
    },
    {
      type: 'context.append_loop_event',
      event: { type: 'content.part', part: { type: 'text', text: 'recorded answer' } },
    },
    {
      type: 'agent.message.appended',
      message: { message: { role: 'assistant', content: 'recorded answer' } },
    },
    { type: 'context.apply_compaction', summary: 'native summary' },
    { type: 'turn.ended', reason: 'completed' },
  ];
  const records = raw.map((r, i) => ({
    schema_version: 'agent-event/1.0',
    agent_id: 'main',
    event_id: `main:${i + 1}`,
    source_line: i + 1,
    source_file: 'raw/session/agents/main/wire.jsonl',
    timestamp_ms: 10000 + i * 10,
    event_type: r.type,
    raw: r,
  }));
  // Simulate wall-time sorting that places the terminal before its inputs.
  records[9].timestamp_ms = 10001;
  records.sort((a, b) => a.timestamp_ms - b.timestamp_ms);
  const manifest = {
    schema_version: 'agent-trajectory-export/1.0',
    session_id: 'test-session',
    statistics: {
      event_count: 10,
      agent_count: 1,
      tool_calls: 1,
      tool_results: 1,
      thinking_blocks: 1,
      compactions: 1,
      decision_count: 1,
    },
  };
  return new Map([
    ['manifest.json', JSON.stringify(manifest)],
    ['events.timeline.jsonl', records.map(r => JSON.stringify(r)).join('\n') + '\n'],
    ['diagnostics.json', JSON.stringify({ issues: [] })],
    ['raw/session/agents/main/wire.jsonl', raw.map(r => JSON.stringify(r)).join('\n') + '\n'],
    ['do-not-run.py', 'raise Exception("must never execute")\n'],
  ]);
}
function seal(files) {
  const result = new Map(files);
  result.set(
    'SHA256SUMS',
    [...files]
      .map(([name, text]) => `${crypto.createHash('sha256').update(text).digest('hex')}  ${name}`)
      .join('\n') + '\n',
  );
  return result;
}
function octal(buffer, offset, length, number) {
  buffer.write(number.toString(8).padStart(length - 1, '0') + '\0', offset, length);
}
function tar(files, extra = []) {
  const parts = [];
  for (const [name, content, type = '0'] of [...files, ...extra]) {
    const body = Buffer.from(content);
    const header = Buffer.alloc(512);
    header.write(name);
    octal(header, 100, 8, 0o644);
    octal(header, 108, 8, 0);
    octal(header, 116, 8, 0);
    octal(header, 124, 12, body.length);
    octal(header, 136, 12, 0);
    header.fill(32, 148, 156);
    header.write(type, 156);
    header.write('ustar\0', 257);
    octal(
      header,
      148,
      8,
      header.reduce((a, b) => a + b, 0),
    );
    parts.push(header, body, Buffer.alloc((512 - (body.length % 512)) % 512));
  }
  return zlib.gzipSync(Buffer.concat([...parts, Buffer.alloc(1024)]));
}
function directory(t, files = seal(fixture())) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'native-replay-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  for (const [name, content] of files) {
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    fs.writeFileSync(path.join(dir, name), content);
  }
  return dir;
}
function archive(t, files = seal(fixture()), extra) {
  const dir = directory(t, new Map());
  const file = path.join(dir, 'native.tar.gz');
  fs.writeFileSync(
    file,
    tar(
      [...files].map(([name, text]) => [`export/${name}`, text]),
      extra,
    ),
  );
  return file;
}

test('native directory and tar.gz preserve canonical content, historical errors and source order', async t => {
  const dir = directory(t);
  const before = fs.readFileSync(path.join(dir, 'SHA256SUMS'));
  const a = await loadReplayInput(dir);
  const b = await loadReplayInput(archive(t));
  assert.deepEqual(a.events, b.events);
  assert.equal(a.events.length, 10);
  assert.deepEqual(
    a.events.map(r => r.source.sourceLine),
    [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
  );
  assert.equal(a.events.filter(r => r.event.text === 'recorded answer').length, 1);
  assert.equal(a.events[5].event.error, true);
  assert.equal(a.events[5].event.message, 'original note');
  assert.equal(a.events[9].event.type, 'done');
  assert.equal(a.manifest.status, 'complete');
  assert.equal(a.native.toolErrors, 1);
  assert.equal(a.native.verifiedFiles, 5);
  assert.deepEqual(validateManifest(a.manifest), []);
  assert.deepEqual(
    validateEventStream(a.events.map(JSON.stringify).join('\n') + '\n', a.manifest.limits).errors,
    [],
  );
  assert.ok(a.warnings.some(w => w.startsWith('native:source-order:')));
  assert.deepEqual(fs.readFileSync(path.join(dir, 'SHA256SUMS')), before);
});
test('existing Harness recording bundles still load through the same input API', async () => {
  const b = await loadReplayInput(path.join(__dirname, '../fixtures/success-demo'));
  assert.equal(b.manifest.status, 'complete');
  assert.ok(b.events.length);
});
test('checksum corruption and uncovered members fail explicitly', async t => {
  const files = seal(fixture());
  files.set('do-not-run.py', 'changed');
  await assert.rejects(loadReplayInput(archive(t, files)), { code: 'native:checksum-mismatch' });
  await assert.rejects(loadReplayInput(archive(t, seal(fixture()), [['export/extra', 'bad']])), {
    code: 'native:checksum-missing',
  });
});
test('links, traversal, duplicate members and absolute paths are rejected', async t => {
  for (const extra of [
    [['export/link', '', '2']],
    [['../escape', 'bad']],
    [['/absolute', 'bad']],
    [['export/manifest.json', '{}']],
  ]) {
    await assert.rejects(loadReplayInput(archive(t, seal(fixture()), extra)), error =>
      /^native:(member-type|unsafe-path|duplicate-member)$/.test(error.code),
    );
  }
  const dir = directory(t);
  fs.symlinkSync('/etc/hosts', path.join(dir, 'linked'));
  await assert.rejects(loadReplayInput(dir), { code: 'native:unsafe-link' });
});
test('bounded archive and directory resources reject oversize inputs', async t => {
  const file = archive(t);
  await assert.rejects(loadReplayInput(file, { limits: { maxArchiveBytes: 10 } }), {
    code: 'native:archive-size',
  });
  await assert.rejects(loadReplayInput(file, { limits: { maxEntries: 2 } }), {
    code: 'native:entry-limit',
  });
  await assert.rejects(loadReplayInput(file, { limits: { maxMemberBytes: 10 } }), {
    code: 'native:size-limit',
  });
  await assert.rejects(loadReplayInput(file, { limits: { maxCompressionRatio: 1 } }), {
    code: 'native:compression-ratio',
  });
  await assert.rejects(loadReplayInput(directory(t), { limits: { maxTotalBytes: 10 } }), {
    code: 'native:size-limit',
  });
});
test('native source count, identity, ordering gaps, orphan results and torn streams fail loudly', async t => {
  const mutations = [
    files => {
      const m = JSON.parse(files.get('manifest.json'));
      m.statistics.event_count++;
      files.set('manifest.json', JSON.stringify(m));
    },
    files => {
      const lines = files.get('events.timeline.jsonl').trim().split('\n');
      lines.push(lines[0]);
      files.set('events.timeline.jsonl', lines.join('\n') + '\n');
    },
    files => {
      const lines = files.get('events.timeline.jsonl').trim().split('\n').map(JSON.parse);
      const r = lines.find(r => r.source_line === 5);
      r.raw.event.toolCallId = 'different';
      files.set('events.timeline.jsonl', lines.map(JSON.stringify).join('\n') + '\n');
    },
    files => files.set('events.timeline.jsonl', files.get('events.timeline.jsonl').trimEnd()),
  ];
  for (const mutate of mutations) {
    const files = fixture();
    mutate(files);
    await assert.rejects(loadReplayInput(archive(t, seal(files))), error =>
      error.code.startsWith('native:'),
    );
  }
});
test('PAX metadata names are passive and effective traversal paths are rejected', async t => {
  const value = 'path=../escape\n';
  let length = value.length + 2;
  while (String(length).length + 1 + value.length !== length)
    length = String(length).length + 1 + value.length;
  const pax = `${length} ${value}`;
  await assert.rejects(
    loadReplayInput(
      archive(t, seal(fixture()), [
        ['././@PaxHeader', pax, 'x'],
        ['export/payload', 'bad'],
      ]),
    ),
    { code: 'native:unsafe-path' },
  );
  const oversized = archive(t, seal(fixture()), [['././@PaxHeader', 'x'.repeat(1024), 'x']]);
  await assert.rejects(loadReplayInput(oversized, { limits: { maxPaxBytes: 512 } }), {
    code: 'native:tar-pax-limit',
  });
  const fields = archive(t, seal(fixture()), [['././@PaxHeader', '6 a=b\n6 c=d\n', 'x']]);
  await assert.rejects(loadReplayInput(fields, { limits: { maxPaxFields: 1 } }), {
    code: 'native:tar-pax-limit',
  });
});
test('a rootless archive cannot redefine its root and overwrite a verified member', async t => {
  const files = seal(fixture());
  const dir = directory(t, new Map());
  const file = path.join(dir, 'mixed.tar.gz');
  fs.writeFileSync(
    file,
    tar([
      ['manifest.json', 'unverified'],
      ...[...files].map(([name, text]) => [`export/${name}`, text]),
    ]),
  );
  await assert.rejects(loadReplayInput(file), { code: 'native:checksums-missing' });
  fs.writeFileSync(file, tar([...files]));
  assert.equal((await loadReplayInput(file)).events.length, 10);
});
test('malformed native content never invents a successful result', async t => {
  const files = fixture();
  const lines = files.get('events.timeline.jsonl').trim().split('\n').map(JSON.parse);
  delete lines.find(entry => entry.raw.event?.type === 'tool.result').raw.event.result;
  files.set('events.timeline.jsonl', lines.map(JSON.stringify).join('\n') + '\n');
  await assert.rejects(loadReplayInput(archive(t, seal(files))), { code: 'native:result-shape' });
});
test('post-terminal content is an incomplete tail even when an earlier turn completed', async t => {
  const files = fixture();
  const lines = files.get('events.timeline.jsonl').trim().split('\n').map(JSON.parse);
  lines.push({
    ...lines[0],
    source_line: 11,
    event_id: 'main:11',
    timestamp_ms: 10200,
    event_type: 'context.append_loop_event',
    raw: {
      type: 'context.append_loop_event',
      event: {
        type: 'content.part',
        turnId: '1',
        part: { type: 'text', text: 'unfinished new activity' },
      },
    },
  });
  files.set('events.timeline.jsonl', lines.map(JSON.stringify).join('\n') + '\n');
  const m = JSON.parse(files.get('manifest.json'));
  m.statistics.event_count++;
  files.set('manifest.json', JSON.stringify(m));
  const bundle = await loadReplayInput(archive(t, seal(files)));
  assert.equal(bundle.manifest.status, 'incomplete');
  assert.equal(bundle.manifest.outcome, 'unknown');
  assert.equal(bundle.events.at(-1).event.text, 'unfinished new activity');
});
test('non-contiguous native turn identity is retained for prompts, content and terminals', async t => {
  const files = fixture();
  const lines = files.get('events.timeline.jsonl').trim().split('\n').map(JSON.parse);
  for (const entry of lines) {
    if (entry.raw.type === 'turn.prompt' || entry.raw.type === 'turn.ended') entry.raw.turnId = 42;
    if (entry.raw.event?.turnId !== undefined) entry.raw.event.turnId = '42';
  }
  files.set('events.timeline.jsonl', lines.map(JSON.stringify).join('\n') + '\n');
  const bundle = await loadReplayInput(archive(t, seal(files)));
  assert.ok(bundle.events.every(record => record.origin.turnId === 'main-turn-42'));
});
