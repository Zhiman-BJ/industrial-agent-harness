const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { launchElectron } = require('./launch-electron.cjs');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'industrial-desktop-restart-'));
async function launch(stage) {
  const child = launchElectron(['--chat-selftest'], {
    env: {
      ...process.env,
      INDUSTRIAL_CHAT_SELFTEST_USER_DATA: directory,
      INDUSTRIAL_CHAT_SELFTEST_STAGE: stage,
    },
  });
  const timeout = setTimeout(() => child.kill('SIGKILL'), 45000);
  try {
    const code = await new Promise((resolve, reject) => {
      child.once('exit', resolve);
      child.once('error', reject);
    });
    if (code !== 0) throw Error(`Desktop ${stage} phase exited ${code}; evidence: ${directory}`);
  } finally {
    clearTimeout(timeout);
  }
}
(async () => {
  await launch('first');
  await launch('second');
  await launch('sync');
  console.log(JSON.stringify({ ok: true, restartedApp: true, evidence: directory }));
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
