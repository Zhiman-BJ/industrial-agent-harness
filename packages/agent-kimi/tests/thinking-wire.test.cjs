const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createSession } = require('../src/code-session.cjs');
const {
  validateProfile,
  configToml,
  sessionEnv,
  thinkingEffort,
} = require('../src/model-config.cjs');
const { startModel } = require('../../../tests/integration/fixtures/domain-mcp-model.cjs');

// Observe the real pinned runtime's HTTP bodies, including a second turn with
// reasoning history. Local responses exercise the wrapper, not vendor quality.
for (const mode of ['minimax-old-profile', 'compatible-default', 'kimi-on', 'kimi-off'])
  test(`native thinking request: ${mode}`, { timeout: 25000 }, async t => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-thinking-wire-'));
    const model = await startModel({
      calls: [],
      success: 'OK',
      thinking: mode.endsWith('off') ? undefined : 'Controlled reasoning',
    });
    const profile = validateProfile({
      provider: mode.startsWith('compatible') ? 'openai_legacy' : 'kimi',
      endpoint: mode.startsWith('minimax') ? 'https://api.minimaxi.com/v1' : model.endpoint,
      model: mode.startsWith('minimax') ? 'MiniMax-M3' : 'controlled',
      contextSize: 32768,
      thinking: !mode.endsWith('off'),
    });
    const local = { ...profile, endpoint: model.endpoint };
    fs.writeFileSync(
      path.join(directory, 'config.toml'),
      configToml(profile).replace(profile.endpoint, model.endpoint),
    );
    fs.writeFileSync(path.join(directory, 'mcp.json'), '{}');
    const session = createSession({
      workDir: directory,
      shareDir: directory,
      thinking: profile.thinking,
      thinkingEffort: thinkingEffort(profile),
      env: sessionEnv(local, 'synthetic-thinking-key'),
    });
    t.after(async () => {
      await session.close();
      model.close();
      // Windows may retain transient handles after the native process exits.
      // Retry removal for a bounded interval; persistent leaks still fail.
      fs.rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    });
    for (const prompt of ['Reply OK', 'Reply OK again']) {
      const turn = session.prompt(prompt);
      for await (const event of turn) void event;
      assert.equal((await turn.result).status, 'finished');
    }
    assert.equal(model.requests.length, 2);
    for (const body of model.requests) {
      assert.equal(body.stream, true);
      if (profile.provider === 'kimi') {
        assert.equal(body.thinking?.type, mode.endsWith('off') ? 'disabled' : 'enabled');
        // Upstream owns effort/keep lowering while replaying reasoning history.
        if (mode.endsWith('off')) assert.deepEqual(body.thinking, { type: 'disabled' });
      } else {
        assert.equal(
          body.thinking,
          undefined,
          'a generic API never receives the Moonshot thinking extension',
        );
        assert.notEqual(
          body.reasoning_effort,
          'high',
          'the wrapper does not impose a vendor-independent tier',
        );
      }
    }
    if (profile.provider === 'openai_legacy') {
      assert.equal(
        model.requests[0].reasoning_effort,
        undefined,
        'the initial request uses the service default',
      );
      // Kimi owns history lowering and may choose medium when reasoning is replayed.
      assert.equal(model.requests[1].reasoning_effort, 'medium');
    }
  });
