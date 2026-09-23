const {spawn} = require('node:child_process');
const readline = require('node:readline');
const path = require('node:path');
class RasterService {
  constructor(python) { this.python = python; this.pending = new Map(); this.sequence = 0; this.serial = Promise.resolve(); }
  start() {
    if (this.worker) return;
    this.worker = spawn(this.python, ['-u', path.join(__dirname, 'layout.py')], {stdio:['pipe','pipe','pipe']});
    this.worker.stderr.on('data', () => {});
    this.worker.on('error', error => this.fail(error.message));
    this.worker.on('exit', () => this.fail('KLayout renderer stopped. Reopen the layout to retry.'));
    this.worker.stdin.on('error', error => this.fail(error.message));
    readline.createInterface({input:this.worker.stdout}).on('line', line => {
      let message; try {message = JSON.parse(line);} catch {return this.fail('Invalid KLayout response.');}
      const pending = this.pending.get(message.id); if (!pending) return;
      clearTimeout(pending.timer); this.pending.delete(message.id);
      message.error ? pending.reject(Error(message.error)) : pending.resolve(message.result);
    });
  }
  fail(message) { this.failure = message; for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(Error(message)); } this.pending.clear(); }
  call(request) {
    const result = this.serial.then(() => new Promise((resolve,reject) => {
      if (this.failure) return reject(Error(this.failure));
      this.start(); const id = ++this.sequence;
      const timer = setTimeout(() => {this.fail('KLayout render timed out.'); this.worker?.kill();},120000);
      this.pending.set(id,{resolve,reject,timer});
      this.worker.stdin.write(JSON.stringify({...request,id})+'\n');
    }));
    this.serial = result.catch(() => {}); return result;
  }
  close() {this.fail('Renderer closed.');this.worker?.kill();}
}
module.exports = {RasterService};
