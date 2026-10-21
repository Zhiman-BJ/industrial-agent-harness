#!/usr/bin/env node
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { createRequire } = require('node:module');
const { execFileSync } = require('node:child_process');

function packagedPaths(executable, platform = process.platform) {
  const directory = path.dirname(executable);
  return {
    executable,
    archive:
      platform === 'darwin'
        ? path.join(path.dirname(directory), 'Resources', 'app.asar')
        : path.join(directory, 'resources', 'app.asar'),
  };
}

async function child(archive, directory, python) {
  const appRequire = createRequire(path.join(archive, 'electron', 'main.cjs'));
  const { RasterService, resolveLayoutScript } = appRequire(
    '@industrial-agent-harness/viewer-builtin/runtime/layout',
  );
  const script = resolveLayoutScript();
  assert.ok(script.startsWith(archive + '.unpacked' + path.sep));
  const companion = path.join(path.dirname(script), 'layout_themes.py');
  for (const file of [script, companion]) assert.ok(fs.statSync(file).isFile());
  const result = {
    version: appRequire('../package.json').version,
    script,
    companion,
    archiveModule: true,
    rendered: false,
  };
  if (python) {
    const fixture = path.join(directory, 'packaged-layout.gds');
    execFileSync(
      python,
      [
        '-B',
        '-E',
        '-s',
        '-c',
        `import klayout.db as db; l=db.Layout(); l.dbu=0.001; c=l.create_cell('PACKAGED_TOP'); c.shapes(l.layer(1,0)).insert(db.Box(0,0,1000,1000)); l.write(${JSON.stringify(fixture)})`,
      ],
      { encoding: 'utf8', timeout: 30000, windowsHide: true },
    );
    const service = new RasterService(python);
    try {
      const loaded = await service.call({ op: 'load', path: fixture, token: 'packaged' });
      assert.equal(loaded.cell, 'PACKAGED_TOP');
      assert.equal(loaded.layers.length, 1);
      const rendered = await service.call({
        op: 'render',
        token: 'packaged',
        box: loaded.bbox,
        width: 128,
        height: 128,
        visible: loaded.layers.map(item => item.key),
        quality: 'fine',
      });
      const png = Buffer.from(rendered.png, 'base64');
      assert.equal(png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
      fs.writeFileSync(path.join(directory, 'packaged-layout.png'), png);
      Object.assign(result, {
        rendered: true,
        cell: loaded.cell,
        layers: loaded.layers.length,
        klayout: loaded.klayout,
      });
    } finally {
      service.close();
    }
  }
  process.stdout.write(JSON.stringify(result) + '\n');
}

function verifyPackagedLayout(
  executable,
  { python = process.env.KLAYOUT_PYTHON, requireRender = false } = {},
) {
  const { archive } = packagedPaths(executable);
  assert.ok(fs.statSync(executable).isFile(), 'Packaged Desktop executable is missing.');
  assert.ok(fs.statSync(archive).isFile(), 'Packaged app.asar is missing.');
  if (requireRender && !python)
    throw Error('Set KLAYOUT_PYTHON for the required packaged GDS render.');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'industrial-packaged-layout-'));
  try {
    // Load the actual shipped JS through Electron's ASAR filesystem. It must
    // resolve external Python scripts to physical files, never source copies.
    const stdout = execFileSync(
      executable,
      [__filename, '--child', archive, directory, python || ''],
      {
        cwd: directory,
        encoding: 'utf8',
        timeout: 60000,
        windowsHide: true,
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      },
    );
    const result = JSON.parse(stdout.trim());
    assert.equal(result.archiveModule, true);
    assert.ok(result.script.startsWith(archive + '.unpacked' + path.sep));
    // This process is ordinary Node, without Electron's ASAR filesystem patch.
    // Reading here proves the interpreter receives actual on-disk bytes.
    result.scripts = [result.script, result.companion].map(file => {
      assert.ok(fs.statSync(file).isFile());
      const bytes = fs.readFileSync(file);
      assert.ok(bytes.length > 0, 'Packaged Python files must not be empty.');
      return {
        file: path.relative(path.dirname(archive), file),
        sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
      };
    });
    delete result.script;
    delete result.companion;
    result.externalRead = true;
    if (requireRender) assert.equal(result.rendered, true);
    return result;
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

async function main() {
  if (process.argv[2] === '--child') return child(...process.argv.slice(3));
  const selected = process.argv.indexOf('--executable');
  if (selected < 0 || !process.argv[selected + 1])
    throw Error(
      'Usage: node scripts/smoke-packaged-layout.cjs --executable <packaged-app-executable> [--require-render]',
    );
  const result = verifyPackagedLayout(path.resolve(process.argv[selected + 1]), {
    requireRender: process.argv.includes('--require-render'),
  });
  process.stdout.write(JSON.stringify(result) + '\n');
}

module.exports = { packagedPaths, verifyPackagedLayout };
if (require.main === module)
  main().catch(error => {
    console.error(error);
    process.exitCode = 1;
  });
