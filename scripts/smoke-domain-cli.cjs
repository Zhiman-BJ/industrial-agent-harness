#!/usr/bin/env node
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const assert = require('node:assert/strict');
const owner = require('@zhiman-bj/industrial-domain-packs');
const metadata = owner.consumerMetadata();
const packs = owner.hostPacks();
const platform = `${process.platform}-${process.arch}`;
const qualified = metadata.domains.filter(domain =>
  domain.qualifiedBundlePlatforms.includes(platform),
);
const domains = (qualified.length ? qualified : metadata.domains).map(domain => domain.id);
assert.ok(domains.length, 'No declared Domain package profiles.');
const directory = path.resolve(process.argv[2]);
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'domain-cli-smoke-'));
const environment = {
  ...process.env,
  INDUSTRIAL_HARNESS_CONFIG_DIR: path.join(temporary, 'config'),
};
// A source-package smoke must not accidentally consume a developer's installed
// store or authenticated remote GPU configuration instead of its own resources.
delete environment.INDUSTRIAL_HARNESS_PACK_STORE;
for (const key of Object.keys(environment))
  if (key.startsWith('INDUSTRIAL_HARNESS_CUDA_')) delete environment[key];
const command = (domain, args) =>
  execFileSync(
    process.execPath,
    [path.join(directory, `headless-${domain}`, 'industrial-harness.cjs'), ...args],
    { cwd: temporary, encoding: 'utf8', env: environment },
  );
const scopeRows = (domain, extra = [], task = 'Inspect project files') =>
  command(domain, ['run', '--project-dir', temporary, '--task', task, '--scope-only', ...extra])
    .trim()
    .split('\n')
    .map(JSON.parse);
try {
  for (const domain of domains) {
    const packageRoot = path.join(directory, `headless-${domain}`);
    const filenames = fs.readdirSync(packageRoot).map(name => name.toLowerCase());
    assert.equal(
      new Set(filenames).size,
      filenames.length,
      'Package root filenames must coexist on case-insensitive filesystems.',
    );
    const identity = JSON.parse(fs.readFileSync(path.join(packageRoot, 'HARNESS-PACKAGE.json')));
    assert.equal(identity.domain, domain);
    assert.equal(
      JSON.parse(fs.readFileSync(path.join(packageRoot, 'package.json'))).name,
      '@industrial-agent-harness/cli',
    );
    const skillsRoot = fs.realpathSync(
      path.join(packageRoot, 'node_modules/@industrial-agent-harness/domain-skills'),
    );
    const inspect = `const {capabilities,listSkills,listDomains,domainPacks,loadRegistry,validateResources}=require(${JSON.stringify(skillsRoot)});const fs=require('fs'),path=require('path');const registry=loadRegistry();for(const runtime of registry.runtimePacks)validateResources(runtime.directory,domainPacks.find(pack=>pack.id===runtime.id).provider);const factory=require(${JSON.stringify(path.join(packageRoot, 'node_modules/@industrial-agent-harness/harness-core'))}).createProjectRuntime({projectDir:process.cwd(),domain:${JSON.stringify(domain)},directory:path.join(process.cwd(),"factory-"+${JSON.stringify(domain)}),environment:process.env,registry});factory.runtime.close();const inside=file=>path.relative(${JSON.stringify(packageRoot)},file);console.log(JSON.stringify({skills:listSkills(),capabilities:capabilities.map(c=>({id:c.id,domain:c.domain})),domains:listDomains(capabilities),packs:domainPacks.map(p=>({id:p.id,domain:p.domain,provider:p.provider})),nativeEntries:registry.runtimePacks.map(p=>({exists:fs.existsSync(path.join(p.directory,p.runtime.entry)),inside:inside(p.directory)})),skillFiles:registry.skills.map(s=>({exists:fs.existsSync(s.file),inside:inside(s.file)}))}))`;
    const catalog = JSON.parse(
      execFileSync(process.execPath, ['-e', inspect], {
        cwd: temporary,
        encoding: 'utf8',
        env: environment,
      }),
    );
    const expectedPacks = packs.filter(pack => pack.domain === domain);
    const expectedSkills = metadata.skills.filter(skill => skill.domain === domain);
    assert.deepEqual(
      catalog.skills
        .filter(skill => skill.domain === domain)
        .map(skill => skill.id)
        .sort(),
      expectedSkills.map(skill => skill.id).sort(),
    );
    assert.ok(catalog.skills.every(skill => skill.domain === domain || skill.domain === '*'));
    assert.deepEqual(
      catalog.skills.filter(skill => skill.domain === '*').map(skill => skill.id),
      ['project.work'],
      'Every isolated domain package must ship the shared workspace Skill.',
    );
    assert.ok(fs.existsSync(path.join(skillsRoot, 'skills/project-work/SKILL.md')));
    const expectedCapabilities = [
      ...metadata.capabilities,
      ...expectedPacks.flatMap(pack => pack.capabilities),
    ]
      .filter(capability => capability.domain === domain)
      .map(capability => capability.id)
      .sort();
    assert.deepEqual(
      catalog.capabilities.map(capability => capability.id).sort(),
      expectedCapabilities,
    );
    assert.ok(catalog.capabilities.every(capability => capability.domain === domain));
    assert.deepEqual(
      catalog.domains.map(item => item.id),
      [domain],
    );
    assert.deepEqual(
      catalog.packs.map(pack => pack.id).sort(),
      expectedPacks.map(pack => pack.id).sort(),
    );
    for (const expected of expectedPacks)
      assert.deepEqual(
        catalog.packs.find(pack => pack.id === expected.id).provider,
        expected.provider,
      );
    const contained = item =>
      item.exists && !item.inside.startsWith('..') && !path.isAbsolute(item.inside);
    assert.equal(catalog.nativeEntries.length, expectedPacks.filter(pack => pack.runtime).length);
    assert.ok(
      catalog.nativeEntries.every(contained),
      'Runtime entries must resolve inside the extracted release.',
    );
    assert.ok(
      catalog.skillFiles.every(contained),
      'Every Skill must resolve inside the extracted release.',
    );
    for (const pack of packs.filter(pack => pack.domain !== domain))
      assert.equal(
        fs.existsSync(path.join(packageRoot, 'domain-packs', pack.provider.packDirectory)),
        false,
        'Other domain runtime resources must not leak into the isolated release root.',
      );
    const rows = scopeRows(domain);
    assert.equal(rows[0].scope.domain, domain);
    assert.equal(rows.at(-1).status, 'scoped');
    assert.equal(
      rows[0].trace.find(row => row.event === 'domain.index').detail.count,
      expectedCapabilities.length,
    );
    const denied = metadata.domains.find(item => item.id !== domain).id;
    assert.throws(
      () => scopeRows(domain, ['--domain', denied]),
      error => error.stdout.includes(`fixed to the ${domain} domain`),
    );
    for (const pack of expectedPacks.filter(pack => pack.provider.transport === 'runtime')) {
      assert.throws(
        () => scopeRows(domain, ['--disable-mcp', pack.provider.id]),
        error => error.stdout.includes('Unknown project MCP'),
        'Runtime tools must not masquerade as registered MCP servers.',
      );
    }
    const task = expectedPacks
      .flatMap(pack => pack.capabilities)
      .flatMap(capability => capability.keywords)
      .join(' ');
    const selected = scopeRows(domain, [], task)[0].scope;
    const permitted = new Set(
      expectedPacks.flatMap(pack => pack.provider.tools).map(tool => tool.id),
    );
    assert.ok(
      selected.tools.every(id => id.startsWith('project.') || permitted.has(id)),
      'Domain scope must contain only declared domain tools or shared workspace tools.',
    );
    for (const skill of selected.skills.filter(id => id !== 'project.work')) {
      assert.ok(expectedSkills.some(item => item.id === skill));
      assert.ok(
        !scopeRows(domain, ['--disable-skill', skill], task)[0].scope.skills.includes(skill),
        'Disabling a selected domain Skill must remove it from disclosure.',
      );
    }
    if (domain === 'pcb') {
      assert.ok(selected.tools.some(id => id.startsWith('pcb.design.')));
      assert.ok(
        !selected.tools.some(id => id.startsWith('pcb.bench.') || id.endsWith('.finalize_claims')),
      );
      const productSkill = catalog.skills.find(skill => skill.id === 'pcb.design.e2e');
      assert.ok(productSkill);
      assert.ok(fs.existsSync(path.join(packageRoot, 'domain-packs/pcb/uv.lock')));
      assert.throws(
        () => scopeRows(domain, ['--disable-mcp', 'pcb-bench.tools']),
        error => error.stdout.includes('Unknown project MCP'),
      );
    }
    if (domain === 'cuda') {
      const unconfigured = JSON.parse(
        execFileSync(
          process.execPath,
          [
            '-e',
            `const registry=require(${JSON.stringify(skillsRoot)}).loadRegistry();const pack=registry.runtimePacks.find(p=>p.domain==="cuda");const api=require(pack.directory+"/"+pack.runtime.entry);const plugin=api.createRuntimePlugin({environment:{},managed:true,runtimeApi:{resolveDependency:pack.resolveDependency}});console.log(JSON.stringify({available:plugin.available,tools:plugin.tools.map(t=>t.descriptor.id)}))`,
          ],
          { cwd: temporary, encoding: 'utf8', env: environment },
        ),
      );
      assert.equal(unconfigured.available, false);
      assert.deepEqual(
        unconfigured.tools,
        [],
        'Unconfigured remote services must not expose executable GPU tools.',
      );
    }
    console.log(
      JSON.stringify({
        domain,
        ok: true,
        skills: catalog.skills.length,
        providers: catalog.packs.length,
        capabilities: expectedCapabilities.length,
        mode: 'source-package-smoke',
        installableOnHost: qualified.some(item => item.id === domain),
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
  command(domains[0], ['mcp', 'add', '--file', configFile]);
  for (const domain of domains) {
    assert.equal(JSON.parse(command(domain, ['mcp', 'list'])).servers[0].id, 'external.host');
    const task = 'Use the host screenshot';
    const scope = scopeRows(domain, [], task)[0].scope;
    assert.equal(scope.tools.filter(id => id.startsWith('external.host.')).length, 3);
    const disabled = scopeRows(domain, ['--disable-mcp', 'external.host'], task)[0].scope.tools;
    assert.ok(disabled.every(id => !id.startsWith('external.host.')));
    console.log(
      JSON.stringify({ domain, externalRegistrationShared: true, scoped: true, disable: true }),
    );
  }
  command(domains.at(-1), ['mcp', 'remove', 'external.host']);
  assert.deepEqual(JSON.parse(command(domains[0], ['mcp', 'list'])).servers, []);
} finally {
  fs.rmSync(temporary, { recursive: true, force: true });
}
