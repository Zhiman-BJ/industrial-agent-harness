'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { extractReferences, titleOf } = require('../src/markdown-links.cjs');
const { resolveRelative } = require('../src/index-builder.cjs');

test('titles come from the first heading', () => {
  assert.equal(titleOf('正文在前\n# 标题在后\n', 'fallback'), '标题在后');
  assert.equal(titleOf('没有标题的文档', 'fallback'), 'fallback');
});

test('links inside code fences and inline code are not references', () => {
  const references = extractReferences(
    '正文 [真链接](a.md)\n\n```js\nconst x = "[假链接](fence.md)";\n```\n行内 `[内联](inline.md)` 结束',
  );
  assert.deepEqual(
    references.links.map(link => link.target),
    ['a.md'],
  );
});

test('images and links are separated', () => {
  const references = extractReferences('[文字](doc.md) ![图](img/banner.png)');
  assert.equal(references.links.length, 1);
  assert.equal(references.images.length, 1);
});

test('relative resolution: parent, sibling, fragment, external, unsafe', () => {
  assert.deepEqual(resolveRelative('guides/', '../README.md'), { id: 'README', anchor: null });
  assert.deepEqual(resolveRelative('', 'guides/usage.md'), { id: 'guides/usage', anchor: null });
  assert.deepEqual(resolveRelative('guides/', 'usage.md#数据流'), {
    id: 'guides/usage',
    anchor: '数据流',
  });
  assert.deepEqual(resolveRelative('guides/', '#锚点'), { anchor: '锚点' });
  assert.deepEqual(resolveRelative('', 'https://example.com/x'), {
    external: 'https://example.com/x',
  });
  assert.deepEqual(resolveRelative('', 'mailto:a@b.c'), { external: 'mailto:a@b.c' });
  // URL-encoded traversal stays conservative: any '..' substring is rejected.
  assert.equal(resolveRelative('', '..%2Fescape.md'), null);
  assert.equal(resolveRelative('', 'a/../../b.md'), null);
  assert.equal(resolveRelative('', 'C:/win.md'), null);
  assert.equal(resolveRelative('', 'back\\slash.md'), null);
});

test('fixture paths line up', () => {
  assert.equal(path.posix.dirname('guides/usage.md'), 'guides');
  assert.equal(path.posix.dirname('README.md'), '.');
});
