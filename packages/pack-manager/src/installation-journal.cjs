const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

// A small durable receipt distinguishes an interrupted preparation from a clean
// idle start. It contains no credentials and never replaces Pack/Runtime facts.
class InstallationJournal {
  constructor(manager) {
    this.manager = manager;
    this.file = path.join(manager.directory, '.installation-operation.json');
    this.lastWrite = 0;
  }
  read() {
    try {
      return JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch (error) {
      if (error.code === 'ENOENT') return this.fallbackReceipt || null;
      return {
        active: false,
        outcome: 'interrupted',
        error:
          'The last installation status could not be read. Check or repair the installed domain.',
        finishedAt: new Date().toISOString(),
      };
    }
  }
  snapshot() {
    const value = this.read();
    if (!value?.active) return value;
    try {
      if (!Number.isInteger(value.pid) || value.pid < 1) throw Error('Invalid installation owner.');
      process.kill(value.pid, 0);
      return value;
    } catch (error) {
      if (error.code === 'EPERM') return value;
      return {
        ...value,
        active: false,
        outcome: 'interrupted',
        finishedAt: value.updatedAt,
        error:
          'Preparation was interrupted. Retry installation or check and repair the domain; the previously installed version is preserved.',
      };
    }
  }
  write(value) {
    const temporary = `${this.file}.${crypto.randomUUID()}.tmp`;
    try {
      fs.writeFileSync(temporary, JSON.stringify(value), { flag: 'wx', mode: 0o600 });
      fs.renameSync(temporary, this.file);
    } finally {
      fs.rmSync(temporary, { force: true });
    }
  }
  begin(domains, operation = 'install') {
    return this.manager.withLock(() => {
      if (this.snapshot()?.active) throw Error('Domain preparation is already in progress.');
      for (const domain of domains) this.manager.assertIdle(domain);
      this.id = crypto.randomUUID();
      this.write({
        id: this.id,
        pid: process.pid,
        active: true,
        operation,
        domains,
        startedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
      this.fallbackReceipt = undefined;
      return this.id;
    });
  }
  progress(progress) {
    const now = Date.now();
    const previous = this.read();
    if (!this.id || previous?.id !== this.id || !previous?.active) return;
    if (now - this.lastWrite < 500 && previous.progress?.phase === progress.phase) return;
    this.lastWrite = now;
    this.write({ ...previous, progress, updatedAt: new Date(now).toISOString() });
  }
  finish(outcome, error) {
    if (!this.id) return;
    const previous = this.read();
    if (previous?.id !== this.id) return;
    const terminal = {
      ...previous,
      active: false,
      progress: null,
      outcome,
      ...(error ? { error: String(error.message || error) } : {}),
      finishedAt: new Date().toISOString(),
    };
    try {
      this.write(terminal);
    } catch (error) {
      // A full disk must not leave the live Desktop PID permanently owning an
      // already-finished operation. Preserve the terminal state in this process,
      // release the durable ownership record, and expose the persistence warning.
      this.fallbackReceipt = {
        ...terminal,
        statusWarning:
          'The operation finished, but its status could not be saved. Free disk space and check the installed domains.',
      };
      if (this.read()?.id === this.id) fs.rmSync(this.file, { force: true });
      return this.fallbackReceipt;
    }
    this.fallbackReceipt = undefined;
    return terminal;
  }
}

module.exports = { InstallationJournal };
