#!/usr/bin/env node
// Development-only model qualification through the application's task API.
const fs = require('node:fs');
const path = require('node:path');
const { runTask } = require('../tests/integration/fixtures/task-service-process.cjs');
const { readProfile } = require('./benchmark-model-profile.cjs');

async function main(argv = process.argv.slice(2)) {
  if (argv.length !== 5)
    throw Error('Usage: benchmark-harness.cjs PROJECT DOMAIN TASK_FILE OUTPUT_DIR PROFILE_FILE');
  const [projectDir, domain, taskFile, outputDir, profileFile] = argv;
  const { profile, apiKeyEnv, executable, configurationId } = readProfile(profileFile);
  const send = row => process.stdout.write(JSON.stringify(row) + '\n');
  send({
    type: 'benchmark_driver',
    driver: 'harness',
    configurationId,
    model: { provider: profile.provider, id: profile.model, configurationId },
    seedControl: 'not-enforced',
    acceptance: 'external-verifier-required',
  });
  let result;
  const code = await runTask(
    {
      projectDir,
      domain,
      task: fs.readFileSync(taskFile, 'utf8'),
      ...profile,
      apiKeyEnv,
      kimiExecutable: executable,
      approval: 'auto',
      chatDir: path.join(outputDir, 'chats'),
      stateDir: path.join(outputDir, 'state'),
      logDir: path.join(outputDir, 'logs'),
    },
    {
      write(line) {
        const row = JSON.parse(line);
        if (row.type === 'result') result = row;
        process.stdout.write(line);
      },
    },
    { ...process.env, INDUSTRIAL_HARNESS_CONFIG_DIR: path.join(outputDir, 'resource-settings') },
  );
  send({ type: 'benchmark_transport_result', result });
  return code;
}
module.exports = { main };
if (require.main === module)
  main()
    .then(code => {
      process.exitCode = code;
    })
    .catch(error => {
      process.stderr.write(String(error) + '\n');
      process.exitCode = 1;
    });
