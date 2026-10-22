const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const moduleUrl = pathToFileURL(path.resolve(__dirname, '../src/kicad/board-normalize.js')).href;
const normalize = import(moduleUrl);

const MINIMAL_BOARD =
  '(kicad_pcb (version 20240108) (generator pcbnew) ' +
  '(footprint "Contract:ExplicitModel" (layer "F.Cu") (at 10 10 0) ' +
  '(model "${KICAD10_3DMODEL_DIR}/Resistor_SMD.3dshapes/R_0603_1608Metric.step" ' +
  '(offset (xyz 0 0 0)) (scale (xyz 1 1 1)) (rotate (xyz 0 0 0)))))';

test('boards without a (layers ...) block gain the standard two-layer declaration', async () => {
  const { ensurePcbLayersBlock, boardDeclaresLayers } = await normalize;
  assert.equal(boardDeclaresLayers(MINIMAL_BOARD), false);
  const fixed = ensurePcbLayersBlock(MINIMAL_BOARD);
  assert.equal(boardDeclaresLayers(fixed), true);
  // The declaration must define the layers the footprints reference, by name.
  assert.match(fixed, /\(0 "F\.Cu" signal\)/);
  assert.match(fixed, /"B\.Cu" signal\)/);
  // The original content stays intact and ordered after the injected block.
  const footprintAt = fixed.indexOf('(footprint "Contract:ExplicitModel"');
  const layersAt = fixed.indexOf('(layers');
  assert.ok(layersAt > -1 && layersAt < footprintAt);
  // Parentheses stay balanced.
  const opens = fixed.split('(').length;
  const closes = fixed.split(')').length;
  assert.equal(opens, closes);
});

test('boards that already declare layers pass through untouched', async () => {
  const { ensurePcbLayersBlock } = await normalize;
  const declared = MINIMAL_BOARD.replace(
    '(generator pcbnew)',
    '(generator pcbnew) (layers (0 "F.Cu" signal) (2 "B.Cu" signal))',
  );
  assert.equal(ensurePcbLayersBlock(declared), declared);
});

test('quoted generator clauses still anchor the injection', async () => {
  const { ensurePcbLayersBlock } = await normalize;
  const quoted = MINIMAL_BOARD.replace('(generator pcbnew)', '(generator "pcbnew")');
  const fixed = ensurePcbLayersBlock(quoted);
  assert.match(fixed, /\(generator "pcbnew"\)\n {2}\(layers/);
});

test('sources without a generator clause fall back to the version clause', async () => {
  const { ensurePcbLayersBlock } = await normalize;
  const noGenerator = MINIMAL_BOARD.replace(' (generator pcbnew)', '');
  const fixed = ensurePcbLayersBlock(noGenerator);
  assert.match(fixed, /\(version 20240108\)\n {2}\(layers/);
});

test('non-board sources and unusable sources are left alone', async () => {
  const { ensurePcbLayersBlock } = await normalize;
  const schematic = '(kicad_sch (version 20240108) (generator eeschema))';
  assert.equal(ensurePcbLayersBlock(schematic), schematic);
  assert.equal(ensurePcbLayersBlock(''), '');
  assert.equal(ensurePcbLayersBlock('not a board'), 'not a board');
  // No anchor clause at all: nothing to inject safely.
  assert.equal(ensurePcbLayersBlock('(kicad_pcb)'), '(kicad_pcb)');
});

test('real fixture boards keep their original declaration', async () => {
  const { ensurePcbLayersBlock } = await normalize;
  const fixture = fs.readFileSync(
    path.resolve(__dirname, '../fixtures/kicad/pads.kicad_pcb'),
    'utf8',
  );
  assert.equal(ensurePcbLayersBlock(fixture), fixture);
});
