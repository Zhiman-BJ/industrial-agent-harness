#!/usr/bin/env node
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

async function verifyLauncher({ projectDir, shareDir, executable, agentEntry, timeoutMs = 15000 }) {
  agentEntry ||= require.resolve('@industrial-agent-harness/agent-kimi', {
    paths: [path.resolve(__dirname, '..')],
  });
  const { createProcessSandbox } = require(
    path.join(path.dirname(agentEntry), 'process-sandbox.cjs'),
  );
  const evidence = path.join(shareDir, 'process-boundary.json');
  fs.rmSync(evidence, { force: true });
  const launcher = createProcessSandbox({
    executable,
    projectDir,
    shareDir,
    kimiProjectAccess: true,
    environment: { ...process.env, HARNESS_INSTALLER_HOST_ONLY: 'installer-host-only' },
    hostOnlyEnv: ['HARNESS_INSTALLER_HOST_ONLY'],
  });
  try {
    // The launcher always keeps the project writable (the startup probe below
    // relies on it); whether an OS isolation layer confines the rest depends
    // on the host platform's primitives.
    if (process.platform === 'darwin') {
      assert.equal(launcher.boundary.mechanism, 'seatbelt');
      assert.equal(launcher.boundary.osIsolation, true);
    } else if (process.platform === 'linux') {
      assert.ok(['bubblewrap', 'current-user'].includes(launcher.boundary.mechanism));
    } else {
      assert.equal(launcher.boundary.mechanism, 'current-user');
      assert.equal(launcher.boundary.osIsolation, false);
    }
    assert.equal(launcher.boundary.projectWritable, true);
    assert.equal(launcher.env.HARNESS_INSTALLER_HOST_ONLY, undefined);
    const script = /\.[cm]?js$/i.test(launcher.executable);
    const child = launcher.spawn(
      script ? process.execPath : launcher.executable,
      [...(script ? [launcher.executable] : []), '--version'],
      { env: launcher.env, cwd: launcher.workDir, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let stdout = '',
      stderr = '',
      timedOut = false;
    child.stdout.on('data', chunk => {
      stdout += chunk;
    });
    child.stderr.on('data', chunk => {
      stderr += chunk;
    });
    const timer = setTimeout(() => {
      timedOut = true;
      launcher.close();
    }, timeoutMs);
    try {
      const status = await new Promise((resolve, reject) => {
        child.once('error', reject);
        child.once('close', resolve);
      });
      assert.equal(timedOut, false, 'Kimi startup timed out');
      assert.equal(status, 0, stderr || 'Current-user Kimi startup failed');
      assert.match(stdout, /2\.1\.1/, 'Unexpected bundled Kimi version');
    } finally {
      clearTimeout(timer);
    }
    fs.writeFileSync(evidence, JSON.stringify(launcher.boundary, null, 2) + '\n');
    return launcher.boundary;
  } finally {
    launcher.close();
  }
}

if (require.main === module) {
  const [projectDir, shareDir, executable, ...extra] = process.argv.slice(2);
  if (!projectDir || !shareDir || !executable || extra.length) {
    console.error('Usage: node verify-kimi-launcher.cjs PROJECT_DIR SHARE_DIR KIMI_EXECUTABLE');
    process.exitCode = 64;
  } else
    verifyLauncher({ projectDir, shareDir, executable }).catch(error => {
      console.error(error);
      process.exitCode = 1;
    });
}
module.exports = { verifyLauncher };
