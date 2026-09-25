const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {DatabaseSync} = require('node:sqlite');
const {ObservedArtifactSchema, ObservedStateSchema, ContextCheckpointSchema} = require('@industrial-agent-harness/contracts');

function defaultStateDirectory() {return path.join(os.homedir(), '.industrial-agent-harness', 'state');}

async function fileDigest(file) {
  const hash = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

class ObservedContextStore {
  constructor(projectDir, domain, {directory = defaultStateDirectory()} = {}) {
    this.projectDir = fs.realpathSync(projectDir);
    if (!fs.statSync(this.projectDir).isDirectory()) throw Error('Project path must be a directory.');
    if (typeof domain !== 'string' || !domain) throw Error('Project domain is required.');
    this.domain = domain;
    this.projectId = crypto.createHash('sha256').update(`${this.projectDir}\0${domain}`).digest('hex');
    fs.mkdirSync(directory, {recursive: true, mode: 0o700});
    fs.chmodSync(directory, 0o700);
    this.file = path.join(directory, `${this.projectId}.sqlite`);
    try {fs.closeSync(fs.openSync(this.file, 'wx', 0o600));} catch (error) {if (error.code !== 'EEXIST') throw error;}
    fs.chmodSync(this.file, 0o600);
    this.db = new DatabaseSync(this.file);
    this.db.exec(`PRAGMA busy_timeout = 5000;
      PRAGMA foreign_keys = ON;
      CREATE TABLE IF NOT EXISTS projects (id TEXT PRIMARY KEY, path TEXT NOT NULL, domain TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS artifacts (project_id TEXT NOT NULL, id TEXT NOT NULL, kind TEXT NOT NULL, relative_path TEXT NOT NULL, size_bytes INTEGER NOT NULL, sha256 TEXT NOT NULL, recorded_at TEXT NOT NULL, PRIMARY KEY (project_id, id), FOREIGN KEY (project_id) REFERENCES projects(id));
      CREATE TABLE IF NOT EXISTS checkpoints (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, parent_id TEXT, state_hash TEXT NOT NULL, state_json TEXT NOT NULL, created_at TEXT NOT NULL, FOREIGN KEY (project_id) REFERENCES projects(id));`);
    const schemaVersion = this.db.prepare('PRAGMA user_version').get().user_version;
    if (schemaVersion > 1) {this.close(); throw Error('Observed-context database has a newer schema.');}
    if (schemaVersion === 0) this.db.exec('PRAGMA user_version = 1');
    this.db.prepare('INSERT OR IGNORE INTO projects (id, path, domain) VALUES (?, ?, ?)').run(this.projectId, this.projectDir, domain);
    const existing = this.db.prepare('SELECT path, domain FROM projects WHERE id = ?').get(this.projectId);
    if (existing.path !== this.projectDir || existing.domain !== domain) {this.close(); throw Error('Stored project identity or domain differs from this project.');}
  }

  projectFile(relativeOrAbsolute) {
    const file = fs.realpathSync(path.resolve(this.projectDir, relativeOrAbsolute));
    const relativePath = path.relative(this.projectDir, file);
    if (!relativePath || relativePath === '..' || relativePath.startsWith(`..${path.sep}`) || path.isAbsolute(relativePath) || !fs.statSync(file).isFile()) throw Error('Artifact must be a file inside the project.');
    return {file, relativePath};
  }

  async observeArtifact({id, kind, file}) {
    if (typeof id !== 'string' || !id || typeof kind !== 'string' || !kind) throw Error('Artifact id and kind are required.');
    const resolved = this.projectFile(file);
    const stat = fs.statSync(resolved.file);
    const artifact = ObservedArtifactSchema.parse({id, kind, relativePath: resolved.relativePath, sizeBytes: stat.size, sha256: await fileDigest(resolved.file), source: 'project-file', verificationStatus: 'not_run'});
    this.db.prepare(`INSERT INTO artifacts (project_id, id, kind, relative_path, size_bytes, sha256, recorded_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(project_id, id) DO UPDATE SET kind=excluded.kind, relative_path=excluded.relative_path, size_bytes=excluded.size_bytes, sha256=excluded.sha256, recorded_at=excluded.recorded_at`)
      .run(this.projectId, id, kind, artifact.relativePath, artifact.sizeBytes, artifact.sha256, new Date().toISOString());
    return artifact;
  }

  async readArtifact(id) {
    const row = this.db.prepare('SELECT id, kind, relative_path, size_bytes, sha256 FROM artifacts WHERE project_id = ? AND id = ?').get(this.projectId, id);
    if (!row) throw Error('Artifact is unavailable.');
    let resolved;
    try {resolved = this.projectFile(row.relative_path);} catch {throw Error('Artifact is unavailable or changed.');}
    if (resolved.relativePath !== row.relative_path || await fileDigest(resolved.file) !== row.sha256) throw Error('Artifact is unavailable or changed.');
    return {id: row.id, kind: row.kind, name: path.basename(resolved.file), relativePath: row.relative_path, sizeBytes: row.size_bytes, sha256: row.sha256};
  }

  async currentState() {
    const rows = this.db.prepare('SELECT id, kind, relative_path, size_bytes, sha256 FROM artifacts WHERE project_id = ? ORDER BY id').all(this.projectId);
    const artifacts = [];
    const staleArtifactIds = [];
    for (const row of rows) {
      try {
        const resolved = this.projectFile(row.relative_path);
        if (resolved.relativePath !== row.relative_path || await fileDigest(resolved.file) !== row.sha256) throw Error('Changed');
        artifacts.push(ObservedArtifactSchema.parse({id: row.id, kind: row.kind, relativePath: row.relative_path, sizeBytes: row.size_bytes, sha256: row.sha256, source: 'project-file', verificationStatus: 'not_run'}));
      } catch {staleArtifactIds.push(row.id);}
    }
    return ObservedStateSchema.parse({projectId: this.projectId, domain: this.domain, artifacts, staleArtifactIds});
  }

  async checkpoint() {
    const state = await this.currentState();
    const stateJson = JSON.stringify(state);
    const stateHash = crypto.createHash('sha256').update(stateJson).digest('hex');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const previous = this.db.prepare('SELECT id, state_hash, created_at, parent_id FROM checkpoints WHERE project_id = ? ORDER BY rowid DESC LIMIT 1').get(this.projectId);
      if (previous?.state_hash === stateHash) {
        const unchanged = ContextCheckpointSchema.parse({id: previous.id, parentId: previous.parent_id, stateHash, createdAt: previous.created_at, state});
        this.db.exec('COMMIT');
        return unchanged;
      }
      const checkpoint = ContextCheckpointSchema.parse({id: crypto.randomUUID(), parentId: previous?.id || null, stateHash, createdAt: new Date().toISOString(), state});
      this.db.prepare('INSERT INTO checkpoints (id, project_id, parent_id, state_hash, state_json, created_at) VALUES (?, ?, ?, ?, ?, ?)')
        .run(checkpoint.id, this.projectId, checkpoint.parentId, stateHash, stateJson, checkpoint.createdAt);
      this.db.exec('COMMIT');
      return checkpoint;
    } catch (error) {this.db.exec('ROLLBACK'); throw error;}
  }

  async anchor() {
    const checkpoint = await this.checkpoint();
    return {checkpointId: checkpoint.id, stateHash: checkpoint.stateHash, domain: checkpoint.state.domain, artifactCount: checkpoint.state.artifacts.length, staleArtifactCount: checkpoint.state.staleArtifactIds.length, staleArtifactIds: checkpoint.state.staleArtifactIds.slice(0, 12), artifacts: checkpoint.state.artifacts.slice(0, 12), hasMore: checkpoint.state.artifacts.length > 12 || checkpoint.state.staleArtifactIds.length > 12, verificationStatus: 'not_run'};
  }

  readPage(checkpointId, offset = 0, limit = 12) {
    if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 20) throw Error('Use offset >= 0 and limit between 1 and 20.');
    const row = this.db.prepare('SELECT state_hash, state_json FROM checkpoints WHERE project_id = ? AND id = ?').get(this.projectId, checkpointId);
    if (!row) throw Error('Checkpoint is unavailable for this project.');
    const state = ObservedStateSchema.parse(JSON.parse(row.state_json));
    return {checkpointId, stateHash: row.state_hash, offset, total: state.artifacts.length, artifacts: state.artifacts.slice(offset, offset + limit), totalStale: state.staleArtifactIds.length, staleArtifactIds: state.staleArtifactIds.slice(offset, offset + limit), verificationStatus: 'not_run', observation: 'historical'};
  }

  close() {this.db?.close(); this.db = undefined;}
}

module.exports = {ObservedContextStore, defaultStateDirectory};
