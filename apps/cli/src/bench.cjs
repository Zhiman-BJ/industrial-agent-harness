const fs = require('node:fs');
const path = require('node:path');
const {Writable} = require('node:stream');
const {resourceCatalog} = require('@industrial-agent-harness/harness-core');

const idPattern = /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/;
const allowedExpected = new Set(['status', 'capabilityIds', 'skills', 'tools', 'mcpServers']);

function parseBenchArgs(argv) {
  if (argv.length !== 4 || argv[0] !== '--suite' || argv[2] !== '--output-dir' || !argv[1] || !argv[3]) {
    throw Error('Usage: industrial-harness bench --suite FILE --output-dir DIR');
  }
  return {suiteFile: path.resolve(argv[1]), outputDir: path.resolve(argv[3])};
}

function loadSuite(suiteFile) {
  const suite = JSON.parse(fs.readFileSync(suiteFile, 'utf8'));
  if (suite?.schemaVersion !== 1 || !Array.isArray(suite.scenarios) || !suite.scenarios.length) throw Error('Bench suite requires schemaVersion 1 and a nonempty scenarios array.');
  const ids = new Set();
  return suite.scenarios.map(item => {
    if (!item || !idPattern.test(item.id || '') || ids.has(item.id)) throw Error(`Invalid or duplicate scenario ID: ${item?.id}`);
    ids.add(item.id);
    if (typeof item.projectDir !== 'string' || typeof item.domain !== 'string' || typeof item.task !== 'string' || !item.task.trim()) throw Error(`Scenario ${item.id} requires projectDir, domain, and task.`);
    if (item.artifactManifest !== undefined && typeof item.artifactManifest !== 'string') throw Error(`Scenario ${item.id} has invalid artifactManifest.`);
    if (item.scopeOnly !== undefined && typeof item.scopeOnly !== 'boolean') throw Error(`Scenario ${item.id} has invalid scopeOnly.`);
    const expected = item.expected || {};
    if (!expected || typeof expected !== 'object' || Array.isArray(expected) || Object.keys(expected).some(key => !allowedExpected.has(key))) throw Error(`Scenario ${item.id} has invalid expected fields.`);
    for (const key of ['capabilityIds', 'skills', 'tools', 'mcpServers']) if (expected[key] !== undefined && (!Array.isArray(expected[key]) || expected[key].some(value => typeof value !== 'string'))) throw Error(`Scenario ${item.id} has invalid expected.${key}.`);
    if (expected.status !== undefined && typeof expected.status !== 'string') throw Error(`Scenario ${item.id} has invalid expected.status.`);
    for (const key of ['disabledSkills', 'disabledMcpServers']) if (item[key] !== undefined && (!Array.isArray(item[key]) || item[key].some(value => typeof value !== 'string'))) throw Error(`Scenario ${item.id} has invalid ${key}.`);
    return {...item, expected, projectDir: path.resolve(path.dirname(suiteFile), item.projectDir), artifactManifest: item.artifactManifest && path.resolve(path.dirname(suiteFile), item.artifactManifest)};
  });
}

async function executeScenario(item, outputFile, Session) {
  const {run} = require('./main.cjs');
  const fd = fs.openSync(outputFile, 'wx', 0o600);
  const output = new Writable({write(chunk, _encoding, callback) {
    try {fs.writeSync(fd, chunk); callback();} catch (error) {callback(error);}
  }});
  try {
    const exitCode = await run({projectDir: item.projectDir, domain: item.domain, task: item.task, scopeOnly: item.scopeOnly, timeoutMs: item.timeoutMs, artifactManifest: item.artifactManifest, disabledSkills: item.disabledSkills, disabledMcpServers: item.disabledMcpServers}, output, process.env, Session);
    return {exitCode};
  } catch (error) {
    fs.writeSync(fd, `${JSON.stringify({schemaVersion: 1, type: 'error', message: String(error)})}\n`);
    return {exitCode: 1};
  } finally {fs.closeSync(fd);}
}

function compare(item, rows, execution) {
  const scope = rows.find(row => row.type === 'scope')?.scope;
  const result = rows.findLast(row => row.type === 'result');
  const failures = [];
  if (execution.exitCode !== 0) failures.push(`exit code ${execution.exitCode}`);
  if (!scope) failures.push('missing scope event');
  if (!result) failures.push('missing result event');
  if (result && result.status !== (item.expected.status || (item.scopeOnly ? 'scoped' : 'completed'))) failures.push(`status: ${result.status}`);
  for (const key of ['capabilityIds', 'skills', 'tools']) {
    if (item.expected[key] !== undefined && JSON.stringify(scope?.[key]) !== JSON.stringify(item.expected[key])) failures.push(`${key}: ${JSON.stringify(scope?.[key])}`);
  }
  if (item.expected.mcpServers !== undefined) {
    const actual = scope ? resourceCatalog(scope.domain).mcpServers.filter(server => !(item.disabledMcpServers || []).includes(server.id) && server.toolIds.length > 0 && server.toolIds.every(id => scope.tools.includes(id))).map(server => server.id) : [];
    if (JSON.stringify(actual) !== JSON.stringify(item.expected.mcpServers)) failures.push(`mcpServers: ${JSON.stringify(actual)}`);
  }
  return failures;
}

async function runBench(argv, Session) {
  const {suiteFile, outputDir} = parseBenchArgs(argv);
  const scenarios = loadSuite(suiteFile);
  fs.mkdirSync(outputDir, {recursive: true});
  const summary = {schemaVersion: 1, suiteFile, scenarios: []};
  for (const item of scenarios) {
    const outputFile = path.join(outputDir, `${item.id}.jsonl`);
    const execution = await executeScenario(item, outputFile, Session);
    let rows = [];
    let parseError;
    try {rows = fs.readFileSync(outputFile, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);}
    catch (error) {parseError = String(error);}
    const failures = compare(item, rows, execution);
    if (parseError) failures.push(parseError);
    const record = {id: item.id, passed: failures.length === 0, failures, outputFile};
    summary.scenarios.push(record);
    process.stdout.write(`${JSON.stringify({type: 'scenario', ...record})}\n`);
  }
  summary.passed = summary.scenarios.every(item => item.passed);
  fs.writeFileSync(path.join(outputDir, 'summary.json'), JSON.stringify(summary, null, 2) + '\n');
  return summary.passed ? 0 : 1;
}

module.exports = {parseBenchArgs, loadSuite, compare, runBench};
