const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { domainPacks, materializeSkills } = require('../../packages/domain-skills/src/index.cjs');
const { resolveProjectTask } = require('../../packages/harness-core/src/index.cjs');
const { prepareSessionFiles } = require('../../packages/agent-kimi/src/index.cjs');
const execute = promisify(execFile);
const root = path.resolve(__dirname, '../..');
const python =
  process.env.INDUSTRIAL_HARNESS_PCB_GATEWAY_PYTHON ||
  path.join(
    require('../../packages/domain-skills/src/index.cjs').packSourceDirectory('pcb-pack'),
    '.venv/bin/python',
  );
const backend = path.join(__dirname, 'fixtures/pcb-mcp-backend.py');
const client = path.join(__dirname, 'fixtures/pcb-mcp-client.py');

async function setup(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pcb-mcp-transport-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const project = path.join(directory, 'project');
  fs.mkdirSync(project);
  const fakeDocker = path.join(directory, 'controlled-docker');
  const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
  // The immutable pnpm dependency path can exceed Linux's shebang limit.
  fs.writeFileSync(fakeDocker, `#!/bin/sh\nexec ${quote(python)} ${quote(backend)} "$@"\n`, {
    mode: 0o700,
  });
  const { stdout } = await execute(python, [
    '-c',
    'import importlib.util,hashlib,json,sys; s=importlib.util.spec_from_file_location("fixture",sys.argv[1]); m=importlib.util.module_from_spec(s);s.loader.exec_module(m);print(json.dumps({"definitions":m.DEFINITIONS,"hash":hashlib.sha256(json.dumps(m.DEFINITIONS,sort_keys=True).encode()).hexdigest()}))',
    backend,
  ]);
  const { definitions, hash } = JSON.parse(stdout);
  const provider = require(
    path.join(
      require('@zhiman-bj/industrial-domain-packs').sourceDirectory('pcb-pack'),
      'legacy-harness-pack.json',
    ),
  ).provider;
  const tools = provider.tools.filter(t => definitions.some(d => d.function.name === t.name));
  const policy = {
    schemaVersion: 1,
    ...provider,
    projectDir: project,
    python,
    docker: fakeDocker,
    sourceDir: directory,
    controller: path.join(
      require('../../packages/domain-skills/src/index.cjs').packSourceDirectory('pcb-pack'),
      'bridge/pcb-controller.py',
    ),
    cacheDir: path.join(directory, 'cache'),
    tools,
    allowedToolIds: tools.map(t => t.id),
    toolSchemaSha256: hash,
  };
  const policyFile = path.join(directory, 'policy.json');
  const config = path.join(directory, 'mcp.json');
  fs.writeFileSync(
    config,
    JSON.stringify({
      mcpServers: {
        'pcb-bench.tools': {
          command: python,
          args: [
            path.join(
              require('../../packages/domain-skills/src/index.cjs').packSourceDirectory('pcb-pack'),
              'bridge/pcb-gateway.py',
            ),
            policyFile,
          ],
        },
      },
    }),
  );
  return { directory, project, policy, policyFile, config };
}

test(
  'official MCP transport rejects scope/argument escapes, preserves check FAIL, images and complete large responses',
  { skip: !fs.existsSync(python), timeout: 60000 },
  async t => {
    const fixture = await setup(t);
    for (const mode of ['fixture', 'vision']) {
      fs.writeFileSync(
        fixture.policyFile,
        JSON.stringify({ ...fixture.policy, imageInput: mode === 'vision' }),
      );
      const { stdout } = await execute(python, [client, fixture.config, mode], {
        timeout: 25000,
        maxBuffer: 2 * 1024 * 1024,
      });
      assert.equal(JSON.parse(stdout).ok, true);
    }
    const calls = fs
      .readFileSync(path.join(fixture.project, 'fixture-actions.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map(JSON.parse);
    assert.equal(calls.length, 12, 'rejected requests never reach the backend');
    for (const call of calls.filter(call => call.name === 'finalize_claims')) {
      assert.deepEqual(call.arguments, { completed: true, remaining_issues: ['fixture'] });
    }
    assert.ok(!calls.some(call => call.name === 'run_python'));
  },
);

test(
  'a changed live native schema is refused before any operation',
  { skip: !fs.existsSync(python), timeout: 30000 },
  async t => {
    const fixture = await setup(t);
    fs.writeFileSync(
      fixture.policyFile,
      JSON.stringify({ ...fixture.policy, fixtureBadSchema: true }),
    );
    await assert.rejects(
      execute(python, [client, fixture.config], { timeout: 15000 }),
      /schemas differ|Connection closed|unhandled errors/,
    );
    assert.ok(!fs.existsSync(path.join(fixture.project, 'fixture-actions.jsonl')));
  },
);

test(
  'fixed real PCB-bench source supplies all 89 schemas and complete Skill resources, while host execution remains refused',
  { skip: !fs.existsSync(python) || !process.env.INDUSTRIAL_HARNESS_PCB_BENCH_DIR, timeout: 60000 },
  async t => {
    const fixture = await setup(t);
    const environment = {
      ...process.env,
      INDUSTRIAL_HARNESS_PCB_GATEWAY_PYTHON: python,
      INDUSTRIAL_HARNESS_PCB_DOCKER: fixture.policy.docker,
    };
    const packDirectory = path.dirname(
      require.resolve(
        '@zhiman-bj/industrial-domain-packs/packs/pcb/legacy-harness-pack.json',
      ),
    );
    const legacy = require(path.join(packDirectory, 'legacy-harness-pack.json'));
    // The frozen legacy manifest predates the vendored snapshot; rebuild the
    // gateway provider view from the current pinned bench-upstream snapshot
    // so the checkout inventory (INDUSTRIAL_HARNESS_PCB_BENCH_DIR at the
    // pinned commit) validates against what the pack ships today.
    const { bridgeProvider } = require(path.join(
      packDirectory,
      'runtime/bench-gateway.cjs',
    ));
    const snapshot = JSON.parse(
      fs.readFileSync(path.join(packDirectory, 'runtime/bench-upstream.json'), 'utf8'),
    );
    const provider = bridgeProvider(legacy.provider, snapshot);
    const { scope } = resolveProjectTask(
      'pcb',
      { task: 'pcb mcp' },
      undefined,
      legacy.capabilities,
    );
    fs.writeFileSync(path.join(fixture.directory, 'config.toml'), 'default_model = "industrial"\n');
    const session = path.join(fixture.directory, 'standalone-session');
    fs.mkdirSync(session);
    require('../../packages/domain-mcp/src/gateway.cjs').gatewayConfig(
      session,
      { ...provider, allowedToolIds: scope.tools },
      fixture.project,
      environment,
    );
    require('../../packages/domain-mcp/src/index.cjs').writeMcpConfig(
      session,
      [{ ...provider, allowedToolIds: scope.tools }],
      { projectDir: fixture.project, environment },
    );
    t.after(() => fs.rmSync(session, { recursive: true, force: true }));
    const generated = path.join(session, 'mcp-pcb-bench.tools.policy.json');
    const policy = JSON.parse(fs.readFileSync(generated));
    assert.equal(policy.tools.length, 89);
    policy.allowedToolIds = policy.allowedToolIds.filter(id => id !== 'pcb.bench.run_python');
    policy.fixtureSourceDir = process.env.INDUSTRIAL_HARNESS_PCB_BENCH_DIR;
    fs.writeFileSync(generated, JSON.stringify(policy));
    fs.mkdirSync(path.join(fixture.project, 'session'));
    const { stdout } = await execute(python, [client, path.join(session, 'mcp.json'), 'source'], {
      timeout: 30000,
    });
    assert.deepEqual(JSON.parse(stdout), {
      ok: true,
      realSourceSchema: true,
      hostExecutionRejected: true,
      tools: 88,
    });
    // The complete vendored skill tree materializes into the session from
    // the pack itself (upstream verbatim, no integration suffix).
    materializeSkills({ skills: ['pcb.design.e2e'] }, session, environment);
    const skills = path.join(session, 'skills/pcb-design-e2e');
    assert.ok(fs.existsSync(path.join(skills, 'assets/constraints.example.yaml')));
    assert.equal(fs.readdirSync(path.join(skills, 'references')).length, 9);
    assert.equal(
      fs.readFileSync(path.join(skills, 'SKILL.md'), 'utf8'),
      fs.readFileSync(
        path.join(packDirectory, 'skills/pcb-design-e2e/SKILL.md'),
        'utf8',
      ),
    );
    materializeSkills({ skills: ['pcb.layout.inspect'] }, session, environment);
    assert.ok(
      !fs.existsSync(skills),
      'changed scope removes the entire previous design Skill tree',
    );
  },
);
