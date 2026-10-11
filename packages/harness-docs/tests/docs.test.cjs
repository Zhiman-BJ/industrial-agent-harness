'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const { buildDocsIndex } = require('../src/index-builder.cjs');
const { createDocsProvider, DocsError } = require('../src/provider.cjs');
const { createDocsNavigation } = require('../src/navigation.cjs');

const FIXTURE_ROOT = path.join(__dirname, '..', 'fixtures', 'docs');

function provider(root = FIXTURE_ROOT) {
  const manifest = buildDocsIndex(root, { include: ['*.md', 'guides/*.md', 'images/*'] });
  return { manifest, provider: createDocsProvider({ manifest, root }) };
}

test('the fixture index covers docs, assets, and records broken refs', () => {
  const { manifest } = provider();
  assert.deepEqual(manifest.docs.map(doc => doc.id).sort(), [
    'README',
    'architecture',
    'guides/usage',
  ]);
  assert.deepEqual(
    manifest.assets.map(asset => asset.id),
    ['images/banner.png'],
  );
  assert.equal(manifest.edition, 'internal-only');
  // The link inside the code fence is NOT a reference; the missing image is
  // an explicit gap, not a crash.
  const architecture = manifest.docs.find(doc => doc.id === 'architecture');
  assert.deepEqual(
    architecture.links.map(link => link.target),
    ['guides/usage.md#数据流'],
  );
  assert.deepEqual(manifest.brokenRefs, [
    { from: 'architecture', kind: 'image', target: 'images/not-there.png' },
  ]);
});

test('titles and CJK anchors come from the docs themselves', () => {
  const { manifest } = provider();
  assert.equal(manifest.docs.find(doc => doc.id === 'README').title, '研发文档索引');
  assert.equal(manifest.docs.find(doc => doc.id === 'guides/usage').title, '使用指南');
});

test('the provider accepts manifest ids only', () => {
  const { provider: docs } = provider();
  assert.match(docs.getDoc('guides/usage').markdown, /TaskService/);
  assert.throws(
    () => docs.getDoc('../../AGENTS'),
    error => {
      assert.ok(error instanceof DocsError);
      assert.equal(error.code, 'docs:unknown-id');
      return true;
    },
  );
  assert.throws(
    () => docs.getDoc(''),
    error => error.code === 'docs:unknown-id',
  );
});

test('tampered docs fail the hash check instead of silently serving new bytes', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-docs-'));
  fs.writeFileSync(path.join(root, 'a.md'), '# 原文\n');
  const { provider: docs } = (() => {
    const manifest = buildDocsIndex(root, { include: ['*.md'] });
    return { provider: createDocsProvider({ manifest, root }) };
  })();
  fs.writeFileSync(path.join(root, 'a.md'), '# 篡改后\n');
  assert.throws(
    () => docs.getDoc('a'),
    error => error.code === 'docs:hash-mismatch',
  );
});

test('a symlinked doc file is refused by the provider', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-docs-'));
  fs.writeFileSync(path.join(root, 'real.md'), '# 真\n');
  fs.symlinkSync(path.join(root, 'real.md'), path.join(root, 'linked.md'));
  const manifest = buildDocsIndex(root, { include: ['*.md'] });
  // The builder itself refuses symlinks, so tamper the manifest to simulate a
  // stale index pointing at one — the provider must still refuse to follow it.
  manifest.docs.push({
    id: 'linked',
    file: 'linked.md',
    title: 'linked',
    bytes: 5,
    sha256: '0'.repeat(64),
    links: [],
    images: [],
  });
  const docs = createDocsProvider({ manifest, root });
  assert.throws(
    () => docs.getDoc('linked'),
    error => /unknown-id|unsafe-path/.test(error.code) || error.code === undefined,
  );
});

test('links resolve to doc ids, anchors, externals, or explicit missing', () => {
  const { provider: docs } = provider();
  assert.deepEqual(docs.resolveLink('README', 'architecture.md'), {
    kind: 'doc',
    targetId: 'architecture',
    anchor: null,
  });
  assert.deepEqual(docs.resolveLink('README', 'guides/usage.md#数据流'), {
    kind: 'doc',
    targetId: 'guides/usage',
    anchor: '数据流',
  });
  assert.deepEqual(docs.resolveLink('guides/usage', '../README.md'), {
    kind: 'doc',
    targetId: 'README',
    anchor: null,
  });
  assert.deepEqual(docs.resolveLink('guides/usage', '#数据流'), {
    kind: 'anchor',
    anchor: '数据流',
  });
  assert.deepEqual(docs.resolveLink('README', 'https://example.com/external'), {
    kind: 'external',
    href: 'https://example.com/external',
  });
  assert.deepEqual(docs.resolveLink('README', 'no-such.md'), {
    kind: 'missing',
    href: 'no-such.md',
  });
  assert.deepEqual(docs.resolveLink('README', '../../escape.md'), {
    kind: 'missing',
    href: '../../escape.md',
  });
});

test('search matches CJK and latin, with caps and honest counts', () => {
  const { provider: docs } = provider();
  const cjk = docs.search('数据流');
  assert.ok(cjk.results.length >= 1);
  assert.equal(cjk.results[0].id, 'guides/usage');
  assert.match(cjk.results[0].snippet, /任务事件/);
  const latin = docs.search('taskservice');
  assert.ok(
    latin.results.some(result => result.id === 'guides/usage'),
    'case-insensitive latin match',
  );
  const limited = docs.search('的');
  assert.ok(limited.results.length <= 50);
  assert.equal(typeof limited.hasMore, 'boolean');
  assert.equal(limited.matched >= limited.results.length, true);
  assert.throws(
    () => docs.search('   '),
    error => error.code === 'docs:empty-query',
  );
  assert.throws(
    () => docs.search('x'.repeat(101)),
    error => error.code === 'docs:query-too-long',
  );
});

test('assets are served by manifest id with verified bytes', () => {
  const { provider: docs } = provider();
  const asset = docs.getAsset('images/banner.png');
  assert.equal(asset.bytes.toString(), 'PNG-fixture-bytes');
  assert.equal(asset.mediaType, 'image/png');
  assert.throws(
    () => docs.getAsset('images/not-there.png'),
    error => error.code === 'docs:unknown-id',
  );
});

test('the navigation stack supports anchors, back, caps, and reset', () => {
  const nav = createDocsNavigation({ start: { id: 'README' } });
  assert.deepEqual(nav.current(), { id: 'README', anchor: null, depth: 1, canBack: false });
  nav.open('architecture');
  nav.open('architecture', '#数据流'); // anchor jump inside the same doc
  assert.equal(nav.current().canBack, true);
  nav.back();
  assert.equal(nav.current().id, 'architecture');
  assert.equal(nav.current().anchor, null);
  nav.back();
  assert.equal(nav.current().id, 'README');
  nav.back(); // at the bottom: staying put, never undefined
  assert.equal(nav.current().id, 'README');
  for (let index = 0; index < 300; index++) nav.open('architecture', `#a${index}`);
  assert.ok(nav.current().depth <= 100, 'stack depth is capped');
  nav.reset('guides/usage');
  assert.deepEqual(nav.current(), { id: 'guides/usage', anchor: null, depth: 1, canBack: false });
});

test('builder limits reject oversize subsets deterministically', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-docs-'));
  fs.writeFileSync(path.join(root, 'big.md'), `# 大文件\n${'x'.repeat(300 * 1024)}`);
  assert.throws(() => buildDocsIndex(root, { include: ['*.md'] }), /maxDocBytes/);
});
