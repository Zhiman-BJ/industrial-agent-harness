const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { createProcessSandbox } = require('../src/process-sandbox.cjs');

test(
  'a real descendant process can write session scratch but cannot overwrite project, lateral files, metadata or sandbox launcher',
  { skip: !['darwin', 'linux'].includes(process.platform) },
  t => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'boundary-test-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    for (const name of ['project', 'share', 'state']) fs.mkdirSync(path.join(directory, name));
    const projectFile = path.join(directory, 'project', 'counter.sv');
    fs.writeFileSync(projectFile, 'engineering source');
    const sandbox = createProcessSandbox({
      executable: '/usr/bin/python3',
      shareDir: path.join(directory, 'share'),
      projectDir: path.join(directory, 'project'),
      protectedPaths: [path.join(directory, 'state')],
      environment: {
        ...process.env,
        KIMI_SHARE_DIR: path.join(directory, 'foreign-share'),
        HARNESS_TEST_REMOTE_TOKEN: 'host-only-secret',
      },
      hostOnlyEnv: ['HARNESS_TEST_REMOTE_TOKEN'],
    });
    t.after(() => sandbox.close());
    assert.equal(sandbox.env.KIMI_SHARE_DIR, fs.realpathSync(path.join(directory, 'share')));
    assert.equal(sandbox.env.HARNESS_TEST_REMOTE_TOKEN, undefined);
    const credentialProbe = spawnSync(
      sandbox.executable,
      ['-c', 'import os; assert "HARNESS_TEST_REMOTE_TOKEN" not in os.environ'],
      { env: sandbox.env, encoding: 'utf8' },
    );
    assert.equal(credentialProbe.status, 0, credentialProbe.stderr);
    fs.symlinkSync(path.join(directory, 'project'), path.join(directory, 'share', 'project-link'));
    const probe = `import json, pathlib, subprocess, sys\nresults=[]\nfor name in sys.argv[1:]:\n try:\n  pathlib.Path(name).write_text('bypass')\n  results.append(True)\n except OSError as error:\n  if error.errno not in (1,13,30): raise\n  results.append(False)\n# Descendants inherit the same restriction, including an arbitrary shell.\np=subprocess.run(['/bin/sh','-c','printf bypass > "$1"','probe',sys.argv[1]],capture_output=True)\nprint(json.dumps({'writes':results,'child':p.returncode}))`;
    const probeResult = spawnSync(
      sandbox.executable,
      [
        '-c',
        probe,
        projectFile,
        path.join(directory, 'outside'),
        path.join(directory, 'state', 'fake.sqlite'),
        sandbox.executable,
        path.join(directory, 'share', 'project-link', 'counter.sv'),
        path.join(directory, 'share', 'context.json'),
      ],
      { env: sandbox.env, encoding: 'utf8' },
    );
    assert.equal(probeResult.status, 0, probeResult.stderr);
    const result = JSON.parse(probeResult.stdout);
    assert.deepEqual(result.writes, [false, false, false, false, false, true]);
    assert.notEqual(result.child, 0);
    assert.equal(fs.readFileSync(projectFile, 'utf8'), 'engineering source');
  },
);

test(
  'session storage nested inside a protected runtime root stays writable while the root and project remain read-only',
  { skip: !['darwin', 'linux'].includes(process.platform) },
  t => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'boundary-nested-test-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    fs.mkdirSync(path.join(directory, 'project'));
    // Mirrors the desktop layout: settings.directory is protected and the
    // default chat session storage lives under it (chats/sessions/<id>).
    const settings = path.join(directory, 'settings');
    const share = path.join(settings, 'chats', 'sessions', 'chat-1');
    fs.mkdirSync(share, { recursive: true });
    const projectFile = path.join(directory, 'project', 'counter.sv');
    fs.writeFileSync(projectFile, 'engineering source');
    const sandbox = createProcessSandbox({
      executable: '/usr/bin/python3',
      shareDir: share,
      projectDir: path.join(directory, 'project'),
      protectedPaths: [settings],
    });
    t.after(() => sandbox.close());
    // Structural: the write allowance for share must come AFTER the
    // protected-root deny (seatbelt profile / bwrap mount order).
    if (process.platform === 'darwin') {
      const profile = fs.readFileSync(path.join(sandbox.directory, 'agent.sb'), 'utf8');
      const denyAt = profile.indexOf(
        `(deny file-write* (subpath ${JSON.stringify(fs.realpathSync(settings))}))`,
      );
      const allowAt = profile.indexOf(
        `(allow file-write* (subpath ${JSON.stringify(fs.realpathSync(share))})`,
      );
      assert.ok(denyAt !== -1 && allowAt !== -1, profile);
      assert.ok(denyAt < allowAt, profile);
    } else {
      const wrapper = fs.readFileSync(sandbox.executable, 'utf8');
      // Wrapper args are individually shell-quoted: '--ro-bind' '<path>'.
      const roAt = wrapper.indexOf(`'--ro-bind' '${fs.realpathSync(settings)}'`);
      const bindAt = wrapper.indexOf(`'--bind' '${fs.realpathSync(share)}'`);
      assert.ok(roAt !== -1 && bindAt !== -1, wrapper);
      assert.ok(roAt < bindAt, wrapper);
    }
    const probe = `import json, pathlib, sys\nresults=[]\nfor name in sys.argv[1:]:\n try:\n  pathlib.Path(name).write_text('bypass')\n  results.append(True)\n except OSError as error:\n  if error.errno not in (1,13,30): raise\n  results.append(False)\nprint(json.dumps(results))`;
    const probeResult = spawnSync(
      sandbox.executable,
      [
        '-c',
        probe,
        projectFile,
        path.join(settings, 'remote-settings.json'),
        path.join(settings, 'chats', 'other.sqlite'),
        path.join(share, 'context.json'),
      ],
      { env: sandbox.env, encoding: 'utf8' },
    );
    assert.equal(probeResult.status, 0, probeResult.stderr);
    assert.deepEqual(JSON.parse(probeResult.stdout), [false, false, false, true]);
    assert.equal(fs.readFileSync(projectFile, 'utf8'), 'engineering source');
  },
);

test(
  'session storage still cannot replace a protected root or live inside the project',
  { skip: !['darwin', 'linux'].includes(process.platform) },
  t => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'boundary-reject-test-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    for (const name of ['project', 'settings', 'share']) fs.mkdirSync(path.join(directory, name));
    fs.mkdirSync(path.join(directory, 'project', 'nested'));
    const base = {
      executable: '/usr/bin/python3',
      projectDir: path.join(directory, 'project'),
      protectedPaths: [path.join(directory, 'settings')],
    };
    assert.throws(
      () =>
        createProcessSandbox({
          ...base,
          shareDir: path.join(directory, 'settings'),
        }),
      /must not replace a protected root/,
    );
    assert.throws(
      () =>
        createProcessSandbox({
          ...base,
          shareDir: path.join(directory, 'project', 'nested'),
        }),
      /must be outside the protected project/,
    );
  },
);
