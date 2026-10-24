'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const { createProductReplayBackend } = require('./product-backend.cjs');
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

function recorded(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'product-history-')));
  const manifest = {
    recordingId: 'sidebar-history',
    createdAt: '2026-10-24T00:00:00Z',
    chat: { chatId: 'recorded-chat' },
    assets: [],
    replayStages: [],
  };
  const events = [];
  for (const index of [1, 2]) {
    const id = `stage-${index}`;
    const relativePath = `assets/source/snapshots/${id}/board.kicad_pcb`;
    const bytes = Buffer.from(`(kicad_pcb (version 20240108) (footprint "R" (at ${index} 2)))`);
    fs.mkdirSync(path.dirname(path.join(root, relativePath)), { recursive: true });
    fs.writeFileSync(path.join(root, relativePath), bytes);
    manifest.assets.push({
      id,
      relativePath,
      type: 'artifact-snapshot',
      status: 'present',
      sha256: hash(bytes),
      bytes: bytes.length,
    });
    manifest.replayStages.push({
      id,
      title: id,
      assetId: id,
      atSeq: index * 2,
      provenance: { snapshotId: id, sourceBoardSha256: hash(bytes) },
    });
    for (const event of [
      {
        type: 'tool',
        id: `operation-${index}`,
        name: 'recorded.inspect',
        arguments: JSON.stringify({ original: index }),
      },
      { type: 'tool-result', id: `operation-${index}`, output: `original result ${index}` },
    ])
      events.push({
        seq: events.length + 1,
        relMs: events.length,
        at: manifest.createdAt,
        origin: { agentId: 'main', turnId: 'recorded-turn' },
        event,
      });
  }
  const backend = createProductReplayBackend({ manifest, events, sourceDirectory: root });
  t.after(() => {
    backend.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  return backend;
}

// Run the actual main-process refresh function against a control-only DOM
// harness. The chat control calls the real recorded selectChat/history API;
// this is a host/navigation regression, not a claim of Chromium acceptance.
function productControls(backend, { collapsed, locale }) {
  let visible = !collapsed;
  let navigating = false;
  let displayed;
  const actions = [];
  const select = {
    get disabled() {
      return navigating;
    },
    click() {
      actions.push('select');
      navigating = true;
      backend.invoke('chat:select', 'recorded-chat').then(history => {
        displayed = history;
        navigating = false;
      });
    },
  };
  const showLabel = locale === 'zh-CN' ? '展开侧栏' : 'Show sidebar';
  const hideLabel = locale === 'zh-CN' ? '收起侧栏' : 'Hide sidebar';
  const document = {
    querySelector(selector) {
      if (selector === '.ia-sidebar-chat[aria-current="page"]') return visible ? select : null;
      if (selector.includes(`[aria-label="${showLabel}"]`))
        return visible
          ? null
          : {
              click() {
                actions.push('show');
                visible = true;
              },
            };
      if (selector.includes(`[aria-label="${hideLabel}"]`))
        return visible
          ? {
              click() {
                assert.equal(navigating, false);
                actions.push('hide');
                visible = false;
              },
            }
          : null;
      throw Error(`Unexpected product control: ${selector}`);
    },
  };
  const renderer = vm.createContext({ document });
  const uiErrors = [];
  const window = {
    isDestroyed: () => false,
    webContents: {
      async executeJavaScript(script, gesture) {
        assert.equal(gesture, true);
        return vm.runInContext(script, renderer);
      },
    },
  };
  const main = fs.readFileSync(path.join(__dirname, 'product-main.cjs'), 'utf8');
  const start = main.indexOf('let refreshing = false;');
  const end = main.indexOf('const unsubscribe =', start);
  assert.ok(start > 0 && end > start);
  const host = vm.createContext({
    window,
    uiErrors,
    setTimeout: callback => setImmediate(callback),
  });
  vm.runInContext(
    main.slice(start, end) + ';globalThis.refreshHistory=refreshProductHistory;',
    host,
  );
  return {
    refresh: host.refreshHistory,
    displayed: () => displayed,
    visible: () => visible,
    actions,
    uiErrors,
  };
}

for (const collapsed of [true, false])
  for (const locale of ['en', 'zh-CN']) {
    test(`seek keeps recorded history/native source aligned with sidebar ${collapsed ? 'collapsed' : 'open'} (${locale})`, async t => {
      const backend = recorded(t);
      const controls = productControls(backend, { collapsed, locale });
      const stages = backend.controller.metadata().replayStages;
      let pending;
      backend.subscribe(({ channel }) => {
        if (channel === 'replay:history-invalidated') pending = controls.refresh();
      });
      for (const stage of [stages[0], stages[1], stages[0]]) {
        backend.control({ action: 'seek', value: stage.position });
        await pending;
        const expected = await backend.invoke('chat:history', { id: 'recorded-chat' });
        assert.deepEqual(structuredClone(controls.displayed()), expected);
        assert.equal(
          controls.visible(),
          !collapsed,
          'The original layout is restored after history adoption',
        );
        const tools = controls
          .displayed()
          .turns.flatMap(turn => turn.events.filter(event => event.type === 'tool'));
        const results = controls
          .displayed()
          .turns.flatMap(turn => turn.events.filter(event => event.type === 'tool-result'));
        assert.equal(tools.length, stage.position / 2);
        assert.equal(results.length, tools.length, 'Seek never duplicates or orphans tool results');
        assert.equal(JSON.parse(tools.at(-1).arguments).original, stage.position / 2);
        const artifact = backend.viewer.openProjectFile('board.kicad_pcb');
        const opened = await backend.viewer.openArtifact({ artifactId: artifact.id });
        const native = await (
          await backend.viewer.handleProtocol(
            new Request(opened.data.url.replace('index.html', 'manifest.json')),
          )
        ).json();
        assert.equal(native.boardSha256, stage.provenance.sourceBoardSha256);
        backend.viewer.release({ token: opened.data.token });
      }
      assert.deepEqual(
        controls.actions,
        collapsed
          ? ['show', 'select', 'hide', 'show', 'select', 'hide', 'show', 'select', 'hide']
          : ['select', 'select', 'select'],
      );
      assert.deepEqual(controls.uiErrors, []);
    });
  }
