#!/usr/bin/env node
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { StringDecoder } = require('node:string_decoder');
const { startProcess, signalProcess } = require('./lib/benchmark-process.cjs');
const { StreamRedactor, environmentSecrets } = require('./lib/benchmark-redact.cjs');

const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const hashFile = file => sha(fs.readFileSync(file));
function inputFiles(directory, relative = '') {
  return fs
    .readdirSync(path.join(directory, relative), { withFileTypes: true })
    .sort((a, b) => a.name.localeCompare(b.name, 'en'))
    .flatMap(entry => {
      const name = path.join(relative, entry.name);
      if (entry.isSymbolicLink()) throw Error(`Benchmark inputs cannot contain symlinks: ${name}`);
      if (entry.isDirectory()) return inputFiles(directory, name);
      if (!entry.isFile()) throw Error(`Benchmark input is not a regular file: ${name}`);
      return [
        { path: name.split(path.sep).join('/'), sha256: hashFile(path.join(directory, name)) },
      ];
    });
}
const treeHash = directory => sha(JSON.stringify(inputFiles(directory)));
function executableFile(executable, directory) {
  if (executable === 'node') return fs.realpathSync(process.execPath);
  if (executable.includes('/') || executable.includes('\\'))
    return fs.realpathSync(path.resolve(directory, executable));
  for (const entry of (process.env.PATH || '').split(path.delimiter)) {
    const file = path.join(entry, executable);
    try {
      fs.accessSync(file, fs.constants.X_OK);
      return fs.realpathSync(file);
    } catch (_) {}
  }
  throw Error(`Executable not found: ${executable}`);
}
function commandSpec(item, directory, formal) {
  if (
    !item ||
    typeof item.executable !== 'string' ||
    !Array.isArray(item.args) ||
    item.args.some(value => typeof value !== 'string')
  )
    throw Error('Command requires executable and string args.');
  const executable = executableFile(item.executable, directory);
  const actualSha = hashFile(executable);
  if ((formal && !item.sha256) || (item.sha256 && item.sha256 !== actualSha))
    throw Error(`Executable hash mismatch or missing frozen identity: ${item.executable}`);
  const files = (item.files || []).map(record => {
    if (typeof record.path !== 'string' || !/^[a-f0-9]{64}$/.test(record.sha256 || ''))
      throw Error('Command files require path and SHA-256.');
    const file = fs.realpathSync(path.resolve(directory, record.path));
    if (hashFile(file) !== record.sha256) throw Error(`Command file hash mismatch: ${record.path}`);
    return { path: file, sha256: record.sha256 };
  });
  if (formal && !files.length)
    throw Error('Freeze at least one driver/verifier implementation file.');
  return { executable, executableSha256: actualSha, args: item.args, files };
}
function loadBaseline(file) {
  const directory = path.dirname(fs.realpathSync(file));
  const raw = fs.readFileSync(file, 'utf8');
  const suite = JSON.parse(raw);
  if (
    suite.schemaVersion !== 1 ||
    !['engineering-smoke', 'paired-model'].includes(suite.mode) ||
    !['first-attempt', 'diagnostic'].includes(suite.runKind)
  )
    throw Error('Unsupported baseline schema, mode, or runKind.');
  if (suite.runKind === 'diagnostic' && !/^[a-f0-9]{64}$/.test(suite.parentSummarySha256 || ''))
    throw Error('Diagnostic runs require parentSummarySha256 and never enter first-attempt rates.');
  if (
    !Array.isArray(suite.seeds) ||
    !suite.seeds.length ||
    suite.seeds.some(seed => !Number.isSafeInteger(seed) || seed < 0) ||
    new Set(suite.seeds).size !== suite.seeds.length
  )
    throw Error('Provide unique nonnegative seeds.');
  if (
    !Number.isInteger(suite.budget?.maxMs) ||
    suite.budget.maxMs < 100 ||
    suite.budget.maxMs > 7200000
  )
    throw Error('Provide budget.maxMs between 100 and 7200000.');
  if (suite.budget.maxTokens !== null)
    throw Error(
      'This runner enforces wall time only; set maxTokens:null and record measured usage when available.',
    );
  if (
    !Number.isInteger(suite.verifierMaxMs) ||
    suite.verifierMaxMs < 100 ||
    suite.verifierMaxMs > 600000
  )
    throw Error('Provide verifierMaxMs between 100 and 600000.');
  const formal = suite.mode === 'paired-model';
  if (
    formal &&
    (!suite.model?.provider ||
      !suite.model?.id ||
      !suite.model?.configurationId ||
      !suite.environment?.platform ||
      !suite.environment?.toolchainId)
  )
    throw Error('Formal comparison requires frozen model and environment identities.');
  if (suite.environment?.platform && suite.environment.platform !== process.platform)
    throw Error('Frozen platform differs from this host.');
  if (
    Object.keys(suite.environment?.variables || {}).some(key =>
      /key|token|secret|password/i.test(key),
    )
  )
    throw Error('Credentials belong in the parent environment, never the baseline file.');
  const drivers = {};
  for (const label of ['native-kimi', 'harness'])
    drivers[label] = commandSpec(suite.drivers?.[label], directory, formal);
  const verifier = commandSpec(suite.verifier, directory, formal);
  const tools = (suite.environment?.tools || []).map(tool => {
    if (formal && !tool.sha256) throw Error('Formal tools require executable SHA-256.');
    return commandSpec({ ...tool, args: [] }, directory, false);
  });
  if (formal && !tools.length)
    throw Error('Formal comparison requires frozen tool executable identities.');
  if (!Array.isArray(suite.tasks) || !suite.tasks.length)
    throw Error('Provide a nonempty tasks array.');
  const seen = new Set();
  const tasks = suite.tasks.map(task => {
    if (
      !/^[\w-]+$/.test(task.id || '') ||
      seen.has(task.id) ||
      typeof task.prompt !== 'string' ||
      !task.prompt.trim() ||
      typeof task.projectDir !== 'string' ||
      typeof task.domain !== 'string'
    )
      throw Error('Invalid or duplicate task.');
    seen.add(task.id);
    const projectDir = fs.realpathSync(path.resolve(directory, task.projectDir));
    const actualHash = treeHash(projectDir);
    if (actualHash !== task.inputTreeSha256) throw Error(`Input tree hash mismatch: ${task.id}`);
    return {
      ...task,
      projectDir,
      promptSha256: sha(task.prompt),
      inputFiles: inputFiles(projectDir),
    };
  });
  return { ...suite, directory, baselineSha256: sha(raw), drivers, verifier, tasks, tools };
}

function expandCommand(command, variables) {
  const args = command.args.map(argument =>
    argument.replace(/\{(\w+)\}/g, (_, key) => {
      if (!Object.hasOwn(variables, key)) throw Error(`Unknown command placeholder: ${key}`);
      return String(variables[key]);
    }),
  );
  return { executable: command.executable, args };
}
function checkCommandFiles(command) {
  if (
    hashFile(command.executable) !== command.executableSha256 ||
    command.files.some(file => hashFile(file.path) !== file.sha256)
  )
    throw Error('Frozen command implementation changed during execution.');
}
function execute(command, variables, directory, maxMs, prefix, environment) {
  checkCommandFiles(command);
  const expanded = expandCommand(command, variables);
  const stdoutFile = `${prefix}.stdout.jsonl`,
    stderrFile = `${prefix}.stderr.log`;
  const stdoutFd = fs.openSync(stdoutFile, 'wx', 0o600),
    stderrFd = fs.openSync(stderrFile, 'wx', 0o600);
  const child = startProcess(expanded.executable, expanded.args, {
    cwd: directory,
    env: environment,
  });
  const started = process.hrtime.bigint();
  let timedOut = false,
    spawnError,
    killTimer,
    pending = '',
    usage = null,
    driverInfo = null;
  const decoder = new StringDecoder('utf8');
  const secrets = environmentSecrets(environment);
  const stdoutRedactor = new StreamRedactor(secrets),
    stderrRedactor = new StreamRedactor(secrets);
  // Usage is instrumentation reported by a trusted adapter, never engineering acceptance.
  function parseUsage(line) {
    try {
      const row = JSON.parse(line);
      if (row.type === 'benchmark_driver') driverInfo = row;
      if (
        row.type === 'benchmark_usage' &&
        row.source === 'provider-response' &&
        Number.isInteger(row.inputTokens) &&
        row.inputTokens >= 0 &&
        Number.isInteger(row.outputTokens) &&
        row.outputTokens >= 0
      )
        usage = {
          inputTokens: row.inputTokens,
          outputTokens: row.outputTokens,
          source: row.source,
          cost: null,
        };
    } catch (_) {}
  }
  child.stdout.on('data', chunk => {
    fs.writeSync(stdoutFd, stdoutRedactor.write(chunk));
    pending += decoder.write(chunk);
    let end;
    while ((end = pending.indexOf('\n')) >= 0) {
      parseUsage(pending.slice(0, end));
      pending = pending.slice(end + 1);
    }
    if (Buffer.byteLength(pending) > 4 * 1024 * 1024) pending = '';
  });
  child.stderr.on('data', chunk => fs.writeSync(stderrFd, stderrRedactor.write(chunk)));
  const timer = setTimeout(() => {
    timedOut = true;
    signalProcess(child, 'SIGTERM');
    killTimer = setTimeout(() => signalProcess(child, 'SIGKILL'), 1000);
  }, maxMs);
  child.once('error', error => {
    spawnError = String(error);
  });
  child.once('exit', () => signalProcess(child, 'SIGKILL'));
  return new Promise(resolve =>
    child.once('close', (exitCode, signal) => {
      clearTimeout(timer);
      clearTimeout(killTimer);
      fs.writeSync(stdoutFd, stdoutRedactor.end());
      fs.writeSync(stderrFd, stderrRedactor.end());
      fs.closeSync(stdoutFd);
      fs.closeSync(stderrFd);
      pending += decoder.end();
      if (pending) parseUsage(pending);
      let identityError;
      try {
        checkCommandFiles(command);
      } catch (error) {
        identityError = String(error);
      }
      resolve({
        exitCode,
        signal,
        timedOut,
        spawnError: spawnError || null,
        identityError: identityError || null,
        elapsedMs: Number(process.hrtime.bigint() - started) / 1e6,
        usage,
        driverInfo,
        stdoutFile,
        stderrFile,
        stdoutSha256: hashFile(stdoutFile),
        stderrSha256: hashFile(stderrFile),
        command: expanded,
      });
    }),
  );
}

async function runBaseline(baselineFile, outputDir) {
  const suite = loadBaseline(baselineFile);
  const output = path.resolve(outputDir);
  if (
    suite.tasks.some(
      task => output === task.projectDir || output.startsWith(task.projectDir + path.sep),
    )
  )
    throw Error('Results must be outside the frozen input projects.');
  fs.mkdirSync(output, { recursive: false, mode: 0o700 });
  const environment = { ...process.env, ...(suite.environment?.variables || {}) };
  const toolchainError = () => {
    try {
      for (const tool of suite.tools) checkCommandFiles(tool);
      return null;
    } catch (error) {
      return String(error);
    }
  };
  const summary = {
    schemaVersion: 1,
    mode: suite.mode,
    runKind: suite.runKind,
    parentSummarySha256: suite.parentSummarySha256 || null,
    baselineSha256: suite.baselineSha256,
    model: suite.model || null,
    environment: {
      ...suite.environment,
      platform: process.platform,
      arch: process.arch,
      node: process.version,
      kernel: os.release(),
      tools: suite.tools,
    },
    budget: suite.budget,
    tokenBudgetEnforced: false,
    rankingEligible: false,
    records: [],
  };
  for (const task of suite.tasks)
    for (const seed of suite.seeds) {
      const order = seed % 2 ? ['harness', 'native-kimi'] : ['native-kimi', 'harness'];
      for (const label of order) {
        if (treeHash(task.projectDir) !== task.inputTreeSha256)
          throw Error('Frozen inputs changed during execution.');
        const directory = path.join(output, `${task.id}-${seed}-${label}`);
        fs.mkdirSync(directory, { mode: 0o700 });
        const projectDir = path.join(directory, 'project');
        fs.cpSync(task.projectDir, projectDir, { recursive: true, dereference: false });
        const taskFile = path.join(directory, 'task.txt');
        fs.writeFileSync(taskFile, task.prompt, { mode: 0o600 });
        const variables = {
          projectDir,
          taskFile,
          seed,
          domain: task.domain,
          maxMs: suite.budget.maxMs,
          outputDir: directory,
          suiteDir: suite.directory,
        };
        if (toolchainError()) throw Error('Frozen toolchain changed before execution.');
        const execution = await execute(
          suite.drivers[label],
          variables,
          projectDir,
          suite.budget.maxMs,
          path.join(directory, 'trajectory'),
          environment,
        );
        // Independent verification runs even after a driver failure, retaining diagnostics.
        const verification = await execute(
          suite.verifier,
          variables,
          projectDir,
          suite.verifierMaxMs,
          path.join(directory, 'verification'),
          environment,
        );
        const toolchainIdentityError = toolchainError();
        const modelIdentityValid =
          suite.mode !== 'paired-model' ||
          (execution.driverInfo?.driver === label &&
            ['provider', 'id', 'configurationId'].every(
              key => execution.driverInfo?.model?.[key] === suite.model[key],
            ));
        const passed =
          modelIdentityValid &&
          !toolchainIdentityError &&
          execution.exitCode === 0 &&
          !execution.timedOut &&
          !execution.identityError &&
          verification.exitCode === 0 &&
          !verification.timedOut &&
          !verification.identityError;
        const record = {
          taskId: task.id,
          seed,
          driver: label,
          modelIdentityValid,
          toolchainIdentityError,
          promptSha256: task.promptSha256,
          inputTreeSha256: task.inputTreeSha256,
          outputTreeSha256: treeHash(projectDir),
          passed,
          acceptanceSource: 'independent-verifier-exit',
          execution,
          verification,
        };
        summary.records.push(record);
        fs.writeFileSync(
          path.join(directory, 'record.json'),
          JSON.stringify(record, null, 2) + '\n',
        );
        process.stdout.write(
          JSON.stringify({ type: 'paired_case', taskId: task.id, seed, driver: label, passed }) +
            '\n',
        );
      }
    }
  summary.metrics = {};
  for (const label of ['native-kimi', 'harness']) {
    const records = summary.records.filter(record => record.driver === label);
    summary.metrics[label] = {
      trials: records.length,
      accepted: records.filter(record => record.passed).length,
      firstAttemptSuccessRate:
        suite.mode === 'paired-model' &&
        suite.runKind === 'first-attempt' &&
        summary.records.every(
          record =>
            record.modelIdentityValid &&
            !record.toolchainIdentityError &&
            !record.execution.identityError &&
            !record.verification.identityError,
        )
          ? records.filter(record => record.passed).length / records.length
          : null,
      meanElapsedMs:
        records.reduce((sum, record) => sum + record.execution.elapsedMs, 0) / records.length,
      measuredUsage: records.every(record => record.execution.usage)
        ? records.map(record => record.execution.usage)
        : null,
      cost: null,
    };
  }
  summary.paired = suite.tasks.flatMap(task =>
    suite.seeds.map(seed => {
      const pair = summary.records.filter(
        record => record.taskId === task.id && record.seed === seed,
      );
      return {
        taskId: task.id,
        seed,
        nativeAccepted: pair.find(record => record.driver === 'native-kimi').passed,
        harnessAccepted: pair.find(record => record.driver === 'harness').passed,
      };
    }),
  );
  summary.comparisonValid =
    suite.mode === 'paired-model' &&
    summary.records.every(
      record =>
        record.modelIdentityValid &&
        !record.toolchainIdentityError &&
        !record.execution.identityError &&
        !record.verification.identityError,
    );
  fs.writeFileSync(path.join(output, 'summary.json'), JSON.stringify(summary, null, 2) + '\n');
  return summary;
}

if (require.main === module) {
  const argv = process.argv.slice(2);
  if (argv.length === 2 && argv[0] === '--hash-input')
    process.stdout.write(treeHash(fs.realpathSync(argv[1])) + '\n');
  else if (argv.length === 4 && argv[0] === '--suite' && argv[2] === '--output-dir')
    runBaseline(argv[1], argv[3])
      .then(summary => {
        process.exitCode = summary.records.every(record => record.passed) ? 0 : 1;
      })
      .catch(error => {
        process.stderr.write(String(error) + '\n');
        process.exitCode = 1;
      });
  else {
    process.stderr.write(
      'Usage: benchmark-paired.cjs --suite FILE --output-dir NEW_DIR | --hash-input DIR\n',
    );
    process.exitCode = 2;
  }
}
module.exports = { loadBaseline, runBaseline, treeHash, hashFile, expandCommand };
