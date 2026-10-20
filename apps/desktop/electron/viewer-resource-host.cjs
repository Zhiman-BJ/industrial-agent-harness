// The renderer supplies only an opaque Viewer session token. Resource URLs,
// catalogs and filesystem roots stay behind the active project/artifact binding.
class ViewerResourceHost {
  constructor({ context, checked, prepare, release = () => {}, onProgress = () => {} }) {
    this.context = context;
    this.checked = checked;
    this.prepareResources = prepare;
    this.releaseResources = release;
    this.onProgress = onProgress;
    this.bindings = new Map();
    this.operations = new Map();
  }
  bind(token, binding) {
    if (this.bindings.has(token)) this.release({ token });
    this.bindings.set(token, Object.freeze({ ...binding }));
  }
  binding(request) {
    if (
      !request ||
      typeof request.token !== 'string' ||
      Object.keys(request).some(key => key !== 'token')
    )
      throw Error('Invalid Viewer resource request.');
    const binding = this.bindings.get(request.token);
    if (!binding) throw Error('Viewer session changed; reopen the file.');
    this.assertContext(binding);
    return binding;
  }
  assertContext(binding) {
    const current = this.context();
    if (
      !current ||
      current.projectId !== binding.projectId ||
      current.domain !== binding.domain ||
      current.root !== binding.root
    )
      throw Error('Viewer project changed; reopen the file.');
  }
  async prepare(request) {
    const binding = this.binding(request);
    if (this.operations.has(request.token))
      throw Error('Viewer resources are already downloading.');
    const controller = new AbortController();
    this.operations.set(request.token, controller);
    try {
      const entry = await this.checked(binding.artifactId);
      controller.signal.throwIfAborted();
      this.assertContext(binding);
      if (
        this.bindings.get(request.token) !== binding ||
        entry.artifact.sha256 !== binding.sha256 ||
        entry.file !== binding.file
      )
        throw Error('Viewer source changed; reopen the file.');
      const result = await this.prepareResources(request.token, {
        signal: controller.signal,
        onProgress: progress => {
          if (!controller.signal.aborted && this.bindings.get(request.token) === binding) {
            this.assertContext(binding);
            this.onProgress({ token: request.token, ...progress });
          }
        },
      });
      controller.signal.throwIfAborted();
      this.assertContext(binding);
      if (this.bindings.get(request.token) !== binding)
        throw Error('Viewer session changed; reopen the file.');
      const finalEntry = await this.checked(binding.artifactId);
      controller.signal.throwIfAborted();
      this.assertContext(binding);
      if (
        this.bindings.get(request.token) !== binding ||
        finalEntry.artifact.sha256 !== binding.sha256 ||
        finalEntry.file !== binding.file
      )
        throw Error('Viewer session changed; reopen the file.');
      return result;
    } finally {
      if (this.operations.get(request.token) === controller) this.operations.delete(request.token);
    }
  }
  cancel(request) {
    this.binding(request);
    const controller = this.operations.get(request.token);
    controller?.abort(Error('Viewer resource download cancelled.'));
    return { cancelled: Boolean(controller) };
  }
  release(request) {
    if (
      !request ||
      typeof request.token !== 'string' ||
      Object.keys(request).some(key => key !== 'token')
    )
      throw Error('Invalid Viewer resource request.');
    if (!this.bindings.has(request.token)) return { released: false };
    this.operations.get(request.token)?.abort(Error('Viewer session changed; reopen the file.'));
    this.operations.delete(request.token);
    this.bindings.delete(request.token);
    this.releaseResources(request.token);
    return { released: true };
  }
  close() {
    for (const controller of this.operations.values())
      controller.abort(Error('Viewer session changed; reopen the file.'));
    this.operations.clear();
    for (const token of this.bindings.keys()) this.releaseResources(token);
    this.bindings.clear();
  }
}

module.exports = { ViewerResourceHost };
