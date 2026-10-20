const fs = require('node:fs');
const path = require('node:path');
const {
  ProjectInitializeRequestSchema,
  ProjectFileReadRequestSchema,
  ProjectFileApplyRequestSchema,
  ProjectTaskRunRequestSchema,
  ProjectTaskCheckReportSchema,
  ProjectPathSchema,
  ProjectTaskManifestSchema,
} = require('@industrial-agent-harness/contracts');
const {
  hash,
  projectFile,
  createInputIndexer,
  applyFiles,
  manifest,
  runDirectory,
  readBytes,
} = require('./workspace-files.cjs');
const { executeTask } = require('./task-process.cjs');
const { bindSnapshotResult } = require('./evidence-inputs.cjs');
const { preflight } = require('./preflight.cjs');
const VERSION = '1.0.0';
const fileVerifier = 'project.files.integrity',
  taskVerifier = 'project.task.checks';
const json = value => JSON.stringify(value, null, 2) + '\n';
function editPreview(projectDir, changes, protectedPaths) {
  const summary = changes.map(
    change =>
      `${change.content === null ? 'Delete' : change.expectedSha256 === null ? 'Create' : 'Modify'} ${change.path}`,
  );
  const diffs = changes.map(change => {
    const file = projectFile(projectDir, change.path, protectedPaths);
    const before = fs.existsSync(file) ? readBytes(file).toString('utf8').split('\n') : [];
    const after = change.content === null ? [] : change.content.split('\n');
    let start = 0,
      end = 0;
    while (start < before.length && start < after.length && before[start] === after[start]) start++;
    while (
      end < before.length - start &&
      end < after.length - start &&
      before[before.length - end - 1] === after[after.length - end - 1]
    )
      end++;
    const from = Math.max(0, start - 3),
      tail = Math.min(end, 3);
    return (
      `--- ${change.path} (current)\n+++ ${change.path} (proposed)\n` +
      before
        .slice(from, start)
        .map(line => ' ' + line)
        .concat(
          before.slice(start, before.length - end).map(line => '-' + line),
          after.slice(start, after.length - end).map(line => '+' + line),
          after.slice(after.length - end, after.length - end + tail).map(line => ' ' + line),
        )
        .join('\n')
    );
  });
  return {
    title: `Edit ${changes.length} project files`,
    text: summary.join('\n') + '\n\n' + diffs.join('\n\n'),
  };
}
const guides = {
  'project.environment.inspect': {
    inputs: {},
    description:
      'Check protected local execution, declared executables, dependency directories and offline Docker images without a model request or engineering acceptance.',
  },
  'project.initialize': {
    inputs: { name: 'string' },
    description:
      'Create harness.project.json and an empty harness.tasks.json without replacing existing files. This does not establish an engineering stage.',
  },
  'project.files.read': {
    inputs: { path: 'optional project-relative POSIX file path' },
    description:
      'With no path, list input file hashes. With path, return a UTF-8 file and its SHA-256 as a report artifact (256 KiB limit). Read the report with industrial_artifact_read.',
  },
  'project.files.apply': {
    inputs: {
      changes: [
        {
          path: 'src/example.js',
          content: 'complete new contents, or null to delete',
          expectedSha256: 'current SHA-256, or null for exclusive creation',
        },
      ],
    },
    description:
      'Apply up to 32 approved edits after checking every file precondition. Runtime/evidence/dependency paths and symlinks are refused. Read the current file hash first. Edits invalidate prior acceptance; they do not verify the design.',
  },
  'project.tasks.inspect': {
    inputs: {},
    description:
      'Read the declared harness.tasks.json, its normalized task definitions and any manifest error as a report artifact.',
  },
  'project.task.run': {
    inputs: { task: 'declared task name' },
    description:
      'Execute only a task declared in harness.tasks.json. command is an argv array, inputs are exact source/test file paths, outputs are paths relative to a fresh output directory. Use {input} and {output} placeholders or HARNESS_INPUT_DIR/HARNESS_OUTPUT_DIR. Local tasks are offline with a read-only host/input boundary; Docker tasks use a preinstalled image and resource limits. timeoutMs is bounded. verification={kind:"checks-json",path:"checks.json"} reads a fresh report {schemaVersion:"1",checks:[{name:"assertion",passed:true}]}. Only these declared checks are accepted; process exit alone does not verify a task or a complete product.',
  },
};
function receipt(projectDir, action, kind, value) {
  const directory = runDirectory(projectDir, action.id);
  const file = path.join(directory, 'receipt.json');
  fs.writeFileSync(file, json(value), { mode: 0o600 });
  return {
    executionSucceeded: true,
    artifacts: [{ kind, file }],
    diagnostics: [],
    toolVersion: VERSION,
  };
}
function outputFile(work, relative) {
  ProjectPathSchema.parse(relative);
  let current = work;
  for (const part of relative.split('/')) {
    current = path.join(current, part);
    const stat = fs.lstatSync(current, { throwIfNoEntry: false });
    if (!stat) return null;
    if (stat.isSymbolicLink()) throw Error('Task outputs cannot contain symlinks.');
    if (current !== path.join(work, ...relative.split('/')) && !stat.isDirectory())
      throw Error('Invalid output parent.');
  }
  const stat = fs.statSync(current);
  if (!stat.isFile() || stat.nlink !== 1 || stat.size > 64 * 1024 * 1024)
    throw Error('Task output must be a bounded ordinary file.');
  return current;
}
function createWorkspacePlugin({
  domain,
  environment = process.env,
  protectedPaths = [],
  inspectionDiagnostics = () => [],
}) {
  const indexer = createInputIndexer();
  const tool = (id, risk, execute, effect) => ({
    descriptor: {
      schemaVersion: '1',
      id,
      version: VERSION,
      risk,
      ...(effect ? { effect } : {}),
      verification: risk === 'read-only' ? [] : [effect === 'inputs' ? fileVerifier : taskVerifier],
    },
    guide: guides[id],
    preview: ({ projectDir, inputs }) => {
      if (id === 'project.files.apply')
        return editPreview(
          projectDir,
          ProjectFileApplyRequestSchema.parse(inputs).changes,
          protectedPaths,
        );
      if (id === 'project.task.run') {
        const request = ProjectTaskRunRequestSchema.parse(inputs),
          task = manifest(projectDir, protectedPaths).tasks[request.task];
        return {
          title: `Run task ${request.task}`,
          text: json(task || { error: 'Task is not declared.' }),
        };
      }
      return { title: guides[id].description, text: json(inputs) };
    },
    execute,
  });
  return {
    stateProvider: async ({ projectDir }) => ({
      stage: null,
      inputHashes: await indexer.index(projectDir, protectedPaths),
    }),
    tools: [
      tool('project.environment.inspect', 'read-only', context => {
        if (Object.keys(context.inputs).length)
          throw Error('Environment inspection accepts an empty inputs object.');
        return preflight(context, environment, protectedPaths);
      }),
      tool(
        'project.initialize',
        'mutating',
        ({ projectDir, inputs, action }) => {
          const request = ProjectInitializeRequestSchema.parse(inputs);
          const changes = [
            {
              path: 'harness.project.json',
              content: json({ schemaVersion: '1', name: request.name }),
              expectedSha256: null,
            },
            ...(!fs.existsSync(path.join(projectDir, 'harness.tasks.json'))
              ? [
                  {
                    path: 'harness.tasks.json',
                    content: json({ schemaVersion: '1', tasks: {} }),
                    expectedSha256: null,
                  },
                ]
              : []),
          ];
          return receipt(projectDir, action, 'report.files', {
            changes: applyFiles(projectDir, changes, protectedPaths),
          });
        },
        'inputs',
      ),
      tool('project.files.read', 'read-only', async ({ projectDir, inputs, action }) => {
        const request = ProjectFileReadRequestSchema.parse(inputs);
        let value;
        if (request.path) {
          const bytes = readBytes(projectFile(projectDir, request.path, protectedPaths));
          value = {
            path: request.path,
            sha256: hash(bytes),
            content: new TextDecoder('utf-8', { fatal: true }).decode(bytes),
          };
        } else
          value = {
            files: await indexer.index(projectDir, protectedPaths),
            diagnostics: indexer.diagnostics,
          };
        return receipt(projectDir, action, 'report.files', value);
      }),
      tool(
        'project.files.apply',
        'mutating',
        ({ projectDir, inputs, action }) => {
          const request = ProjectFileApplyRequestSchema.parse(inputs);
          const changes = applyFiles(projectDir, request.changes, protectedPaths);
          const result = receipt(projectDir, action, 'report.files', { changes });
          const outputs = changes.filter(change => change.sha256 !== null);
          result.artifacts.push(
            ...outputs.map((change, index) => ({
              localId: `file-${index}`,
              file: change.path,
              kind: 'file.project',
              sha256: change.sha256,
            })),
          );
          result.presentation = {
            schemaVersion: '1',
            groups: outputs.map((change, index) => ({
              key: `file-${index}`,
              title: change.path,
              primary: `file-${index}`,
              preview: `file-${index}`,
              ...(change.beforeSha256
                ? { supersedesInput: { relativePath: change.path, sha256: change.beforeSha256 } }
                : {}),
            })),
          };
          return result;
        },
        'inputs',
      ),
      tool('project.tasks.inspect', 'read-only', ({ projectDir, inputs, action }) => {
        if (Object.keys(inputs).length)
          throw Error('Task inspection accepts an empty inputs object.');
        let value;
        try {
          value = { manifest: manifest(projectDir, protectedPaths) };
        } catch (error) {
          value = { error: error.message };
        }
        return receipt(projectDir, action, 'report.tasks', {
          ...value,
          inspectionDiagnostics: [...indexer.diagnostics, ...inspectionDiagnostics()],
        });
      }),
      tool(
        'project.task.run',
        'mutating',
        async ({ projectDir, inputs, action, state, signal }) => {
          const request = ProjectTaskRunRequestSchema.parse(inputs);
          const manifestBytes = readBytes(
            projectFile(projectDir, 'harness.tasks.json', protectedPaths),
          );
          if (hash(manifestBytes) !== state.inputHashes['harness.tasks.json'])
            throw Error('Task declaration differs from the approved input state.');
          const task = ProjectTaskManifestSchema.parse(JSON.parse(manifestBytes.toString('utf8')))
            .tasks[request.task];
          if (!task) throw Error('Task is not declared in harness.tasks.json.');
          const directory = runDirectory(projectDir, action.id),
            input = path.join(directory, 'input'),
            work = path.join(directory, 'work');
          fs.mkdirSync(input);
          fs.mkdirSync(work);
          for (const name of task.inputs) {
            const bytes = readBytes(
              projectFile(projectDir, name, protectedPaths),
              64 * 1024 * 1024,
            );
            if (!state.inputHashes[name] || hash(bytes) !== state.inputHashes[name])
              throw Error('Declared task input differs from the bound state: ' + name);
            const copy = path.join(input, ...name.split('/'));
            fs.mkdirSync(path.dirname(copy), { recursive: true });
            fs.writeFileSync(copy, bytes, {
              mode:
                fs.statSync(projectFile(projectDir, name, protectedPaths)).mode & 0o111
                  ? 0o500
                  : 0o400,
            });
          }
          let execution;
          try {
            execution = await executeTask(task, {
              directory,
              input,
              work,
              actionId: action.id,
              environment,
              signal,
            });
          } catch (error) {
            execution = {
              status: 'START_FAILED',
              exitCode: null,
              log: error.message,
              runtime: task.runtime,
            };
          }
          const log = path.join(directory, 'task.log'),
            report = path.join(directory, 'execution.json');
          fs.writeFileSync(log, execution.log || '');
          const { log: ignored, ...observed } = execution;
          fs.writeFileSync(
            report,
            json({
              schemaVersion: '1',
              task: request.task,
              ...observed,
              inputHashes: action.inputHashes,
              declaredVerification: task.verification || null,
            }),
          );
          const artifacts = [
              { kind: 'log.task', file: log },
              { kind: 'report.execution', file: report },
            ],
            diagnostics = [];
          let snapshotIntact = true;
          for (const name of task.inputs) {
            try {
              if (
                fs.lstatSync(input).isSymbolicLink() ||
                hash(readBytes(projectFile(input, name), 64 * 1024 * 1024)) !==
                  state.inputHashes[name]
              )
                throw Error('Snapshot content differs from the recorded input.');
            } catch {
              snapshotIntact = false;
              diagnostics.push('Captured task input changed or became unavailable: ' + name);
            }
          }
          for (const output of [
            ...task.outputs,
            ...(task.verification
              ? [{ path: task.verification.path, kind: 'report.task-checks' }]
              : []),
          ]) {
            try {
              const file = outputFile(work, output.path);
              if (file) artifacts.push({ ...output, file });
              else diagnostics.push('Missing declared output: ' + output.path);
            } catch (error) {
              diagnostics.push(error.message);
            }
          }
          const result = {
            executionSucceeded: execution.status === 'COMPLETED' && snapshotIntact,
            inputSnapshotChanged: !snapshotIntact,
            artifacts,
            diagnostics,
            toolVersion: execution.identity?.imageId || execution.identity?.sha256 || VERSION,
          };
          return snapshotIntact ? bindSnapshotResult(result, action) : result;
        },
      ),
    ],
    verifiers: {
      [fileVerifier]: () => ({
        status: 'not_run',
        reason:
          'Input changes were recorded. Engineering verification must be rerun for the new inputs.',
        metrics: {},
      }),
      [taskVerifier]: ({ artifacts, readArtifact, result }) => {
        const assessed = (status, reason, metrics = {}) => ({ status, reason, metrics });
        if (result.inputSnapshotChanged)
          return assessed(
            'insufficient_evidence',
            'Captured task inputs changed during execution; the reported checks cannot be bound to the recorded inputs.',
          );
        const execution = JSON.parse(
          readArtifact(artifacts.find(a => a.kind === 'report.execution')).toString('utf8'),
        );
        if (!['COMPLETED', 'FAILED'].includes(execution.status))
          return assessed(
            'insufficient_evidence',
            'Task execution did not complete: ' + execution.status,
          );
        if (!execution.declaredVerification)
          return assessed(
            'not_run',
            'Task has no declared checks report; exit code is execution evidence only.',
          );
        const check = artifacts.find(a => a.kind === 'report.task-checks');
        if (!check)
          return assessed('insufficient_evidence', 'The fresh declared checks report is missing.');
        let data;
        try {
          data = ProjectTaskCheckReportSchema.parse(
            JSON.parse(readArtifact(check).toString('utf8')),
          );
        } catch {
          return assessed('insufficient_evidence', 'The declared checks report is malformed.');
        }
        const passed =
          data.checks.every(check => check.passed) &&
          execution.exitCode === 0 &&
          !result.diagnostics.length;
        return assessed(
          passed ? 'passed' : 'failed',
          passed
            ? 'All declared task checks passed. This accepts these checks only, not complete domain sign-off.'
            : 'Declared task checks or execution failed.',
          {
            checks: data.checks.length,
            passedChecks: data.checks.filter(check => check.passed).length,
          },
        );
      },
    },
    capabilities: [
      {
        id: 'project.workspace',
        domain,
        title: 'Project workspace and declared tasks',
        stages: [],
        alwaysAvailable: true,
        priority: 0,
        keywords: [
          'project',
          'task',
          'file',
          'initialize',
          'edit',
          'test',
          '工程',
          '创建',
          '修改',
          '运行',
          '测试',
        ],
        skills: [
          {
            id: 'project.work',
            summary: 'Initialize, edit, run declared checks, repair and retain evidence.',
          },
        ],
        tools: Object.keys(guides).map(id => ({ id, summary: guides[id].description })),
        verification: [fileVerifier, taskVerifier],
      },
    ],
  };
}
module.exports = { createWorkspacePlugin };
