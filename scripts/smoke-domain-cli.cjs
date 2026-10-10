#!/usr/bin/env node
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const assert = require('node:assert/strict');
const directory = path.resolve(process.argv[2]);
const domains = ['chip', 'pcb', 'godot', 'cad'];
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'domain-cli-smoke-'));
try {
  for (const domain of domains) {
    const entry = path.join(directory, `headless-${domain}`, 'industrial-harness.cjs');
    const packageRoot = path.dirname(entry);
    const filenames = fs.readdirSync(packageRoot).map(name => name.toLowerCase());
    assert.equal(
      new Set(filenames).size,
      filenames.length,
      'Package root filenames must coexist on case-insensitive filesystems.',
    );
    const identity = JSON.parse(
      fs.readFileSync(path.join(packageRoot, 'HARNESS-PACKAGE.json'), 'utf8'),
    );
    assert.equal(identity.domain, domain);
    assert.equal(
      JSON.parse(fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8')).name,
      '@industrial-agent-harness/cli',
      'Release identity must preserve the Node package manifest.',
    );
    const args = [
      'run',
      '--project-dir',
      temporary,
      '--task',
      domain === 'chip'
        ? '检查工程状态'
        : domain === 'pcb'
          ? 'Inspect PCB board'
          : domain === 'cad'
            ? 'FreeCAD 3D 零件建模'
            : 'Inspect project files',
      '--scope-only',
    ];
    const run = extra =>
      execFileSync(process.execPath, [entry, ...args, ...extra], {
        cwd: temporary,
        encoding: 'utf8',
        env: { ...process.env, INDUSTRIAL_HARNESS_CONFIG_DIR: path.join(temporary, 'config') },
      })
        .trim()
        .split('\n')
        .map(JSON.parse);
    const rows = run([]);
    assert.equal(rows[0].scope.domain, domain);
    assert.equal(rows.at(-1).status, 'scoped');
    assert.ok(
      rows[0].trace.find(row => row.event === 'domain.index').detail.count ===
        (domain === 'chip' ? 8 : domain === 'cad' ? 4 : domain === 'pcb' ? 8 : 1),
    );
    const denied = domain === 'chip' ? 'pcb' : 'chip';
    assert.throws(
      () => run(['--domain', denied]),
      error => error.stdout.includes(`fixed to the ${domain} domain`),
    );
    const skillsRoot = fs.realpathSync(
      path.join(path.dirname(entry), 'node_modules/@industrial-agent-harness/domain-skills'),
    );
    const inspect = `const {capabilities,listSkills,listDomains,domainPacks,loadRegistry}=require(${JSON.stringify(skillsRoot)});const fs=require('fs'),path=require('path');console.log(JSON.stringify({skills:listSkills(),capabilities:capabilities.map(c=>c.domain),domains:listDomains(capabilities),packs:domainPacks.map(p=>p.domain),nativeEntries:loadRegistry().runtimePacks.map(p=>({exists:fs.existsSync(path.join(p.directory,p.runtime.entry)),inside:path.relative(${JSON.stringify(packageRoot)},p.directory)}))}))`;
    const catalog = JSON.parse(
      execFileSync(process.execPath, ['-e', inspect], { cwd: temporary, encoding: 'utf8' }),
    );
    assert.ok(catalog.skills.every(skill => skill.domain === domain || skill.domain === '*'));
    assert.deepEqual(
      catalog.skills.filter(skill => skill.domain === '*').map(skill => skill.id),
      ['project.work'],
      'Every isolated domain package must ship the shared workspace Skill.',
    );
    assert.ok(fs.existsSync(path.join(skillsRoot, 'skills/project-work/SKILL.md')));
    assert.ok(catalog.capabilities.every(item => item === domain));
    assert.deepEqual(
      catalog.domains.map(item => item.id),
      [domain],
    );
    assert.ok(catalog.packs.every(item => item === domain));
    assert.ok(
      catalog.nativeEntries.every(
        item => item.exists && !item.inside.startsWith('..') && !path.isAbsolute(item.inside),
      ),
      'Packaged native runtime entries must resolve inside the extracted release.',
    );
    if (domain === 'chip') {
      assert.equal(catalog.skills.length, 5);
      assert.equal(
        fs.existsSync(
          path.join(
            path.dirname(entry),
            'domain-packs/chip/eda-harness/src/eda_harness/server/mcp.py',
          ),
        ),
        true,
      );
      assert.deepEqual(run(['--disable-mcp', 'chip-pack.eda'])[0].scope.tools, []);
    } else assert.equal(fs.existsSync(path.join(path.dirname(entry), 'domain-packs/chip')), false);
    if (domain === 'pcb') {
      // project.work (domain-agnostic) + the three pcb skills; the bench
      // alignment added pcb.design.e2e.
      assert.equal(catalog.skills.length, 4);
      assert.equal(fs.existsSync(path.join(packageRoot, 'domain-packs/pcb/uv.lock')), true);
      const pcbScope = extra =>
        execFileSync(
          process.execPath,
          [entry, 'run', '--project-dir', temporary, '--task', 'pcb mcp', '--scope-only', ...extra],
          {
            cwd: temporary,
            encoding: 'utf8',
            env: { ...process.env, INDUSTRIAL_HARNESS_CONFIG_DIR: path.join(temporary, 'config') },
          },
        )
          .trim()
          .split('\n')
          .map(JSON.parse)[0].scope;
      assert.deepEqual(pcbScope([]).tools, ['pcb.kicad.edit', 'pcb.kicad.verify']);
      assert.throws(
        () => pcbScope(['--disable-mcp', 'pcb-bench.tools']),
        error => error.stdout.includes('Unknown project MCP'),
      );
      assert.ok(fs.existsSync(path.join(packageRoot, 'domain-packs/pcb/runtime/index.cjs')));
      assert.ok(!pcbScope(['--disable-skill', 'pcb.design.e2e']).skills.includes('pcb.design.e2e'));
    }
    if (domain === 'godot') {
      assert.equal(catalog.skills.length, 3);
      assert.equal(catalog.packs.length, 1);
      assert.equal(
        fs.existsSync(path.join(packageRoot, 'domain-packs/godot/runtime/index.cjs')),
        true,
      );
      const godotScope = (task, extra = []) =>
        JSON.parse(
          execFileSync(
            process.execPath,
            [entry, 'run', '--project-dir', temporary, '--task', task, '--scope-only', ...extra],
            {
              cwd: temporary,
              encoding: 'utf8',
              env: {
                ...process.env,
                INDUSTRIAL_HARNESS_CONFIG_DIR: path.join(temporary, 'config'),
              },
            },
          ).split('\n')[0],
        ).scope;
      assert.deepEqual(godotScope('Inspect scene').tools, [
        'godot.scene.edit',
        'godot.scene.verify',
      ]);
      assert.deepEqual(godotScope('Develop a Godot game').tools, [
        'godot.scene.edit',
        'godot.scene.verify',
      ]);
      assert.throws(
        () => godotScope('Develop a Godot game', ['--disable-mcp', 'godot.local']),
        error => error.stdout.includes('Unknown project MCP'),
      );
      assert.ok(
        !godotScope('Develop a Godot game', [
          '--disable-skill',
          'godot.game.develop',
        ]).skills.includes('godot.game.develop'),
      );
    }
    console.log(
      JSON.stringify({
        domain,
        ok: true,
        skills: catalog.skills.length,
        providers: catalog.packs.length,
      }),
    );
  }
  const configFile = path.join(temporary, 'external.json');
  fs.writeFileSync(
    configFile,
    JSON.stringify({
      mcpServers: {
        host: {
          command: process.execPath,
          args: [path.resolve(__dirname, '../tests/integration/fixtures/external-mcp-server.cjs')],
          env: { FIXTURE_CLICK_MARKER: path.join(temporary, 'host.json') },
        },
      },
    }),
  );
  const environment = {
    ...process.env,
    INDUSTRIAL_HARNESS_CONFIG_DIR: path.join(temporary, 'config'),
  };
  const command = (domain, args) =>
    execFileSync(
      process.execPath,
      [path.join(directory, `headless-${domain}`, 'industrial-harness.cjs'), ...args],
      { cwd: temporary, encoding: 'utf8', env: environment },
    );
  command('chip', ['mcp', 'add', '--file', configFile]);
  for (const domain of domains) {
    assert.equal(JSON.parse(command(domain, ['mcp', 'list'])).servers[0].id, 'external.host');
    const args = [
      'run',
      '--project-dir',
      temporary,
      '--task',
      'Use the host screenshot',
      '--scope-only',
    ];
    const scope = JSON.parse(command(domain, args).split('\n')[0]).scope;
    assert.equal(scope.tools.filter(id => id.startsWith('external.host.')).length, 3);
    // The domain-bound fallback may keep its primary capability's tools; the
    // disable policy must still remove every external registration tool.
    const disabledTools = JSON.parse(
      command(domain, [...args, '--disable-mcp', 'external.host']).split('\n')[0],
    ).scope.tools;
    assert.ok(disabledTools.every(id => !id.startsWith('external.host.')));
    console.log(
      JSON.stringify({ domain, externalRegistrationShared: true, scoped: true, disable: true }),
    );
  }
  command('godot', ['mcp', 'remove', 'external.host']);
  assert.deepEqual(JSON.parse(command('chip', ['mcp', 'list'])).servers, []);
} finally {
  fs.rmSync(temporary, { recursive: true, force: true });
}
