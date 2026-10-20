// Classic Worker: synchronous native CAD parsing stays off the UI thread.
// The host terminates this worker on deadline, cancellation, or parser failure.
const MAX_TRIANGLES = 150000;
const MAX_BYTES = 32 * 1024 * 1024;
const MAX_MESHES = 2048;
let parser;
let busy = false;
const finite = value => typeof value === 'number' && Number.isFinite(value);
const rgb = value =>
  Array.isArray(value) &&
  value.length === 3 &&
  value.every(component => finite(component) && component >= 0 && component <= 1);

function normalizeStepMeshes(result, triangleLimit, byteLimit) {
  if (
    !result?.success ||
    !Array.isArray(result.meshes) ||
    !result.meshes.length ||
    result.meshes.length > MAX_MESHES
  )
    throw Error('STEP model could not be parsed.');
  let triangles = 0;
  let bytes = 0;
  const meshes = [];
  for (const source of result.meshes) {
    const points = source.attributes?.position?.array;
    const indices = source.index?.array;
    if (
      !Array.isArray(points) ||
      !points.length ||
      points.length % 3 ||
      !Array.isArray(indices) ||
      !indices.length ||
      indices.length % 3
    )
      throw Error('STEP model contains invalid mesh data.');
    const count = points.length / 3;
    const color = rgb(source.color) ? source.color : [0.68, 0.7, 0.72];
    const faces = source.brep_faces;
    const hasFaceColors = Array.isArray(faces) && faces.some(face => rgb(face.color));
    triangles += indices.length / 3;
    bytes += points.length * (hasFaceColors ? 12 : 8) + indices.length * 4;
    if (triangles > triangleLimit || bytes > byteLimit)
      throw Error('Component model exceeds the mesh budget.');
    if (
      !points.every(value => finite(value) && Math.abs(value) <= 100000) ||
      !indices.every(value => Number.isInteger(value) && value >= 0 && value < count)
    )
      throw Error('STEP model contains invalid mesh coordinates.');
    const positions = new Float32Array(points);
    const index = new Uint32Array(indices);
    let normals;
    const sourceNormals = source.attributes?.normal?.array;
    if (
      Array.isArray(sourceNormals) &&
      sourceNormals.length === points.length &&
      sourceNormals.every(finite)
    ) {
      normals = new Float32Array(sourceNormals);
    } else {
      normals = new Float32Array(points.length);
      for (let i = 0; i < index.length; i += 3) {
        const a = index[i] * 3;
        const b = index[i + 1] * 3;
        const c = index[i + 2] * 3;
        const ux = positions[b] - positions[a];
        const uy = positions[b + 1] - positions[a + 1];
        const uz = positions[b + 2] - positions[a + 2];
        const vx = positions[c] - positions[a];
        const vy = positions[c + 1] - positions[a + 1];
        const vz = positions[c + 2] - positions[a + 2];
        const nx = uy * vz - uz * vy;
        const ny = uz * vx - ux * vz;
        const nz = ux * vy - uy * vx;
        for (const vertex of [a, b, c]) {
          normals[vertex] += nx;
          normals[vertex + 1] += ny;
          normals[vertex + 2] += nz;
        }
      }
      for (let i = 0; i < normals.length; i += 3) {
        const length = Math.hypot(normals[i], normals[i + 1], normals[i + 2]) || 1;
        normals[i] /= length;
        normals[i + 1] /= length;
        normals[i + 2] /= length;
      }
    }
    let colors;
    if (hasFaceColors) {
      if (faces.length > triangleLimit) throw Error('STEP model exceeds the face budget.');
      colors = new Float32Array(points.length);
      for (let i = 0; i < colors.length; i += 3) colors.set(color, i);
      for (const face of faces) {
        if (!rgb(face.color)) continue;
        if (
          !Number.isInteger(face.first) ||
          !Number.isInteger(face.last) ||
          face.first < 0 ||
          face.last < face.first ||
          face.last >= index.length / 3
        )
          throw Error('STEP model contains invalid face colors.');
        for (let i = face.first * 3; i < (face.last + 1) * 3; i++)
          colors.set(face.color, index[i] * 3);
      }
    }
    meshes.push({
      positions,
      normals,
      indices: index,
      colors,
      color,
      opacity: 1,
      doubleSided: false,
    });
  }
  return { meshes };
}

async function stepParser() {
  if (!parser) {
    parser = (async () => {
      const response = await fetch('./vendor/occt-import/occt-import-js.wasm');
      if (!response.ok) throw Error('STEP parser binary is unavailable.');
      const { boundPcbStepWasm } = await import('./component-wasm.js');
      const wasmBinary = await boundPcbStepWasm(await response.arrayBuffer());
      importScripts('./vendor/occt-import/occt-import-js.js');
      return self.occtimportjs({ wasmBinary, print() {}, printErr() {} });
    })();
  }
  return parser;
}

self.onmessage = async event => {
  const job = event.data;
  if (busy || job?.type !== 'parse' || !Number.isInteger(job.jobId)) return;
  busy = true;
  try {
    if (!(job.bytes instanceof ArrayBuffer) || job.bytes.byteLength > 8 * 1024 * 1024)
      throw Error('Component model exceeds the input budget.');
    const triangleLimit = Math.min(MAX_TRIANGLES, job.limits?.triangles ?? MAX_TRIANGLES);
    const byteLimit = Math.min(MAX_BYTES, job.limits?.bytes ?? MAX_BYTES);
    if (!(triangleLimit > 0 && byteLimit > 0)) throw Error('Component mesh budget reached.');
    let result;
    if (job.format === 'step') {
      const occt = await stepParser();
      result = normalizeStepMeshes(
        occt.ReadStepFile(new Uint8Array(job.bytes), {
          linearUnit: 'millimeter',
          linearDeflectionType: 'absolute_value',
          linearDeflection: 0.05,
          angularDeflection: 0.4,
        }),
        triangleLimit,
        byteLimit,
      );
    } else if (job.format === 'wrl') {
      const { parsePcbVrml } = await import('./component-vrml.js');
      result = parsePcbVrml(new TextDecoder('utf-8', { fatal: true }).decode(job.bytes), {
        maxTriangles: triangleLimit,
        maxBytes: byteLimit,
      });
    } else throw Error('Unsupported component model format.');
    const buffers = [];
    for (const mesh of result.meshes)
      for (const name of ['positions', 'normals', 'indices', 'colors'])
        if (mesh[name]) buffers.push(mesh[name].buffer);
    self.postMessage({ jobId: job.jobId, meshes: result.meshes }, [...new Set(buffers)]);
  } catch (error) {
    self.postMessage({ jobId: job.jobId, error: String(error?.message || error).slice(0, 300) });
  } finally {
    busy = false;
  }
};
