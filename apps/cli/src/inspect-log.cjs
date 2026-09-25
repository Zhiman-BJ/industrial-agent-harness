const fs = require('node:fs');

function inspectLog(file) {
  const rows = fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
  if (!rows.length) throw Error('Diagnostic log is empty.');
  const traceId = rows[0].traceId;
  for (let index = 0; index < rows.length; index++) {
    if (rows[index].schemaVersion !== 1 || rows[index].traceId !== traceId || rows[index].sequence !== index + 1) throw Error('Diagnostic log has a missing or inconsistent record.');
  }
  const start = rows.find(row => row.type === 'run.start')?.payload || {};
  const prompt = rows.find(row => row.type === 'prompt')?.payload.text || '';
  const sdk = rows.filter(row => row.type === 'sdk.event');
  const calls = new Map();
  let streamingCallId = null;
  for (const row of sdk) {
    const event = row.payload;
    if (event.type === 'ToolCall') {streamingCallId = event.payload.id; calls.set(event.payload.id, {id: event.payload.id, name: event.payload.function?.name || null, arguments: event.payload.function?.arguments || '', resultBytes: null, error: null});}
    if (event.type === 'ToolCallPart' && streamingCallId) calls.get(streamingCallId).arguments += event.payload.arguments_part || '';
    if (event.type === 'ToolResult') {
      const item = calls.get(event.payload.tool_call_id) || {id: event.payload.tool_call_id, name: null, arguments: ''};
      item.resultBytes = Buffer.byteLength(typeof event.payload.return_value?.output === 'string' ? event.payload.return_value.output : '', 'utf8');
      item.error = Boolean(event.payload.return_value?.is_error);
      calls.set(item.id, item);
      if (streamingCallId === item.id) streamingCallId = null;
    }
  }
  return {schemaVersion: 1, traceId, projectDir: start.projectDir || null, model: start.model || null, scope: start.scope || null, brokerTrace: start.brokerTrace || [], promptBytes: Buffer.byteLength(prompt, 'utf8'), sdkEvents: sdk.length, toolCalls: [...calls.values()], compactions: sdk.filter(row => row.payload.type === 'CompactionBegin').length, statusUpdates: sdk.filter(row => row.payload.type === 'StatusUpdate').map(row => ({sequence: row.sequence, contextUsage: row.payload.payload?.context_usage ?? null, tokenUsage: row.payload.payload?.token_usage ?? null})), snapshots: rows.filter(row => row.type === 'kimi.snapshot').map(row => row.payload), snapshotErrors: rows.filter(row => row.type === 'kimi.snapshot_error').map(row => row.payload), final: rows.findLast(row => row.type === 'run.end')?.payload || null, logComplete: rows.at(-1).type === 'run.end'};
}

function main(argv = process.argv.slice(2), output = process.stdout) {
  if (argv.length !== 2 || argv[0] !== '--file') throw Error('Usage: industrial-harness inspect-log --file FILE');
  output.write(`${JSON.stringify(inspectLog(argv[1]), null, 2)}\n`);
}

module.exports = {inspectLog, main};
if (require.main === module) {try {main();} catch (error) {process.stderr.write(`${String(error)}\n`); process.exitCode = 1;}}
