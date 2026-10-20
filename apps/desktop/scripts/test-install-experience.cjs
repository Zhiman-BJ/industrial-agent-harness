const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
try {
  require('./gui-startup.cjs').requireGuiStartup();
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-install-experience-'));
for (const mode of process.platform === 'darwin' ? ['ui', 'quit'] : ['ui']) {
  const report = path.join(root, mode);
  fs.mkdirSync(report);
  const result = spawnSync(
    require('electron'),
    [path.join(__dirname, '..'), '--install-experience-selftest'],
    {
      cwd: path.join(__dirname, '..'),
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: '',
        INDUSTRIAL_HARNESS_PACK_STORE: path.join(report, 'packs'),
        INDUSTRIAL_HARNESS_PACK_FEED_FILE: path.join(report, 'no-feed.json'),
        INDUSTRIAL_HARNESS_PACK_CATALOG_URL: '',
        INDUSTRIAL_HARNESS_PACK_KEYS_FILE: '',
        HARNESS_INSTALL_EXPERIENCE_REPORT_DIR: report,
        HARNESS_INSTALL_EXPERIENCE_QUIT_TEST: mode === 'quit' ? 'true' : '',
      },
      stdio: 'inherit',
      timeout: 180000,
    },
  );
  console.log(`Installation ${mode} selftest evidence: ${report}`);
  if (result.error) throw result.error;
  if (result.status !== 0 || !fs.existsSync(path.join(report, 'result.json'))) {
    process.exitCode = result.status || 1;
    break;
  }
}
