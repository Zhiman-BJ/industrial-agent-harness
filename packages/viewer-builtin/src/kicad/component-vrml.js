import { LoadingManager, Matrix3, Vector3 } from './three/three.module.js';
import { VRMLLoader } from './three/loaders/VRMLLoader.js';

// This is a bounded validator for the static, triangulated VRML subset used by
// KiCad component libraries. The pinned Three loader owns geometry parsing.
// Reject unsupported semantics before that loader can ignore them or load URLs.
const TYPES = {
  Group: { children: 'nodes', bboxCenter: 'v3', bboxSize: 'v3' },
  Transform: {
    children: 'nodes',
    bboxCenter: 'v3',
    bboxSize: 'v3',
    center: 'v3',
    rotation: 'v4',
    scale: 'v3',
    scaleOrientation: 'v4',
    translation: 'v3',
  },
  Shape: { appearance: 'node', geometry: 'node' },
  Appearance: { material: 'node' },
  Material: {
    diffuseColor: 'v3',
    emissiveColor: 'v3',
    specularColor: 'v3',
    ambientIntensity: 'number',
    shininess: 'number',
    transparency: 'number',
  },
  IndexedFaceSet: {
    coord: 'node',
    coordIndex: 'numbers',
    normal: 'node',
    normalIndex: 'numbers',
    color: 'node',
    colorIndex: 'numbers',
    ccw: 'boolean',
    solid: 'boolean',
    creaseAngle: 'number',
    convex: 'boolean',
    colorPerVertex: 'boolean',
    normalPerVertex: 'boolean',
  },
  Coordinate: { point: 'numbers' },
  Normal: { vector: 'numbers' },
  Color: { color: 'numbers' },
  WorldInfo: { title: 'string', info: 'strings' },
};
const LIMITS = Object.freeze({
  tokens: 1000000,
  nodes: 32768,
  depth: 64,
  meshes: 4096,
  normalWork: 4000000,
});
const fail = message => {
  throw Error(`Unsupported PCB VRML: ${message}`);
};
const budget = message => {
  throw Error(`PCB VRML budget exceeded: ${message}`);
};

function utf8Size(text, limit) {
  let bytes = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    bytes += code < 128 ? 1 : code < 2048 ? 2 : 3;
    if (
      code >= 0xd800 &&
      code <= 0xdbff &&
      i + 1 < text.length &&
      text.charCodeAt(i + 1) >= 0xdc00 &&
      text.charCodeAt(i + 1) <= 0xdfff
    ) {
      bytes++;
      i++;
    }
    if (bytes > limit) budget('source bytes');
  }
}

function inspect(text, maxTriangles) {
  if (!/^#VRML V2\.0 utf8(?:[ \t]*\r?\n|$)/.test(text)) fail('expected VRML V2.0 utf8 header');
  const tokens = [];
  const lexer =
    /\s+|,[ \t]*|#[^\r\n]*|"(?:\\[^\r\n]|[^"\\\r\n])*"|[{}[\]]|[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?|[A-Za-z_][A-Za-z0-9_.-]*/gy;
  let end = 0;
  while (end < text.length) {
    lexer.lastIndex = end;
    const match = lexer.exec(text);
    if (!match) fail('invalid token');
    end = lexer.lastIndex;
    if (/^[\s,#]/.test(match[0])) continue;
    if (tokens.length >= LIMITS.tokens) budget('tokens');
    tokens.push(match[0]);
  }
  let cursor = 0,
    count = 0;
  const definitions = new Map(),
    all = [],
    identifierTokens = [],
    loaderDefaults = new Map();
  const take = () => tokens[cursor++];
  const expect = token => {
    if (take() !== token) fail(`expected ${token}`);
  };
  const number = () => {
    const token = take();
    if (!/^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/.test(token || ''))
      fail('expected finite number');
    const value = Number(token);
    if (!Number.isFinite(value)) fail('nonfinite number');
    return value;
  };
  const string = () => {
    const token = take();
    if (!token?.startsWith('"')) fail('expected string');
    return token;
  };
  function list(read) {
    if (tokens[cursor] !== '[') return [read()];
    take();
    const values = [];
    while (tokens[cursor] !== ']') {
      if (cursor >= tokens.length) fail('unterminated array');
      values.push(read());
    }
    take();
    return values;
  }
  function identifier() {
    const value = take();
    if (
      !/^[A-Za-z_][A-Za-z0-9_-]*$/.test(value || '') ||
      value === '__proto__' ||
      value in Object.prototype
    )
      fail('unsafe or unsupported DEF/USE identifier');
    identifierTokens.push(cursor - 1);
    return value;
  }
  function node(depth = 0) {
    if (depth > LIMITS.depth) budget('node depth');
    if (++count > LIMITS.nodes) budget('nodes');
    if (tokens[cursor] === 'NULL') {
      take();
      return null;
    }
    if (tokens[cursor] === 'USE') {
      take();
      return { use: identifier() };
    }
    let name;
    if (tokens[cursor] === 'DEF') {
      take();
      name = identifier();
    }
    const type = take(),
      schema = Object.hasOwn(TYPES, type || '') ? TYPES[type] : null;
    if (!schema) fail(`node ${type || '(missing)'}`);
    const result = { type, fields: Object.create(null) };
    all.push(result);
    if (name) {
      if (definitions.has(name)) fail('duplicate DEF');
      definitions.set(name, result);
    }
    expect('{');
    while (tokens[cursor] !== '}') {
      const field = take();
      if (!Object.hasOwn(schema, field || '')) fail(`field ${type}.${field || '(missing)'}`);
      if (Object.hasOwn(result.fields, field)) fail(`duplicate field ${type}.${field}`);
      const kind = schema[field];
      let value;
      if (kind === 'number') value = number();
      else if (kind === 'v3' || kind === 'v4')
        value = Array.from({ length: Number(kind[1]) }, number);
      else if (kind === 'numbers') value = list(number);
      else if (kind === 'string') value = string();
      else if (kind === 'strings') value = list(string);
      else if (kind === 'boolean') {
        const token = take();
        if (token !== 'TRUE' && token !== 'FALSE') fail('expected boolean');
        value = token === 'TRUE';
      } else if (kind === 'node') value = node(depth + 1);
      else value = list(() => node(depth + 1));
      result.fields[field] = value;
    }
    // VRML97 defaults differ from Three's empty MeshPhongMaterial defaults.
    // Make these two source-defined defaults explicit for the pinned loader.
    if (type === 'Material' && !Object.hasOwn(result.fields, 'diffuseColor'))
      loaderDefaults.set(cursor, 'diffuseColor 0.8 0.8 0.8 ');
    if (type === 'Appearance' && !Object.hasOwn(result.fields, 'material'))
      loaderDefaults.set(cursor, 'material NULL ');
    expect('}');
    return result;
  }
  const roots = [];
  while (cursor < tokens.length) roots.push(node());
  if (!roots.length) fail('empty model');
  function resolve(value, expected) {
    const resolved = value?.use ? definitions.get(value.use) : value;
    if (value?.use && !resolved) fail('unresolved USE');
    if (resolved && expected && !expected.includes(resolved.type))
      fail(`expected ${expected.join('/')}`);
    return resolved;
  }
  const vectorData = (value, type, field) => {
    const resolved = resolve(value, [type]);
    if (!resolved) return null;
    const data = resolved.fields[field];
    if (!data?.length || data.length % 3) fail(`${type} requires triplets`);
    if (data.length / 3 > maxTriangles * 3) budget('source vertices');
    return data;
  };
  const triangles = new Map();
  let sourceTriangles = 0,
    normalWork = 0;
  for (const item of all) {
    const f = item.fields;
    if (item.type === 'Transform') {
      if (f.center?.some(value => value !== 0))
        fail('nonzero Transform.center is unsupported by the pinned loader');
      if (f.scaleOrientation && f.scaleOrientation[3] !== 0)
        fail('Transform.scaleOrientation is unsupported by the pinned loader');
      if (f.scale?.some(value => value === 0)) fail('singular transform');
      if (
        f.rotation &&
        f.rotation[3] !== 0 &&
        Math.abs(Math.hypot(...f.rotation.slice(0, 3)) - 1) > 1e-6
      )
        fail('rotation axis must have unit length');
    }
    if (item.type === 'Material') {
      // KiCad exports include ambientIntensity > 1 (for example GLASS-19).
      // KiCad accepts this scalar; the upstream Three loader ignores ambient
      // lighting and we preserve only diffuse color and transparency.
      for (const [field, value] of Object.entries(f)) {
        if (field === 'ambientIntensity') {
          if (value < 0 || value > 1000000) fail('ambient intensity outside supported range');
          continue;
        }
        if ((Array.isArray(value) ? value : [value]).some(v => v < 0 || v > 1))
          fail('material value outside 0..1');
      }
    }
    if (item.type === 'Shape') {
      resolve(f.appearance, ['Appearance']);
      // KiCad's library exports often define shared materials in an empty
      // Shape. VRML specifies that absent/NULL geometry draws nothing.
      resolve(f.geometry, ['IndexedFaceSet']);
    }
    if (item.type === 'Appearance') resolve(f.material, ['Material']);
    if (item.type !== 'IndexedFaceSet') continue;
    const coord = vectorData(f.coord, 'Coordinate', 'point');
    if (!coord) fail('missing coordinates');
    const indices = f.coordIndex;
    if (!indices?.length) fail('missing coordIndex');
    const faces = [];
    let face = [];
    for (const index of indices) {
      if (!Number.isInteger(index) || index < -1 || index >= coord.length / 3)
        fail('coordinate index outside array');
      if (index === -1) {
        if (face.length !== 3) fail('only triangulated IndexedFaceSet geometry is supported');
        faces.push(face);
        face = [];
        if (faces.length > maxTriangles) budget('triangles');
      } else {
        face.push(index);
        if (face.length > 3) fail('only triangulated IndexedFaceSet geometry is supported');
      }
    }
    if (face.length) {
      if (face.length !== 3) fail('incomplete face');
      faces.push(face);
    }
    sourceTriangles += faces.length;
    if (sourceTriangles > maxTriangles) budget('source triangles');
    triangles.set(item, faces.length);
    const normal = vectorData(f.normal, 'Normal', 'vector');
    const color = vectorData(f.color, 'Color', 'color');
    if (color?.some(value => value < 0 || value > 1)) fail('vertex color outside 0..1');
    for (const [data, indexName, perVertexName] of [
      [normal, 'normalIndex', 'normalPerVertex'],
      [color, 'colorIndex', 'colorPerVertex'],
    ]) {
      const index = f[indexName];
      if (!data) {
        if (index?.length) fail(`${indexName} without attribute`);
        continue;
      }
      const perVertex = f[perVertexName] !== false;
      if (index?.length) {
        if (perVertex) {
          if (
            index.length !== indices.length ||
            index.some(
              (v, i) =>
                !Number.isInteger(v) ||
                (indices[i] === -1 ? v !== -1 : v < 0 || v >= data.length / 3),
            )
          )
            fail(`invalid ${indexName}`);
        } else if (
          index.length !== faces.length ||
          index.some(v => !Number.isInteger(v) || v < 0 || v >= data.length / 3)
        ) {
          fail(`invalid ${indexName}`);
        }
      } else if (
        perVertex ? indices.some(v => v >= data.length / 3) : faces.length > data.length / 3
      ) {
        fail(`${indexName} attribute is too short`);
      }
    }
    if (f.creaseAngle !== undefined && (f.creaseAngle < 0 || f.creaseAngle > Math.PI))
      fail('invalid creaseAngle');
    if (!normal && f.creaseAngle > 0) {
      const incidence = new Uint32Array(coord.length / 3);
      for (const face of faces) for (const index of face) incidence[index]++;
      for (const valence of incidence) {
        normalWork += valence * valence;
        if (normalWork > LIMITS.normalWork) budget('normal smoothing work');
      }
    }
  }
  // KiCad's legacy-unit switch is global and order dependent. Accept only files
  // where no top-level Transform can switch it off, then convert everything once.
  for (const root of roots) {
    const item = resolve(root);
    if (item?.type === 'Transform' && item.fields.scale?.some(value => value !== 1))
      fail('ambiguous units from a top-level nonunity Transform.scale');
  }
  const active = new Set(),
    costs = new Map();
  function cost(value, depth = 0) {
    const item = resolve(value);
    if (!item) return { nodes: 0, meshes: 0, triangles: 0 };
    if (depth > LIMITS.depth || active.has(item)) fail('cyclic or too deep USE graph');
    if (costs.has(item)) return costs.get(item);
    active.add(item);
    const result = {
      nodes: 1,
      meshes: item.type === 'Shape' && resolve(item.fields.geometry) ? 1 : 0,
      triangles: 0,
      height: 1,
    };
    if (item.type === 'Shape') result.triangles = triangles.get(resolve(item.fields.geometry)) || 0;
    for (const [name, kind] of Object.entries(TYPES[item.type])) {
      if (kind !== 'nodes' && kind !== 'node') continue;
      const children = kind === 'nodes' ? item.fields[name] || [] : [item.fields[name]];
      for (const child of children) {
        const childCost = cost(child, depth + 1);
        result.nodes += childCost.nodes;
        result.meshes += childCost.meshes;
        result.triangles += childCost.triangles;
        result.height = Math.max(result.height, (childCost.height || 0) + 1);
        if (result.height > LIMITS.depth) budget('expanded USE depth');
        if (
          result.nodes > LIMITS.nodes ||
          result.meshes > LIMITS.meshes ||
          result.triangles > maxTriangles
        )
          budget('expanded USE graph');
      }
    }
    active.delete(item);
    costs.set(item, result);
    return result;
  }
  let expandedTriangles = 0,
    expandedNodes = 0,
    expandedMeshes = 0;
  for (const root of roots) {
    const result = cost(root);
    expandedTriangles += result.triangles;
    expandedNodes += result.nodes;
    expandedMeshes += result.meshes;
    if (
      expandedTriangles > maxTriangles ||
      expandedNodes > LIMITS.nodes ||
      expandedMeshes > LIMITS.meshes
    )
      budget('expanded scene');
  }
  if (!expandedTriangles) fail('model contains no triangle meshes');
  // Legal KiCad DEF/USE names often contain hyphens, which the pinned upstream
  // lexer rejects. Rename only validated identifier tokens, never strings or
  // numbers. This adapter preserves source geometry and the raw asset hash.
  const safeNames = new Map([...definitions.keys()].map((name, i) => [name, `PcbModelDef${i}`]));
  for (const index of identifierTokens) tokens[index] = safeNames.get(tokens[index]);
  for (const [index, prefix] of loaderDefaults) tokens[index] = prefix + tokens[index];
  return {
    expectedTriangles: expandedTriangles,
    loaderText: `#VRML V2.0 utf8\n${tokens.join(' ')}`,
  };
}

export function parsePcbVrml(text, { maxTriangles = 150000, maxBytes = 32 * 1024 * 1024 } = {}) {
  if (
    !Number.isSafeInteger(maxTriangles) ||
    maxTriangles < 1 ||
    maxTriangles > 150000 ||
    !Number.isSafeInteger(maxBytes) ||
    maxBytes < 1 ||
    maxBytes > 32 * 1024 * 1024
  )
    throw Error('Invalid PCB VRML budget.');
  if (typeof text !== 'string') throw Error('PCB VRML source must be text.');
  if (text.length > maxBytes) budget('source bytes');
  utf8Size(text, maxBytes);
  const { expectedTriangles, loaderText } = inspect(text, maxTriangles);
  const manager = new LoadingManager();
  manager.setURLModifier(() => {
    fail('external resources are disabled');
  });
  const scene = new VRMLLoader(manager).parse(loaderText, '');
  const geometries = new Set(),
    materials = new Set();
  try {
    scene.updateMatrixWorld(true);
    const meshes = [];
    let totalTriangles = 0;
    scene.traverse(object => {
      if (object.geometry) geometries.add(object.geometry);
      if (object.material)
        for (const material of Array.isArray(object.material) ? object.material : [object.material])
          materials.add(material);
      if (!object.isMesh) return;
      const geometry = object.geometry,
        position = geometry.getAttribute('position');
      const normal = geometry.getAttribute('normal'),
        vertexColor = geometry.getAttribute('color');
      const index = geometry.getIndex();
      const triangleCount = (index ? index.count : position?.count) / 3;
      if (
        !position ||
        !normal ||
        !Number.isInteger(triangleCount) ||
        triangleCount < 1 ||
        position.itemSize !== 3 ||
        normal.itemSize !== 3 ||
        normal.count !== position.count ||
        (vertexColor && (vertexColor.itemSize !== 3 || vertexColor.count !== position.count))
      )
        fail('invalid loader geometry');
      totalTriangles += triangleCount;
      if (
        totalTriangles > maxTriangles ||
        totalTriangles > expectedTriangles ||
        meshes.length >= LIMITS.meshes
      )
        budget('output triangles');
      if (position.count > maxTriangles * 3) budget('output vertices');
      const determinant = object.matrixWorld.determinant();
      if (!Number.isFinite(determinant) || determinant === 0)
        fail('singular or nonfinite transform');
      const positions = new Float32Array(position.count * 3);
      const normals = new Float32Array(normal.count * 3);
      const indices = new Uint32Array(triangleCount * 3);
      const colors = vertexColor ? new Float32Array(vertexColor.count * 3) : undefined;
      const normalMatrix = new Matrix3().getNormalMatrix(object.matrixWorld),
        point = new Vector3();
      for (let i = 0; i < position.count; i++) {
        point
          .fromBufferAttribute(position, i)
          .applyMatrix4(object.matrixWorld)
          .multiplyScalar(2.54);
        if (![point.x, point.y, point.z].every(v => Number.isFinite(v) && Math.abs(v) <= 1000000))
          fail('transformed position outside supported range');
        point.toArray(positions, i * 3);
        point.fromBufferAttribute(normal, i).applyMatrix3(normalMatrix).normalize();
        if (![point.x, point.y, point.z].every(Number.isFinite)) fail('nonfinite normal');
        point.toArray(normals, i * 3);
        if (colors) {
          const values = [vertexColor.getX(i), vertexColor.getY(i), vertexColor.getZ(i)];
          if (!values.every(v => Number.isFinite(v) && v >= 0 && v <= 1))
            fail('invalid vertex color');
          colors.set(values, i * 3);
        }
      }
      for (let i = 0; i < indices.length; i += 3) {
        const face = [0, 1, 2].map(j => (index ? index.getX(i + j) : i + j));
        if (!face.every(v => Number.isInteger(v) && v >= 0 && v < position.count))
          fail('invalid output index');
        if (determinant < 0) [face[1], face[2]] = [face[2], face[1]];
        indices.set(face, i);
      }
      if (Array.isArray(object.material) || !object.material?.color)
        fail('unsupported material groups');
      const material = object.material,
        color = material.color.toArray();
      if (
        !color.every(v => Number.isFinite(v) && v >= 0 && v <= 1) ||
        !Number.isFinite(material.opacity) ||
        material.opacity < 0 ||
        material.opacity > 1
      )
        fail('invalid material output');
      meshes.push({
        positions,
        normals,
        indices,
        color,
        ...(colors ? { colors } : {}),
        opacity: material.opacity,
        doubleSided: material.side === 2,
      });
    });
    if (totalTriangles !== expectedTriangles) fail('loader omitted source geometry');
    // StepUp models commonly put each BREP face in a separate Shape. Merge
    // compatible material batches so repeated packages do not create thousands
    // of draw calls. Vertex positions already include each source transform.
    const groups = new Map();
    for (const mesh of meshes) {
      const key = JSON.stringify([
        mesh.color,
        mesh.opacity,
        mesh.doubleSided,
        Boolean(mesh.colors),
      ]);
      const group = groups.get(key) || [];
      group.push(mesh);
      groups.set(key, group);
    }
    const merged = [];
    for (const group of groups.values()) {
      if (group.length === 1) {
        merged.push(group[0]);
        continue;
      }
      const floats = group.reduce((n, mesh) => n + mesh.positions.length, 0);
      const indexCount = group.reduce((n, mesh) => n + mesh.indices.length, 0);
      const positions = new Float32Array(floats),
        normals = new Float32Array(floats);
      const indices = new Uint32Array(indexCount);
      const colors = group[0].colors ? new Float32Array(floats) : undefined;
      let offset = 0,
        indexOffset = 0;
      for (const mesh of group) {
        positions.set(mesh.positions, offset);
        normals.set(mesh.normals, offset);
        if (colors) colors.set(mesh.colors, offset);
        for (const index of mesh.indices) indices[indexOffset++] = index + offset / 3;
        offset += mesh.positions.length;
      }
      merged.push({ ...group[0], positions, normals, indices, ...(colors ? { colors } : {}) });
    }
    return { meshes: merged };
  } finally {
    for (const geometry of geometries) geometry.dispose();
    for (const material of materials) material.dispose();
  }
}
