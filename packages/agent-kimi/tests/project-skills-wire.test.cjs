const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { KimiSession } = require('../src/index.cjs');
const { validateProfile, writeCliConfig, sessionEnv } = require('../src/model-config.cjs');
const { startModel } = require('../../../tests/integration/fixtures/domain-mcp-model.cjs');

test(
  'real current-user Kimi discovers project skills progressively with native brand precedence',
  {
    skip: !process.env.KIMI_EXECUTABLE || !['darwin', 'linux'].includes(process.platform),
    timeout: 45000,
  },
  async t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-project-skills-wire-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const project = path.join(root, 'project with spaces');
    const roots = [
      '.skill',
      '.skills',
      '.agents/skills',
      '.kimi/skills',
      '.claude/skills',
      '.codex/skills',
    ];
    const files = roots.map((relative, index) => {
      const file = path.join(project, relative, `guide-${index}`, 'SKILL.md');
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(
        file,
        `---\nname: harness-wire-guide-${index}\ndescription: HARNESS_DISCOVERY_${index}\n---\nHARNESS_LAZY_BODY_${index}\n`,
      );
      return file;
    });
    fs.writeFileSync(path.join(project, '.skills/broken.md'), '---\nname: [invalid yaml\n---\n');
    fs.writeFileSync(path.join(project, 'AGENTS.md'), 'HARNESS_ROOT_PROJECT_INSTRUCTIONS\n');
    fs.writeFileSync(path.join(project, '.kimi/AGENTS.md'), 'HARNESS_KIMI_PROJECT_INSTRUCTIONS\n');
    fs.writeFileSync(path.join(project, 'counter.sv'), 'module counter; endmodule\n');
    for (const brand of ['.kimi', '.claude', '.codex']) {
      const directory = path.join(project, brand, 'skills/shared-guide');
      fs.mkdirSync(directory, { recursive: true });
      fs.writeFileSync(
        path.join(directory, 'SKILL.md'),
        `---\nname: harness-wire-shared-guide\ndescription: HARNESS_BRAND_PRIORITY_${brand}\n---\nShared guide\n`,
      );
    }
    const fixture = await startModel({
      calls: [
        { name: 'Read', arguments: { path: files[0] } },
        { name: 'Glob', arguments: { pattern: '*.sv', path: fs.realpathSync(project) } },
      ],
      success: 'PROJECT_SKILL_READ',
    });
    t.after(fixture.close);
    const profile = validateProfile({
      provider: 'openai_legacy',
      endpoint: fixture.endpoint,
      model: 'project-skills-test',
      contextSize: 262144,
      thinking: false,
    });
    const runtime = {
      profile,
      apiKey: 'fixture-key',
      shareDir: writeCliConfig(path.join(root, 'model'), profile),
      env: {
        ...sessionEnv(profile, 'fixture-key'),
        KIMI_SHARE_DIR: path.join(root, 'foreign-share'),
      },
      executable: process.env.KIMI_EXECUTABLE,
      revision: 0,
    };
    const events = [];
    const session = new KimiSession(
      project,
      () => ({ domain: 'test', stage: 'test', capabilityIds: [], skills: [], tools: [] }),
      () => null,
      () => null,
      event => events.push(event),
      () => runtime,
      undefined,
      { directory: path.join(root, 'logs') },
    );
    t.after(() => session.close());
    const timer = setTimeout(() => void session.interrupt(), 35000);
    t.after(() => clearTimeout(timer));
    await session.run('Read the local project guide');
    assert.deepEqual(
      events.filter(event => event.type === 'error'),
      [],
    );
    assert.ok(
      events.some(
        event =>
          event.type === 'execution-boundary' &&
          event.mechanism === 'current-user' &&
          event.osIsolation === false &&
          event.projectWritable === true,
      ),
    );
    assert.equal(fixture.requests.length, 3);
    const initial = JSON.stringify(fixture.requests[0].messages);
    for (const index of [0, 1, 2, 3, 4, 5])
      assert.match(initial, new RegExp(`HARNESS_DISCOVERY_${index}`));
    assert.match(initial, /HARNESS_ROOT_PROJECT_INSTRUCTIONS/);
    assert.match(initial, /HARNESS_KIMI_PROJECT_INSTRUCTIONS/);
    assert.ok(initial.includes('HARNESS_BRAND_PRIORITY_.kimi'));
    for (const brand of ['.claude', '.codex'])
      assert.ok(!initial.includes(`HARNESS_BRAND_PRIORITY_${brand}`));
    assert.ok(!initial.includes('HARNESS_LAZY_BODY_0'));
    assert.match(JSON.stringify(fixture.requests[1].messages), /HARNESS_LAZY_BODY_0/);
    const search = JSON.stringify(
      fixture.requests[2].messages.filter(message => message.role === 'tool').at(-1),
    );
    assert.match(search, /counter\.sv/);
    assert.ok(!search.includes('outside the workspace'));
    assert.ok(
      !fixture.requests[0].tools.some(tool => tool.function.name === 'industrial_action_call'),
    );
    assert.match(fs.readFileSync(files[0], 'utf8'), /HARNESS_LAZY_BODY_0/);
  },
);
