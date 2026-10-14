const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { gatewayConfig } = require('./gateway.cjs');

test('PCB launch policy binds a canonical candidate and external requirements without model credentials', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pcb-runtime-policy-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, 'source'),
    project = path.join(root, 'candidate');
  fs.mkdirSync(project);
  const sourceFiles = {};
  for (const [relative, text] of [
    ['pcb-agent/runtime.py', 'controlled source'],
    ['skills/pcb-design-e2e/SKILL.md', 'controlled skill'],
  ]) {
    fs.mkdirSync(path.dirname(path.join(source, relative)), { recursive: true });
    fs.writeFileSync(path.join(source, relative), text);
    sourceFiles[relative] = crypto.createHash('sha256').update(text).digest('hex');
  }
  const python = path.join(root, 'python'),
    docker = path.join(root, 'docker');
  fs.writeFileSync(python, 'fixture executable never launched');
  fs.writeFileSync(docker, 'fixture executable never launched');
  const provider = {
    id: 'fixture',
    title: 'Fixture',
    backend: 'pcb-design',
    packDirectory: 'pcb',
    directoryEnv: 'FIXTURE_SOURCE',
    pythonEnv: 'FIXTURE_PYTHON',
    imageId: `sha256:${'a'.repeat(64)}`,
    resourceRoots: ['pcb-agent', 'skills/pcb-design-e2e'],
    sourceFiles,
    sourceSha256: crypto.createHash('sha256').update(JSON.stringify(sourceFiles)).digest('hex'),
    tools: [],
    allowedToolIds: [],
  };
  const requirements = path.join(root, 'requirements.json');
  fs.writeFileSync(requirements, '{"controlled":true}');
  const environment = {
    FIXTURE_SOURCE: source,
    FIXTURE_PYTHON: python,
    INDUSTRIAL_HARNESS_PCB_DOCKER: docker,
    INDUSTRIAL_HARNESS_PCB_REQUIREMENTS: requirements,
    DOCKER_CONTEXT: 'controlled-context',
    KIMI_API_KEY: 'fixture-secret-not-forwarded',
  };
  const config = gatewayConfig(root, provider, project, environment, { imageInput: true });
  const policy = JSON.parse(fs.readFileSync(config.args[1]));
  assert.equal(policy.projectDir, fs.realpathSync(project));
  assert.equal(policy.requirementsPath, fs.realpathSync(requirements));
  assert.equal(
    policy.requirementsSha256,
    crypto.createHash('sha256').update(fs.readFileSync(requirements)).digest('hex'),
  );
  assert.equal(policy.imageInput, true);
  assert.equal(policy.imageId, provider.imageId);
  assert.equal(config.env.DOCKER_CONTEXT, 'controlled-context');
  assert.ok(!JSON.stringify({ config, policy }).includes('fixture-secret-not-forwarded'));
  // POSIX permission bits are not represented by Windows stat().
  if (process.platform !== 'win32') assert.equal(fs.statSync(config.args[1]).mode & 0o777, 0o600);
  const internal = path.join(project, 'requirements.json');
  fs.writeFileSync(internal, '{}');
  assert.throws(
    () =>
      gatewayConfig(root, provider, project, {
        ...environment,
        INDUSTRIAL_HARNESS_PCB_REQUIREMENTS: internal,
      }),
    /outside the writable candidate/,
  );
  const alias = path.join(root, 'requirements-alias.json');
  fs.symlinkSync(internal, alias);
  assert.throws(
    () =>
      gatewayConfig(root, provider, project, {
        ...environment,
        INDUSTRIAL_HARNESS_PCB_REQUIREMENTS: alias,
      }),
    /outside the writable candidate/,
  );
  assert.throws(
    () =>
      gatewayConfig(root, provider, project, {
        ...environment,
        INDUSTRIAL_HARNESS_PCB_DOCKER: 'relative',
      }),
    /absolute Docker executable/,
  );
  const developmentImageId = `sha256:${'b'.repeat(64)}`;
  const development = gatewayConfig(root, provider, project, {
    ...environment,
    INDUSTRIAL_HARNESS_PCB_DEV_IMAGE_ID: developmentImageId,
  });
  assert.equal(JSON.parse(fs.readFileSync(development.args[1])).imageId, developmentImageId);
  assert.throws(
    () =>
      gatewayConfig(root, provider, project, {
        ...environment,
        INDUSTRIAL_HARNESS_PCB_DEV_IMAGE_ID: 'industrial-pcb-runtime:latest',
      }),
    /immutable Docker image ID/,
  );
  const comma = path.join(root, 'comma,candidate');
  fs.mkdirSync(comma);
  assert.throws(() => gatewayConfig(root, provider, comma, environment), /cannot contain commas/);
});
