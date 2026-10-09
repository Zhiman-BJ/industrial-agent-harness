#!/usr/bin/env node
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { startModel } = require('../tests/integration/fixtures/domain-mcp-model.cjs');
const execute = promisify(execFile);

async function main() {
  const [prefix, launcher, output, ...extra] = process.argv.slice(2);
  if (process.platform !== 'linux' || !prefix || !launcher || !output || extra.length)
    throw Error(
      'Usage on Linux: node scripts/smoke-linux-chip-install.cjs PREFIX LAUNCHER OUTPUT.json',
    );
  const receipt = JSON.parse(fs.readFileSync(path.join(prefix, 'install-receipt.json')));
  assert.equal(receipt.package.sourceDirty, false);
  assert.equal(receipt.protected_kimi_startup, 'PASS');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'installed-chip-consumer-'));
  let fixture;
  try {
    // The pinned Verilator's host --build command splits a spaced Mdir.
    // Docker uses its fixed /workspace mount and supports the spaced host path.
    const project = path.join(
      directory,
      receipt.image ? 'engineering project' : 'engineering-project',
    );
    fs.cpSync(path.join(__dirname, '../tests/integration/fixtures/industrial-rtl'), project, {
      recursive: true,
    });
    if (receipt.image) {
      const config = path.join(project, 'eda.yaml');
      fs.writeFileSync(
        config,
        fs
          .readFileSync(config, 'utf8')
          .replace(
            'kind: local',
            `kind: docker\n  image: ${receipt.image}\n  require_native: true`,
          ),
      );
    }
    const skill = path.join(project, '.skills', 'release-check', 'SKILL.md');
    fs.mkdirSync(path.dirname(skill), { recursive: true });
    fs.writeFileSync(
      skill,
      '---\nname: release-check\ndescription: RELEASE_SKILL_DISCOVERY\n---\nRELEASE_LAZY_SKILL_BODY\n',
    );
    fs.writeFileSync(path.join(project, 'AGENTS.md'), 'RELEASE_PROJECT_GUIDANCE\n');
    const before = fs.readFileSync(path.join(project, 'rtl/counter.sv'));
    fixture = await startModel({
      // Native write/Docker permission errors are expected; still exercise the host actions.
      stopOnRejection: false,
      success: 'INSTALLED_CHIP_VERIFIED',
      calls: body => {
        const id = JSON.stringify(body.messages).match(/expectedStateId=([a-f0-9-]{36})/)?.[1];
        assert.ok(id, 'Installed consumer must receive the real DomainState identity.');
        return [
          { name: 'Read', arguments: { path: skill } },
          { name: 'Bash', arguments: { command: 'printf bypass > project/rtl/counter.sv' } },
          { name: 'Bash', arguments: { command: 'docker info' } },
          {
            name: 'industrial_action_call',
            arguments: { toolId: 'chip.environment.check', inputs: {}, expectedStateId: id },
          },
          {
            name: 'industrial_action_call',
            arguments: { toolId: 'chip.rtl.verify', inputs: {}, expectedStateId: id },
          },
        ];
      },
    });
    const result = await execute(
      launcher,
      [
        'run',
        '--project-dir',
        project,
        '--task',
        'Run RTL simulation verification assertions',
        '--approval',
        'approve',
        '--provider',
        'openai_legacy',
        '--endpoint',
        fixture.endpoint,
        '--model',
        'release-controlled',
        '--no-thinking',
        '--timeout-ms',
        '2592000000',
        '--chat-dir',
        path.join(directory, 'chats'),
        '--state-dir',
        path.join(directory, 'state'),
        '--log-dir',
        path.join(directory, 'logs'),
      ],
      {
        cwd: directory,
        env: {
          ...process.env,
          OPENAI_API_KEY: 'local-release-fixture',
          KIMI_SHARE_DIR: path.join(directory, 'foreign-share'),
          INDUSTRIAL_HARNESS_CONFIG_DIR: path.join(directory, 'config'),
        },
        timeout: 120000,
        maxBuffer: 4 * 1024 * 1024,
      },
    );
    const rows = result.stdout.trim().split('\n').map(JSON.parse);
    assert.equal(rows.at(-1).status, 'finished', result.stdout + result.stderr);
    assert.ok(!rows.some(row => row.type === 'timeout'));
    assert.doesNotMatch(result.stderr, /TimeoutOverflowWarning/);
    const initial = JSON.stringify(fixture.requests[0].messages);
    assert.match(initial, /RELEASE_PROJECT_GUIDANCE/);
    assert.match(initial, /RELEASE_SKILL_DISCOVERY/);
    assert.doesNotMatch(initial, /RELEASE_LAZY_SKILL_BODY/);
    const requests = JSON.stringify(fixture.requests);
    assert.match(requests, /RELEASE_LAZY_SKILL_BODY/);
    assert.match(requests, /Read-only file system|Operation not permitted/);
    assert.match(
      requests,
      /Docker group activation is unavailable|permission denied while trying to connect|connect: operation not permitted|socket: operation not permitted/i,
    );
    assert.deepEqual(fs.readFileSync(path.join(project, 'rtl/counter.sv')), before);
    const preflight = rows.find(
      row => row.type === 'industrial_result' && row.action.toolId === 'chip.environment.check',
    );
    assert.equal(preflight?.action.status, 'completed', JSON.stringify(preflight));
    assert.equal(preflight.verification.status, 'not_run');
    assert.equal(preflight.state.id, preflight.action.stateId);
    const environment = JSON.parse(preflight.action.diagnostics[0]);
    assert.equal(environment.execution_location, 'host_domain_runtime');
    assert.equal(environment.agent_docker_access, 'intentionally_denied');
    assert.equal(environment.ready, true, JSON.stringify(environment));
    const engineering = rows.find(
      row => row.type === 'industrial_result' && row.action.toolId === 'chip.rtl.verify',
    );
    if (engineering?.verification.status !== 'passed') {
      const failures = (engineering?.artifacts || [])
        .filter(item => item.kind === 'log.tool')
        .map(item => ({
          sha256: item.sha256,
          log: fs.readFileSync(path.join(project, item.relativePath), 'utf8').slice(-16384),
        }));
      fs.mkdirSync(path.dirname(path.resolve(output)), { recursive: true });
      fs.writeFileSync(
        output + '.failure.json',
        JSON.stringify({ engineering, failures }, null, 2) + '\n',
      );
      throw Error(
        'Installed RTL verification failed: ' +
          JSON.stringify({ verification: engineering?.verification, failures }),
      );
    }
    assert.equal(rows.at(-1).engineering.checkpointId, engineering.checkpoint.id);
    const boundary = rows.find(row => row.event?.type === 'execution-boundary')?.event;
    assert.equal(boundary?.mechanism, 'bubblewrap-seccomp');
    fs.mkdirSync(path.dirname(path.resolve(output)), { recursive: true });
    fs.writeFileSync(
      output,
      JSON.stringify(
        {
          platform: process.platform,
          arch: process.arch,
          kernel: os.release(),
          sourceCommit: receipt.package.sourceCommit,
          sourceDirty: false,
          installedLauncher: launcher,
          timeoutMs: '2592000000',
          longTimeoutWithoutOverflow: 'PASS',
          skillDiscovery: 'PASS',
          nativeGuidance: 'PASS',
          progressiveSkillBody: 'PASS',
          conflictingShareEnvironment: 'PASS',
          shellBypassDenied: 'PASS',
          agentDockerDenied: 'PASS',
          hostEnvironmentCheck: 'PASS',
          readOnlyCheckPreservesState: 'PASS',
          engineeringVerification: engineering.verification.status,
          checkpointPersisted: true,
          processBoundary: boundary.mechanism,
          executionBackend: receipt.image ? 'docker' : 'local',
          projectPathIncludesSpaces: project.includes(' '),
          image: receipt.image,
          model: 'controlled-local-fixture',
        },
        null,
        2,
      ) + '\n',
    );
    console.log(
      'Installed Chip CLI, project Skills, write boundary, real RTL verification and checkpoint: PASS',
    );
  } finally {
    await fixture?.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
}
main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
