const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { resolveDockerHost } = require('../src/task-process.cjs');

function fixture(t, { contextHost = null, sockets = [] } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-docker-host-'));
  const bin = path.join(root, 'bin');
  const home = path.join(root, 'home');
  fs.mkdirSync(bin, { recursive: true });
  fs.mkdirSync(home, { recursive: true });
  const lines = ['#!/bin/sh', 'if [ "$1" = "context" ]; then'];
  if (contextHost) lines.push(`echo '${contextHost}'`, 'exit 0');
  lines.push('fi', 'exit 1');
  const docker = path.join(bin, 'docker');
  fs.writeFileSync(docker, lines.join('\n'), { mode: 0o755 });
  for (const socket of sockets) {
    const file = path.join(home, socket);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '');
  }
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { docker, home };
}

test('explicit DOCKER_HOST always wins and the CLI is never probed', t => {
  const host = resolveDockerHost(path.join('nonexistent', 'docker'), {
    DOCKER_HOST: 'tcp://docker.internal:2375',
  });
  assert.equal(host, 'tcp://docker.internal:2375');
});

test('active context endpoint is honored (Docker Desktop / colima / lima)', t => {
  if (process.platform === 'win32') return t.skip('shell stub needs posix');
  const { docker, home } = fixture(t, {
    contextHost: 'unix:///Users/x/.colima/default/docker.sock',
  });
  const host = resolveDockerHost(docker, { PATH: path.dirname(docker), HOME: home });
  assert.equal(host, 'unix:///Users/x/.colima/default/docker.sock');
});

test('sandboxed HOME falls back to well-known socket probing', t => {
  if (process.platform === 'win32') return t.skip('shell stub needs posix');
  const { docker, home } = fixture(t, {
    contextHost: null,
    sockets: ['.docker/run/docker.sock', '.colima/default/docker.sock'],
  });
  const host = resolveDockerHost(docker, { PATH: path.dirname(docker), HOME: home });
  assert.ok(host && host.startsWith('unix://'), 'expected a unix:// endpoint, got ' + host);
  if (!fs.existsSync('/var/run/docker.sock'))
    assert.equal(host, 'unix://' + path.join(home, '.docker/run/docker.sock'));
});

test('no context and no sockets resolves to null so the CLI error surfaces unchanged', t => {
  if (process.platform === 'win32') return t.skip('shell stub needs posix');
  if (fs.existsSync('/var/run/docker.sock')) return t.skip('host has the default socket');
  const { docker, home } = fixture(t, { contextHost: null });
  const host = resolveDockerHost(docker, { PATH: path.dirname(docker), HOME: home });
  assert.equal(host, null);
});
