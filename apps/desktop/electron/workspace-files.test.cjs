const test = require('node:test');
const assert = require('node:assert/strict');
test('browsing replaces one preview while explicitly retained files keep their identity', async () => {
  const { openWorkspaceFile } = await import('../src/workspace-files.ts');
  const file = (path, id = path, sha256 = id) => ({
    id,
    path,
    name: path,
    artifact: { id, sha256 },
  });
  let current = openWorkspaceFile([], file('model.FCStd')).files;
  current = openWorkspaceFile(current, file('README.md')).files;
  assert.deepEqual(
    current.map(item => item.path),
    ['README.md'],
  );
  current = openWorkspaceFile(current, file('README.md', 'new-read', 'README.md'), true).files;
  const retained = current[0];
  assert.equal(retained.id, 'README.md', 'Pinning an unchanged artifact retains its Viewer');
  assert.equal(retained.preview, false);
  current = openWorkspaceFile(current, file('model.FCStd')).files;
  current = openWorkspaceFile(current, file('recipe.json')).files;
  assert.equal(current[0], retained);
  assert.deepEqual(
    current.map(item => [item.path, item.preview]),
    [
      ['README.md', false],
      ['recipe.json', true],
    ],
  );
  const reopened = openWorkspaceFile(current, file('README.md', 'refresh', 'README.md'));
  assert.equal(reopened.selected.id, retained.id);
  assert.equal(reopened.selected.preview, false, 'Single-clicking a pinned file does not unpin it');
  assert.deepEqual(
    reopened.files.map(item => item.path),
    ['README.md', 'recipe.json'],
  );
  const changed = openWorkspaceFile(reopened.files, file('README.md', 'changed'));
  assert.equal(changed.selected.id, 'changed');
  assert.equal(changed.selected.preview, false, 'Refreshing a changed source retains pin status');
  assert.equal(reopened.files[0], retained, 'Opening is a pure update');
  const retried = openWorkspaceFile(
    reopened.files,
    file('README.md', 'retry', 'README.md'),
    false,
    true,
  );
  assert.equal(
    retried.selected.id,
    'retry',
    'Retrying a failed view recreates it even when the source hash is unchanged',
  );
  assert.equal(retried.selected.preview, false);
});

test('pinning a second file retains the active preview and browsing replaces only that preview', async () => {
  const { openWorkspaceFile } = await import('../src/workspace-files.ts');
  const pinned = Object.freeze({
    id: 'pinned',
    path: 'notes.md',
    name: 'notes.md',
    preview: false,
  });
  const preview = Object.freeze({
    id: 'preview',
    path: 'draft.md',
    name: 'draft.md',
    preview: true,
  });
  const current = Object.freeze([pinned, preview]);
  const next = { id: 'new-pin', path: 'spec.md', name: 'spec.md' };
  const retained = openWorkspaceFile(current, next, true);
  assert.deepEqual(
    retained.files.map(file => [file.path, file.preview]),
    [
      ['notes.md', false],
      ['draft.md', true],
      ['spec.md', false],
    ],
  );
  assert.equal(retained.files[0], pinned);
  assert.equal(retained.files[1], preview);
  assert.equal(next.preview, undefined, 'Opening must not mutate the caller-owned file');
  const browsed = openWorkspaceFile(retained.files, {
    id: 'readme',
    path: 'README.md',
    name: 'README.md',
  });
  assert.deepEqual(
    browsed.files.map(file => file.path),
    ['notes.md', 'README.md', 'spec.md'],
  );
  assert.equal(browsed.files[2], retained.selected, 'The other pinned view retains its identity');
  assert.equal(current.length, 2);
});

test('source-only previews refresh their content without silently pinning or duplicating the tab', async () => {
  const { openWorkspaceFile } = await import('../src/workspace-files.ts');
  const old = Object.freeze({
    id: 'old',
    path: 'settings.json',
    name: 'settings.json',
    preview: true,
    source: Object.freeze({ content: '{"enabled":false}', truncated: false }),
  });
  const next = {
    id: 'new',
    path: 'settings.json',
    name: 'settings.json',
    source: { content: '{"enabled":true}', truncated: false },
  };
  const refreshed = openWorkspaceFile(Object.freeze([old]), next);
  assert.equal(refreshed.files.length, 1);
  assert.equal(refreshed.selected.source.content, '{"enabled":true}');
  assert.equal(refreshed.selected.preview, true);
  assert.equal(old.source.content, '{"enabled":false}');
  const pinned = openWorkspaceFile(refreshed.files, next, true);
  const retry = openWorkspaceFile(pinned.files, { ...next, id: 'retry' }, false, true);
  assert.equal(retry.selected.id, 'retry');
  assert.equal(retry.selected.preview, false);
  assert.equal(retry.files.length, 1);
});

test('equal artifact hashes at different paths remain separate retained views', async () => {
  const { openWorkspaceFile } = await import('../src/workspace-files.ts');
  const file = path => ({
    id: path,
    path,
    name: path,
    artifact: { id: path, sha256: 'same-bytes' },
  });
  const first = openWorkspaceFile([], file('input/model.step'), true);
  const second = openWorkspaceFile(first.files, file('output/model.step'), true);
  assert.equal(second.files.length, 2);
  assert.equal(second.files[0], first.selected);
  assert.equal(second.selected.path, 'output/model.step');
  const reopened = openWorkspaceFile(second.files, { ...file('input/model.step'), id: 'fresh-id' });
  assert.equal(reopened.selected, first.selected);
  assert.equal(reopened.files[1], second.selected);
});
