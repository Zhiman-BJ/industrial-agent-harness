const {spawn} = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const electron = require('electron');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'industrial-desktop-restart-'));
async function launch(stage) {
  const child = spawn(electron, ['.', '--chat-selftest'], {cwd: path.resolve(__dirname, '..'), env: {...process.env, INDUSTRIAL_CHAT_SELFTEST_USER_DATA: directory, INDUSTRIAL_CHAT_SELFTEST_STAGE: stage}, stdio: 'inherit'});
  const timeout = setTimeout(() => child.kill('SIGKILL'), 45000);
  try {const code = await new Promise((resolve, reject) => {child.once('exit', resolve); child.once('error', reject);}); if (code !== 0) throw Error(`Desktop ${stage} phase exited ${code}; evidence: ${directory}`);}
  finally {clearTimeout(timeout);}
}
(async () => {await launch('first'); await launch('second'); console.log(JSON.stringify({ok: true, restartedApp: true, evidence: directory}));})().catch(error => {console.error(error); process.exitCode = 1;});
