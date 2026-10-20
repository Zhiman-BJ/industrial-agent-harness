const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const directory = path.resolve(__dirname, '../src/kicad');
const source = fs
  .readFileSync(path.join(directory, 'component-vrml.js'), 'utf8')
  .replace(
    "'./three/three.module.js'",
    JSON.stringify(pathToFileURL(path.join(directory, 'vendor/three/three.module.js')).href),
  )
  .replace(
    "'./three/loaders/VRMLLoader.js'",
    JSON.stringify(pathToFileURL(path.join(directory, 'vendor/three/loaders/VRMLLoader.js')).href),
  );
const component = import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
const header = '#VRML V2.0 utf8\n';
const shape = (extra = '', appearance = '') => `Shape {
  appearance Appearance { material Material { diffuseColor 1 0 0 ${appearance} } }
  geometry IndexedFaceSet {
    coord Coordinate { point [ 0 0 0, 1 0 0, 0 1 0 ] }
    coordIndex [ 0 1 2 -1 ] ${extra}
  }
}`;
const near = (actual, expected) => {
  assert.equal(actual.length, expected.length);
  actual.forEach((value, i) =>
    assert.ok(Math.abs(value - expected[i]) < 1e-5, `${value} != ${expected[i]}`),
  );
};

test('real triangle mesh is converted from legacy KiCad units to millimeters with source material', async () => {
  const { parsePcbVrml } = await component;
  const { meshes } = parsePcbVrml(header + shape('', 'transparency 0.25'));
  assert.equal(meshes.length, 1);
  assert.ok(meshes[0].positions instanceof Float32Array);
  assert.ok(meshes[0].normals instanceof Float32Array);
  assert.ok(meshes[0].indices instanceof Uint32Array);
  near([...meshes[0].positions], [0, 0, 0, 2.54, 0, 0, 0, 2.54, 0]);
  near([...meshes[0].normals], [0, 0, 1, 0, 0, 1, 0, 0, 1]);
  near(meshes[0].color, [1, 0, 0]);
  assert.equal(meshes[0].opacity, 0.75);
});

test('nested transform, translation and nonuniform scale are baked once without changing the local model origin', async () => {
  const { parsePcbVrml } = await component;
  const text =
    header +
    `Transform { translation 2 3 4 children [
    Transform { translation 1 0 0 rotation 0 0 1 1.5707963267948966 scale 2 3 1 children [ ${shape()} ] }
  ] }`;
  const { meshes } = parsePcbVrml(text);
  near([...meshes[0].positions], [7.62, 7.62, 10.16, 7.62, 12.7, 10.16, 0, 7.62, 10.16]);
  near([...meshes[0].normals], [0, 0, 1, 0, 0, 1, 0, 0, 1]);
});

test('a nested reflection reverses triangle winding while keeping transformed normals consistent', async () => {
  const { parsePcbVrml } = await component;
  const { meshes } = parsePcbVrml(
    header + `Group { children [ Transform { scale -1 1 1 children [ ${shape()} ] } ] }`,
  );
  near([...meshes[0].positions], [0, 0, 0, -2.54, 0, 0, 0, 2.54, 0]);
  assert.deepEqual([...meshes[0].indices], [0, 2, 1]);
});

test('DEF/USE instances retain each transform and count toward the expanded geometry budget', async () => {
  const { parsePcbVrml } = await component;
  const text =
    header +
    `DEF Part ${shape()}
    Transform { translation 2 0 0 children [ USE Part ] }`;
  const { meshes } = parsePcbVrml(text, { maxTriangles: 2 });
  assert.equal(meshes.length, 1, 'identical material meshes are batched');
  near([...meshes[0].positions.slice(9)], [5.08, 0, 0, 7.62, 0, 0, 5.08, 2.54, 0]);
  assert.deepEqual([...meshes[0].indices], [0, 1, 2, 3, 4, 5]);
  assert.throws(() => parsePcbVrml(text, { maxTriangles: 1 }), /budget.*expanded/i);
  assert.throws(() => parsePcbVrml(header + 'DEF Loop Group { children [ USE Loop ] }'), /cyclic/i);
});

test('KiCad material-only Shapes are retained as definitions and never become invented geometry', async () => {
  const { parsePcbVrml } = await component;
  const text =
    header +
    `Shape {
    appearance Appearance { material DEF BODY Material { diffuseColor 0 1 0 } }
  }\n` +
    shape().replace('Material { diffuseColor 1 0 0  }', 'USE BODY');
  const { meshes } = parsePcbVrml(text);
  assert.equal(meshes.length, 1);
  assert.equal(meshes[0].indices.length, 3);
  near(meshes[0].color, [0, 1, 0]);
});

test('real KiCad hyphenated material identifiers are adapted without changing negative numbers or quoted metadata', async () => {
  const { parsePcbVrml } = await component;
  const text =
    header +
    `WorldInfo { title "IC-BODY-EPOXY-04" }
  Shape { appearance Appearance {
    material DEF IC-BODY-EPOXY-04 Material { diffuseColor 0 1 0 ambientIntensity 2.018212 }
  } }\n` +
    shape()
      .replace('Material { diffuseColor 1 0 0  }', 'USE IC-BODY-EPOXY-04')
      .replace('0 0 0, 1 0 0', '-1 0 0, 1 0 0');
  const { meshes } = parsePcbVrml(text);
  assert.equal(meshes.length, 1);
  near(meshes[0].color, [0, 1, 0]);
  near([...meshes[0].positions.slice(0, 3)], [-2.54, 0, 0]);
});

test('omitted material fields use VRML defaults rather than Three material defaults', async () => {
  const { parsePcbVrml } = await component;
  const gray = parsePcbVrml(header + shape().replace('diffuseColor 1 0 0', '')).meshes[0];
  const linearGray = ((0.8 + 0.055) / 1.055) ** 2.4;
  near(gray.color, [linearGray, linearGray, linearGray]);
  const black = parsePcbVrml(
    header + shape().replace('material Material { diffuseColor 1 0 0  }', ''),
  ).meshes[0];
  near(black.color, [0, 0, 0]);
});

test('source normals and per-vertex colors survive conversion, including VRML color space', async () => {
  const { parsePcbVrml } = await component;
  const { meshes } = parsePcbVrml(
    header +
      shape(`
    normal Normal { vector [0 0 1, 0 0 1, 0 0 1] }
    color Color { color [1 0 0, 0 1 0, 0 0 1] }
    solid FALSE
  `),
  );
  near([...meshes[0].colors], [1, 0, 0, 0, 1, 0, 0, 0, 1]);
  assert.equal(meshes[0].doubleSided, true);
});

test('external resources and active or unsupported nodes are rejected before any loader request', async () => {
  const { parsePcbVrml } = await component;
  for (const text of [
    'Script { url "javascript:alert(1)" }',
    'Inline { url "https://example.invalid/model.wrl" }',
    'ImageTexture { url "file:///private/secret" }',
    'Shape { geometry Sphere { radius 1 } }',
    'PROTO MyShape [] { Group {} }',
    'Anchor { url "https://example.invalid" children [] }',
    'Background { skyColor [1 1 1] }',
  ])
    assert.throws(() => parsePcbVrml(header + text), /Unsupported PCB VRML/);
  // Metadata and comments are not executable fields.
  assert.equal(
    parsePcbVrml(
      header +
        '# Script { url "https://example.invalid" }\nWorldInfo { title "Script" }\n' +
        shape(),
    ).meshes.length,
    1,
  );
});

test('ambiguous units and transforms ignored by the pinned loader are explicit failures', async () => {
  const { parsePcbVrml } = await component;
  for (const field of ['scale 2 2 2', 'scale 0.3937 0.3937 0.3937'])
    assert.throws(
      () => parsePcbVrml(header + `Transform { ${field} children [ ${shape()} ] }`),
      /ambiguous units/,
    );
  for (const field of [
    'center 1 0 0',
    'scaleOrientation 0 0 1 1',
    'rotation 0 0 2 1',
    'scale 0 1 1',
  ]) {
    assert.throws(
      () =>
        parsePcbVrml(
          header + `Group { children [Transform { ${field} children [ ${shape()} ] }] }`,
        ),
      /Unsupported PCB VRML/,
    );
  }
  assert.equal(
    parsePcbVrml(header + `Transform { scale 1 1 1 children [ ${shape()} ] }`).meshes.length,
    1,
  );
});

test('invalid and oversized arrays fail without returning partial component geometry', async () => {
  const { parsePcbVrml } = await component;
  for (const text of [
    shape().replace('0 1 2 -1', '0 1 99 -1'),
    shape().replace('0 1 2 -1', '0 1 -1'),
    shape().replace('0 1 2 -1', '0 1 2 0 -1'),
    shape().replace('1 0 0, 0 1 0', '1e999 0 0, 0 1 0'),
    shape('normal Normal { vector [0 0 1] }'),
    shape('colorIndex [0 0 0 -1]'),
    shape('normal Normal { vector [0 0 1] } normalIndex [0 0 0 8]'),
    shape().replace('coordIndex [', 'coordIndex [0 1 2 -1] coordIndex ['),
  ])
    assert.throws(() => parsePcbVrml(header + text), /Unsupported PCB VRML/);
  assert.throws(() => parsePcbVrml(header + shape(), { maxBytes: 16 }), /source bytes/);
  assert.throws(
    () => parsePcbVrml(header + shape() + shape(), { maxTriangles: 1 }),
    /source triangles/,
  );
  assert.throws(
    () => parsePcbVrml(header + shape(), { maxTriangles: Infinity }),
    /Invalid PCB VRML budget/,
  );
  assert.throws(() => parsePcbVrml(header + 'DEF __proto__ ' + shape()), /identifier/);
});

test('high-valence normal smoothing and deep graphs have explicit preallocation budgets', async () => {
  const { parsePcbVrml } = await component;
  const indices = Array.from({ length: 2100 }, () => '0 1 2 -1').join(' ');
  const highValence = shape('creaseAngle 0.5').replace('0 1 2 -1', indices);
  assert.throws(() => parsePcbVrml(header + highValence), /normal smoothing work/);
  const deep = 'Group { children ['.repeat(66) + shape() + '] }'.repeat(66);
  assert.throws(() => parsePcbVrml(header + deep), /depth/);
});
