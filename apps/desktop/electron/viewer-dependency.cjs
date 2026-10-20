const fs = require('node:fs');
const os = require('node:os');
const { spawnSync } = require('node:child_process');

function interpreterIdentity(python) {
  if (typeof python !== 'string' || !python.trim()) throw Error('Missing interpreter.');
  const real = fs.realpathSync(python);
  const stat = fs.statSync(real);
  if (!stat.isFile()) throw Error('Interpreter is not a file.');
  fs.accessSync(real, fs.constants.X_OK);
  return JSON.stringify([python, real, stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs]);
}

// Explicit user configuration is authoritative. A managed dependency must be
// ready before it is returned; source checkouts alone retain their old venv.
function resolveViewerInterpreter({
  override,
  resolveManaged,
  legacy,
  allowLegacy = false,
  unavailableMessage,
  overrideMessage,
  validateOverride,
}) {
  if (override !== undefined) {
    try {
      const identity = interpreterIdentity(override);
      validateOverride?.(override, identity);
      return { python: override, identity };
    } catch (cause) {
      throw Error(overrideMessage, { cause });
    }
  }
  try {
    const python = resolveManaged() || (allowLegacy ? legacy : undefined);
    return { python, identity: interpreterIdentity(python) };
  } catch (cause) {
    throw Error(unavailableMessage, { cause });
  }
}

function pythonModuleProbe(modules) {
  if (!modules.length || modules.some(name => !/^[a-zA-Z_]\w*(?:\.[a-zA-Z_]\w*)*$/.test(name)))
    throw Error('Invalid Python module probe.');
  return python => {
    const result = spawnSync(
      python,
      ['-I', '-c', modules.map(name => `import ${name}`).join('; ')],
      {
        cwd: os.tmpdir(),
        stdio: 'ignore',
        timeout: 10000,
        windowsHide: true,
      },
    );
    if (result.error || result.status !== 0) throw Error('Python module probe failed.');
  };
}

class ResolvedViewerService {
  constructor(resolveInterpreter, createService, { configurationKey = () => undefined } = {}) {
    this.resolveInterpreter = resolveInterpreter;
    this.createService = createService;
    this.configurationKey = configurationKey;
  }
  get(refresh = false) {
    const key = this.configurationKey();
    if (!refresh && this.service && !this.service.failure && key === this.key) {
      try {
        // Panning must not reload and rehash every installed Pack. A fresh
        // artifact open still resolves its authenticated declaration in full.
        if (interpreterIdentity(this.python) === this.identity) return this.service;
      } catch {
        // A removed or replaced interpreter must go through resolution again.
      }
    }
    let interpreter;
    try {
      interpreter = this.resolveInterpreter();
    } catch (error) {
      this.close();
      throw error;
    }
    if (!this.service || this.service.failure || this.identity !== interpreter.identity) {
      this.close();
      this.service = this.createService(interpreter.python);
      this.identity = interpreter.identity;
      this.python = interpreter.python;
    }
    this.key = key;
    return this.service;
  }
  close() {
    this.service?.close();
    this.service = undefined;
    this.identity = undefined;
    this.python = undefined;
    this.key = undefined;
  }
}

module.exports = { resolveViewerInterpreter, ResolvedViewerService, pythonModuleProbe };
