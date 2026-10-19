const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { prepareProjectWorkspace } = require('../src/project-workspace.cjs');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'industrial-win-inputs-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const project = path.join(root, 'project with spaces');
  const session = path.join(root, 'session');
  fs.mkdirSync(project);
  const write = (relative, content = 'input') => {
    const file = path.join(project, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
    return file;
  };
  return {
    root,
    project,
    session,
    write,
    workspace: path.join(session, 'workspace'),
    prepare: () => prepareProjectWorkspace(session, project, 'win32'),
  };
}

test('Windows snapshots preserve native discovery roots, fallbacks and instruction precedence', t => {
  const f = fixture(t);
  for (const relative of [
    '.skill',
    '.skills',
    '.kimi/skills',
    '.claude/skills',
    '.codex/skills',
    '.agents/skills',
  ])
    f.write(`${relative}/guide/SKILL.md`, relative);
  f.write('AGENTS.md', 'primary instructions');
  if (!fs.existsSync(path.join(f.project, 'agents.md')))
    f.write('agents.md', 'lowercase instructions');
  f.write('.kimi/AGENTS.md', 'legacy instructions');
  f.write('engineering/design.v', 'must stay in project');
  assert.deepEqual(
    f.prepare(),
    ['.skill', '.skills', '.claude/skills', '.codex/skills'].map(relative =>
      path.join(f.workspace, relative),
    ),
  );
  for (const brand of ['.kimi-code', '.kimi', '.claude', '.codex', '.agents']) {
    const mapped = path.join(f.workspace, brand, 'skills');
    assert.equal(fs.lstatSync(mapped).isSymbolicLink(), false);
    assert.equal(fs.lstatSync(path.join(mapped, 'guide/SKILL.md')).isSymbolicLink(), false);
  }
  assert.equal(
    fs.readFileSync(path.join(f.workspace, '.kimi-code/skills/guide/SKILL.md'), 'utf8'),
    '.kimi/skills',
  );
  assert.equal(
    fs.readFileSync(path.join(f.workspace, 'AGENTS.md'), 'utf8'),
    'primary instructions',
  );
  assert.equal(
    fs.readFileSync(path.join(f.workspace, '.kimi-code/AGENTS.md'), 'utf8'),
    'legacy instructions',
  );
  assert.equal(fs.existsSync(path.join(f.workspace, 'engineering')), false);
  fs.writeFileSync(path.join(f.workspace, '.agents/skills/guide/SKILL.md'), 'session edit');
  assert.equal(
    fs.readFileSync(path.join(f.project, '.agents/skills/guide/SKILL.md'), 'utf8'),
    '.agents/skills',
  );

  f.write('.kimi-code/skills/native/SKILL.md', 'native guide');
  f.write('.kimi-code/AGENTS.md', 'native instructions');
  f.prepare();
  assert.equal(fs.existsSync(path.join(f.workspace, '.kimi-code/skills/guide')), false);
  assert.equal(
    fs.readFileSync(path.join(f.workspace, '.kimi-code/skills/native/SKILL.md'), 'utf8'),
    'native guide',
  );
  assert.equal(
    fs.readFileSync(path.join(f.workspace, '.kimi-code/AGENTS.md'), 'utf8'),
    'native instructions',
  );
});

test('Windows refresh removes deleted project inputs while preserving unrelated session files', t => {
  const f = fixture(t);
  f.write('.skills/guide/SKILL.md');
  f.write('.kimi/skills/guide/SKILL.md');
  f.write('agents.md', 'lowercase instructions');
  f.prepare();
  fs.writeFileSync(path.join(f.workspace, 'scratch.txt'), 'session data');
  fs.rmSync(path.join(f.project, '.skills'), { recursive: true });
  fs.rmSync(path.join(f.project, '.kimi'), { recursive: true });
  fs.rmSync(path.join(f.project, 'agents.md'));
  assert.deepEqual(f.prepare(), []);
  for (const relative of ['.skills', '.kimi/skills', '.kimi-code/skills', 'agents.md'])
    assert.equal(fs.existsSync(path.join(f.workspace, relative)), false);
  assert.equal(fs.readFileSync(path.join(f.workspace, 'scratch.txt'), 'utf8'), 'session data');
});

test('Windows refresh replaces an old hard link without modifying its source', t => {
  const f = fixture(t);
  const original = f.write('AGENTS.md', 'new instructions');
  fs.mkdirSync(f.workspace, { recursive: true });
  const outside = path.join(f.root, 'unrelated.txt');
  fs.writeFileSync(outside, 'protected content');
  fs.linkSync(outside, path.join(f.workspace, 'AGENTS.md'));
  f.prepare();
  assert.equal(fs.readFileSync(outside, 'utf8'), 'protected content');
  assert.equal(fs.readFileSync(original, 'utf8'), 'new instructions');
  assert.equal(fs.readFileSync(path.join(f.workspace, 'AGENTS.md'), 'utf8'), 'new instructions');
  assert.equal(fs.statSync(path.join(f.workspace, 'AGENTS.md')).nlink, 1);
});

test('Windows rejects source junctions before creating a session snapshot', t => {
  const f = fixture(t);
  const outside = path.join(f.root, 'outside');
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, 'SKILL.md'), 'outside');
  fs.symlinkSync(outside, path.join(f.project, '.skills'), 'junction');
  assert.throws(f.prepare, /input links are not permitted/);
  assert.equal(fs.existsSync(f.session), false);
});

test('Windows rejects nested destination junctions before refreshing any files', t => {
  const f = fixture(t);
  f.write('AGENTS.md', 'new instructions');
  fs.mkdirSync(path.join(f.workspace, '.skills'), { recursive: true });
  fs.writeFileSync(path.join(f.workspace, 'AGENTS.md'), 'previous instructions');
  fs.symlinkSync(f.project, path.join(f.workspace, '.skills/escape'), 'junction');
  assert.throws(f.prepare, /input links are not permitted/);
  assert.equal(
    fs.readFileSync(path.join(f.workspace, 'AGENTS.md'), 'utf8'),
    'previous instructions',
  );
  assert.equal(fs.readFileSync(path.join(f.project, 'AGENTS.md'), 'utf8'), 'new instructions');
});

test('Windows input file and aggregate limits fail before replacing existing snapshots', t => {
  const f = fixture(t);
  f.write('AGENTS.md', 'initial');
  f.prepare();
  f.write('AGENTS.md', 'replacement');
  const large = f.write('.skills/oversized.md', Buffer.alloc(1024 * 1024 + 1));
  assert.throws(f.prepare, /file limit/);
  assert.equal(fs.readFileSync(path.join(f.workspace, 'AGENTS.md'), 'utf8'), 'initial');
  fs.unlinkSync(large);
  for (let index = 0; index < 17; index++)
    f.write(`.skills/${index}.md`, Buffer.alloc(1024 * 1024));
  assert.throws(f.prepare, /byte limit/);
  assert.equal(fs.readFileSync(path.join(f.workspace, 'AGENTS.md'), 'utf8'), 'initial');
});

test('Windows rejects overly deep and excessive input trees without partial snapshots', t => {
  const f = fixture(t);
  f.write(`.skills/${Array(17).fill('nested').join('/')}/SKILL.md`);
  assert.throws(f.prepare, /depth limit/);
  assert.equal(fs.existsSync(f.session), false);
  fs.rmSync(path.join(f.project, '.skills'), { recursive: true });
  for (let index = 0; index < 2048; index++) f.write(`.skills/${index}.md`, '');
  assert.throws(f.prepare, /entry limit/);
  assert.equal(fs.existsSync(f.session), false);
});

test(
  'Windows rejects reserved names and alternate data stream syntax',
  { skip: process.platform === 'win32' },
  t => {
    const f = fixture(t);
    for (const name of ['CON.md', 'LPT1.log', 'guide:stream', 'trailing.', 'escape\\name']) {
      const file = f.write(`.skills/${name}`);
      assert.throws(f.prepare, /Unsupported Windows project input name/);
      assert.equal(fs.existsSync(f.session), false);
      fs.unlinkSync(file);
    }
  },
);
