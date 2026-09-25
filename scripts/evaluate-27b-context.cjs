#!/usr/bin/env node
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const {performance} = require('node:perf_hooks');

function parseArgs(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    if (!['--endpoint', '--model', '--api-key-file', '--output-dir', '--cases'].includes(flag) || !argv[index + 1]) throw Error(`Invalid argument: ${flag}`);
    values[flag.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())] = argv[index + 1];
  }
  if (!values.endpoint || !values.model || !values.apiKeyFile || !values.outputDir) throw Error('Provide --endpoint, --model, --api-key-file, and --output-dir.');
  values.cases = (values.cases || '8000:middle,64000:middle,180000:middle,230000:middle').split(',').map(item => {
    const [target, position] = item.split(':');
    const targetTokens = Number(target);
    if (!Number.isInteger(targetTokens) || targetTokens < 1000 || targetTokens > 260000 || !['start', 'middle', 'end'].includes(position)) throw Error(`Invalid case: ${item}`);
    return {targetTokens, position};
  });
  return values;
}

function buildCase(targetTokens, position) {
  const expectedHash = crypto.createHash('sha256').update(`target-${targetTokens}-${position}`).digest('hex');
  const target = `OBSERVED_ARTIFACT artifact_id=critical-${targetTokens}-${position} sha256=${expectedHash} verification=not_run`;
  const filler = [];
  let length = 0;
  // Hex-heavy artifact rows tokenize densely on the target model; actual usage is recorded by the API.
  for (let index = 0; length < targetTokens * 1.62; index++) {
    const hash = crypto.createHash('sha256').update(`filler-${index}`).digest('hex');
    const line = `OBSERVED_ARTIFACT artifact_id=aux-${index} sha256=${hash} verification=not_run\n`;
    filler.push(line);
    length += line.length;
  }
  const targetIndex = position === 'start' ? Math.floor(filler.length * 0.05) : position === 'end' ? Math.floor(filler.length * 0.95) : Math.floor(filler.length * 0.5);
  filler.splice(targetIndex, 0, `${target}\n`);
  const content = `Below is a long artifact observation log. Find the one record whose artifact_id starts with critical-. Return only its exact 64-character sha256, then one space, then its verification value.\n\n${filler.join('')}`;
  return {content, expected: `${expectedHash} not_run`, promptSha256: crypto.createHash('sha256').update(content).digest('hex'), targetIndex, recordCount: filler.length};
}

async function runCase(options, item, apiKey) {
  const test = buildCase(item.targetTokens, item.position);
  const started = performance.now();
  let result;
  try {
    const response = await fetch(options.endpoint, {
      method: 'POST',
      headers: {'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}`},
      body: JSON.stringify({model: options.model, messages: [{role: 'user', content: test.content}], temperature: 0, seed: 42, max_tokens: 96, chat_template_kwargs: {enable_thinking: false}}),
      signal: AbortSignal.timeout(240000),
    });
    const body = await response.json();
    const answer = String(body.choices?.[0]?.message?.content || '').trim();
    result = {httpStatus: response.status, answer, expected: test.expected, passed: response.ok && answer === test.expected, usage: body.usage || null, finishReason: body.choices?.[0]?.finish_reason || null, error: body.error?.message || null};
  } catch (error) {result = {httpStatus: null, passed: false, error: String(error), cause: error?.cause?.code || error?.cause?.message || null};}
  return {schemaVersion: 1, targetTokens: item.targetTokens, position: item.position, promptSha256: test.promptSha256, recordCount: test.recordCount, elapsedMs: Math.round(performance.now() - started), ...result};
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const apiKey = fs.readFileSync(options.apiKeyFile, 'utf8').trim();
  if (!apiKey) throw Error('API key file is empty.');
  fs.mkdirSync(options.outputDir, {recursive: true, mode: 0o700});
  const file = path.join(options.outputDir, 'results.jsonl');
  const fd = fs.openSync(file, 'wx', 0o600);
  let failed = false;
  try {
    for (const item of options.cases) {
      const result = await runCase(options, item, apiKey);
      if (!result.passed) failed = true;
      fs.writeSync(fd, `${JSON.stringify(result)}\n`);
      process.stdout.write(`${JSON.stringify({targetTokens: result.targetTokens, position: result.position, promptTokens: result.usage?.prompt_tokens || null, passed: result.passed, elapsedMs: result.elapsedMs, error: result.error || null, cause: result.cause || null})}\n`);
    }
  } finally {fs.closeSync(fd);}
  process.stdout.write(`${file}\n`);
  if (failed) process.exitCode = 1;
}

module.exports = {parseArgs, buildCase, runCase};
if (require.main === module) void main().catch(error => {process.stderr.write(`${String(error)}\n`); process.exitCode = 1;});
