export const componentLimits = Object.freeze({
  fileBytes: 8 * 1024 * 1024,
  totalBytes: 64 * 1024 * 1024,
  uniqueModels: 64,
  modelTriangles: 150000,
  totalTriangles: 300000,
  meshBytes: 32 * 1024 * 1024,
  modelMs: 10000,
  totalMs: 60000,
});
const abortError = () => new DOMException('Component loading cancelled.', 'AbortError');
const finite = value => typeof value === 'number' && Number.isFinite(value);
const rgb = value =>
  Array.isArray(value) &&
  value.length === 3 &&
  value.every(component => finite(component) && component >= 0 && component <= 1);

export function inspectComponentMeshes(meshes, triangleLimit, byteLimit) {
  if (!Array.isArray(meshes) || !meshes.length || meshes.length > 2048)
    throw Error('Component parser returned invalid meshes.');
  let triangles = 0;
  let bytes = 0;
  for (const mesh of meshes) {
    if (
      !(mesh.positions instanceof Float32Array) ||
      !(mesh.normals instanceof Float32Array) ||
      !(mesh.indices instanceof Uint32Array) ||
      !mesh.positions.length ||
      mesh.positions.length % 3 ||
      mesh.normals.length !== mesh.positions.length ||
      !mesh.indices.length ||
      mesh.indices.length % 3 ||
      (mesh.colors &&
        (!(mesh.colors instanceof Float32Array) || mesh.colors.length !== mesh.positions.length)) ||
      !rgb(mesh.color) ||
      (mesh.opacity !== undefined &&
        (!finite(mesh.opacity) || mesh.opacity < 0 || mesh.opacity > 1)) ||
      (mesh.doubleSided !== undefined && typeof mesh.doubleSided !== 'boolean')
    )
      throw Error('Component parser returned invalid mesh attributes.');
    triangles += mesh.indices.length / 3;
    bytes += mesh.positions.byteLength + mesh.normals.byteLength + mesh.indices.byteLength;
    if (mesh.colors) bytes += mesh.colors.byteLength;
    if (triangles > triangleLimit || bytes > byteLimit)
      throw Error('Component model exceeds the mesh budget.');
    if (
      !mesh.positions.every(value => finite(value) && Math.abs(value) <= 100000) ||
      !mesh.normals.every(finite) ||
      !mesh.indices.every(value => value < mesh.positions.length / 3) ||
      (mesh.colors && !mesh.colors.every(value => finite(value) && value >= 0 && value <= 1))
    )
      throw Error('Component parser returned invalid mesh coordinates.');
  }
  return { triangles, bytes };
}

async function readModel(response, entry, signal) {
  if (!response.ok || response.redirected) throw Error('Component model is unavailable.');
  if (Number(response.headers.get('Content-Length')) > componentLimits.fileBytes)
    throw Error('Component model exceeds the input budget.');
  // Streaming keeps an oversized response from being buffered before its limit.
  if (!response.body?.getReader) throw Error('Component model stream is unavailable.');
  const reader = response.body.getReader();
  const chunks = [];
  let length = 0;
  const cancel = () => {
    reader.cancel().catch(() => {});
  };
  signal.addEventListener('abort', cancel, { once: true });
  try {
    for (;;) {
      if (signal.aborted) throw signal.reason || abortError();
      const next = await reader.read();
      if (next.done) break;
      length += next.value.byteLength;
      if (length > componentLimits.fileBytes || length > entry.size) {
        cancel();
        throw Error('Component model exceeds the input budget.');
      }
      chunks.push(next.value);
    }
    if (signal.aborted) throw signal.reason || abortError();
    if (length !== entry.size) throw Error('Component model changed; reopen the board.');
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.length;
    }
    const digest = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)))
      .map(value => value.toString(16).padStart(2, '0'))
      .join('');
    if (digest !== entry.sha256) throw Error('Component model changed; reopen the board.');
    return bytes.buffer;
  } finally {
    signal.removeEventListener('abort', cancel);
    reader.releaseLock();
  }
}

// Dependencies let the resource tests exercise real streams, hashes, worker
// failure and cancellation without a WebGL context or native desktop process.
export async function loadPcbComponentModels(
  entries,
  { signal, onProgress } = {},
  dependencies = {},
) {
  if (!Array.isArray(entries) || entries.length > 4096)
    throw Error('Component manifest exceeds the model count limit.');
  const base = new URL('.', import.meta.url);
  const runtime = {
    fetch: globalThis.fetch.bind(globalThis),
    createWorker: () => new Worker(new URL('./component-worker.js', import.meta.url)),
    ...dependencies,
  };
  const assets = [];
  const failures = [];
  const stats = {
    sourceModels: entries.length,
    uniqueModels: 0,
    loadedModels: 0,
    failedModels: 0,
    modelTriangles: 0,
    modelBytes: 0,
    inputBytes: 0,
  };
  const controller = new AbortController();
  const cancel = () => controller.abort(signal.reason || abortError());
  signal?.addEventListener('abort', cancel, { once: true });
  if (signal?.aborted) cancel();
  let expired = false;
  const totalTimer = setTimeout(() => {
    expired = true;
    controller.abort(Error('Component loading deadline reached.'));
  }, componentLimits.totalMs);
  let worker;
  let sequence = 0;
  const stopWorker = () => {
    worker?.terminate();
    worker = null;
  };
  const failed = (entry, reason) => {
    failures.push({ id: entry?.id ?? null, sha256: entry?.sha256 ?? null, reason });
    stats.failedModels++;
  };
  try {
    const groups = new Map();
    for (const entry of entries) {
      if (
        !entry ||
        !['string', 'number'].includes(typeof entry.id) ||
        typeof entry.sha256 !== 'string' ||
        !/^[a-f0-9]{64}$/.test(entry.sha256) ||
        !['step', 'wrl'].includes(entry.format) ||
        typeof entry.url !== 'string' ||
        !/^models\/(0|[1-9]\d*)$/.test(entry.url) ||
        !Number.isInteger(entry.size) ||
        entry.size <= 0 ||
        entry.size > componentLimits.fileBytes
      ) {
        failed(entry, 'Unsupported or oversized component model.');
        continue;
      }
      const url = new URL(entry.url, base);
      if (
        url.protocol !== base.protocol ||
        url.host !== base.host ||
        url.pathname !== base.pathname + entry.url
      ) {
        failed(entry, 'Component URL is outside the board session.');
        continue;
      }
      const key = entry.sha256 + ':' + entry.format;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(entry);
    }
    stats.uniqueModels = groups.size;
    let done = 0;
    for (const group of groups.values()) {
      const entry = group[0];
      if (signal?.aborted) throw signal.reason || abortError();
      if (
        expired ||
        done >= componentLimits.uniqueModels ||
        stats.inputBytes + entry.size > componentLimits.totalBytes ||
        stats.modelTriangles >= componentLimits.totalTriangles ||
        stats.modelBytes >= componentLimits.meshBytes
      ) {
        for (const item of group) failed(item, 'Component loading budget or deadline reached.');
        continue;
      }
      const jobController = new AbortController();
      const abortJob = () => jobController.abort(controller.signal.reason || abortError());
      controller.signal.addEventListener('abort', abortJob, { once: true });
      if (controller.signal.aborted) abortJob();
      const modelTimer = setTimeout(
        () => jobController.abort(Error('Component model parsing timed out.')),
        componentLimits.modelMs,
      );
      try {
        stats.inputBytes += entry.size;
        const response = await runtime.fetch(new URL(entry.url, base), {
          signal: jobController.signal,
          credentials: 'omit',
          redirect: 'error',
        });
        const bytes = await readModel(response, entry, jobController.signal);
        if (jobController.signal.aborted) throw jobController.signal.reason || abortError();
        const limits = {
          triangles: Math.min(
            componentLimits.modelTriangles,
            componentLimits.totalTriangles - stats.modelTriangles,
          ),
          bytes: componentLimits.meshBytes - stats.modelBytes,
        };
        worker ||= runtime.createWorker();
        const jobId = ++sequence;
        const meshes = await new Promise((resolve, reject) => {
          const abort = () => {
            stopWorker();
            reject(jobController.signal.reason || abortError());
          };
          const finish = (error, value) => {
            jobController.signal.removeEventListener('abort', abort);
            if (worker) worker.onmessage = worker.onerror = worker.onmessageerror = null;
            if (error) reject(error);
            else resolve(value);
          };
          worker.onmessage = event => {
            if (event.data?.jobId !== jobId) return;
            if (event.data.error) finish(Error(String(event.data.error)));
            else finish(null, event.data.meshes);
          };
          worker.onerror = () => finish(Error('Component model parser failed.'));
          worker.onmessageerror = () =>
            finish(Error('Component model parser returned invalid data.'));
          jobController.signal.addEventListener('abort', abort, { once: true });
          if (jobController.signal.aborted) return abort();
          worker.postMessage({ type: 'parse', jobId, format: entry.format, bytes, limits }, [
            bytes,
          ]);
        });
        const counts = inspectComponentMeshes(meshes, limits.triangles, limits.bytes);
        stats.modelTriangles += counts.triangles;
        stats.modelBytes += counts.bytes;
        stats.loadedModels += group.length;
        assets.push({ sha256: entry.sha256, format: entry.format, meshes });
      } catch (error) {
        stopWorker();
        if (signal?.aborted) throw signal.reason || abortError();
        for (const item of group) failed(item, String(error?.message || error).slice(0, 300));
      } finally {
        clearTimeout(modelTimer);
        controller.signal.removeEventListener('abort', abortJob);
      }
      done++;
      onProgress?.({
        completed: done,
        total: Math.min(groups.size, componentLimits.uniqueModels),
        ...stats,
      });
    }
    return { assets, failures, stats };
  } finally {
    stopWorker();
    clearTimeout(totalTimer);
    signal?.removeEventListener('abort', cancel);
  }
}
