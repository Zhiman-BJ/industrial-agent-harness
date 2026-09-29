const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '../..');
const ledger = JSON.parse(fs.readFileSync(path.join(root, 'doc/prototype-register.json'), 'utf8'));
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8');
const prototype = id => ledger.prototypes.find(item => item.id === id);

function sourceFiles(relative) {
  const directory = path.join(root, relative);
  return fs.readdirSync(directory, {withFileTypes: true}).flatMap(entry => {
    const target = path.join(relative, entry.name);
    if (entry.isDirectory()) return sourceFiles(target);
    return /\.(?:cjs|mjs|js|ts|tsx)$/.test(entry.name) && !/\.test\./.test(entry.name) ? [target] : [];
  });
}

test('core, contracts and runtime cannot depend on Kimi or Electron', () => {
  for (const area of ['packages/harness-core', 'packages/contracts', 'packages/domain-runtime']) {
    const manifest = JSON.parse(read(`${area}/package.json`));
    const dependencies = {...manifest.dependencies, ...manifest.devDependencies};
    assert.ok(!Object.keys(dependencies).some(name => name.includes('agent-kimi') || name.includes('kimi-agent-sdk') || name === 'electron'), area);
    for (const file of sourceFiles(area)) assert.doesNotMatch(read(file), /@moonshot-ai\/kimi-agent-sdk|@industrial-agent-harness\/agent-kimi|(?:require|from)\s*\(?['"][^'"]*electron/i, file);
  }
});

test('core packages cannot grow concrete domain IDs', () => {
  for (const area of ['packages/harness-core', 'packages/contracts', 'packages/capability-broker', 'packages/viewer-core']) {
    for (const file of sourceFiles(area)) assert.doesNotMatch(read(file), /['"`](?:chip|pcb)(?:['"`]|\.)|['"`](?:eda|openroad|kicad)\.[\w.-]+/, file);
  }
});

test('Broker cannot import concrete runtimes, domains or viewers', () => {
  for (const file of sourceFiles('packages/capability-broker')) assert.doesNotMatch(read(file), /@industrial-agent-harness\/(?:agent-kimi|domain-runtime|domain-skills|domain-mcp|viewer-builtin)|\b(?:electron|openroad|yosys|kicad|verilator)\b/i, file);
});

test('known agent domain mapping is frozen until ToolDescriptor replaces it', () => {
  const source = read('packages/agent-kimi/src/index.cjs');
  const mapping = source.match(/const canonicalNames = \{([\s\S]*?)\n\};/);
  assert.ok(mapping, 'the registered prototype changed; update the replacement and test');
  const ids = [...mapping[1].matchAll(/'([^']+)':/g)].map(match => match[1]).sort();
  assert.deepEqual(ids, [...prototype('kimi-domain-tool-map').allowedCanonicalToolIds].sort());
  const remaining = source.replace(mapping[0], '').replace("canonicalId.startsWith('eda.')", '');
  assert.doesNotMatch(remaining, /['"`](?:chip|pcb)(?:['"`]|\.)|['"`](?:eda|openroad|kicad)\.[\w.-]+/, 'new domain ID in agent-kimi');
  assert.equal(source.split("canonicalId.startsWith('eda.')").length - 1, 1, 'legacy EDA inference must not expand');
});

test('Desktop and CLI cannot directly spawn industrial executables', () => {
  for (const area of ['apps/desktop/electron', 'apps/cli/src']) {
    for (const file of sourceFiles(area)) assert.doesNotMatch(read(file), /\b(?:spawn|spawnSync|execFile|execFileSync|execSync)\s*\(\s*['"`](?:yosys|verilator|openroad|kicad(?:-cli)?)\b/i, file);
  }
  const electron = read('apps/desktop/electron/main.cjs');
  assert.equal([...electron.matchAll(/\bspawnSync\s*\(/g)].length, 2, 'only existing Kimi availability probes may spawn from Electron');
  assert.doesNotMatch(electron, /\b(?:spawn|execFile|execFileSync|execSync)\s*\(/, 'industrial process execution belongs in Domain Runtime');
  for (const file of sourceFiles('apps/cli/src')) assert.doesNotMatch(read(file), /node:child_process|require\(['"]child_process['"]\)/, file);
});

test('Viewer dispatch uses a registry and static Capability IDs cannot expand', () => {
  const app = read('apps/desktop/src/App.tsx');
  const imported = [...app.matchAll(/from '@industrial-agent-harness\/viewer-builtin\/(\w+)'/g)].map(match => match[1]).filter(name => name !== 'api').sort();
  assert.deepEqual(imported, ['canvas']);
  const rendered = [...app.matchAll(/opened\?\.kind === '(\w+)'/g)].map(match => match[1]).sort();
  assert.deepEqual(rendered, []);
  const main = read('apps/desktop/electron/main.cjs');
  const openedInMain = [...main.matchAll(/artifact\.kind === '(\w+)'/g)].map(match => match[1]).sort();
  assert.deepEqual(openedInMain, []);
  assert.match(main, /createViewerRegistry\(/);
  assert.match(main, /viewerRegistry\.get\(artifact\.kind\)/);
  const capabilities = require(path.join(root, 'packages/domain-skills/src/capabilities.cjs'));
  assert.deepEqual(capabilities.map(item => item.id).sort(), [...prototype('static-capability-registry').allowedCapabilityIds].sort());
});

test('prototype exceptions are explicit and core milestone cannot be claimed early', () => {
  assert.equal(ledger.schemaVersion, 1);
  assert.equal(new Set(ledger.prototypes.map(item => item.id)).size, ledger.prototypes.length);
  for (const item of ledger.prototypes) {
    assert.ok(item.replacement && read(item.path).includes(item.signature), item.id);
  }
  if (ledger.milestone === ledger.nextMilestone) {
    assert.ok(fs.existsSync(path.join(root, ledger.verticalSliceTest)), 'real vertical slice test is required before declaring Industrial Core');
  } else assert.equal(ledger.milestone, 'workbench-mvp');
});

test('mutating capability tools must declare verification', () => {
  const capabilities = require(path.join(root, 'packages/domain-skills/src/capabilities.cjs'));
  const known = new Set(prototype('static-capability-registry').allowedToolIds);
  for (const capability of capabilities) for (const tool of capability.tools) {
    if (!known.has(tool.id)) assert.ok(tool.risk, `new tool ${tool.id} needs a risk declaration`);
    if (tool.risk === 'mutating') assert.ok(Array.isArray(tool.verification) && tool.verification.length > 0, tool.id);
  }
});

test('a stale scoped Agent tool call is rejected at its handler', async () => {
  const {externalTools} = require(path.join(root, 'packages/agent-kimi/src/index.cjs'));
  let scope = {capabilityIds: ['chip.rtl.netlist.inspect'], tools: ['eda.netlist.inspect']};
  const tools = externalTools(() => scope, async () => ({kind: 'netlist'}), () => ({}));
  const selected = tools.find(item => item.name === 'eda_netlist_inspect');
  assert.ok(selected);
  scope = {capabilityIds: ['chip.verification.waveform.inspect'], tools: ['eda.waveform.inspect']};
  await assert.rejects(selected.handler({artifactId: 'artifact-1'}), /outside the current Broker scope/);
});

test('unscoped direct Domain MCP servers cannot be added before a Gateway', () => {
  const {listMcpServers} = require(path.join(root, 'packages/domain-mcp/src/index.cjs'));
  if (listMcpServers().length) {
    assert.ok(fs.existsSync(path.join(root, 'packages/domain-mcp/src/gateway.cjs')), 'Domain MCP needs execution-boundary allowlist');
    assert.ok(fs.existsSync(path.join(root, 'tests/integration/domain-mcp-scope.test.cjs')), 'Domain MCP needs a real out-of-scope invocation test');
  }
});

test('the computer-use plugin tool surface is frozen', () => {
  const {GUI_TOOLS} = require(path.join(root, 'packages/computer-use-bridge/src/tools.cjs'));
  const declared = GUI_TOOLS.map(item => item.canonicalId).sort();
  assert.deepEqual(declared, [...prototype('computer-use-plugin').allowedCanonicalToolIds].sort());
  for (const item of GUI_TOOLS) {
    assert.match(item.canonicalId, /^computer-use\./, item.name);
    assert.ok(['read', 'mutating'].includes(item.risk), item.name);
    assert.ok(!item.name.startsWith('browser_'), 'browser tools are not part of the plugin surface');
  }
});

test('the computer-use binary is only referenced by the bridge package source', () => {
  const areas = ['apps/desktop/electron', 'apps/cli/src', 'packages/harness-core', 'packages/agent-kimi', 'packages/domain-runtime', 'packages/domain-mcp', 'packages/domain-skills', 'packages/capability-broker', 'packages/contracts', 'packages/viewer-core', 'packages/viewer-builtin'];
  const offenders = [];
  for (const area of areas) {
    for (const file of sourceFiles(area)) {
      if (read(file).includes('munim-computer-use')) offenders.push(file);
    }
  }
  assert.deepEqual(offenders, [], 'only packages/computer-use-bridge may spawn or name the computer-use binary');
});
