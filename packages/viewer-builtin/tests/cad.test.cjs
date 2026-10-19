const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { hash } = require('../src/engineering/read.cjs');
const { parseStl, createCadPlugins } = require('../src/cad/service.cjs');
const { parseSketches } = require('../src/cad/sketches.cjs');
function triangle() {
  const b = Buffer.alloc(134);
  b.writeUInt32LE(1, 80);
  [0, 0, 0, 1, 0, 0, 0, 1, 0].forEach((v, i) => b.writeFloatLE(v, 96 + i * 4));
  return b;
}
function sketchData(sourceSha256) {
  return {
    schemaVersion: 1,
    units: 'mm',
    sourceSha256,
    sketches: [
      {
        name: 'PlateSketch',
        label: 'PlateSketch',
        fullyConstrained: true,
        origin: [0, 0, 0],
        rotation: [0, 0, 0, 1],
        geometry: [{ index: 0, construction: false, kind: 'circle', center: [0, 0], radius: 2 }],
        constraints: [
          {
            index: 0,
            type: 'Radius',
            value: 2,
            driving: true,
            first: 0,
            firstPos: 0,
            second: -2000,
            secondPos: 0,
            third: -2000,
            thirdPos: 0,
          },
        ],
      },
    ],
  };
}
test('native sketch display rejects wrong source identity, invalid coordinates and unbounded constraints', () => {
  const sha = 'a'.repeat(64),
    data = sketchData(sha);
  const parse = () => parseSketches(Buffer.from(JSON.stringify(data)), sha);
  assert.equal(parse()[0].constraints[0].value, 2);
  assert.throws(() => parseSketches(Buffer.from(JSON.stringify(data)), 'b'.repeat(64)), /Invalid/);
  data.sketches[0].geometry[0].radius = 1e20;
  assert.throws(parse, /Invalid/);
  data.sketches[0].geometry[0].radius = 2;
  data.sketches[0].constraints[0].first = 1;
  assert.throws(parse, /Invalid/);
  data.sketches[0].constraints = Array(4001).fill(data.sketches[0].constraints[0]);
  assert.throws(parse, /Invalid/);
});
test('sketch companions require declared hashes and remain inside the selected project', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cad-sketch-view-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'model.FCStd'),
    preview = path.join(root, 'model.cad-sketches.json');
  fs.writeFileSync(file, 'model');
  fs.writeFileSync(path.join(root, 'model.stl'), triangle());
  const sha = hash(fs.readFileSync(file));
  fs.writeFileSync(preview, JSON.stringify(sketchData(sha)));
  const manifest = {
    schemaVersion: 1,
    hashes: {
      'model.FCStd': sha,
      'model.stl': hash(triangle()),
      'model.cad-sketches.json': hash(fs.readFileSync(preview)),
    },
  };
  const manifestFile = path.join(root, 'model.cad-preview.json');
  fs.writeFileSync(manifestFile, JSON.stringify(manifest));
  const plugin = createCadPlugins({ projectRoot: () => root })[0],
    artifact = { name: 'model.FCStd', sha256: sha };
  assert.equal((await plugin.open({ file, artifact })).data.sketches[0].geometry[0].radius, 2);
  fs.writeFileSync(preview, JSON.stringify(sketchData('b'.repeat(64))));
  await assert.rejects(plugin.open({ file, artifact }), /changed/);
  manifest.hashes['model.cad-sketches.json'] = hash(fs.readFileSync(preview));
  fs.writeFileSync(manifestFile, JSON.stringify(manifest));
  await assert.rejects(plugin.open({ file, artifact }), /Invalid/);
  const outside = path.join(root, '..', path.basename(root) + '.json');
  fs.writeFileSync(outside, JSON.stringify(sketchData(sha)));
  t.after(() => fs.rmSync(outside, { force: true }));
  fs.unlinkSync(preview);
  fs.symlinkSync(outside, preview);
  await assert.rejects(plugin.open({ file, artifact }), /outside/);
  fs.unlinkSync(preview);
  await assert.rejects(plugin.open({ file, artifact }), /ENOENT/);
});
test('CAD STL parser rejects nonfinite, excessive and malformed mesh data', () => {
  assert.equal(parseStl(triangle()).triangles, 1);
  const bad = triangle();
  bad.writeFloatLE(NaN, 96);
  assert.throws(() => parseStl(bad), /invalid/);
  const excessive = Buffer.alloc(84 + 100001 * 50);
  excessive.writeUInt32LE(100001, 80);
  assert.throws(() => parseStl(excessive), /100000/);
  assert.throws(() => parseStl(Buffer.from('solid x\nvertex 0 0 0\nendsolid x')), /incomplete/);
});
test('CAD viewer binds both model and mesh to hash-checked project companions', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cad-view-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const model = path.join(root, 'model.FCStd'),
    mesh = path.join(root, 'model.stl');
  fs.writeFileSync(model, 'fixture-model');
  fs.writeFileSync(mesh, triangle());
  fs.writeFileSync(
    path.join(root, 'model.cad-preview.json'),
    JSON.stringify({
      schemaVersion: 1,
      hashes: {
        'model.FCStd': hash(fs.readFileSync(model)),
        'model.stl': hash(fs.readFileSync(mesh)),
      },
    }),
  );
  const plugin = createCadPlugins({ projectRoot: () => root })[0];
  const artifact = { name: 'model.FCStd', sha256: hash(fs.readFileSync(model)) };
  assert.equal((await plugin.open({ file: model, artifact })).data.triangles, 1);
  fs.writeFileSync(mesh, Buffer.from('changed'));
  await assert.rejects(plugin.open({ file: model, artifact }), /changed/);
  const outside = path.join(root, '..', path.basename(root) + '-outside.stl');
  fs.writeFileSync(outside, triangle());
  t.after(() => fs.rmSync(outside, { force: true }));
  await assert.rejects(
    plugin.open({ file: outside, artifact: { name: 'outside', sha256: hash(triangle()) } }),
    /outside/,
  );
});
test('OCCT BREP companions are hash bound and cannot escape the project', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'occt-boundary-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const model = path.join(root, 'model.FCStd'),
    brep = path.join(root, 'model.brep');
  fs.writeFileSync(model, 'model');
  fs.writeFileSync(path.join(root, 'model.stl'), triangle());
  fs.writeFileSync(brep, 'DBRep_DrawableShape\nCASCADE Topology V3, (c) Open Cascade\n');
  const manifest = {
    schemaVersion: 1,
    hashes: {
      'model.FCStd': hash(fs.readFileSync(model)),
      'model.stl': hash(triangle()),
      'model.brep': hash(fs.readFileSync(brep)),
    },
  };
  fs.writeFileSync(path.join(root, 'model.cad-preview.json'), JSON.stringify(manifest));
  const plugin = createCadPlugins({ projectRoot: () => root })[0],
    artifact = { name: 'model.FCStd', sha256: manifest.hashes['model.FCStd'] };
  assert.equal(
    Buffer.from((await plugin.open({ file: model, artifact })).data.brep, 'base64').toString(),
    fs.readFileSync(brep, 'utf8'),
  );
  fs.writeFileSync(brep, 'tamper');
  await assert.rejects(plugin.open({ file: model, artifact }), /changed/);
  const outside = path.join(root, '..', path.basename(root) + '.brep');
  fs.writeFileSync(outside, 'DBRep_DrawableShape\nCASCADE Topology V3, (c) Open Cascade\n');
  t.after(() => fs.rmSync(outside, { force: true }));
  fs.unlinkSync(brep);
  fs.symlinkSync(outside, brep);
  await assert.rejects(plugin.open({ file: model, artifact }), /outside/);
});

test('remote CAD artifact bundles resolve FCStd/STEP BREP previews without renaming source bytes', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cad-bundle-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const model = Buffer.from('native model'),
    step = Buffer.from('step model'),
    mesh = triangle();
  const hashes = { 'model.FCStd': hash(model), 'model.step': hash(step), 'model.stl': hash(mesh) };
  const brep = Buffer.from('DBRep_DrawableShape\nCASCADE Topology V3, (c) Open Cascade\n');
  hashes['model.brep'] = hash(brep);
  const files = [
    ['0-model.cad.fcstd.fcstd', 'model.cad.fcstd', model],
    ['1-model.cad.step.step', 'model.cad.step', step],
    ['2-model.cad.stl.stl', 'model.cad.stl', mesh],
    ['3-display.cad.brep.brep', 'display.cad.brep', brep],
    [
      '4-display.cad.manifest.manifest',
      'display.cad.manifest',
      Buffer.from(JSON.stringify({ schemaVersion: 1, hashes })),
    ],
  ];
  const index = {
    schemaVersion: 1,
    artifacts: files.map(([name, kind, bytes]) => {
      fs.writeFileSync(path.join(root, name), bytes);
      return { name, kind, sha256: hash(bytes), sizeBytes: bytes.length };
    }),
  };
  const indexFile = path.join(root, 'artifact-bundle.json');
  const save = () => fs.writeFileSync(indexFile, JSON.stringify(index));
  save();
  const plugin = createCadPlugins({ projectRoot: () => root })[0];
  const open = (i = 0) =>
    plugin.open({
      file: path.join(root, files[i][0]),
      artifact: { name: files[i][0], sha256: hash(files[i][2]) },
    });
  for (const i of [0, 1]) {
    assert.ok(plugin.matches(path.join(root, files[i][0])));
    const result = await open(i);
    assert.equal(result.data.triangles, 1);
    assert.equal(Buffer.from(result.data.brep, 'base64').toString(), brep.toString());
  }
  assert.deepEqual(fs.readFileSync(path.join(root, files[0][0])), model);
  fs.writeFileSync(path.join(root, files[2][0]), Buffer.alloc(mesh.length));
  await assert.rejects(open(), /changed/);
  fs.writeFileSync(path.join(root, files[2][0]), mesh);
  index.artifacts[2].name = '../outside.stl';
  save();
  await assert.rejects(open(), /Invalid artifact/);
  index.artifacts[2].name = files[2][0];
  index.artifacts.push({ ...index.artifacts[2] });
  save();
  await assert.rejects(open(), /Invalid artifact/);
  index.artifacts.pop();
  index.artifacts[0].sha256 = 'b'.repeat(64);
  save();
  await assert.rejects(open(), /source changed/);
  index.artifacts[0].sha256 = hash(model);
  save();
  fs.mkdirSync(path.join(root, 'other'));
  fs.renameSync(path.join(root, files[2][0]), path.join(root, 'other', 'mesh.stl'));
  fs.symlinkSync(path.join(root, 'other', 'mesh.stl'), path.join(root, files[2][0]));
  await assert.rejects(open(), /outside the result directory/);
});
