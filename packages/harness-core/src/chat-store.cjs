const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const {DatabaseSync} = require('node:sqlite');

function defaultChatDirectory(environment = process.env) {return environment.INDUSTRIAL_HARNESS_CHAT_DIR || path.join(os.homedir(), '.industrial-agent-harness', 'chats');}
function alive(pid) {try {process.kill(pid, 0); return true;} catch (error) {return error.code === 'EPERM';}}
const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);

// Product history and opaque adapter identities. Model context remains owned by the agent runtime.
class ChatStore {
  constructor(directory = defaultChatDirectory()) {
    fs.mkdirSync(directory, {recursive: true, mode: 0o700});
    this.directory = fs.realpathSync(directory);
    fs.chmodSync(this.directory, 0o700);
    const file = path.join(this.directory, 'chats.sqlite');
    if (fs.existsSync(file) && fs.lstatSync(file).isSymbolicLink()) throw Error('Chat database cannot be a symbolic link.');
    this.db = new DatabaseSync(file);
    fs.chmodSync(file, 0o600);
    const version = this.db.prepare('PRAGMA user_version').get().user_version;
    if (version > 1) {this.close(); throw Error('Chat database has a newer schema.');}
    this.db.exec(`PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS chats (id TEXT PRIMARY KEY, project_key TEXT NOT NULL, project_path TEXT NOT NULL, domain TEXT NOT NULL, title TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, archived INTEGER NOT NULL DEFAULT 0);
      CREATE INDEX IF NOT EXISTS chat_project ON chats(project_key, updated_at);
      CREATE TABLE IF NOT EXISTS runtime_sessions (id TEXT PRIMARY KEY, chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE, compatibility_key TEXT NOT NULL, initialized INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS execution_locks (chat_id TEXT PRIMARY KEY REFERENCES chats(id) ON DELETE CASCADE, owner_pid INTEGER NOT NULL, token TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS turns (id TEXT PRIMARY KEY, chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE, task TEXT NOT NULL, broker_json TEXT, status TEXT NOT NULL, owner_pid INTEGER, created_at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS chat_turns ON turns(chat_id);
      CREATE TABLE IF NOT EXISTS chat_events (turn_id TEXT NOT NULL REFERENCES turns(id) ON DELETE CASCADE, sequence INTEGER NOT NULL, type TEXT NOT NULL, event_json TEXT NOT NULL, PRIMARY KEY(turn_id, sequence));`);
    if (!version) this.db.exec('PRAGMA user_version = 1');
    this.recoverInterrupted();
  }
  project(projectDir, domain) {
    const projectPath = fs.realpathSync(projectDir);
    if (!fs.statSync(projectPath).isDirectory() || typeof domain !== 'string' || !domain) throw Error('Choose a project with a domain.');
    return {projectPath, key: crypto.createHash('sha256').update(`${projectPath}\0${domain}`).digest('hex')};
  }
  create(projectDir, domain) {
    const {projectPath, key} = this.project(projectDir, domain);
    const id = crypto.randomUUID(), now = new Date().toISOString();
    this.db.prepare('INSERT INTO chats (id, project_key, project_path, domain, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(id, key, projectPath, domain, 'New chat', now, now);
    return this.get(id, projectDir, domain);
  }
  createDraft(projectDir, domain, preferredId = null) {
    const {key} = this.project(projectDir, domain);
    // Serialize lookup + insert across windows; a title is not evidence of emptiness.
    return this.transaction(() => {
      const draft = this.db.prepare(`SELECT id FROM chats
        WHERE project_key = ? AND archived = 0
          AND NOT EXISTS (SELECT 1 FROM turns WHERE chat_id = chats.id)
          AND NOT EXISTS (SELECT 1 FROM execution_locks WHERE chat_id = chats.id)
        ORDER BY CASE WHEN id = ? THEN 0 ELSE 1 END, updated_at DESC, rowid DESC LIMIT 1`).get(key, preferredId);
      return draft ? this.get(draft.id, projectDir, domain) : this.create(projectDir, domain);
    });
  }
  get(id, projectDir, domain) {
    if (!uuid(id)) throw Error('Invalid chat ID.');
    const row = this.db.prepare('SELECT * FROM chats WHERE id = ? AND project_key = ?').get(id, this.project(projectDir, domain).key);
    if (!row) throw Error('Chat is unavailable for this project and domain.');
    return {id: row.id, title: row.title, domain: row.domain, createdAt: row.created_at, updatedAt: row.updated_at, archived: Boolean(row.archived)};
  }
  list(projectDir, domain) {
    return this.db.prepare('SELECT id, title, domain, created_at, updated_at FROM chats WHERE project_key = ? AND archived = 0 ORDER BY updated_at DESC, rowid DESC LIMIT 200').all(this.project(projectDir, domain).key)
      .map(row => ({id: row.id, title: row.title, domain: row.domain, createdAt: row.created_at, updatedAt: row.updated_at, archived: false}));
  }
  transaction(fn) {this.db.exec('BEGIN IMMEDIATE'); try {const result = fn(); this.db.exec('COMMIT'); return result;} catch (error) {this.db.exec('ROLLBACK'); throw error;}}
  beginTurn(chatId, task, broker = null, running = true) {
    if (typeof task !== 'string' || !task.trim() || Buffer.byteLength(task) > 1024 * 1024) throw Error('Enter a task of at most 1 MiB.');
    return this.transaction(() => {
      if (this.db.prepare("SELECT id FROM turns WHERE chat_id = ? AND status = 'running'").get(chatId)) throw Error('This chat is already running.');
      const id = crypto.randomUUID(), now = new Date().toISOString();
      this.db.prepare('INSERT INTO turns (id, chat_id, task, broker_json, status, owner_pid, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(id, chatId, task, broker ? JSON.stringify(broker) : null, running ? 'running' : 'scoped', running ? process.pid : null, now);
      this.db.prepare("UPDATE chats SET title = CASE WHEN title = 'New chat' THEN ? ELSE title END, updated_at = ? WHERE id = ?").run(task.trim().slice(0, 100), now, chatId);
      return id;
    });
  }
  append(turnId, event) {
    // Collapse streamed chunks for a bounded read model; raw events remain in diagnostic JSONL.
    this.transaction(() => {
      if (!this.db.prepare('SELECT id FROM turns WHERE id = ?').get(turnId)) throw Error('Unknown chat turn.');
      if (event.type === 'text' || event.type === 'thinking') {
        const previous = this.db.prepare("SELECT sequence, type, event_json FROM chat_events WHERE turn_id = ? AND type NOT IN ('status', 'step') ORDER BY sequence DESC LIMIT 1").get(turnId);
        if (previous?.type === event.type) {
          const value = JSON.parse(previous.event_json); value.text += event.text;
          this.db.prepare('UPDATE chat_events SET event_json = ? WHERE turn_id = ? AND sequence = ?').run(JSON.stringify(value), turnId, previous.sequence);
          return;
        }
      }
      const sequence = this.db.prepare('SELECT COALESCE(MAX(sequence), 0) + 1 AS next FROM chat_events WHERE turn_id = ?').get(turnId).next;
      this.db.prepare('INSERT INTO chat_events VALUES (?, ?, ?, ?)').run(turnId, sequence, event.type, JSON.stringify(event));
    });
  }
  finish(turnId, status) {this.db.prepare('UPDATE turns SET status = ?, owner_pid = NULL WHERE id = ?').run(status, turnId);}
  recoverInterrupted() {
    const candidates = this.db.prepare("SELECT id, owner_pid FROM turns WHERE status = 'running'").all();
    for (const row of candidates) {
      if (row.owner_pid && alive(row.owner_pid)) continue;
      this.transaction(() => {
        if (this.db.prepare('SELECT status FROM turns WHERE id = ?').get(row.id)?.status !== 'running') return;
        const sequence = this.db.prepare('SELECT COALESCE(MAX(sequence), 0) + 1 AS next FROM chat_events WHERE turn_id = ?').get(row.id).next;
        const event = {type: 'error', message: 'The previous turn was interrupted when the app or process stopped. Send a new message to continue.'};
        this.db.prepare('INSERT INTO chat_events VALUES (?, ?, ?, ?)').run(row.id, sequence, event.type, JSON.stringify(event));
        this.finish(row.id, 'interrupted');
      });
    }
  }
  history(chatId, projectDir, domain, before = null, limit = 10) {
    const chat = this.get(chatId, projectDir, domain);
    this.recoverInterrupted();
    if (!Number.isInteger(limit) || limit < 1 || limit > 20 || (before !== null && !uuid(before))) throw Error('Invalid history page.');
    const boundary = before ? this.db.prepare('SELECT rowid AS position FROM turns WHERE id = ? AND chat_id = ?').get(before, chatId)?.position : Number.MAX_SAFE_INTEGER;
    if (!boundary) throw Error('History cursor is unavailable for this chat.');
    const rows = this.db.prepare('SELECT rowid AS position, * FROM turns WHERE chat_id = ? AND rowid < ? ORDER BY rowid DESC LIMIT ?').all(chatId, boundary, limit + 1);
    const hasMore = rows.length > limit;
    const turns = rows.slice(0, limit).reverse().map(row => ({id: row.id, task: row.task, broker: row.broker_json ? JSON.parse(row.broker_json) : null, status: row.status, createdAt: row.created_at, events: this.db.prepare('SELECT event_json FROM chat_events WHERE turn_id = ? ORDER BY sequence').all(row.id).map(item => JSON.parse(item.event_json))}));
    return {chat, turns, hasMore, before: turns[0]?.id || null};
  }
  runtimeSession(chatId, compatibilityKey) {
    if (!uuid(chatId) || !this.db.prepare('SELECT id FROM chats WHERE id = ?').get(chatId)) throw Error('Unknown chat.');
    const latest = this.db.prepare('SELECT * FROM runtime_sessions WHERE chat_id = ? ORDER BY rowid DESC LIMIT 1').get(chatId);
    if (latest?.compatibility_key === compatibilityKey) return {id: latest.id, shareDir: this.sessionDirectory(latest.id), initialized: Boolean(latest.initialized), reused: true, replaced: false};
    const id = crypto.randomUUID();
    this.db.prepare('INSERT INTO runtime_sessions (id, chat_id, compatibility_key, created_at) VALUES (?, ?, ?, ?)').run(id, chatId, compatibilityKey, new Date().toISOString());
    return {id, shareDir: this.sessionDirectory(id), initialized: false, reused: false, replaced: Boolean(latest)};
  }
  initialized(id) {this.db.prepare('UPDATE runtime_sessions SET initialized = 1 WHERE id = ?').run(id);}
  sessionDirectory(id) {
    if (!uuid(id)) throw Error('Invalid runtime session ID.');
    const directory = path.join(this.directory, 'sessions', id);
    fs.mkdirSync(directory, {recursive: true, mode: 0o700});
    if (fs.realpathSync(directory) !== directory) throw Error('Runtime session directory cannot be a symbolic link.');
    fs.chmodSync(directory, 0o700);
    return directory;
  }
  updateBroker(turnId, broker) {this.db.prepare("UPDATE turns SET broker_json = ? WHERE id = ? AND status = 'scoped'").run(JSON.stringify(broker), turnId);}
  start(turnId) {
    this.transaction(() => {
      const row = this.db.prepare('SELECT chat_id, status FROM turns WHERE id = ?').get(turnId);
      if (!row || row.status !== 'scoped') throw Error('This turn has already been submitted.');
      if (this.db.prepare("SELECT id FROM turns WHERE chat_id = ? AND status = 'running'").get(row.chat_id)) throw Error('This chat is already running.');
      this.db.prepare("UPDATE turns SET status = 'running', owner_pid = ? WHERE id = ?").run(process.pid, turnId);
    });
  }
  acquire(chatId) {
    const token = crypto.randomUUID();
    this.transaction(() => {
      const lock = this.db.prepare('SELECT owner_pid FROM execution_locks WHERE chat_id = ?').get(chatId);
      if (lock && alive(lock.owner_pid)) throw Error('This chat is already open for execution in another process.');
      this.db.prepare('INSERT OR REPLACE INTO execution_locks VALUES (?, ?, ?)').run(chatId, process.pid, token);
    });
    return () => {if (this.db) this.db.prepare('DELETE FROM execution_locks WHERE chat_id = ? AND token = ?').run(chatId, token);};
  }
  remove(chatId, projectDir, domain) {
    this.get(chatId, projectDir, domain);
    const release = this.acquire(chatId);
    try {
      const sessions = this.db.prepare('SELECT id FROM runtime_sessions WHERE chat_id = ?').all(chatId);
      this.db.prepare('DELETE FROM chats WHERE id = ?').run(chatId);
      for (const session of sessions) fs.rmSync(this.sessionDirectory(session.id), {recursive: true, force: true});
    } finally {release();}
  }
  close() {this.db?.close(); this.db = undefined;}
}
module.exports = {ChatStore, defaultChatDirectory};
