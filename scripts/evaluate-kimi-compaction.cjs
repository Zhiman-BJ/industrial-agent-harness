#!/usr/bin/env node
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {KimiSession} = require('../packages/agent-kimi/src/index.cjs');
const {configToml, sessionEnv, validateProfile} = require('../packages/agent-kimi/src/model-config.cjs');
const {ObservedContextStore} = require('../packages/domain-runtime/src/index.cjs');
const {resolveProjectTask} = require('../packages/harness-core/src/index.cjs');
const {capabilities} = require('../packages/domain-skills/src/index.cjs');
const {discloseDetail} = require('../packages/capability-broker/src/index.cjs');

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    if (!['--project-dir', '--artifact-file', '--endpoint', '--model', '--api-key-file', '--kimi-executable', '--output-dir', '--context-size', '--filler-turns', '--filler-lines'].includes(flag) || !argv[index + 1]) throw Error(`Invalid argument: ${flag}`);
    options[flag.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())] = argv[index + 1];
  }
  for (const required of ['projectDir', 'artifactFile', 'endpoint', 'model', 'apiKeyFile', 'kimiExecutable', 'outputDir']) if (!options[required]) throw Error(`Missing --${required.replace(/[A-Z]/g, letter => `-${letter.toLowerCase()}`)}.`);
  options.contextSize = Number(options.contextSize || 65536);
  options.fillerTurns = Number(options.fillerTurns || 5);
  options.fillerLines = Number(options.fillerLines || 150);
  if (!Number.isInteger(options.contextSize) || options.contextSize < 32768 || !Number.isInteger(options.fillerTurns) || options.fillerTurns < 1 || options.fillerTurns > 12 || !Number.isInteger(options.fillerLines) || options.fillerLines < 1 || options.fillerLines > 1000) throw Error('Invalid context-size or filler count.');
  return options;
}

function filler(turn, lines) {
  const records = [];
  for (let index = 0; index < lines; index++) records.push(`unrelated-${turn}-${index} checksum=${crypto.createHash('sha256').update(`${turn}-${index}`).digest('hex')} verification=not_run`);
  return `Read these unrelated diagnostic records. Do not use tools or summarize the records. Reply only ACK.\n${records.join('\n')}`;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const projectDir = fs.realpathSync(options.projectDir);
  const apiKey = fs.readFileSync(options.apiKeyFile, 'utf8').trim();
  if (!apiKey) throw Error('API key file is empty.');
  fs.mkdirSync(options.outputDir, {recursive: true, mode: 0o700});
  const shareDir = fs.mkdtempSync(path.join(os.tmpdir(), 'industrial-compaction-share-'));
  const store = new ObservedContextStore(projectDir, 'chip', {directory: path.join(options.outputDir, 'state')});
  let session;
  try {
    const artifact = await store.observeArtifact({id: 'bench-netlist', kind: 'netlist', file: options.artifactFile});
    const broker = resolveProjectTask('chip', {task: 'Inspect netlist'}, undefined, capabilities, {});
    const scope = broker.scope;
    const profile = validateProfile({provider: 'openai_legacy', endpoint: options.endpoint, model: options.model, contextSize: options.contextSize, thinking: false});
    fs.writeFileSync(path.join(shareDir, 'config.toml'), `${configToml(profile)}\n[loop_control]\nreserved_context_size = 8192\ncompaction_trigger_ratio = 0.7\n`, {mode: 0o600});
    const runtime = {profile, apiKey, revision: 0, executable: options.kimiExecutable, shareDir, env: sessionEnv(profile, apiKey), disabledMcpServers: []};
    const events = [];
    session = new KimiSession(projectDir, () => scope, id => store.readArtifact(id), id => discloseDetail(scope, capabilities, id), event => events.push(event), () => runtime, undefined, {directory: path.join(options.outputDir, 'logs'), getBrokerTrace: () => broker.trace, getContextAnchor: () => store.anchor(), readContextPage: (id, offset, limit) => store.readPage(id, offset, limit)});
    const turns = [`Inspect netlist artifact bench-netlist with the industrial metadata tool. State its SHA-256 hash and whether engineering verification ran.`];
    for (let index = 0; index < options.fillerTurns; index++) turns.push(filler(index, options.fillerLines));
    turns.push('After any context compression, call industrial_context_read for the current checkpoint. Then report the SHA-256 of bench-netlist and whether engineering verification ran.');
    const results = [];
    for (let index = 0; index < turns.length; index++) {
      const start = events.length;
      await session.run(turns[index]);
      const turnEvents = events.slice(start);
      const text = turnEvents.filter(item => item.type === 'text').map(item => item.text).join('');
      const result = {turn: index, status: turnEvents.findLast(item => item.type === 'done')?.result.status || 'error', error: turnEvents.findLast(item => item.type === 'error')?.message || null, compactions: turnEvents.find(item => item.type === 'context-metrics')?.compactions || 0, peakContextUsage: turnEvents.find(item => item.type === 'context-metrics')?.peakContextUsage || null, toolNames: turnEvents.filter(item => item.type === 'tool').map(item => item.name), logPath: turnEvents.find(item => item.type === 'diagnostic-log')?.path || null, answer: index === turns.length - 1 ? text : null};
      results.push(result);
      process.stdout.write(`${JSON.stringify({turn: result.turn, status: result.status, compactions: result.compactions, peakContextUsage: result.peakContextUsage, toolNames: result.toolNames, error: result.error})}\n`);
      if (result.error) break;
    }
    const final = results.at(-1);
    const summary = {schemaVersion: 1, model: options.model, contextSize: options.contextSize, artifactSha256: artifact.sha256, totalCompactions: results.reduce((sum, item) => sum + item.compactions, 0), recovered: Boolean(final?.answer?.includes(artifact.sha256) && final.answer.includes('not_run')), turns: results};
    fs.writeFileSync(path.join(options.outputDir, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`, {mode: 0o600});
    process.stdout.write(`${JSON.stringify({totalCompactions: summary.totalCompactions, recovered: summary.recovered, summaryFile: path.join(options.outputDir, 'summary.json')})}\n`);
    if (!summary.totalCompactions || !summary.recovered) process.exitCode = 1;
  } finally {await session?.close(); store.close(); fs.rmSync(shareDir, {recursive: true, force: true});}
}

module.exports = {parseArgs, filler};
if (require.main === module) void main().catch(error => {process.stderr.write(`${String(error)}\n`); process.exitCode = 1;});
