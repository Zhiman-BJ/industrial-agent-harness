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
  let docker;
  if (contextHost && process.platform !== 'win32') {
    // Posix stub: answers `docker context inspect` with the given endpoint.
    const lines = ['#!/bin/sh', 'if [ "$1" = "context" ]; then'];
    lines.push(`echo '${contextHost}'`, 'exit 0', 'fi', 'exit 1');
    docker = path.join(bin, 'docker');
    fs.writeFileSync(docker, lines.join('\n'), { mode: 0o755 });
  } else {
    // Cross-platform stub: node itself errors out on the probe args,
    // which exercises the fallback path exactly like a dead endpoint.
    docker = process.execPath;
  }
  for (const socket of sockets) {
    const file = path.join(home, socket);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '');
  }
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { docker, home };
}

test('explicit DOCKER_HOST always wins and the CLI is never probed', () => {
  const host = resolveDockerHost(path.join('nonexistent', 'docker'), {
    DOCKER_HOST: 'tcp://docker.internal:2375',
  });
  assert.equal(host, 'tcp://docker.internal:2375');
});

test('active context endpoint is honored (Docker Desktop / colima / lima)', t => {
  if (process.platform === 'win32') {
    // The shell stub cannot execute on win32; the fallback-path tests below
    // cover the same resolver with node itself as the failing probe.
    assert.ok(resolveDockerHost(process.execPath, { HOME: os.tmpdir() }) !== undefined);
    return;
  }
  const { docker, home } = fixture(t, {
    contextHost: 'unix:///Users/x/.colima/default/docker.sock',
  });
  const host = resolveDockerHost(docker, { PATH: path.dirname(docker), HOME: home });
  assert.equal(host, 'unix:///Users/x/.colima/default/docker.sock');
});

test('sandboxed HOME falls back to well-known socket probing', t => {
  const { docker, home } = fixture(t, {
    sockets: ['.docker/run/docker.sock', '.colima/default/docker.sock'],
  });
  const host = resolveDockerHost(docker, { PATH: path.dirname(docker), HOME: home });
  assert.ok(host && host.startsWith('unix://'), 'expected a unix:// endpoint, got ' + host);
  if (!fs.existsSync('/var/run/docker.sock'))
    assert.equal(host, 'unix://' + path.join(home, '.docker/run/docker.sock'));
});

test('with no usable endpoint the default socket still wins when present', t => {
  const { docker, home } = fixture(t);
  const host = resolveDockerHost(docker, { PATH: path.dirname(docker), HOME: home });
  if (fs.existsSync('/var/run/docker.sock')) assert.equal(host, 'unix:///var/run/docker.sock');
  else assert.equal(host, null);
});
