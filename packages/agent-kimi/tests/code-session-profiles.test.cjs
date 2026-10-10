const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createSession, bundledExecutable } = require('../src/code-session.cjs');
const { externalTools } = require('../src/index.cjs');
const { configToml, sessionEnv } = require('../src/model-config.cjs');
const { createProcessSandbox } = require('../src/process-sandbox.cjs');
const { materializeAgentProfiles, nativeAgentProfile } = require('../src/agent-profiles.cjs');
const { startModel } = require('../../../tests/integration/fixtures/domain-mcp-model.cjs');

async function fixture(
  t,
  { profiles = [], selected, snapshot, controlled = {}, protectedProject = false } = {},
) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-native-profiles-'));
  const project = path.join(root, 'project');
  const home = path.join(root, 'private-home');
  const agents = path.join(home, 'managed-agents');
  fs.mkdirSync(project);
  fs.mkdirSync(agents, { recursive: true, mode: 0o700 });
  for (const profile of profiles)
    fs.writeFileSync(
      path.join(agents, `${profile.name}.md`),
      `---\nname: ${profile.name}\ndescription: Controlled native profile\ntools: ${JSON.stringify(profile.tools ?? [])}\nsubagents: ${JSON.stringify(profile.subagents ?? [])}\n---\n\n\${base_prompt}\n\n${profile.marker}\n`,
      { mode: 0o600 },
    );
  const materialized =
    snapshot === undefined ? undefined : materializeAgentProfiles(snapshot, home);
  const model = await startModel({ calls: [], ...controlled });
  const modelProfile = {
    provider: 'openai_legacy',
    endpoint: model.endpoint,
    model: 'controlled',
    contextSize: 32768,
    thinking: false,
  };
  fs.writeFileSync(
    path.join(home, 'config.toml'),
    `extra_agent_dirs = [${JSON.stringify(materialized?.directory ?? agents)}]\n${configToml(modelProfile)}`,
  );
  fs.writeFileSync(path.join(home, 'mcp.json'), '{}');
  const env = sessionEnv(modelProfile, 'controlled-native-profile-key');
  const sandbox = protectedProject
    ? createProcessSandbox({
        executable: bundledExecutable(),
        shareDir: home,
        projectDir: project,
        environment: { ...process.env, ...env },
      })
    : undefined;
  const options = {
    workDir: sandbox?.workDir ?? project,
    projectDir: project,
    shareDir: home,
    executable: sandbox?.executable,
    env: sandbox?.env ?? env,
    agentProfile: materialized?.profile ?? selected,
  };
  const sessions = [];
  const create = overrides => {
    const session = createSession({ ...options, ...overrides });
    sessions.push(session);
    return session;
  };
  t.after(async () => {
    await Promise.all(sessions.map(session => session.close()));
    sandbox?.close();
    model.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { root, home, project, model, create, options };
}

async function run(session, prompt = 'Execute the controlled task') {
  const turn = session.prompt(prompt);
  const events = [];
  for await (const event of turn) {
    events.push(event);
    if (event.type === 'ApprovalRequest') await turn.approve(event.payload.id, 'approve');
  }
  assert.equal((await turn.result).status, 'finished');
  return events;
}

test(
  'native 2.1.1 selects a private agent profile before first model call and enforces its tool policy',
  { timeout: 20000 },
  async t => {
    const f = await fixture(t, {
      profiles: [{ name: 'profile-reader', tools: ['Read'], marker: 'PRIVATE_PROFILE_READER' }],
      selected: 'profile-reader',
      controlled: {
        calls: () => [
          {
            name: 'Bash',
            arguments: {
              command: `printf UNAUTHORIZED > ${JSON.stringify(path.join(f.project, 'forbidden.txt'))}`,
              description: 'Attempt a disabled tool',
            },
          },
        ],
      },
    });
    const session = f.create();
    const events = await run(session);
    const first = f.model.requests[0];
    assert.match(
      JSON.stringify(first.messages.filter(message => message.role === 'system')),
      /PRIVATE_PROFILE_READER/,
    );
    assert.ok(first.tools.some(tool => tool.function.name === 'Read'));
    assert.ok(!first.tools.some(tool => tool.function.name === 'Bash'));
    assert.equal(fs.existsSync(path.join(f.project, 'forbidden.txt')), false);
    assert.ok(
      events.some(event => event.type === 'ToolResult' && event.payload.return_value.is_error),
    );
    const identity = JSON.parse(fs.readFileSync(path.join(f.home, 'harness-native-session.json')));
    assert.equal(identity.agentProfile, 'profile-reader');
  },
);

test(
  'materialized native main profile with empty subagents rejects all delegation despite discovered profiles',
  { timeout: 20000 },
  async t => {
    const f = await fixture(t, {
      snapshot: {
        schemaVersion: 1,
        id: 'custom:isolated',
        profiles: [
          {
            id: 'custom:isolated',
            description: 'Controlled isolated profile',
            instructions: 'MATERIALIZED_ISOLATED_PROFILE',
            tools: ['Agent'],
            subagents: [],
          },
          {
            id: 'custom:discovered',
            description: 'Another discovered profile',
            instructions: 'MUST_NOT_RUN_CHILD',
            tools: [],
            subagents: [],
          },
        ],
      },
      controlled: {
        calls: [
          {
            name: 'Agent',
            arguments: {
              subagent_type: 'coder',
              prompt: 'Forbidden delegation',
              description: 'Check explicit empty delegation policy',
            },
          },
        ],
      },
    });
    const events = await run(f.create());
    assert.match(f.options.agentProfile, /^harness-[a-f0-9]{24}$/);
    assert.match(JSON.stringify(f.model.requests[0].messages), /MATERIALIZED_ISOLATED_PROFILE/);
    assert.ok(!events.some(event => event.type === 'SubagentState'));
    assert.ok(
      events.some(
        event =>
          event.type === 'ToolResult' &&
          /not allowed.*Allowed subagent types: none/s.test(event.payload.return_value.output),
      ),
    );
    assert.ok(
      f.model.requests.every(
        body =>
          !JSON.stringify(body.messages.filter(message => message.role === 'system')).includes(
            'MUST_NOT_RUN_CHILD',
          ),
      ),
    );
  },
);

test(
  'native profile identity survives resume and rejects a changed selection without another model request',
  { timeout: 30000 },
  async t => {
    const f = await fixture(t, {
      profiles: [
        { name: 'profile-one', marker: 'PROFILE_ONE_MARKER' },
        { name: 'profile-two', marker: 'PROFILE_TWO_MARKER' },
      ],
      selected: 'profile-one',
    });
    const first = f.create();
    await run(first, 'Remember the controlled first turn');
    const nativeId = first.nativeId;
    await first.close();
    const resumed = f.create({ sessionId: first.sessionId, resumeRequired: true });
    await run(resumed, 'Continue the controlled second turn');
    assert.equal(resumed.nativeId, nativeId);
    assert.match(
      JSON.stringify(f.model.requests.at(-1).messages),
      /Remember the controlled first turn/,
    );
    assert.match(JSON.stringify(f.model.requests.at(-1).messages), /PROFILE_ONE_MARKER/);
    await resumed.close();
    const count = f.model.requests.length;
    const changed = f.create({
      sessionId: first.sessionId,
      agentProfile: 'profile-two',
      resumeRequired: true,
    });
    await assert.rejects(changed.prompt('Never execute').result, /identity is incompatible/);
    assert.equal(f.model.requests.length, count);
  },
);

test(
  'legacy native identity without a profile still resumes the default agent',
  { timeout: 25000 },
  async t => {
    const f = await fixture(t);
    const first = f.create();
    await run(first, 'Default profile legacy history');
    await first.close();
    const file = path.join(f.home, 'harness-native-session.json');
    const identity = JSON.parse(fs.readFileSync(file));
    delete identity.agentProfile;
    fs.writeFileSync(file, JSON.stringify(identity));
    const resumed = f.create({ sessionId: first.sessionId, resumeRequired: true });
    await run(resumed);
    assert.equal(resumed.nativeId, first.nativeId);
    assert.match(
      JSON.stringify(f.model.requests.at(-1).messages),
      /Default profile legacy history/,
    );
  },
);

test(
  'missing native profile fails closed before inference instead of using the default',
  { timeout: 15000 },
  async t => {
    const f = await fixture(t, { selected: 'missing-profile' });
    await assert.rejects(f.create().prompt('Never execute').result, /Unknown agent profile/);
    assert.equal(f.model.requests.length, 0);
  },
);

test(
  'native custom child profile cannot bypass a revoked host Broker scope',
  { timeout: 25000 },
  async t => {
    let scope = { capabilityIds: ['chip.rtl.netlist.inspect'], tools: ['eda.netlist.inspect'] };
    let reads = 0;
    const isChild = body =>
      body.messages.some(
        message =>
          message.role === 'system' &&
          JSON.stringify(message.content).includes('PRIVATE_CHILD_PROFILE'),
      );
    const f = await fixture(t, {
      snapshot: {
        schemaVersion: 1,
        id: 'custom:coordinator',
        profiles: [
          {
            id: 'custom:coordinator',
            description: 'Controlled coordinator',
            instructions: 'PRIVATE_PARENT_PROFILE',
            tools: ['Agent'],
            subagents: ['pack:worker'],
          },
          {
            id: 'pack:worker',
            description: 'Controlled domain pack worker',
            instructions: 'PRIVATE_CHILD_PROFILE',
            tools: ['mcp__harness_adapter__*'],
            subagents: [],
          },
        ],
      },
      controlled: {
        stopOnRejection: false,
        calls: body => {
          if (isChild(body)) {
            scope = { capabilityIds: [], tools: [] };
            return [{ name: 'eda_netlist_inspect', arguments: { artifactId: 'artifact-1' } }];
          }
          return [
            {
              name: 'Agent',
              arguments: {
                prompt: 'Perform controlled worker task',
                description: 'Native configured child',
                subagent_type: nativeAgentProfile('pack:worker'),
              },
            },
          ];
        },
        success: body => (isChild(body) ? 'CHILD_FINISHED' : 'PARENT_FINISHED'),
      },
    });
    const session = f.create({
      externalTools: externalTools(
        () => scope,
        async () => {
          reads++;
          return { kind: 'netlist' };
        },
        () => ({}),
      ),
    });
    const events = await run(session);
    assert.ok(f.model.requests.some(isChild), 'Kimi executed the configured child profile');
    assert.equal(reads, 0);
    const childToolResults = f.model.requests
      .filter(isChild)
      .flatMap(body => body.messages.filter(message => message.role === 'tool'));
    assert.match(JSON.stringify(childToolResults), /outside the current Broker scope/);
    assert.ok(events.some(event => event.type === 'SubagentState'));
  },
);

test(
  'native custom profile retains the protected project process boundary',
  { timeout: 20000, skip: process.platform === 'win32' },
  async t => {
    const f = await fixture(t, {
      profiles: [{ name: 'profile-shell', marker: 'PROTECTED_PROFILE', tools: ['Bash'] }],
      selected: 'profile-shell',
      protectedProject: true,
      controlled: {
        calls: () => [
          {
            name: 'Bash',
            arguments: {
              command: `printf UNAUTHORIZED > ${JSON.stringify(path.join(f.project, 'forbidden.txt'))}`,
              description: 'Attempt direct project mutation',
            },
          },
        ],
      },
    });
    const events = await run(f.create());
    assert.equal(fs.existsSync(path.join(f.project, 'forbidden.txt')), false);
    assert.ok(
      events.some(
        event =>
          event.type === 'ToolResult' &&
          /not permitted|permission denied|read-only/i.test(event.payload.return_value.output),
      ),
    );
  },
);
