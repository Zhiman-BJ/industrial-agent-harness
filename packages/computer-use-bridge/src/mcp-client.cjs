const {spawn} = require('node:child_process');
const path = require('node:path');
const {StringDecoder} = require('node:string_decoder');

const MAX_TOOL_OUTPUT_BYTES = 16 * 1024;
// Base64 ceiling for one image block. A 1400px-wide PNG is far below this;
// beyond it the image would dominate the model context, so we drop it with a
// text notice instead of shipping megabytes of base64.
const MAX_IMAGE_BASE64_CHARS = 3_500_000;
const CALL_TIMEOUT_MS = 30000;
const PERMISSION_HINT = /accessibility|screen recording|not granted|permission/i;

function resolveBinary(installedDir, env = process.env) {
  if (env.GUI_BRIDGE_BIN) return env.GUI_BRIDGE_BIN;
  if (installedDir) {
    const candidate = path.join(installedDir, 'munim-computer-use');
    try {
      if (require('node:fs').statSync(candidate).isFile()) return candidate;
    } catch {}
  }
  return 'munim-computer-use';
}

class McpClient {
  constructor(bin, {env = {}, onSpawn, spawner = spawn} = {}) {
    this.bin = bin;
    this.env = env;
    this.child = spawner(bin, [], {env: {...process.env, COMPUTER_USE_BROWSER: '0', ...env}, stdio: ['pipe', 'pipe', 'pipe']});
    this.buffer = '';
    // Pipes deliver arbitrary byte boundaries; a multi-byte UTF-8 character
    // (CJK labels are common here) split across chunks must not be decoded
    // per chunk or it corrupts to replacement characters. StringDecoder holds
    // the incomplete tail until the next chunk completes it.
    this.decoder = new StringDecoder('utf8');
    this.pending = new Map();
    this.nextId = 1;
    this.closed = false;
    this.stderrTail = '';
    this.child.stdout.on('data', chunk => this.onData(chunk));
    this.child.stdout.on('end', () => {this.buffer += this.decoder.end(); this.drainBuffer();});
    this.child.stderr.on('data', chunk => {this.stderrTail = `${this.stderrTail}${chunk.toString('utf8')}`.slice(-4000);});
    this.child.on('error', error => this.die(error));
    this.child.on('exit', () => this.die(new Error('Computer use server exited.')));
    if (onSpawn) onSpawn(this.child);
  }
  get stderr() {return this.stderrTail;}
  onData(chunk) {
    this.buffer += this.decoder.write(chunk);
    this.drainBuffer();
  }
  drainBuffer() {
    let newline;
    while ((newline = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (!line) continue;
      let message;
      try {message = JSON.parse(line);} catch {continue;}
      if (message.id !== undefined && this.pending.has(message.id)) {
        const {resolve, reject, timer} = this.pending.get(message.id);
        this.pending.delete(message.id);
        clearTimeout(timer);
        if (message.error) reject(new Error(message.error.message || 'Computer use tool call failed.'));
        else resolve(message.result);
      }
    }
  }
  rpc(method, params) {
    if (this.closed) return Promise.reject(new Error('Computer use server is closed.'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Computer use call ${method} timed out after ${CALL_TIMEOUT_MS}ms.`));
      }, CALL_TIMEOUT_MS);
      this.pending.set(id, {resolve, reject, timer});
      this.child.stdin.write(`${JSON.stringify({jsonrpc: '2.0', id, method, params})}\n`);
    });
  }
  async initialize() {
    const result = await this.rpc('initialize', {protocolVersion: '2024-11-05', capabilities: {}, clientInfo: {name: 'industrial-agent-harness', version: '0.0.0'}});
    this.child.stdin.write(`${JSON.stringify({jsonrpc: '2.0', method: 'notifications/initialized'})}\n`);
    return result;
  }
  // Returns {output, isError, needsSystemPermission, truncated, outputBytes, images}
  async call(tool, args = {}) {
    const result = await this.rpc('tools/call', {name: tool, arguments: args});
    const blocks = result?.content || [];
    const raw = blocks.filter(block => block.type === 'text').map(block => block.text).join('\n');
    // MCP image blocks carry the screenshot as base64. Without forwarding them
    // the model only sees the coordinate-mapping text and hallucinates the content.
    const images = [];
    let imageNote = '';
    for (const block of blocks) {
      if (block.type !== 'image' || typeof block.data !== 'string') continue;
      if (block.data.length > MAX_IMAGE_BASE64_CHARS) {
        imageNote = '\n[image_unavailable: base64 payload exceeds the bridge limit; re-run with a smaller max_width]';
        continue;
      }
      images.push({data: block.data, mimeType: typeof block.mimeType === 'string' ? block.mimeType : 'image/png'});
    }
    const bytes = Buffer.byteLength(raw, 'utf8');
    const truncated = bytes > MAX_TOOL_OUTPUT_BYTES;
    const isError = Boolean(result?.isError);
    const needsSystemPermission = isError && PERMISSION_HINT.test(raw);
    const prefix = isError ? '[computer-use error] ' : '';
    let output;
    if (!truncated) output = prefix + raw + imageNote;
    else {
      // Truncate the raw body by bytes (never inside a UTF-8 character) and
      // reserve room for the prefix, marker, and image note so the assembled
      // output stays within MAX_TOOL_OUTPUT_BYTES; the model must still learn
      // that the call failed and why pixels are missing.
      const data = Buffer.from(raw, 'utf8');
      const reserve = Buffer.byteLength(prefix + imageNote, 'utf8') + 48;
      let cut = Math.max(0, MAX_TOOL_OUTPUT_BYTES - reserve);
      while (cut > 0 && (data[cut] & 0xC0) === 0x80) cut--;
      output = `${prefix}${data.subarray(0, cut).toString('utf8')}\n[truncated ${bytes - cut} bytes]${imageNote}`;
    }
    return {output, isError, needsSystemPermission, truncated, outputBytes: bytes, images};
  }
  failAll(error) {
    if (this.closed) return;
    for (const {reject, timer} of this.pending.values()) {clearTimeout(timer); reject(error);}
    this.pending.clear();
  }
  // A dead server must not be reused: fail pending calls first, then mark
  // closed so ensureClient() rebuilds a fresh client on the next call.
  die(error) {
    this.failAll(error);
    this.closed = true;
  }
  close() {
    if (this.closed) return;
    this.failAll(new Error('Computer use server closed by harness.'));
    this.closed = true;
    this.child.kill();
  }
}

module.exports = {McpClient, resolveBinary, MAX_TOOL_OUTPUT_BYTES};
