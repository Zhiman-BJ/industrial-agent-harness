const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { runAccount, createCliAccount } = require('../src/account.cjs');
test('account CLI prints safe status and file persistence requires opt-in', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-account-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const environment = {
    INDUSTRIAL_HARNESS_CONFIG_DIR: directory,
    INDUSTRIAL_AUTH_CLIENT_ID: 'harness-cli',
  };
  let output = '';
  await runAccount(
    ['status'],
    {
      write: value => {
        output += value;
      },
    },
    environment,
  );
  assert.equal(JSON.parse(output).persistent, false);
  assert.equal(JSON.parse(output).status, 'signed_out');
  const memory = createCliAccount(environment);
  assert.equal(memory.store.persistent(), false);
  memory.close();
  const file = createCliAccount(environment, true);
  assert.equal(file.store.persistent(), true);
  file.close();
  assert.ok(!/accessToken|refreshToken/.test(output));
});
test('CLI logout clears a corrupt opted-in session and reports failed server revocation', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-account-corrupt-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const storeDirectory = path.join(directory, 'account', 'cli');
  fs.mkdirSync(storeDirectory, { recursive: true, mode: 0o700 });
  const file = path.join(storeDirectory, 'session.json');
  fs.writeFileSync(file, '{broken', { mode: 0o600 });
  let output = '';
  await runAccount(
    ['logout', '--allow-file-store'],
    {
      write: value => {
        output += value;
      },
    },
    {
      INDUSTRIAL_HARNESS_CONFIG_DIR: directory,
      INDUSTRIAL_AUTH_CLIENT_ID: 'harness-cli',
    },
  );
  assert.equal(fs.existsSync(file), false);
  assert.equal(JSON.parse(output).status, 'signed_out');
  assert.equal(JSON.parse(output).revoked, false);
});
