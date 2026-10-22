#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const Module = require('node:module');

const digest = value => crypto.createHash('sha256').update(value).digest('hex');
const objectDigest = value => digest(JSON.stringify(value));
const wirePath = /(?:^|\/)raw\/session\/agents\/([^/]+)\/wire\.jsonl$/;

function installOfflineGuards() {
  const attempts = [];
  const restores = [];
  const deny = operation => {
    attempts.push(operation);
    throw Error(`Replay attempted a forbidden operation: ${operation}`);
  };
  const patch = (object, key, label, replace) => {
    if (typeof object[key] !== 'function') return;
    const original = object[key];
    object[key] = replace || (() => deny(`${label}.${key}`));
    restores.push(() => (object[key] = original));
  };
  for (const name of ['fetch', 'WebSocket', 'EventSource']) patch(globalThis, name, 'global');
  const surfaces = [
    [
      'node:child_process',
      ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork'],
    ],
    ['node:http', ['request', 'get', 'createServer']],
    ['node:https', ['request', 'get', 'createServer']],
    ['node:http2', ['connect', 'createServer', 'createSecureServer']],
    ['node:net', ['connect', 'createConnection', 'createServer']],
    ['node:tls', ['connect', 'createServer']],
    ['node:dgram', ['createSocket']],
    ['node:dns', ['lookup', 'resolve', 'resolve4', 'resolve6']],
    ['node:worker_threads', ['Worker']],
  ];
  for (const [name, methods] of surfaces) {
    const surface = require(name);
    for (const method of methods) patch(surface, method, name);
  }
  patch(require('node:net').Socket.prototype, 'connect', 'net.Socket');
  patch(require('node:net').Server.prototype, 'listen', 'net.Server');
  for (const method of ['lookup', 'resolve', 'resolve4', 'resolve6'])
    patch(require('node:dns').promises, method, 'dns.promises');
  const mutations = [
    'appendFile',
    'chmod',
    'chown',
    'copyFile',
    'cp',
    'createWriteStream',
    'fchmod',
    'fchown',
    'ftruncate',
    'futimes',
    'lchmod',
    'lchown',
    'link',
    'lutimes',
    'mkdir',
    'mkdtemp',
    'rename',
    'rm',
    'rmdir',
    'symlink',
    'truncate',
    'unlink',
    'utimes',
    'write',
    'writeFile',
    'writev',
  ];
  for (const method of mutations) {
    patch(fs, method, 'fs');
    patch(fs, `${method}Sync`, 'fs');
    patch(fs.promises, method, 'fs.promises');
  }
  for (const [surface, label, names] of [
    [fs, 'fs', ['open', 'openSync']],
    [fs.promises, 'fs.promises', ['open']],
  ]) {
    for (const name of names) {
      const original = surface[name];
      patch(surface, name, label, function (file, flags, ...rest) {
        const writes =
          typeof flags === 'number'
            ? flags &
              (fs.constants.O_WRONLY |
                fs.constants.O_RDWR |
                fs.constants.O_CREAT |
                fs.constants.O_TRUNC |
                fs.constants.O_APPEND)
            : flags !== 'r' && flags !== 'rs';
        if (writes) deny(`${label}.${name}(write)`);
        return original.call(this, file, flags, ...rest);
      });
    }
  }
  const originalLoad = Module._load;
  Module._load = function (request, parent, isMain) {
    if (
      /(?:^|[/\\])(?:agent-kimi|harness-application|domain-runtime|execution-backends?)(?:[/\\]|$)|^(?:electron|openai|undici|@anthropic-ai\/sdk|@moonshot-ai\/kimi-code)(?:\/|$)/.test(
        request,
      )
    )
      deny(`live-module:${request}`);
    return originalLoad.call(this, request, parent, isMain);
  };
  restores.push(() => (Module._load = originalLoad));
  Module.syncBuiltinESMExports();
  return {
    attempts,
    restore() {
      while (restores.length) restores.pop()();
      Module.syncBuiltinESMExports();
    },
  };
}

async function hashFile(file) {
  const hash = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

// Read tar data directly. Archive names are data; no archive command or embedded script runs.
async function scanArchive(file, accept) {
  const input = fs.createReadStream(file);
  const stream = input.pipe(zlib.createGunzip());
  input.on('error', error => stream.destroy(error));
  let pending = Buffer.alloc(0);
  let remaining = 0;
  let padding = 0;
  let name = null;
  let chunks = null;
  let kind = '';
  let pax = {};
  let globalPax = {};
  const finish = () => {
    const bytes = Buffer.concat(chunks);
    if (kind === 'x' || kind === 'g') {
      const attributes = {};
      let offset = 0;
      while (offset < bytes.length) {
        const space = bytes.indexOf(32, offset);
        const length = Number(bytes.subarray(offset, space).toString());
        assert.ok(
          space > offset &&
            Number.isSafeInteger(length) &&
            length > 0 &&
            offset + length <= bytes.length,
          'Invalid PAX metadata',
        );
        const field = bytes.subarray(space + 1, offset + length - 1).toString('utf8');
        const equal = field.indexOf('=');
        assert.ok(equal > 0, 'Invalid PAX field');
        attributes[field.slice(0, equal)] = field.slice(equal + 1);
        offset += length;
      }
      if (kind === 'g') globalPax = { ...globalPax, ...attributes };
      else pax = attributes;
    } else accept(name, bytes);
    chunks = null;
  };
  const names = new Set();
  try {
    for await (const chunk of stream) {
      pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
      while (pending.length) {
        if (remaining) {
          const take = Math.min(remaining, pending.length);
          if (chunks) chunks.push(pending.subarray(0, take));
          pending = pending.subarray(take);
          remaining -= take;
          if (!remaining && chunks) {
            finish();
          }
        } else if (padding) {
          const take = Math.min(padding, pending.length);
          pending = pending.subarray(take);
          padding -= take;
        } else {
          if (pending.length < 512) break;
          const header = pending.subarray(0, 512);
          pending = pending.subarray(512);
          if (header.every(byte => byte === 0)) continue;
          const field = (offset, length) =>
            header
              .subarray(offset, offset + length)
              .toString('utf8')
              .replace(/\0.*$/s, '');
          const prefix = field(345, 155);
          name = [prefix, field(0, 100)].filter(Boolean).join('/');
          kind = field(156, 1);
          assert.ok(
            ['', '0', '5', 'x', 'g'].includes(kind),
            `Unsupported archive entry ${name}: ${kind}`,
          );
          if (kind !== 'x' && kind !== 'g') {
            const attributes = { ...globalPax, ...pax };
            name = attributes.path || name;
            assert.ok(
              !attributes.linkpath && !attributes.size,
              'Unsupported PAX link/size override',
            );
            pax = {};
            assert.ok(
              !name.startsWith('/') && !name.split('/').includes('..'),
              `Unsafe archive name ${name}`,
            );
            assert.ok(!names.has(name), `Duplicate archive name ${name}`);
            names.add(name);
          }
          remaining = Number.parseInt(field(124, 12).trim() || '0', 8);
          assert.ok(
            Number.isSafeInteger(remaining) && remaining >= 0,
            `Invalid archive size ${name}`,
          );
          padding = (512 - (remaining % 512)) % 512;
          chunks =
            kind === 'x' ||
            kind === 'g' ||
            wirePath.test(name) ||
            /(?:^|\/)manifest\.json$/.test(name)
              ? []
              : null;
          if (!remaining && chunks) {
            finish();
          }
        }
      }
    }
    assert.equal(remaining, 0, 'Truncated archive member');
    assert.equal(padding, 0, 'Truncated archive padding');
    assert.equal(pending.length, 0, 'Truncated archive header');
  } finally {
    input.destroy();
    stream.destroy();
  }
}

async function readNativeSource(input) {
  const expected = new Map();
  const agents = new Map();
  const files = [];
  let manifest;
  const accept = (name, bytes, file) => {
    const match = name.match(wirePath);
    if (!match) {
      if (/(?:^|\/)manifest\.json$/.test(name)) manifest = JSON.parse(bytes.toString('utf8'));
      return;
    }
    const agentId = match[1];
    assert.ok(!agents.has(agentId), `Duplicate wire file for ${agentId}`);
    const summary = {
      id: agentId,
      events: 0,
      toolCalls: 0,
      toolResults: 0,
      historicalToolErrors: 0,
      thinking: 0,
      texts: 0,
      turnEnds: 0,
      compactions: 0,
    };
    agents.set(agentId, summary);
    files.push({ path: file, name, sha256: digest(bytes), bytes: bytes.length });
    let line = 0;
    for (const text of bytes.toString('utf8').split('\n')) {
      line++;
      if (!text.trim()) continue;
      const raw = JSON.parse(text);
      const event = raw.type === 'context.append_loop_event' ? raw.event : null;
      const entry = { agentId, sourceLine: line, rawType: raw.type, rawHash: objectDigest(raw) };
      if (event?.type === 'tool.call') {
        summary.toolCalls++;
        entry.tool = {
          id: `${agentId}:${event.toolCallId}`,
          name: event.name,
          argumentsHash: objectDigest(event.args),
        };
      } else if (event?.type === 'tool.result') {
        summary.toolResults++;
        summary.historicalToolErrors += Number(Boolean(event.result.isError));
        entry.result = {
          id: `${agentId}:${event.toolCallId}`,
          error: Boolean(event.result.isError),
          outputHash: digest(event.result.output),
          outputBytes: Buffer.byteLength(event.result.output),
          message: event.result.note || '',
        };
      } else if (event?.type === 'content.part') {
        const part = event.part;
        if (part.type === 'think' || part.type === 'text') {
          const type = part.type === 'think' ? 'thinking' : 'text';
          summary[type === 'thinking' ? 'thinking' : 'texts']++;
          entry.content = { type, hash: digest(type === 'thinking' ? part.think : part.text) };
        }
      }
      summary.turnEnds += Number(raw.type === 'turn.ended');
      summary.compactions += Number(raw.type === 'context.apply_compaction');
      summary.events++;
      expected.set(`${agentId}:${line}`, entry);
    }
  };
  const stat = fs.statSync(input);
  if (stat.isDirectory()) {
    let root = input;
    if (!fs.existsSync(path.join(root, 'raw/session/agents'))) {
      const roots = fs
        .readdirSync(root, { withFileTypes: true })
        .filter(
          entry =>
            entry.isDirectory() && fs.existsSync(path.join(root, entry.name, 'raw/session/agents')),
        );
      assert.equal(roots.length, 1, 'Expected one native export directory');
      root = path.join(root, roots[0].name);
    }
    const manifestPath = path.join(root, 'manifest.json');
    if (fs.existsSync(manifestPath)) accept('manifest.json', fs.readFileSync(manifestPath));
    const directory = path.join(root, 'raw/session/agents');
    for (const entry of fs
      .readdirSync(directory, { withFileTypes: true })
      .sort((a, b) => a.name.localeCompare(b.name))) {
      if (!entry.isDirectory()) continue;
      const relative = `raw/session/agents/${entry.name}/wire.jsonl`;
      const file = path.join(root, relative);
      assert.ok(fs.lstatSync(file).isFile(), `Wire source must be a regular file: ${file}`);
      accept(relative, fs.readFileSync(file), file);
    }
  } else {
    assert.ok(stat.isFile(), 'Expected a native export directory or tar.gz archive');
    await scanArchive(input, accept);
    files.push({
      path: input,
      name: path.basename(input),
      sha256: await hashFile(input),
      bytes: stat.size,
    });
  }
  assert.ok(expected.size > 0, 'No native wire events found');
  return { expected, agents: [...agents.values()], files, manifest };
}

function verifyRecords(bundle, source) {
  assert.ok(bundle.native, 'Input was not recognized as a native trajectory');
  assert.equal(bundle.events.length, source.expected.size, 'Every source event must reach replay');
  assert.equal(bundle.native.sourceEventCount, source.expected.size);
  const seen = new Set();
  const lastLine = new Map();
  let lastRelMs = 0;
  let historicalToolErrors = 0;
  const contentHashes = {
    thinking: crypto.createHash('sha256'),
    text: crypto.createHash('sha256'),
    toolArguments: crypto.createHash('sha256'),
    toolOutputs: crypto.createHash('sha256'),
  };
  for (const [index, record] of bundle.events.entries()) {
    const native = record.source;
    assert.ok(native && typeof native.raw === 'object', `Missing original raw event at ${index}`);
    const agentId = record.origin.agentId;
    const key = `${agentId}:${native.sourceLine}`;
    const expected = source.expected.get(key);
    assert.ok(expected, `Unknown source location ${key}`);
    assert.ok(!seen.has(key), `Repeated source location ${key}`);
    seen.add(key);
    assert.equal(native.eventId, key);
    assert.ok(native.sourceFile.endsWith(`raw/session/agents/${agentId}/wire.jsonl`));
    assert.equal(native.type, expected.rawType);
    assert.equal(
      objectDigest(native.raw),
      expected.rawHash,
      `Original native event changed: ${key}`,
    );
    assert.ok(
      native.sourceLine > (lastLine.get(agentId) || 0),
      `Native agent order regressed: ${key}`,
    );
    lastLine.set(agentId, native.sourceLine);
    assert.equal(record.seq, index + 1);
    assert.ok(
      Number.isFinite(record.relMs) && record.relMs >= lastRelMs,
      `Presentation time regressed: ${key}`,
    );
    lastRelMs = record.relMs;
    assert.equal(record.event.replayAgentId, agentId);
    assert.equal(record.event.replayTurnId, record.origin.turnId);
    assert.ok(record.event.replayTurnId, `Missing native turn scope: ${key}`);
    const event = record.event;
    if (expected.rawType === 'agent.message.appended')
      assert.equal(event.type, 'status', `Native mirror duplicated visible content: ${key}`);
    if (expected.tool) {
      assert.equal(event.type, 'tool');
      assert.equal(event.id, expected.tool.id);
      assert.equal(event.name, expected.tool.name);
      assert.equal(
        objectDigest(JSON.parse(event.arguments)),
        expected.tool.argumentsHash,
        `Tool arguments changed: ${key}`,
      );
      contentHashes.toolArguments.update(key).update(expected.tool.argumentsHash);
    } else if (expected.result) {
      assert.equal(event.type, 'tool-result');
      for (const name of ['id', 'error', 'outputBytes', 'message'])
        assert.equal(event[name], expected.result[name], `${key}: ${name}`);
      assert.equal(digest(event.output), expected.result.outputHash, `Tool output changed: ${key}`);
      historicalToolErrors += Number(event.error);
      contentHashes.toolOutputs.update(key).update(expected.result.outputHash);
    } else if (expected.content) {
      assert.equal(event.type, expected.content.type);
      assert.equal(digest(event.text), expected.content.hash, `Native content changed: ${key}`);
      contentHashes[expected.content.type].update(key).update(expected.content.hash);
    }
  }
  assert.equal(seen.size, source.expected.size);
  assert.equal(
    historicalToolErrors,
    source.agents.reduce((sum, agent) => sum + agent.historicalToolErrors, 0),
  );
  for (const agent of source.agents) {
    const imported = bundle.native.agents.find(entry => entry.id === agent.id);
    assert.ok(imported, `Missing agent ${agent.id}`);
    assert.equal(imported.eventCount, agent.events);
    assert.equal(imported.toolCalls, agent.toolCalls);
    assert.equal(imported.toolResults, agent.toolResults);
  }
  if (source.manifest?.statistics?.event_count !== undefined)
    assert.equal(bundle.events.length, source.manifest.statistics.event_count);
  return {
    sourceEvents: seen.size,
    historicalToolErrors,
    contentHashes: Object.fromEntries(
      Object.entries(contentHashes).map(([name, hash]) => [name, hash.digest('hex')]),
    ),
  };
}

function verifyEngine(records) {
  const { createReplayEngine } = require('../packages/harness-replay');
  const engine = createReplayEngine(records);
  const initial = objectDigest(engine.snapshot());
  engine.play();
  const duration = engine.timeline.durationMs;
  const delta = Math.max(1, duration / 64);
  let ticks = 0;
  while (!engine.snapshot().atEnd && ticks < 70) {
    engine.tick(delta);
    ticks++;
  }
  const completed = engine.snapshot();
  assert.equal(
    completed.position,
    records.length,
    'Playback did not consume the complete trajectory',
  );
  assert.equal(completed.atEnd, true);
  assert.equal(completed.phase, 'paused');
  assert.equal(completed.running, false, 'Completed native agents must not appear running');
  const displayHash = objectDigest(completed.display);
  engine.seekToPosition(records.length);
  assert.equal(
    objectDigest(engine.snapshot().display),
    displayHash,
    'End seek diverged from incremental replay',
  );
  const positions = [
    ...new Set([
      0,
      1,
      Math.floor(records.length / 3),
      Math.floor((records.length * 2) / 3),
      records.length,
    ]),
  ];
  for (const position of positions) {
    engine.seekToPosition(position);
    const sought = objectDigest(engine.snapshot().display);
    engine.reset();
    if (position) {
      engine.play();
      engine.tick(engine.timeline.displayAt(position));
      const advanced = engine.snapshot();
      // Equal timestamps reveal the full equal-time group during time-based playback.
      const actualPosition = advanced.position;
      const advancedHash = objectDigest(advanced.display);
      engine.seekToPosition(actualPosition);
      assert.equal(
        objectDigest(engine.snapshot().display),
        advancedHash,
        `Seek diverged at prefix ${actualPosition}`,
      );
    }
    engine.seekToPosition(position);
    assert.equal(
      objectDigest(engine.snapshot().display),
      sought,
      `Reset/seek diverged at prefix ${position}`,
    );
  }
  engine.setSpeed(4);
  engine.reset();
  assert.equal(
    objectDigest(engine.snapshot()),
    initial,
    'Reset did not restore the fresh engine state',
  );
  engine.play();
  engine.setSpeed(4);
  engine.tick(duration + 1);
  assert.equal(
    objectDigest(engine.snapshot().display),
    displayHash,
    'Replay after reset changed final display',
  );
  return {
    ticks,
    consumedEvents: completed.position,
    durationMs: duration,
    displayEvents: completed.display.length,
    displaySha256: displayHash,
    seekPositions: positions,
    resetMatchesFresh: true,
  };
}

async function verifyNativeReplay(inputPath) {
  const input = path.resolve(inputPath);
  const started = Date.now();
  const source = await readNativeSource(input);
  const guard = installOfflineGuards();
  let bundle;
  let coverage;
  let playback;
  try {
    const { loadReplayInput } = require('../packages/harness-recording');
    assert.equal(typeof loadReplayInput, 'function', 'Native replay importer is unavailable');
    bundle = await loadReplayInput(input);
    coverage = verifyRecords(bundle, source);
    playback = verifyEngine(bundle.events);
    assert.deepEqual(guard.attempts, [], 'Replay attempted live execution or a filesystem write');
  } finally {
    guard.restore();
  }
  for (const file of source.files)
    if (file.path)
      assert.equal(
        await hashFile(file.path),
        file.sha256,
        `Replay changed source file ${file.name}`,
      );
  return {
    schema: 'native-replay-acceptance/1',
    input,
    passed: true,
    elapsedMs: Date.now() - started,
    sourceFiles: source.files.map(({ path: file, ...entry }) => ({
      ...entry,
      ...(file ? { path: file } : {}),
    })),
    agents: source.agents,
    ...coverage,
    playback,
    offline: {
      attemptedOperations: guard.attempts,
      sourceFilesUnchanged: true,
      modelCalls: 0,
      toolCalls: 0,
      networkCalls: 0,
      externalLaunches: 0,
      filesystemWritesDuringReplay: 0,
    },
    warnings: bundle.warnings,
    missingAssets: bundle.missingAssets,
  };
}

if (require.main === module) {
  const [input, output, ...extra] = process.argv.slice(2);
  if (!input || extra.length) {
    console.error(
      'Usage: node scripts/verify-native-replay.cjs NATIVE_EXPORT_DIR_OR_TAR_GZ [REPORT_JSON]',
    );
    process.exitCode = 64;
  } else {
    verifyNativeReplay(input)
      .then(report => {
        const text = JSON.stringify(report, null, 2) + '\n';
        if (output) {
          const destination = path.resolve(output);
          const source = path.resolve(input);
          assert.ok(
            destination !== source && !destination.startsWith(source + path.sep),
            'Report must be outside the source input',
          );
          fs.writeFileSync(destination, text);
        }
        process.stdout.write(text);
      })
      .catch(error => {
        console.error(error.stack || error.message);
        process.exitCode = 1;
      });
  }
}

module.exports = { verifyNativeReplay, installOfflineGuards, readNativeSource };
