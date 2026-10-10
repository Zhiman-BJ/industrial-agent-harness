const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const builtinProfiles = new Map([
  ['builtin:default', 'agent'],
  ['builtin:coder', 'coder'],
  ['builtin:explore', 'explore'],
  ['builtin:plan', 'plan'],
]);

// Common native tools offered by the editor. These only restrict the agent's
// available tools; industrial authorization remains with the Capability Broker.
const agentToolCatalog = Object.freeze(
  [
    ['Read', 'Read files'],
    ['Write', 'Write files'],
    ['Edit', 'Edit files'],
    ['Glob', 'Find files'],
    ['Grep', 'Search file contents'],
    ['Bash', 'Run shell commands'],
    ['ReadMediaFile', 'Read images and media'],
    ['Skill', 'Use skills'],
    ['WebSearch', 'Search the web'],
    ['FetchURL', 'Read web pages'],
    ['TodoList', 'Track task steps'],
    ['AskUserQuestion', 'Ask the user'],
    ['NotifyUser', 'Send progress updates'],
    ['Agent', 'Delegate to agents'],
    ['TaskList', 'List background tasks'],
    ['TaskOutput', 'Read task output'],
    ['TaskStop', 'Stop a task'],
    ['WaitFor', 'Wait for tasks'],
    ['EnterPlanMode', 'Enter planning mode'],
    ['ExitPlanMode', 'Finish planning'],
    ['mcp__*', 'MCP tools within the authorized scope'],
  ].map(([id, label]) => Object.freeze({ id, label })),
);
// Retain the complete Kimi Code 2.1.1 registration set for existing profiles and
// Domain Packs, including feature-gated tools that are not editor suggestions.
// Naming a tool here does not enable its underlying native feature.
const knownTools = new Set([
  ...agentToolCatalog.map(tool => tool.id),
  'AgentSwarm',
  'CreateGoal',
  'GetGoal',
  'SetGoalBudget',
  'UpdateGoal',
  'CronCreate',
  'CronList',
  'CronDelete',
  'select_tools',
  'TowerInit',
  'TowerPlan',
  'TowerSpawn',
  'TowerMerge',
  'TowerTeardown',
  'TowerSend',
  'TowerInbox',
  'TowerFinding',
  'TowerReview',
  'TowerMission',
  'TowerStatus',
]);

function validateAgentTools(profile) {
  if (!profile || typeof profile !== 'object') throw Error('Invalid Agent profile.');
  for (const field of ['tools', 'disallowedTools']) {
    const values = profile[field];
    if (values === undefined) continue;
    if (!Array.isArray(values) || values.length > 128 || new Set(values).size !== values.length)
      throw Error(`Agent ${field} must be a list of unique tool names.`);
    for (const value of values) {
      if (value === '*' && field === 'tools' && values.length === 1) continue;
      const mcp =
        typeof value === 'string' && /^mcp__[A-Za-z0-9_.*-]+__[A-Za-z0-9_.*-]+$/.test(value);
      if (typeof value !== 'string' || value.length > 160 || (!knownTools.has(value) && !mcp))
        throw Error(`Unsupported Kimi Code 2.1.1 tool in ${field}: ${String(value)}.`);
    }
  }
  return profile;
}

function nativeAgentProfile(id = 'builtin:default') {
  return (
    builtinProfiles.get(id) ??
    `harness-${crypto.createHash('sha256').update(id).digest('hex').slice(0, 24)}`
  );
}

function materializeAgentProfiles(snapshot, directory) {
  if (snapshot === undefined || snapshot === null) return { profile: 'agent' };
  if (
    snapshot.schemaVersion !== 1 ||
    typeof snapshot.id !== 'string' ||
    !Array.isArray(snapshot.profiles) ||
    snapshot.profiles.length === 0
  )
    throw Error('Invalid Agent snapshot.');
  const profiles = new Map();
  for (const profile of snapshot.profiles) {
    if (
      !profile ||
      typeof profile.id !== 'string' ||
      !/^[a-z][a-z0-9:._-]{0,127}$/.test(profile.id) ||
      profiles.has(profile.id) ||
      typeof profile.instructions !== 'string' ||
      typeof profile.description !== 'string' ||
      !profile.description.trim()
    )
      throw Error('Invalid or duplicate Agent snapshot profile.');
    validateAgentTools(profile);
    if (profile.id.startsWith('builtin:')) {
      if (
        !builtinProfiles.has(profile.id) ||
        profile.instructions !== '' ||
        ['tools', 'disallowedTools', 'skills', 'subagents'].some(key => profile[key] !== undefined)
      )
        throw Error(
          'Built-in Agents are read-only. Create a custom Agent to change its configuration.',
        );
    }
    if (
      profile.subagents !== undefined &&
      (!Array.isArray(profile.subagents) ||
        new Set(profile.subagents).size !== profile.subagents.length)
    )
      throw Error('Agent subagents must be a list of unique Agent IDs.');
    profiles.set(profile.id, profile);
  }
  if (!profiles.has(snapshot.id)) throw Error('Selected Agent is absent from the snapshot.');
  for (const profile of profiles.values())
    for (const id of profile.subagents ?? [])
      if (!profiles.has(id)) throw Error(`Agent snapshot is missing subagent ${String(id)}.`);
  const files = [...profiles.values()]
    .filter(profile => !builtinProfiles.has(profile.id))
    .map(profile => {
      const fields = [
        `name: ${nativeAgentProfile(profile.id)}`,
        `description: ${JSON.stringify(profile.description)}`,
      ];
      for (const key of ['tools', 'disallowedTools'])
        if (profile[key] !== undefined) fields.push(`${key}: ${JSON.stringify(profile[key])}`);
      if (profile.subagents !== undefined)
        fields.push(`subagents: ${JSON.stringify(profile.subagents.map(nativeAgentProfile))}`);
      return {
        name: `${nativeAgentProfile(profile.id)}.md`,
        text: `---\n${fields.join('\n')}\n---\n\n\${base_prompt}\n\n${profile.instructions}\n`,
      };
    });
  if (files.length === 0) return { profile: nativeAgentProfile(snapshot.id) };
  const output = path.join(directory, 'managed-agent-profiles');
  if (fs.lstatSync(directory).isSymbolicLink())
    throw Error('Agent session directory cannot be a symbolic link.');
  try {
    const stat = fs.lstatSync(output);
    if (!stat.isDirectory() || stat.isSymbolicLink())
      throw Error('Agent profile output must be a private directory, not a symbolic link.');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    fs.mkdirSync(output, { mode: 0o700 });
  }
  const existing = fs.readdirSync(output);
  for (const name of existing) {
    const stat = fs.lstatSync(path.join(output, name));
    if (!stat.isFile() || stat.isSymbolicLink())
      throw Error('Agent profile output cannot contain symbolic links or nested directories.');
  }
  for (const name of existing) fs.unlinkSync(path.join(output, name));
  fs.chmodSync(output, 0o700);
  for (const file of files)
    fs.writeFileSync(path.join(output, file.name), file.text, { flag: 'wx', mode: 0o600 });
  return { directory: output, profile: nativeAgentProfile(snapshot.id) };
}

module.exports = {
  materializeAgentProfiles,
  nativeAgentProfile,
  agentToolCatalog,
  validateAgentTools,
};
