const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { prepareSessionFiles } = require('../src/index.cjs');

test('Kimi session receives only selected repository skills and an isolated MCP config', t => {
  const source = fs.mkdtempSync(path.join(os.tmpdir(), 'industrial-kimi-source-'));
  t.after(() => fs.rmSync(source, { recursive: true, force: true }));
  fs.writeFileSync(path.join(source, 'config.toml'), 'default_model = "industrial"\n');
  const directory = prepareSessionFiles(
    { domain: 'chip', skills: ['chip.netlist.inspect'], tools: [] },
    { shareDir: source, disabledMcpServers: [] },
  );
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  assert.deepEqual(fs.readdirSync(path.join(directory, 'skills')), ['chip-netlist-inspect']);
  assert.match(
    fs.readFileSync(path.join(directory, 'config.toml'), 'utf8'),
    /^extra_skill_dirs = \[/,
  );
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(directory, 'mcp.json'))), {
    mcpServers: {},
  });
});

test('session exposes project skill roots without changing project files', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'industrial-project-skills-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const project = path.join(root, 'project with spaces');
  const source = path.join(root, 'source');
  const session = path.join(root, 'session');
  fs.mkdirSync(source);
  fs.writeFileSync(path.join(source, 'config.toml'), 'default_model = "industrial"\n');
  for (const name of [
    '.skill',
    '.skills',
    '.kimi/skills',
    '.claude/skills',
    '.codex/skills',
    '.agents/skills',
  ]) {
    const directory = path.join(project, name, 'local-guide');
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(
      path.join(directory, 'SKILL.md'),
      '---\nname: local-guide\ndescription: Project guide\n---\nOriginal content\n',
    );
  }
  const scope = { domain: 'test', skills: [], tools: [] };
  const runtime = { shareDir: source, disabledMcpServers: [] };
  fs.writeFileSync(path.join(project, 'AGENTS.md'), 'Project instructions\n');
  fs.writeFileSync(path.join(project, '.kimi/AGENTS.md'), 'Kimi project instructions\n');
  prepareSessionFiles(scope, runtime, session, project);
  const config = fs.readFileSync(path.join(session, 'config.toml'), 'utf8');
  const extra = JSON.parse(config.split('\n')[0].split(' = ')[1]);
  const inputRoot = process.platform === 'win32' ? path.join(session, 'workspace') : project;
  assert.deepEqual(extra, [
    fs.realpathSync(path.join(inputRoot, '.skill')),
    fs.realpathSync(path.join(inputRoot, '.skills')),
    fs.realpathSync(path.join(inputRoot, '.claude/skills')),
    fs.realpathSync(path.join(inputRoot, '.codex/skills')),
    path.join(session, 'skills'),
  ]);
  for (const brand of ['.kimi', '.claude', '.codex', '.agents']) {
    const mapped = path.join(session, 'workspace', brand, 'skills');
    if (process.platform === 'win32') assert.equal(fs.lstatSync(mapped).isSymbolicLink(), false);
    else
      assert.equal(fs.realpathSync(mapped), fs.realpathSync(path.join(project, brand, 'skills')));
    assert.match(
      fs.readFileSync(path.join(mapped, 'local-guide/SKILL.md'), 'utf8'),
      /Original content/,
    );
  }
  assert.deepEqual(fs.readdirSync(path.join(session, 'skills')), []);
  for (const relative of ['AGENTS.md', '.kimi/AGENTS.md']) {
    const mapped = path.join(session, 'workspace', relative);
    if (process.platform === 'win32') {
      assert.equal(fs.lstatSync(mapped).isSymbolicLink(), false);
      assert.equal(
        fs.readFileSync(mapped, 'utf8'),
        fs.readFileSync(path.join(project, relative), 'utf8'),
      );
    } else assert.equal(fs.realpathSync(mapped), fs.realpathSync(path.join(project, relative)));
  }
  // Re-preparing persistent storage must not leave deleted project roots active.
  fs.rmSync(path.join(project, '.kimi'), { recursive: true });
  fs.rmSync(path.join(project, '.skill'), { recursive: true });
  fs.rmSync(path.join(project, 'AGENTS.md'));
  prepareSessionFiles(scope, runtime, session, project);
  assert.ok(!fs.existsSync(path.join(session, 'workspace/.kimi/skills')));
  assert.ok(!fs.existsSync(path.join(session, 'workspace/AGENTS.md')));
  assert.ok(!fs.existsSync(path.join(session, 'workspace/.kimi/AGENTS.md')));
  assert.deepEqual(
    JSON.parse(
      fs.readFileSync(path.join(session, 'config.toml'), 'utf8').split('\n')[0].split(' = ')[1],
    ),
    [
      fs.realpathSync(path.join(inputRoot, '.skills')),
      fs.realpathSync(path.join(inputRoot, '.claude/skills')),
      fs.realpathSync(path.join(inputRoot, '.codex/skills')),
      path.join(session, 'skills'),
    ],
  );
  assert.match(
    fs.readFileSync(path.join(project, '.agents/skills/local-guide/SKILL.md'), 'utf8'),
    /Original content/,
  );
});

test('missing project skill roots are optional and workspace parent links are rejected', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'industrial-project-skills-boundary-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const { prepareProjectWorkspace } = require('../src/project-workspace.cjs');
  const project = path.join(root, 'project');
  const session = path.join(root, 'session');
  fs.mkdirSync(project);
  fs.writeFileSync(path.join(project, '.skill'), 'a file is not a skills root');
  assert.deepEqual(prepareProjectWorkspace(session, project), []);
  fs.symlinkSync(project, path.join(session, 'workspace/.kimi'), 'junction');
  assert.throws(
    () => prepareProjectWorkspace(session, project),
    /requires a session directory|input links are not permitted/,
  );
  fs.rmSync(path.join(session, 'workspace'), { recursive: true });
  fs.symlinkSync(project, path.join(session, 'workspace'), 'junction');
  assert.throws(
    () => prepareProjectWorkspace(session, project),
    /session workspace directory|input links are not permitted/,
  );
  assert.equal(
    fs.readFileSync(path.join(project, '.skill'), 'utf8'),
    'a file is not a skills root',
  );
});
