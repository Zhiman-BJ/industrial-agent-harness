#!/usr/bin/env node
// Test-only model: the packaged Kimi loop and scoped Runtime execute the real
// tools. This server does not install Packs, write readiness or verify results.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { startModel } = require('../tests/integration/fixtures/domain-mcp-model.cjs');

async function main() {
  const project = path.resolve(process.argv[2] || '');
  const evidence = path.resolve(process.argv[3] || '');
  if (!process.argv[2] || !process.argv[3])
    throw Error('Usage: qa-fresh-desktop-model.cjs PROJECT EVIDENCE');
  const scene = path.join(project, 'main.tscn');
  if (!fs.statSync(scene).isFile()) throw Error('Use a real structural Godot project.');
  // Atomically claim a fresh run directory; never replace a previous transcript.
  fs.mkdirSync(evidence);
  const requestSummaries = [];
  const server = await startModel({
    perPrompt: true,
    success: 'QA_NATIVE_TOOL_FINISHED: inspect the recorded engineering verification.',
    calls: body => {
      const task =
        JSON.stringify(
          body.messages.findLast(
            message =>
              message.role === 'user' &&
              /QA_(?:VERIFY|EDIT|REVERIFY|CUDA_STATUS)/.test(JSON.stringify(message)),
          ),
        ) || '';
      const state = JSON.stringify(body.messages)
        .match(/expectedStateId=([a-f0-9-]{36})/g)
        ?.at(-1)
        ?.split('=')[1];
      requestSummaries.push({
        at: new Date().toISOString(),
        task,
        state,
        tools: body.tools?.map(tool => tool.function.name),
      });
      fs.writeFileSync(
        path.join(evidence, 'model-requests.json'),
        JSON.stringify(requestSummaries, null, 2),
      );
      if (!state) return [];
      const edit = task.includes('QA_EDIT');
      const cuda = task.includes('QA_CUDA_STATUS');
      const toolId = cuda
        ? 'project.environment.inspect'
        : edit
          ? 'godot.scene.edit'
          : 'godot.scene.verify';
      const inputs = cuda
        ? {}
        : edit
          ? {
              file: 'main.tscn',
              expectedSha256: crypto
                .createHash('sha256')
                .update(fs.readFileSync(scene))
                .digest('hex'),
              changes: [
                {
                  section: 'resource:Box_1',
                  property: 'size',
                  value: { type: 'Vector3', value: [4, 5, 6] },
                },
              ],
            }
          : {
              file: 'main.tscn',
              frames: 12,
              expect: [
                {
                  node: 'Box',
                  property: 'mesh_size',
                  value: task.includes('QA_REVERIFY') ? [4, 5, 6] : [2, 3, 4],
                },
              ],
            };
      return [
        { name: 'industrial_tool_describe', arguments: { toolId } },
        { name: 'industrial_action_call', arguments: { toolId, inputs, expectedStateId: state } },
      ];
    },
  });
  const context = {
    endpoint: server.endpoint,
    model: 'qa-controlled-godot',
    project,
    controlledModel: true,
    runtimeMocked: false,
  };
  fs.writeFileSync(path.join(evidence, 'model-server.json'), JSON.stringify(context, null, 2));
  console.log(JSON.stringify(context));
  const close = () => {
    server.close();
    process.exit(0);
  };
  process.on('SIGTERM', close);
  process.on('SIGINT', close);
}
main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
