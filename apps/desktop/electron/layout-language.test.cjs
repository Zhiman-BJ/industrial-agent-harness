const assert = require('node:assert/strict');
const { test } = require('node:test');
const core = import('../src/i18n/core.ts');

test('layout diagnostics translate both invoke.message and String(invokeError) without losing unknown diagnostics', async () => {
  const { translate } = await core;
  const cases = [
    ['viewer:open', 'KLayout Python is unavailable. Set KLAYOUT_PYTHON or run pnpm setup:layout.'],
    ['viewer:open', 'Layout import unsupported: input exceeds the 128 MiB local limit.'],
    ['viewer:render', 'KLayout renderer stopped. Retry the viewport.'],
    ['viewer:layout-tile', 'KLayout worker exceeded its memory budget. Retry a smaller viewport.'],
    ['viewer:layout-tile', 'KLayout render timed out. Retry the viewport.'],
    [
      'viewer:layout-tile',
      'Layout tile rendering unsupported: resource monitoring is unavailable on this platform.',
    ],
    ['viewer:layout-tile', 'Layout request queue is full. Retry the current viewport.'],
    ['viewer:render', 'Viewport is smaller than one layout database unit.'],
    ['viewer:open', 'Artifact content changed; reopen the file.'],
  ];
  for (const [channel, message] of cases) {
    const chinese = translate('zh-CN', message);
    assert.notEqual(chinese, message, `untranslated: ${message}`);
    for (const wrapper of [
      `Error invoking remote method '${channel}': Error: ${message}`,
      `Error: Error invoking remote method '${channel}': Error: ${message}`,
    ]) {
      assert.equal(translate('zh-CN', wrapper), chinese);
      assert.equal(translate('en', wrapper), message);
    }
  }
  const unknown =
    "Error invoking remote method 'viewer:render': Error: Native parser detail: cell A, code 83\nretained diagnostic";
  assert.equal(translate('zh-CN', unknown), unknown);
  assert.equal(translate('en', unknown), unknown);
  assert.equal(translate('zh-CN', 'Error: Invalid viewport.'), 'Error: 显示区域无效。');
});

test('layout text follows supported primary locales, preserving technical identity and interpolation data', async () => {
  const { languageOptions, normalizePreference, systemLocale, translate } = await core;
  assert.deepEqual(languageOptions.map(option => option.value).sort(), ['en', 'zh-CN']);
  assert.equal(normalizePreference('system'), 'system');
  for (const [languages, expected] of [
    [['zh-CN', 'en-US'], 'zh-CN'],
    [['zh-Hant-TW'], 'zh-CN'],
    [['en-GB', 'zh-CN'], 'en'],
    [['fr-FR', 'zh-CN'], 'en'],
    [[], 'en'],
  ]) {
    const locale = systemLocale(languages);
    assert.equal(locale, expected);
    assert.equal(
      translate(locale, 'Layer {0}', { 0: '235/0' }),
      expected === 'en' ? 'Layer 235/0' : '图层 235/0',
    );
  }
  const cell = '<cell 中文> {0} $&';
  assert.equal(
    translate('zh-CN', 'KLayout rendering of {0}', { 0: cell }),
    `${cell} 的 KLayout 渲染`,
  );
  assert.equal(
    translate('en', 'KLayout rendering of {0}', { 0: cell }),
    `KLayout rendering of ${cell}`,
  );
  assert.equal(
    translate('zh-CN', '{0} layers · read-only verification', { 0: '1,024' }),
    '1,024 个图层 · 只读验证',
  );
});

test('switching layout labels preserves mode, selection, visibility, region and controls', async () => {
  const { translate } = await core;
  const {
    hookHost,
    loadComponent,
    nodes,
  } = require('../../../packages/viewer-builtin/tests/layout-test-host.cjs');
  const host = hookHost();
  let locale = 'en';
  const Raster = () => {},
    Solid = () => {};
  const { LayoutViewport } = loadComponent('LayoutViewport.tsx', host, {
    'lucide-react': { Layers: () => {} },
    '../text': {
      useDisplayText: () => ({ locale, t: (key, values) => translate(locale, key, values) }),
    },
    '../navigation': { ViewNavigationContext: { Provider: Symbol('navigation') } },
    './LayoutRasterViewport': { LayoutRasterViewport: Raster },
    './Layout3DViewport': { Layout3DViewport: Solid },
  });
  const meta = {
    token: 'locale-fixture',
    cell: 'top',
    bbox: [0, 0, 10, 10],
    klayout: 'test',
    layers: [
      { key: '1/0', name: 'Layer 1/0' },
      { key: '2/0', name: 'custom 中文 {0}' },
    ],
  };
  const shell = LayoutViewport({
    meta,
    onReady() {},
    onError(message) {
      assert.fail(message);
    },
  });
  const render = () => host.render(shell.type, shell.props);
  let tree = render();
  const layerCalls = [],
    themeCalls = [];
  const raster = nodes(tree).find(node => node.type === Raster);
  const roi = [2, 3, 4, 5];
  raster.props.controls.current = {
    box: () => roi,
    layers: value => layerCalls.push(value),
    theme: value => themeCalls.push(value),
  };
  raster.props.onReady();
  tree = render();
  nodes(tree)
    .find(node => node.props['aria-label'] === '2.5D layout')
    .props.onClick();
  tree = render();
  nodes(tree)
    .find(node => node.type === Solid)
    .props.onSelectLayer('1/0');
  nodes(tree)
    .find(node => node.props['aria-label'] === 'Layout theme')
    .props.onChange({ target: { value: '03_ember' } });
  nodes(tree)
    .find(node => node.props.type === 'range')
    .props.onChange({ target: { value: '2.1' } });
  nodes(tree)
    .find(node => node.type === 'button' && node.props.children === 'Top / XY')
    .props.onClick();
  tree = render();
  nodes(tree)
    .find(node => node.type === 'button' && node.props.children === 'Isolate selected layer')
    .props.onClick();
  tree = render();
  const before = nodes(tree).find(node => node.type === Solid).props;
  const retained = {
    box: before.box,
    visible: before.visible,
    theme: before.theme,
    spacing: before.spacing,
    selectedLayer: before.selectedLayer,
    viewPreset: before.viewPreset,
  };
  assert.deepEqual(retained, {
    box: roi,
    visible: ['1/0'],
    theme: '03_ember',
    spacing: 2.1,
    selectedLayer: '1/0',
    viewPreset: 'top',
  });
  const controlCounts = [layerCalls.length, themeCalls.length];
  for (let cycle = 0; cycle < 20; cycle++) {
    locale = cycle % 2 ? 'en' : 'zh-CN';
    tree = render();
    const current = nodes(tree).find(node => node.type === Solid).props;
    for (const field of Object.keys(retained)) assert.equal(current[field], retained[field], field);
    assert.equal(current.active, true);
    assert.ok(
      nodes(tree).some(
        node => node.props.children === (locale === 'zh-CN' ? '图层 1/0' : 'Layer 1/0'),
      ),
    );
    assert.ok(nodes(tree).some(node => node.props.children === 'custom 中文 {0}'));
    assert.deepEqual([layerCalls.length, themeCalls.length], controlCounts);
  }
  host.unmount();
});
