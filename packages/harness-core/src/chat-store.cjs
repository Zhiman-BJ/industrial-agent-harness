const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

function defaultChatDirectory(environment = process.env) {
  return (
    environment.INDUSTRIAL_HARNESS_CHAT_DIR ||
    path.join(os.homedir(), '.industrial-agent-harness', 'chats')
  );
}
function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}
const uuid = value =>
  typeof value === 'string' &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);

const CHAT_TITLE_MAX = 100;
const AUTO_TITLE_LENGTH = 48;
// Concise sidebar label: first non-empty line, collapsed whitespace, capped on a
// word boundary so neither CJK nor space-separated text is cut mid-word.
function deriveChatTitle(task) {
  const line =
    String(task)
      .split(/\r?\n/)
      .find(part => part.trim())
      ?.trim() || '';
  const collapsed = line.replace(/\s+/g, ' ');
  const chars = [...collapsed];
  if (chars.length <= AUTO_TITLE_LENGTH) return collapsed;
  let cut = chars.slice(0, AUTO_TITLE_LENGTH).join('');
  const lastSpace = cut.lastIndexOf(' ');
  if (lastSpace >= AUTO_TITLE_LENGTH / 2) cut = cut.slice(0, lastSpace);
  return `${cut.trimEnd()}…`;
}
function cleanChatTitle(title) {
  const value = typeof title === 'string' ? title.replace(/\s+/g, ' ').trim() : '';
  if (!value || [...value].length > CHAT_TITLE_MAX)
    throw Error(`Enter a chat title of at most ${CHAT_TITLE_MAX} characters.`);
  return value;
}

// Product history and opaque adapter identities. Model context remains owned by the agent runtime.
class ChatStore {
  constructor(directory = defaultChatDirectory()) {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    this.directory = fs.realpathSync(directory);
    fs.chmodSync(this.directory, 0o700);
    const file = path.join(this.directory, 'chats.sqlite');
    if (fs.existsSync(file) && fs.lstatSync(file).isSymbolicLink())
      throw Error('Chat database cannot be a symbolic link.');
    this.db = new DatabaseSync(file);
    this.statements = new Map();
    fs.chmodSync(file, 0o600);
    const version = this.statement('PRAGMA user_version').get().user_version;
    if (version > 2) {
      this.close();
      throw Error('Chat database has a newer schema.');
    }
    this.db.exec(`PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS chats (id TEXT PRIMARY KEY, project_key TEXT NOT NULL, project_path TEXT NOT NULL, domain TEXT NOT NULL, title TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, archived INTEGER NOT NULL DEFAULT 0);
      CREATE INDEX IF NOT EXISTS chat_project ON chats(project_key, updated_at);
      CREATE TABLE IF NOT EXISTS runtime_sessions (id TEXT PRIMARY KEY, chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE, compatibility_key TEXT NOT NULL, initialized INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS execution_locks (chat_id TEXT PRIMARY KEY REFERENCES chats(id) ON DELETE CASCADE, owner_pid INTEGER NOT NULL, token TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS turns (id TEXT PRIMARY KEY, chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE, task TEXT NOT NULL, broker_json TEXT, status TEXT NOT NULL, owner_pid INTEGER, created_at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS chat_turns ON turns(chat_id);
      CREATE INDEX IF NOT EXISTS running_turns ON turns(chat_id) WHERE status = 'running';
      CREATE INDEX IF NOT EXISTS chat_runtime_sessions ON runtime_sessions(chat_id);
      CREATE TABLE IF NOT EXISTS chat_preferences (chat_id TEXT PRIMARY KEY REFERENCES chats(id) ON DELETE CASCADE, approval_mode TEXT NOT NULL CHECK(approval_mode IN ('ask', 'auto')));
      CREATE TABLE IF NOT EXISTS chat_events (turn_id TEXT NOT NULL REFERENCES turns(id) ON DELETE CASCADE, sequence INTEGER NOT NULL, type TEXT NOT NULL, event_json TEXT NOT NULL, PRIMARY KEY(turn_id, sequence));`);
    if (version < 2) {
      // Schema 2: explicit custom-title marker (Kimi's isCustomTitle equivalent).
      // Title equality with the derived title is only a heuristic; a user who
      // renames a chat to that same text must still be protected.
      this.db.exec('ALTER TABLE chats ADD COLUMN custom_title INTEGER NOT NULL DEFAULT 0');
      this.db.exec('PRAGMA user_version = 2');
    }
    this.recoverInterrupted();
  }
  statement(sql) {
    let statement = this.statements.get(sql);
    if (!statement) {
      statement = this.db.prepare(sql);
      this.statements.set(sql, statement);
    }
    return statement;
  }
  project(projectDir, domain) {
    const projectPath = fs.realpathSync(projectDir);
    if (!fs.statSync(projectPath).isDirectory() || typeof domain !== 'string' || !domain)
      throw Error('Choose a project with a domain.');
    return {
      projectPath,
      key: crypto.createHash('sha256').update(`${projectPath}\0${domain}`).digest('hex'),
    };
  }
  create(projectDir, domain) {
    const { projectPath, key } = this.project(projectDir, domain);
    const id = crypto.randomUUID(),
      now = new Date().toISOString();
    this.statement(
      'INSERT INTO chats (id, project_key, project_path, domain, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).run(id, key, projectPath, domain, 'New chat', now, now);
    return this.get(id, projectDir, domain);
  }
  createDraft(projectDir, domain, preferredId = null) {
    const { key } = this.project(projectDir, domain);
    // Serialize lookup + insert across windows; a title is not evidence of emptiness.
    return this.transaction(() => {
      const draft = this.statement(
        `SELECT id FROM chats
        WHERE project_key = ? AND archived = 0
          AND NOT EXISTS (SELECT 1 FROM turns WHERE chat_id = chats.id)
          AND NOT EXISTS (SELECT 1 FROM execution_locks WHERE chat_id = chats.id)
        ORDER BY CASE WHEN id = ? THEN 0 ELSE 1 END, updated_at DESC, rowid DESC LIMIT 1`,
      ).get(key, preferredId);
      return draft ? this.get(draft.id, projectDir, domain) : this.create(projectDir, domain);
    });
  }
  get(id, projectDir, domain) {
    if (!uuid(id)) throw Error('Invalid chat ID.');
    const row = this.statement('SELECT * FROM chats WHERE id = ? AND project_key = ?').get(
      id,
      this.project(projectDir, domain).key,
    );
    if (!row) throw Error('Chat is unavailable for this project and domain.');
    return {
      id: row.id,
      title: row.title,
      domain: row.domain,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      archived: Boolean(row.archived),
      approvalMode: this.approvalMode(id),
    };
  }
  list(projectDir, domain) {
    return this.statement(
      'SELECT id, title, domain, created_at, updated_at FROM chats WHERE project_key = ? AND archived = 0 ORDER BY updated_at DESC, rowid DESC LIMIT 200',
    )
      .all(this.project(projectDir, domain).key)
      .map(row => ({
        id: row.id,
        title: row.title,
        domain: row.domain,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        archived: false,
        approvalMode: this.approvalMode(row.id),
      }));
  }
  approvalMode(chatId) {
    return (
      this.statement('SELECT approval_mode FROM chat_preferences WHERE chat_id = ?').get(chatId)
        ?.approval_mode || 'ask'
    );
  }
  setApprovalMode(chatId, projectDir, domain, mode) {
    this.get(chatId, projectDir, domain);
    if (!['ask', 'auto'].includes(mode)) throw Error('Invalid approval mode.');
    return this.transaction(() => {
      const lock = this.statement('SELECT owner_pid FROM execution_locks WHERE chat_id = ?').get(
        chatId,
      );
      if (
        (lock && alive(lock.owner_pid)) ||
        this.statement("SELECT id FROM turns WHERE chat_id = ? AND status = 'running'").get(chatId)
      )
        throw Error('Stop this chat before changing approval mode.');
      this.statement(
        'INSERT INTO chat_preferences (chat_id, approval_mode) VALUES (?, ?) ON CONFLICT(chat_id) DO UPDATE SET approval_mode = excluded.approval_mode',
      ).run(chatId, mode);
      return mode;
    });
  }
  rename(chatId, projectDir, domain, title) {
    this.get(chatId, projectDir, domain);
    const value = cleanChatTitle(title);
    // A rename is display metadata only; it must not reorder the list. The
    // explicit flag — not the title text — is what protects it from auto titles.
    this.statement('UPDATE chats SET title = ?, custom_title = 1 WHERE id = ?').run(value, chatId);
    return this.get(chatId, projectDir, domain);
  }
  // Auto-title eligibility: a single-turn chat whose title was never user-set.
  // The custom_title flag is authoritative; the derived-text comparison stays as
  // defense in depth for rows written before the flag existed.
  autoTitleEligible(chatId) {
    const row = this.statement(
      'SELECT title, custom_title AS custom FROM chats WHERE id = ?',
    ).get(chatId);
    const first = this.statement(
      'SELECT task FROM turns WHERE chat_id = ? ORDER BY rowid LIMIT 1',
    ).get(chatId);
    const count = this.statement('SELECT COUNT(*) AS n FROM turns WHERE chat_id = ?').get(
      chatId,
    ).n;
    if (!row || row.custom || !first || count !== 1 || row.title !== deriveChatTitle(first.task))
      return null;
    return { task: first.task };
  }
  // Eligibility probe for a model-generated title. Checked before asking the
  // model so ineligible chats never trigger a request; autoTitle re-checks
  // atomically before writing.
  autoTitleTarget(chatId) {
    if (!uuid(chatId)) return null;
    return this.autoTitleEligible(chatId);
  }
  // Best-effort model-generated title: never overwrites a user rename.
  autoTitle(chatId, title) {
    if (!uuid(chatId)) return false;
    let value;
    try {
      value = cleanChatTitle(title);
    } catch {
      return false;
    }
    return this.transaction(() => {
      if (!this.autoTitleEligible(chatId)) return false;
      this.statement('UPDATE chats SET title = ? WHERE id = ?').run(value, chatId);
      return true;
    });
  }
  transaction(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
  beginTurn(chatId, task, broker = null, running = true) {
    if (typeof task !== 'string' || !task.trim() || Buffer.byteLength(task) > 1024 * 1024)
      throw Error('Enter a task of at most 1 MiB.');
    return this.transaction(() => {
      if (
        this.statement("SELECT id FROM turns WHERE chat_id = ? AND status = 'running'").get(chatId)
      )
        throw Error('This chat is already running.');
      const id = crypto.randomUUID(),
        now = new Date().toISOString();
      this.statement(
        'INSERT INTO turns (id, chat_id, task, broker_json, status, owner_pid, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      ).run(
        id,
        chatId,
        task,
        broker ? JSON.stringify(broker) : null,
        running ? 'running' : 'scoped',
        running ? process.pid : null,
        now,
      );
      this.statement(
        "UPDATE chats SET title = CASE WHEN title = 'New chat' THEN ? ELSE title END, updated_at = ? WHERE id = ?",
      ).run(deriveChatTitle(task), now, chatId);
      return id;
    });
  }
  append(turnId, event) {
    let recorded = { ...event, recordedAt: new Date().toISOString() };
    // The lookup and write share the same lock, including across processes.
    this.transaction(() => {
      if (event.eventId) {
        const prior = this.statement(
          "SELECT event_json FROM chat_events WHERE turn_id = ? AND json_extract(event_json, '$.eventId') = ?",
        ).get(turnId, event.eventId);
        if (prior) {
          recorded = JSON.parse(prior.event_json);
          return;
        }
      }
      // Collapse streamed chunks; raw events remain in diagnostic JSONL.
      if (!this.statement('SELECT id FROM turns WHERE id = ?').get(turnId))
        throw Error('Unknown chat turn.');
      if (event.type === 'text' || event.type === 'thinking') {
        const previous = this.statement(
          "SELECT sequence, type, event_json FROM chat_events WHERE turn_id = ? AND type NOT IN ('status', 'step') ORDER BY sequence DESC LIMIT 1",
        ).get(turnId);
        if (previous?.type === event.type) {
          const value = JSON.parse(previous.event_json);
          value.text += event.text;
          this.statement(
            'UPDATE chat_events SET event_json = ? WHERE turn_id = ? AND sequence = ?',
          ).run(JSON.stringify(value), turnId, previous.sequence);
          return;
        }
      }
      const sequence = this.statement(
        'SELECT COALESCE(MAX(sequence), 0) + 1 AS next FROM chat_events WHERE turn_id = ?',
      ).get(turnId).next;
      this.statement('INSERT INTO chat_events VALUES (?, ?, ?, ?)').run(
        turnId,
        sequence,
        event.type,
        JSON.stringify(recorded),
      );
    });
    return recorded;
  }
  latestEvents(chatId, type) {
    return this.statement(
      `SELECT e.event_json FROM chat_events e JOIN turns t ON t.id=e.turn_id
      WHERE t.chat_id=? AND e.type=? AND e.sequence=(SELECT MAX(last.sequence) FROM chat_events last WHERE last.turn_id=e.turn_id AND last.type=e.type)
      ORDER BY t.rowid`,
    )
      .all(chatId, type)
      .map(row => JSON.parse(row.event_json));
  }
  turnEvents(chatId, turnId) {
    if (!this.turnBelongsTo(chatId, turnId)) throw Error('Request belongs to another chat.');
    return this.statement('SELECT event_json FROM chat_events WHERE turn_id=? ORDER BY sequence')
      .all(turnId)
      .map(row => JSON.parse(row.event_json));
  }
  turnBelongsTo(chatId, turnId) {
    return Boolean(
      this.statement('SELECT id FROM turns WHERE id=? AND chat_id=?').get(turnId, chatId),
    );
  }
  finish(turnId, status) {
    this.statement('UPDATE turns SET status = ?, owner_pid = NULL WHERE id = ?').run(
      status,
      turnId,
    );
  }
  recoverInterrupted() {
    const candidates = this.statement(
      "SELECT id, owner_pid FROM turns WHERE status = 'running'",
    ).all();
    for (const row of candidates) {
      if (row.owner_pid && alive(row.owner_pid)) continue;
      this.transaction(() => {
        if (
          this.statement('SELECT status FROM turns WHERE id = ?').get(row.id)?.status !== 'running'
        )
          return;
        const sequence = this.statement(
          'SELECT COALESCE(MAX(sequence), 0) + 1 AS next FROM chat_events WHERE turn_id = ?',
        ).get(row.id).next;
        const event = {
          type: 'error',
          message:
            'The previous turn was interrupted when the app or process stopped. Send a new message to continue.',
        };
        this.statement('INSERT INTO chat_events VALUES (?, ?, ?, ?)').run(
          row.id,
          sequence,
          event.type,
          JSON.stringify(event),
        );
        this.finish(row.id, 'interrupted');
      });
    }
  }
  history(chatId, projectDir, domain, before = null, limit = 10) {
    const chat = this.get(chatId, projectDir, domain);
    this.recoverInterrupted();
    if (!Number.isInteger(limit) || limit < 1 || limit > 20 || (before !== null && !uuid(before)))
      throw Error('Invalid history page.');
    const boundary = before
      ? this.statement('SELECT rowid AS position FROM turns WHERE id = ? AND chat_id = ?').get(
          before,
          chatId,
        )?.position
      : Number.MAX_SAFE_INTEGER;
    if (!boundary) throw Error('History cursor is unavailable for this chat.');
    const rows = this.statement(
      'SELECT rowid AS position, * FROM turns WHERE chat_id = ? AND rowid < ? ORDER BY rowid DESC LIMIT ?',
    ).all(chatId, boundary, limit + 1);
    const hasMore = rows.length > limit;
    const turns = rows
      .slice(0, limit)
      .reverse()
      .map(row => ({
        id: row.id,
        task: row.task,
        broker: row.broker_json ? JSON.parse(row.broker_json) : null,
        status: row.status,
        createdAt: row.created_at,
        events: this.statement(
          'SELECT event_json FROM chat_events WHERE turn_id = ? ORDER BY sequence',
        )
          .all(row.id)
          .map(item => JSON.parse(item.event_json)),
      }));
    return { chat, turns, hasMore, before: turns[0]?.id || null };
  }
  runtimeSession(chatId, compatibilityKey) {
    if (!uuid(chatId) || !this.statement('SELECT id FROM chats WHERE id = ?').get(chatId))
      throw Error('Unknown chat.');
    const latest = this.statement(
      'SELECT * FROM runtime_sessions WHERE chat_id = ? ORDER BY rowid DESC LIMIT 1',
    ).get(chatId);
    if (latest?.compatibility_key === compatibilityKey)
      return {
        id: latest.id,
        shareDir: this.sessionDirectory(latest.id),
        initialized: Boolean(latest.initialized),
        reused: true,
        replaced: false,
      };
    const id = crypto.randomUUID();
    this.statement(
      'INSERT INTO runtime_sessions (id, chat_id, compatibility_key, created_at) VALUES (?, ?, ?, ?)',
    ).run(id, chatId, compatibilityKey, new Date().toISOString());
    return {
      id,
      shareDir: this.sessionDirectory(id),
      initialized: false,
      reused: false,
      replaced: Boolean(latest),
    };
  }
  initialized(id) {
    this.statement('UPDATE runtime_sessions SET initialized = 1 WHERE id = ?').run(id);
  }
  sessionDirectory(id) {
    if (!uuid(id)) throw Error('Invalid runtime session ID.');
    const directory = path.join(this.directory, 'sessions', id);
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    if (fs.realpathSync(directory) !== directory)
      throw Error('Runtime session directory cannot be a symbolic link.');
    fs.chmodSync(directory, 0o700);
    return directory;
  }
  updateBroker(turnId, broker) {
    this.statement("UPDATE turns SET broker_json = ? WHERE id = ? AND status = 'scoped'").run(
      JSON.stringify(broker),
      turnId,
    );
  }
  start(turnId) {
    this.transaction(() => {
      const row = this.statement('SELECT chat_id, status FROM turns WHERE id = ?').get(turnId);
      if (!row || row.status !== 'scoped') throw Error('This turn has already been submitted.');
      if (
        this.statement("SELECT id FROM turns WHERE chat_id = ? AND status = 'running'").get(
          row.chat_id,
        )
      )
        throw Error('This chat is already running.');
      this.statement("UPDATE turns SET status = 'running', owner_pid = ? WHERE id = ?").run(
        process.pid,
        turnId,
      );
    });
  }
  acquire(chatId) {
    const token = crypto.randomUUID();
    this.transaction(() => {
      const lock = this.statement('SELECT owner_pid FROM execution_locks WHERE chat_id = ?').get(
        chatId,
      );
      if (lock && alive(lock.owner_pid))
        throw Error('This chat is already open for execution in another process.');
      this.statement('INSERT OR REPLACE INTO execution_locks VALUES (?, ?, ?)').run(
        chatId,
        process.pid,
        token,
      );
    });
    return () => {
      if (this.db)
        this.statement('DELETE FROM execution_locks WHERE chat_id = ? AND token = ?').run(
          chatId,
          token,
        );
    };
  }
  remove(chatId, projectDir, domain) {
    this.get(chatId, projectDir, domain);
    const release = this.acquire(chatId);
    try {
      const sessions = this.statement('SELECT id FROM runtime_sessions WHERE chat_id = ?').all(
        chatId,
      );
      this.statement('DELETE FROM chats WHERE id = ?').run(chatId);
      for (const session of sessions)
        fs.rmSync(this.sessionDirectory(session.id), { recursive: true, force: true });
    } finally {
      release();
    }
  }
  close() {
    this.db?.close();
    this.db = undefined;
    this.statements.clear();
  }
}
module.exports = { ChatStore, defaultChatDirectory, deriveChatTitle };
