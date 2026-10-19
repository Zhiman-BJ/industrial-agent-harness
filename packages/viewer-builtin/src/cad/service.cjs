const fs = require('node:fs');
const path = require('node:path');
const { readBounded, utf8 } = require('../engineering/read.cjs');
const { parseSketches } = require('./sketches.cjs');
const { readArtifactBundle } = require('../engineering/artifact-bundle.cjs');
const LIMIT = 100000;
function parseStl(bytes) {
  const vertices = [];
  if (bytes.length >= 84 && 84 + bytes.readUInt32LE(80) * 50 === bytes.length) {
    const count = bytes.readUInt32LE(80);
    if (!count || count > LIMIT) throw Error('STL needs 1–100000 triangles.');
    for (let i = 0; i < count; i++)
      for (let j = 0; j < 9; j++) vertices.push(bytes.readFloatLE(84 + i * 50 + 12 + j * 4));
  } else {
    const text = utf8(bytes);
    if (!/^\s*solid\b/.test(text) || !/endsolid\b/.test(text))
      throw Error('Unsupported STL encoding.');
    const pattern = /\bvertex\s+([^\s]+)\s+([^\s]+)\s+([^\s]+)/g;
    for (const match of text.matchAll(pattern)) {
      if (vertices.length >= LIMIT * 9) throw Error('STL triangle limit exceeded.');
      vertices.push(...match.slice(1).map(Number));
    }
    if (!vertices.length || vertices.length % 9) throw Error('STL triangle data is incomplete.');
  }
  if (vertices.some(value => !Number.isFinite(value) || Math.abs(value) > 1e7))
    throw Error('STL contains invalid or unbounded coordinates.');
  const min = [Infinity, Infinity, Infinity],
    max = [-Infinity, -Infinity, -Infinity];
  vertices.forEach((value, i) => {
    const axis = i % 3;
    min[axis] = Math.min(min[axis], value);
    max[axis] = Math.max(max[axis], value);
  });
  if (max.every((v, i) => v === min[i])) throw Error('STL has no spatial extent.');
  return { vertices, bounds: [...min, ...max], triangles: vertices.length / 9 };
}
function createCadPlugins({ projectRoot }) {
  return [
    {
      id: 'cad',
      autoPreview: true,
      matches: file =>
        /\.(fcstd|stl)$/i.test(file) ||
        (/\.(step|stp)$/i.test(file) &&
          (fs.existsSync(file.replace(/\.[^.]+$/, '.cad-preview.json')) ||
            fs.existsSync(path.join(path.dirname(file), 'artifact-bundle.json')))),
      open: async ({ artifact, file }) => {
        const root = fs.realpathSync(projectRoot());
        const source = readBounded(file, root, artifact.sha256, 16 * 1024 * 1024);
        let mesh = source,
          companions = [],
          brep,
          sketches;
        if (!/\.stl$/i.test(file)) {
          let manifestFile = file.replace(/\.[^.]+$/, '.cad-preview.json');
          const bundle = fs.existsSync(manifestFile)
            ? null
            : readArtifactBundle(file, root, source.sha256);
          let manifest;
          if (bundle) {
            const entries = bundle.entries.filter(item => item.kind === 'display.cad.manifest');
            if (entries.length !== 1) throw Error('CAD preview manifest is missing or ambiguous.');
            manifest = bundle.read(entries[0], 256 * 1024);
            manifestFile = manifest.file;
          } else if (!fs.existsSync(manifestFile))
            throw Error(
              'Create a CAD mesh preview with the FreeCAD inspect/export tool before opening this model.',
            );
          else manifest = readBounded(manifestFile, root, null, 256 * 1024);
          const data = JSON.parse(utf8(manifest.bytes));
          let sourceName = path.basename(file);
          if (bundle) {
            const matches = Object.entries(data.hashes || {}).filter(
              ([name, sha]) =>
                sha === source.sha256 &&
                path.extname(name).toLowerCase() === path.extname(file).toLowerCase(),
            );
            if (matches.length !== 1) throw Error('CAD preview source is missing or ambiguous.');
            sourceName = matches[0][0];
          }
          if (
            data.schemaVersion !== 1 ||
            !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,255}$/.test(sourceName) ||
            data.hashes?.[sourceName] !== source.sha256
          )
            throw Error('CAD preview source changed; regenerate the preview.');
          const companionName = extension => sourceName.replace(/\.[^.]+$/, extension);
          const readCompanion = (name, expected, limit) => {
            if (!bundle)
              return readBounded(path.join(path.dirname(file), name), root, expected, limit);
            const entry = bundle.entries.find(item => item.sha256 === expected);
            if (!entry) throw Error('CAD companion is missing from the artifact bundle.');
            return bundle.read(entry, limit);
          };
          const meshName = companionName('.stl');
          const expected = data.hashes[meshName];
          if (!/^[a-f0-9]{64}$/.test(expected || ''))
            throw Error('CAD mesh companion hash is missing.');
          mesh = readCompanion(meshName, expected, 16 * 1024 * 1024);
          companions = [
            { name: path.basename(manifestFile), sha256: manifest.sha256 },
            { name: meshName, sha256: mesh.sha256 },
          ];
          const brepName = companionName('.brep');
          const brepHash = data.hashes[brepName];
          if (brepHash !== undefined) {
            if (!/^[a-f0-9]{64}$/.test(brepHash))
              throw Error('CAD BREP companion hash is invalid.');
            const shape = readCompanion(brepName, brepHash, 16 * 1024 * 1024);
            const text = utf8(shape.bytes);
            if (!/^CASCADE Topology V[123],/m.test(text) || text.split('\n').length > 500000)
              throw Error('Unsupported or oversized CAD BREP companion.');
            brep = shape.bytes.toString('base64');
            companions.push({ name: brepName, sha256: shape.sha256 });
          }
          const sketchName = companionName('.cad-sketches.json');
          const sketchHash = data.hashes[sketchName];
          if (sketchHash !== undefined) {
            if (!/^[a-f0-9]{64}$/.test(sketchHash))
              throw Error('CAD sketch companion hash is invalid.');
            const preview = readCompanion(sketchName, sketchHash, 1024 * 1024);
            const nativeHash = data.hashes[companionName('.FCStd')];
            sketches = parseSketches(Buffer.from(utf8(preview.bytes)), nativeHash);
            companions.push({ name: sketchName, sha256: preview.sha256 });
          }
          readBounded(file, root, source.sha256, 16 * 1024 * 1024);
          readBounded(manifestFile, root, manifest.sha256, 256 * 1024);
          bundle?.assertUnchanged();
        }
        return {
          kind: 'cad',
          artifact,
          data: {
            name: artifact.name,
            sha256: source.sha256,
            ...parseStl(mesh.bytes),
            companions,
            brep,
            sketches,
          },
        };
      },
    },
  ];
}
module.exports = { createCadPlugins, parseStl };
