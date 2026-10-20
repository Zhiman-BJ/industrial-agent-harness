const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const { KiCadRuntimeManager, inspectSource } = require('../src/kicad/runtime.cjs');
const { MODEL_LIMITS } = require('../src/kicad/model-resources.cjs');
const hash = data => crypto.createHash('sha256').update(data).digest('hex');
const board = models => `(kicad_pcb (version 20240108) (footprint "test" ${models.join(' ')}))`;

function fixture(t, source, modelProvider) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pcb-hidden-models-')));
  const manager = new KiCadRuntimeManager({ modelProvider });
  const write = (name, contents) => {
    const file = path.join(root, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, contents);
    return file;
  };
  const sourceFile = write('board.kicad_pcb', source);
  t.after(() => {
    manager.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  return {
    manager,
    write,
    open: () => manager.open(sourceFile, hash(source), root),
    request: (view, resource) =>
      manager.handle(new Request(view.url.replace('index.html', resource))),
  };
}

// Execute the pinned upstream Model/parse_expr implementation on parsed lists.
// No DOM or WebGL stubs, reimplemented hide parser, or vendor modifications are
// needed to confirm the exact atom semantics used by the production painter.
function pinnedModelClass() {
  const bundle = fs.readFileSync(path.join(__dirname, '../src/kicad/vendor/kicanvas.js'), 'utf8');
  const parserStart = bundle.indexOf('var R={');
  const parserEnd = bundle.indexOf('function Vr(', parserStart);
  const model = /(\w+)=class\{constructor\(\w+\)\{this\.hide=!1;this\.opacity=1;/.exec(bundle);
  assert.ok(parserStart >= 0 && parserEnd > parserStart && model, 'pinned parser anchors exist');
  const modelEnd =
    bundle.indexOf('static{l(this,"Model")}}', model.index) + 'static{l(this,"Model")}}'.length;
  const sandbox = {
    E: value => typeof value === 'string',
    le: value => typeof value === 'number',
    l: value => value,
    B2: value => (Array.isArray(value) ? value : [value]),
    e2: { info() {}, warn() {} },
  };
  vm.runInNewContext(
    bundle.slice(parserStart, parserEnd) +
      ';var ' +
      bundle.slice(model.index, modelEnd) +
      ';globalThis.Model=' +
      model[1],
    sandbox,
    { timeout: 1000 },
  );
  return sandbox.Model;
}

test('reference visibility matches pinned KiCanvas model hide atoms and direct-list wrappers', () => {
  const Model = pinnedModelClass();
  const cases = [
    { parsed: ['model', 'visible.step'], source: '(model "visible.step")', hidden: false },
    { parsed: ['model', 'bare.step', 'hide'], source: '(model "bare.step" hide)', hidden: true },
    {
      parsed: ['model', 'wrapped.step', ['hide']],
      source: '(model "wrapped.step" (hide))',
      hidden: true,
    },
    {
      parsed: ['model', 'yes.step', ['hide', 'yes']],
      source: '(model "yes.step" (hide yes))',
      hidden: true,
    },
    // Model uses atom(), not pair(boolean): any direct hide list is truthy in
    // this pinned parser, including this noncanonical form.
    {
      parsed: ['model', 'no.step', ['hide', 'no']],
      source: '(model "no.step" (hide no))',
      hidden: true,
    },
    {
      parsed: ['model', 'models/hide.step', ['offset', ['hide']]],
      source: '(model "models/hide.step" (offset (hide)))',
      hidden: false,
    },
    {
      parsed: [
        'model',
        'late.step',
        ['offset', ['xyz', 0, 0, 0]],
        ['scale', ['xyz', 1, 1, 1]],
        'hide',
      ],
      source: '(model "late.step" (offset (xyz 0 0 0)) (scale (xyz 1 1 1)) hide)',
      hidden: true,
    },
  ];
  for (const entry of cases) {
    assert.equal(new Model(entry.parsed).hide, entry.hidden);
    const references = new Set();
    inspectSource(board([entry.source]), '.kicad_pcb', references);
    assert.deepEqual([...references], entry.hidden ? [] : [entry.parsed[1]]);
  }
});

test('64 hidden local STEP models cannot exhaust the visible model file or snapshot budget', async t => {
  const hidden = Array.from(
    { length: MODEL_LIMITS.files },
    (_, index) => `models/hidden-${index}.step`,
  );
  const visible = 'models/visible.step';
  const source = board([
    ...hidden.map(ref => `(model ${JSON.stringify(ref)} hide)`),
    `(model ${JSON.stringify(visible)})`,
  ]);
  const f = fixture(t, source);
  for (let index = 0; index < hidden.length; index++)
    f.write(hidden[index], 'different hidden STEP ' + index);
  const contents = 'visible STEP snapshot';
  f.write(visible, contents);
  const view = await f.open();
  const manifest = await (await f.request(view, 'manifest.json')).json();
  assert.deepEqual(
    manifest.models.map(({ sourceRef, status }) => ({ sourceRef, status })),
    [{ sourceRef: visible, status: 'ready' }],
  );
  assert.equal(await (await f.request(view, manifest.models[0].url)).text(), contents);
  assert.equal(f.manager.snapshotUsage(), Buffer.byteLength(source) + Buffer.byteLength(contents));
  assert.equal(view.modelDownloads.unavailableFiles, 0);
});

test('references used exclusively by hidden models never enter provider plans or downloads', async t => {
  const calls = [];
  const provider = Object.fromEntries(
    ['resolve', 'plan', 'ensure'].map(method => [
      method,
      () => {
        calls.push(method);
        throw Error('Hidden references must not invoke the resource provider.');
      },
    ]),
  );
  const f = fixture(
    t,
    board([
      '(model "${KICAD10_3DMODEL_DIR}/Test.3dshapes/hidden.step" hide)',
      '(model "${KICAD10_3DMODEL_DIR}/Test.3dshapes/also-hidden.wrl" (hide))',
    ]),
    provider,
  );
  const view = await f.open();
  assert.equal(view.modelDownloads.downloadFiles, 0);
  assert.equal(view.modelDownloads.downloadBytes, 0);
  assert.equal(view.modelDownloads.unavailableFiles, 0);
  const manifest = await (await f.request(view, 'manifest.json')).json();
  assert.deepEqual(manifest.models, []);
  const prepared = await f.manager.prepareModels(view.token);
  assert.equal(prepared.modelDownloads.downloadFiles, 0);
  assert.deepEqual(calls, []);
});

test('a source reference shared by hidden and visible instances remains eligible exactly once', async t => {
  const shared = '${KICAD10_3DMODEL_DIR}/Test.3dshapes/shared.step';
  const hidden = '${KICAD10_3DMODEL_DIR}/Test.3dshapes/hidden.step';
  const requests = [];
  const resource = {
    sourceRef: shared,
    sha256: hash('test model bytes'),
    size: 16,
    libraryId: 'test-models',
    version: 'test-1',
    cached: false,
  };
  const provider = {
    resolve(context) {
      requests.push(context.references);
      return { resources: [] };
    },
    plan(context) {
      requests.push(context.references);
      return { resources: [resource], summary: { libraries: [] } };
    },
  };
  const source = `(kicad_pcb (version 20240108)
    (footprint "hidden-first" (model ${JSON.stringify(shared)} hide))
    (footprint "visible" (model ${JSON.stringify(shared)}))
    (footprint "hidden-last" (model ${JSON.stringify(shared)} hide) (model ${JSON.stringify(hidden)} hide)))`;
  const f = fixture(t, source, provider);
  const view = await f.open();
  assert.deepEqual(requests, [[shared], [shared]]);
  assert.equal(view.modelDownloads.downloadFiles, 1);
  assert.equal(view.modelDownloads.unavailableFiles, 0);
  const manifest = await (await f.request(view, 'manifest.json')).json();
  assert.deepEqual(
    manifest.models.map(entry => entry.sourceRef),
    [shared],
  );
});
