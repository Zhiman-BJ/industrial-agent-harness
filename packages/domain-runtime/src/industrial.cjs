const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const {
  ProjectRefSchema,
  ArtifactRefSchema,
  DomainStateSchema,
  RunRecordSchema,
  IndustrialActionRecordSchema,
  IndustrialVerificationResultSchema,
  IndustrialCheckpointSchema,
  ToolDescriptorSchema,
  ActionRequestSchema,
  ActionPresentationSchema,
} = require('@industrial-agent-harness/contracts');

const digest = value => crypto.createHash('sha256').update(value).digest('hex');
const now = () => new Date().toISOString();
const sameInputs = (a, b) =>
  JSON.stringify(Object.entries(a).sort()) === JSON.stringify(Object.entries(b).sort());
const activeStores = new Set();
const { bindPresentation } = require('./presentation.cjs');
const { displayInputs, boundedPreview } = require('./approval-preview.cjs');
const schemas = {
  project: ProjectRefSchema,
  state: DomainStateSchema,
  run: RunRecordSchema,
  action: IndustrialActionRecordSchema,
  artifact: ArtifactRefSchema,
  verification: IndustrialVerificationResultSchema,
  checkpoint: IndustrialCheckpointSchema,
  presentation: ActionPresentationSchema,
};
const defaultDirectory = path.join(os.homedir(), '.industrial-agent-harness', 'core');
const projectReference = (projectDir, domain, projectRef) => {
  const project = ProjectRefSchema.parse(
    projectRef || { schemaVersion: '1', projectId: digest(`${projectDir}\0${domain}`), domain },
  );
  if (project.domain !== domain) throw Error('Runtime project domain differs from its binding.');
  return project;
};
const readRecord = (db, kind, id) => {
  const row = db.prepare('SELECT json FROM core_records WHERE kind=? AND id=?').get(kind, id);
  return row ? schemas[kind].parse(JSON.parse(row.json)) : null;
};

// Execution implementations and engineering interpretation are injected by a Pack.
// This class owns policy, identities, immutable facts, CAS and the durable head.
class IndustrialRuntime {
  // History reads existing canonical facts without acquiring an execution lease,
  // recovering interrupted Actions, migrating stores or loading producer plugins.
  static openRecords(projectDir, domain, { directory = defaultDirectory, projectRef } = {}) {
    projectDir = fs.realpathSync(projectDir);
    const project = projectReference(projectDir, domain, projectRef);
    const file = path.join(directory, `${project.projectId}.sqlite`);
    if (!fs.existsSync(file)) return null;
    const db = new DatabaseSync(file, { readOnly: true });
    try {
      if (db.prepare('PRAGMA user_version').get().user_version !== 1)
        throw Error('Unsupported industrial store version.');
      const stored = readRecord(db, 'project', project.projectId);
      if (!stored || stored.projectId !== project.projectId || stored.domain !== domain)
        throw Error('Industrial store differs from its project binding.');
      return {
        projectDir,
        project,
        get: (kind, id) => readRecord(db, kind, id),
        close: () => db.close(),
      };
    } catch (error) {
      db.close();
      throw error;
    }
  }
  constructor(
    projectDir,
    domain,
    {
      directory = defaultDirectory,
      stateProvider,
      tools = [],
      verifiers = {},
      dispose = () => {},
      releaseOwner = () => {},
      projectRef,
    } = {},
  ) {
    this.projectDir = fs.realpathSync(projectDir);
    if (
      !fs.statSync(this.projectDir).isDirectory() ||
      !domain ||
      typeof stateProvider !== 'function'
    )
      throw Error('A bound project, domain and StateProvider are required.');
    this.projectIdentity = fs.statSync(this.projectDir);
    this.project = projectReference(this.projectDir, domain, projectRef);
    this.stateProvider = stateProvider;
    this.dispose = dispose;
    this.releaseOwner = releaseOwner;
    this.tools = new Map();
    for (const tool of tools) {
      const descriptor = ToolDescriptorSchema.parse(tool.descriptor);
      if (descriptor.verification.length > 1)
        throw Error('This Runtime requires one aggregate verifier per tool.');
      if (this.tools.has(descriptor.id) || typeof tool.execute !== 'function')
        throw Error('Invalid or duplicate runtime tool.');
      for (const id of descriptor.verification)
        if (typeof verifiers[id] !== 'function') throw Error(`Missing verifier: ${id}`);
      this.tools.set(descriptor.id, { ...tool, descriptor });
    }
    this.verifiers = verifiers;
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    this.directory = fs.realpathSync(directory);
    this.blobDirectory = path.join(this.directory, 'objects');
    fs.mkdirSync(this.blobDirectory, { recursive: true, mode: 0o700 });
    this.file = path.join(this.directory, `${this.project.projectId}.sqlite`);
    if (activeStores.has(this.file))
      throw Error('Project runtime is already open in this process.');
    this.db = new DatabaseSync(this.file);
    fs.chmodSync(this.file, 0o600);
    const version = this.db.prepare('PRAGMA user_version').get().user_version;
    if (version > 1) {
      this.db.close();
      this.db = null;
      throw Error('Industrial store version is newer than this runtime.');
    }
    this.db.exec(
      'PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS core_records(kind TEXT NOT NULL,id TEXT NOT NULL,json TEXT NOT NULL,PRIMARY KEY(kind,id)); CREATE TABLE IF NOT EXISTS core_metadata(key TEXT PRIMARY KEY,value TEXT NOT NULL);',
    );
    if (!version) this.db.exec('PRAGMA user_version=1');
    this.put('project', this.project.projectId, this.project);
    try {
      this.recoverInterrupted();
    } catch (error) {
      this.db.close();
      this.db = null;
      throw error;
    }
    activeStores.add(this.file);
  }

  put(kind, id, record, mutable = false) {
    const value = schemas[kind].parse(record);
    const prior = this.get(kind, id);
    if (prior && !mutable) {
      if (JSON.stringify(prior) !== JSON.stringify(value))
        throw Error('Immutable industrial evidence cannot be overwritten.');
      return prior;
    }
    this.db
      .prepare(
        'INSERT INTO core_records(kind,id,json) VALUES(?,?,?) ON CONFLICT(kind,id) DO UPDATE SET json=excluded.json',
      )
      .run(kind, id, JSON.stringify(value));
    return value;
  }
  get(kind, id) {
    return readRecord(this.db, kind, id);
  }
  list(kind) {
    return this.db
      .prepare('SELECT json FROM core_records WHERE kind=? ORDER BY rowid')
      .all(kind)
      .map(row => schemas[kind].parse(JSON.parse(row.json)));
  }
  metadata(key) {
    return this.db.prepare('SELECT value FROM core_metadata WHERE key=?').get(key)?.value || null;
  }
  setMetadata(key, value) {
    this.db
      .prepare(
        'INSERT INTO core_metadata(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
      )
      .run(key, value);
  }
  transaction(operation) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = operation();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
  recoveryVerification(reason, inputHashes = {}) {
    return IndustrialVerificationResultSchema.parse({
      schemaVersion: '1',
      id: crypto.randomUUID(),
      status: 'insufficient_evidence',
      verifierId: null,
      reason,
      metrics: {},
      evidence: { artifactIds: [], inputHashes },
    });
  }
  recoverInterrupted() {
    // A stopped process is never silently upgraded to a successful engineering run.
    // Only the owning runtime can have a live lease; concurrent opens cannot recover it.
    this.transaction(() => {
      const owner = this.metadata('owner_pid');
      if (owner) {
        try {
          process.kill(Number(owner), 0);
          throw Error(
            `Project runtime is active in another process (pid ${owner}). Close the other window or CLI session using this project, then retry.`,
          );
        } catch (error) {
          if (error.code !== 'ESRCH') throw error;
        }
      }
      const running = this.list('action').filter(action => action.status === 'running');
      for (const action of running) {
        const verification = this.recoveryVerification(
          'Runtime stopped before evidence was atomically committed; inspect native run before retrying.',
          action.inputHashes,
        );
        this.put('verification', verification.id, verification);
        this.put(
          'action',
          action.id,
          {
            ...action,
            status: 'failed',
            endedAt: now(),
            diagnostics: [
              ...action.diagnostics,
              'Interrupted runtime recovered without an acceptance claim.',
            ],
            verification,
          },
          true,
        );
        const run = this.get('run', action.runId);
        if (run) this.put('run', run.id, { ...run, status: 'failed', endedAt: now() }, true);
        const state = this.get('state', this.metadata('head_state'));
        if (state && run) this.createCheckpoint(state, run, action);
      }
      this.setMetadata('owner_pid', String(process.pid));
    });
  }
  async inspect() {
    this.assertProjectBound();
    const observed = await this.stateProvider({
      projectDir: this.projectDir,
      project: this.project,
    });
    const inputHashes = observed.inputHashes || {};
    // Validate the Pack result before it can create a fact.
    const prior = this.get('state', this.metadata('head_state'));
    if (
      prior &&
      prior.stage === (observed.stage || null) &&
      sameInputs(prior.inputHashes, inputHashes)
    )
      return prior;
    const state = DomainStateSchema.parse({
      ...this.project,
      id: crypto.randomUUID(),
      stage: observed.stage || null,
      status: prior?.verificationIds.length ? 'stale' : 'unverified',
      inputHashes,
      artifacts: prior?.artifacts || [],
      verificationIds: prior?.verificationIds || [],
      createdAt: now(),
    });
    this.transaction(() => {
      this.put('state', state.id, state);
      this.setMetadata('head_state', state.id);
      this.createCheckpoint(state);
    });
    return state;
  }
  createCheckpoint(state, run = null, action = null) {
    const checkpoint = IndustrialCheckpointSchema.parse({
      schemaVersion: '1',
      id: crypto.randomUUID(),
      parentId: this.metadata('head_checkpoint'),
      stateHash: digest(JSON.stringify(state)),
      createdAt: now(),
      state,
      runId: run?.id || null,
      actionIds: action ? [action.id] : [],
      artifactIds: state.artifacts.map(item => item.id),
    });
    this.put('checkpoint', checkpoint.id, checkpoint);
    this.setMetadata('head_checkpoint', checkpoint.id);
    return checkpoint;
  }
  descriptors(scope) {
    return [...this.tools.values()]
      .map(tool => tool.descriptor)
      .filter(tool => !scope || scope.tools.includes(tool.id));
  }
  describeTool(id, scope) {
    const tool = this.tools.get(id);
    if (!tool || !scope?.tools.includes(id))
      throw Error('Tool is outside the current Broker scope.');
    return {
      descriptor: tool.descriptor,
      guide: tool.guide || { inputs: {}, description: 'This tool accepts an empty inputs object.' },
    };
  }
  approvalPreview(request) {
    const tool = this.tools.get(request.toolId);
    let title = request.toolId,
      text;
    try {
      const preview = tool?.preview?.({ projectDir: this.projectDir, inputs: request.inputs });
      title = preview?.title || title;
      text = preview?.text || JSON.stringify(displayInputs(request.inputs), null, 2);
    } catch (error) {
      text =
        'Preview unavailable: ' +
        error.message +
        '\n' +
        JSON.stringify(displayInputs(request.inputs), null, 2);
    }
    return {
      title,
      ...boundedPreview(text),
      stateId: request.expectedStateId,
      requestSha256: digest(
        JSON.stringify({
          toolId: request.toolId,
          version: tool?.descriptor.version,
          stateId: request.expectedStateId,
          inputs: request.inputs,
        }),
      ),
    };
  }
  assertProjectBound() {
    const current = fs.statSync(this.projectDir);
    if (
      fs.realpathSync(this.projectDir) !== this.projectDir ||
      current.dev !== this.projectIdentity.dev ||
      current.ino !== this.projectIdentity.ino
    )
      throw Error(
        'Bound project directory changed; reopen and inspect the new project before execution.',
      );
  }
  async collect(result, action) {
    const artifacts = [];
    for (const output of result.artifacts || []) {
      const file = fs.realpathSync(path.resolve(this.projectDir, output.file));
      const relativePath = path.relative(this.projectDir, file).split(path.sep).join('/');
      if (
        !relativePath ||
        relativePath.startsWith('../') ||
        path.isAbsolute(relativePath) ||
        !fs.statSync(file).isFile()
      )
        throw Error('Collected artifact escaped the bound project.');
      const content = fs.readFileSync(file);
      const sha256 = digest(content);
      if (output.sha256 && output.sha256 !== sha256)
        throw Error('Native artifact digest differs from collected evidence.');
      const artifact = ArtifactRefSchema.parse({
        schemaVersion: '1',
        id: crypto.randomUUID(),
        projectId: this.project.projectId,
        runId: action.runId,
        actionId: action.id,
        kind: output.kind,
        relativePath,
        sha256,
        sizeBytes: content.length,
        source: 'domain-tool',
        inputHashes: action.inputHashes,
      });
      const destination = path.join(this.blobDirectory, sha256);
      if (fs.existsSync(destination)) {
        if (digest(fs.readFileSync(destination)) !== sha256)
          throw Error('Artifact content store is corrupted.');
      } else fs.writeFileSync(destination, content, { flag: 'wx', mode: 0o400 });
      artifacts.push(artifact);
    }
    return artifacts;
  }
  async execute(request, { scope, approval = false, ownerId = 'project' } = {}) {
    if (this.executing) throw Error('A project action is already running.');
    this.executing = true;
    this.activeOwnerId = ownerId;
    this.abortController = new AbortController();
    this.activeExecution = this.executeOne(request, { scope, approval, ownerId });
    try {
      return await this.activeExecution;
    } finally {
      this.executing = false;
      this.abortController = null;
      this.activeExecution = null;
      this.activeOwnerId = null;
    }
  }
  cancel(ownerId) {
    if (ownerId !== undefined && ownerId !== this.activeOwnerId) return;
    this.abortController?.abort();
  }
  async waitForIdle(ownerId) {
    if (ownerId !== undefined && ownerId !== this.activeOwnerId) return;
    if (this.activeExecution) await this.activeExecution;
  }
  async executeOne(request, policy) {
    const state = await this.inspect();
    const tool = this.tools.get(request.toolId);
    let verification = this.recoveryVerification(
      'No engineering verifier has run.',
      state.inputHashes,
    );
    let action = IndustrialActionRecordSchema.parse({
      ...this.project,
      id: crypto.randomUUID(),
      runId: crypto.randomUUID(),
      stateId: state.id,
      toolId: String(request.toolId || 'invalid-request'),
      toolVersion: tool?.descriptor.version || 'unavailable',
      inputHashes: state.inputHashes,
      inputs: request.inputs || {},
      startedAt: now(),
      endedAt: null,
      status: 'running',
      diagnostics: [],
      artifactIds: [],
      verification,
    });
    let run = RunRecordSchema.parse({
      ...this.project,
      id: action.runId,
      stateId: state.id,
      startedAt: action.startedAt,
      endedAt: null,
      status: 'running',
      actionIds: [action.id],
    });
    this.transaction(() => {
      this.put('run', run.id, run);
      this.put('action', action.id, action);
    });
    let artifacts = [],
      result,
      permitted = false;
    try {
      const parsed = ActionRequestSchema.parse({ ...this.project, ...request });
      if (parsed.projectId !== this.project.projectId || parsed.domain !== this.project.domain)
        throw Error('Request is bound to a different project or domain.');
      if (
        !policy.scope ||
        policy.scope.domain !== this.project.domain ||
        !policy.scope.tools.includes(parsed.toolId)
      )
        throw Error('Tool is outside the current Broker scope.');
      if (policy.scope.projectId !== this.project.projectId)
        throw Error('Broker scope is bound to a different or missing project identity.');
      if (policy.scope.stateId !== state.id)
        throw Error('Broker scope is stale; inspect and resolve a fresh scope before execution.');
      if (!tool) throw Error('Tool is unavailable in this runtime.');
      if (parsed.expectedStateId !== state.id)
        throw Error('Input state is stale; inspect and resolve a fresh scope before execution.');
      if (tool.descriptor.risk === 'mutating' && policy.approval !== true)
        throw Error('Mutating action requires caller approval.');
      permitted = true;
      this.assertProjectBound();
      if (this.abortController.signal.aborted)
        throw Error('Action was cancelled before native execution.');
      result = await tool.execute({
        projectDir: this.projectDir,
        project: this.project,
        state,
        action,
        inputs: parsed.inputs,
        signal: this.abortController.signal,
        ownerId: policy.ownerId,
      });
      if (typeof result.toolVersion === 'string' && result.toolVersion)
        action.toolVersion = result.toolVersion;
      artifacts = await this.collect(result, action);
      action.diagnostics = (result.diagnostics || []).map(String).slice(0, 40);
      const verifierId = tool.descriptor.verification[0];
      if (verifierId) {
        const assessed = await this.verifiers[verifierId]({
          result,
          artifacts,
          action,
          readArtifact: artifact => this.readContent(artifact),
        });
        verification = IndustrialVerificationResultSchema.parse({
          schemaVersion: '1',
          id: crypto.randomUUID(),
          verifierId,
          ...assessed,
          evidence: {
            artifactIds: artifacts.map(item => item.id),
            inputHashes: action.inputHashes,
          },
        });
      } else
        verification = {
          ...verification,
          status: 'not_run',
          reason: 'This tool has no declared engineering verifier.',
        };
      this.assertProjectBound();
      const after = await this.stateProvider({
        projectDir: this.projectDir,
        project: this.project,
      });
      if (tool.descriptor.effect !== 'inputs' && !sameInputs(after.inputHashes, action.inputHashes))
        verification = {
          ...verification,
          status: 'insufficient_evidence',
          reason:
            'Project inputs changed during execution; results do not establish the current state.',
        };
      action.status = result.executionSucceeded === true ? 'completed' : 'failed';
    } catch (error) {
      action.status = 'failed';
      action.diagnostics.push(String(error.message).slice(0, 4096));
      verification = this.recoveryVerification(
        String(error.message).slice(0, 4096),
        action.inputHashes,
      );
    }
    action = IndustrialActionRecordSchema.parse({
      ...action,
      endedAt: now(),
      artifactIds: artifacts.map(item => item.id),
      verification,
    });
    run = { ...run, endedAt: action.endedAt, status: action.status };
    let next = state;
    // Read-only host diagnostics are recorded as Actions/Checkpoints, but must
    // not replace a design's accepted state, artifacts or verification evidence.
    if (
      permitted &&
      tool.descriptor.risk === 'mutating' &&
      !['inputs', 'external'].includes(tool.descriptor.effect)
    )
      next = DomainStateSchema.parse({
        ...state,
        id: crypto.randomUUID(),
        createdAt: now(),
        status:
          verification.status === 'passed'
            ? 'verified'
            : verification.status === 'failed'
              ? 'failed'
              : 'unverified',
        artifacts,
        verificationIds: [verification.id],
      });
    // Input edits invalidate prior acceptance and retain its immutable evidence.
    // File integrity is not an engineering verifier for the resulting design.
    if (permitted && tool.descriptor.effect === 'inputs') next = await this.inspect();
    const checkpoint = this.transaction(() => {
      for (const artifact of artifacts) this.put('artifact', artifact.id, artifact);
      this.put('verification', verification.id, verification);
      this.put('action', action.id, action, true);
      this.put('run', run.id, run, true);
      this.put('state', next.id, next);
      this.setMetadata('head_state', next.id);
      return this.createCheckpoint(next, run, action);
    });
    // A second inspection makes concurrent input edits visibly stale immediately.
    next = await this.inspect();
    const presentation = bindPresentation(result, action, artifacts, this.projectDir);
    this.put('presentation', action.id, presentation);
    return {
      presentation,
      run,
      action,
      artifacts,
      verification,
      state: next,
      checkpoint: next.id === checkpoint.state.id ? checkpoint : this.latestCheckpoint(),
    };
  }
  readContent(artifact) {
    const file = path.join(this.blobDirectory, artifact.sha256);
    const content = fs.readFileSync(file);
    if (digest(content) !== artifact.sha256 || content.length !== artifact.sizeBytes)
      throw Error('Artifact content is missing or corrupted.');
    return content;
  }
  readArtifact(id) {
    const artifact = this.get('artifact', id);
    if (!artifact) throw Error('Artifact does not belong to this project.');
    return { artifact, content: this.readContent(artifact) };
  }
  listRuns() {
    return this.list('run');
  }
  listActions() {
    return this.list('action');
  }
  listVerifications() {
    return this.list('verification');
  }
  listCheckpoints() {
    return this.list('checkpoint');
  }
  latestCheckpoint() {
    return this.get('checkpoint', this.metadata('head_checkpoint'));
  }
  close() {
    if (this.executing) throw Error('Cannot close a runtime during an active action.');
    if (this.db) this.db.prepare('DELETE FROM core_metadata WHERE key=?').run('owner_pid');
    this.db?.close();
    this.db = null;
    activeStores.delete(this.file);
    return (this.disposing ??= Promise.resolve().then(() => this.dispose()));
  }
}

module.exports = { IndustrialRuntime };
