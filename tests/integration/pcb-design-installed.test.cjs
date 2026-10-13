const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { PackCatalog } = require('../../packages/pack-manager/src/catalog.cjs');
const { RuntimeEnvironmentManager } = require('../../packages/pack-manager/src/index.cjs');
const { createProjectRuntime } = require('../../packages/harness-core/src/project-runtime.cjs');

test(
  'installed production PCB design container creates a physical board, checks it, cancels and recovers through Project Runtime',
  { timeout: 300000 },
  async t => {
    assert.ok(
      process.env.HARNESS_PCB_RELEASE_DIR,
      'HARNESS_PCB_RELEASE_DIR must name the separately built production Pack catalog directory.',
    );
    const release = path.resolve(process.env.HARNESS_PCB_RELEASE_DIR);
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pcb-design-installed-')));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const catalog = new PackCatalog({
      directory: path.join(root, 'store'),
      bundledDirectory: release,
    });
    const entry = (await catalog.available()).find(item => item.domain === 'pcb');
    assert.ok(entry, 'The production release must contain a compatible PCB bundle.');
    await catalog.manager.install(entry);
    const bundle = catalog.manager.list().find(item => item.domain === 'pcb');
    const profile = bundle.executionProfiles.find(
      item => item.kind === 'container' && item.toolIds.includes('pcb.design.project_status'),
    );
    assert.ok(profile);
    const project = path.join(root, 'project');
    fs.mkdirSync(project);
    t.after(() => {
      // Reclaim only containers whose writable workspace is this test project,
      // including failed qualification attempts that retain a live session.
      const names = execFileSync('docker', ['ps', '-a', '--format', '{{.Names}}'], {
        encoding: 'utf8',
      })
        .trim()
        .split('\n')
        .filter(name => name.startsWith('industrial-session-'));
      for (const name of names) {
        const record = JSON.parse(
          execFileSync('docker', ['inspect', name], { encoding: 'utf8' }),
        )[0];
        if (
          record.Mounts.some(
            mount => mount.Destination === '/workspace' && mount.Source === project,
          )
        )
          execFileSync('docker', ['rm', '--force', name]);
      }
    });
    const prepared = await new RuntimeEnvironmentManager({ manager: catalog.manager }).prepare(
      'pcb',
      { profileId: profile.id, projectDir: project },
    );
    assert.equal(prepared.status, 'ready', JSON.stringify(prepared));
    const environment = {
      ...process.env,
      INDUSTRIAL_HARNESS_PACK_STORE: catalog.manager.directory,
    };
    let view;
    t.after(async () => {
      await view?.runtime.close();
    });
    const open = () =>
      createProjectRuntime({
        projectDir: project,
        domain: 'pcb',
        directory: path.join(root, 'state'),
        environment,
      });
    view = open();
    let state = await view.runtime.inspect();
    const evidence = {
      productionArchive: { sha256: entry.sha256, version: entry.version },
      profile: profile.id,
      operations: [],
      cancellation: null,
      recovery: null,
      passed: false,
    };
    t.after(() => {
      if (process.env.HARNESS_PCB_EVIDENCE_DIR) {
        const output = path.resolve(process.env.HARNESS_PCB_EVIDENCE_DIR);
        fs.mkdirSync(output, { recursive: true });
        fs.writeFileSync(
          path.join(output, 'pcb-design-installed-report.json'),
          JSON.stringify(evidence, null, 2) + '\n',
        );
      }
    });
    const call = async (name, inputs = {}) => {
      const toolId = 'pcb.design.' + name;
      process.stdout.write('Installed PCB Project Runtime: ' + name + '\n');
      const result = await view.runtime.execute(
        { toolId, inputs, expectedStateId: state.id },
        {
          approval: true,
          scope: { domain: 'pcb', projectId: state.projectId, stateId: state.id, tools: [toolId] },
        },
      );
      state = result.state;
      evidence.operations.push({
        toolId,
        actionId: result.action.id,
        actionStatus: result.action.status,
        verification: result.verification.status,
        ...(result.action.status === 'failed' ? { diagnostics: result.action.diagnostics } : {}),
      });
      assert.notEqual(result.action.status, 'failed', JSON.stringify(result.action));
      const diagnostic = result.action.diagnostics.find(item => item.startsWith('{'));
      assert.ok(diagnostic, JSON.stringify(result.action));
      const payload = JSON.parse(diagnostic);
      return { result, payload, native: payload.result.result };
    };
    const initial = await call('project_status');
    assert.equal(initial.payload.requirementsBound, false);
    assert.deepEqual(initial.native.files, {});
    await call('new_project', { width_mm: 40, height_mm: 30 });
    await call('add_component', {
      ref: 'R1',
      symbol: 'Device:R',
      value: '1k',
      footprint: 'Resistor_SMD:R_0603_1608Metric',
    });
    await call('add_no_connect', { ref: 'R1', pin: '1' });
    await call('add_no_connect', { ref: 'R1', pin: '2' });
    await call('set_requirements', {
      section: 'constraints',
      value: {
        board_rules: {
          clearance_mm: 0.2,
          track_mm: 0.25,
          via_mm: 0.6,
          drill_mm: 0.3,
          edge_mm: 0.3,
          hole_mm: 0.25,
        },
      },
    });
    await call('generate_schematic');
    assert.equal((await call('run_erc')).native.status, 'PASS');
    assert.equal(
      (
        await call('generate_pcb', {
          cad_only_reason: 'Installed runtime CAD prototype qualification',
        })
      ).native.status,
      'PASS',
    );
    const drc = (await call('run_drc')).native;
    assert.equal(drc.status, 'PASS');
    assert.equal(drc.report.report_valid, true);
    assert.equal(drc.report.counts.error, 0);
    assert.equal((await call('verify_design')).native.status, 'UNKNOWN');
    assert.ok(fs.existsSync(path.join(project, 'board.kicad_pcb')));
    evidence.nativeChecks = {
      erc: 'PASS',
      drc: drc.status,
      drcErrors: drc.report.counts.error,
      overallDesign: 'UNKNOWN',
    };
    const toolId = 'pcb.design.run_python';
    const pending = view.runtime.execute(
      { toolId, inputs: { code: 'while True: pass' }, expectedStateId: state.id },
      {
        approval: true,
        scope: { domain: 'pcb', projectId: state.projectId, stateId: state.id, tools: [toolId] },
      },
    );
    await new Promise(resolve => setTimeout(resolve, 1500));
    view.runtime.cancel();
    const cancelled = await pending;
    assert.equal(cancelled.action.status, 'failed');
    evidence.cancellation = {
      actionStatus: cancelled.action.status,
      verification: cancelled.verification.status,
    };
    await view.runtime.close();
    view = open();
    state = await view.runtime.inspect();
    const recovered = await call('project_status');
    assert.ok(recovered.native.files['board.kicad_pcb']);
    assert.equal(JSON.parse(fs.readFileSync(path.join(project, 'spec.json'))).parts[0].value, '1k');
    evidence.recovery = { boardPresent: true, componentValue: '1k' };
    // Cancel a final bounded action through Runtime so the persistent recovered
    // session is closed before this qualification process exits.
    const cleanup = view.runtime.execute(
      { toolId, inputs: { code: 'while True: pass' }, expectedStateId: state.id },
      {
        approval: true,
        scope: { domain: 'pcb', projectId: state.projectId, stateId: state.id, tools: [toolId] },
      },
    );
    await new Promise(resolve => setTimeout(resolve, 1500));
    view.runtime.cancel();
    assert.equal((await cleanup).action.status, 'failed');
    assert.deepEqual(catalog.manager.scan().errors, []);
    evidence.passed = true;
    if (process.env.HARNESS_PCB_EVIDENCE_DIR) {
      const output = path.resolve(process.env.HARNESS_PCB_EVIDENCE_DIR);
      fs.mkdirSync(output, { recursive: true });
      fs.writeFileSync(
        path.join(output, 'pcb-design-installed-report.json'),
        JSON.stringify(evidence, null, 2) + '\n',
      );
    }
    process.stdout.write(JSON.stringify(evidence) + '\n');
  },
);
