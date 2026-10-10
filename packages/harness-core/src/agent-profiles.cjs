const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const { AgentDefinitionSchema } = require('@industrial-agent-harness/contracts');
const { defaultResourceDirectory } = require('./resource-settings.cjs');

const DEFAULT_AGENT_ID = 'builtin:default';
const builtins = [
  ['default', 'Default agent', 'General assistant with the standard tools and delegation.'],
  ['coder', 'Coder', 'Implement and check changes using the available tools.'],
  ['explore', 'Explorer', 'Read and investigate without editing files.'],
  ['plan', 'Planner', 'Develop an implementation plan before making changes.'],
].map(([id, name, description]) => ({
  id: `builtin:${id}`,
  name,
  description,
  instructions: '',
  domain: '*',
  source: 'builtin',
  editable: false,
}));
const copy = value => JSON.parse(JSON.stringify(value));
const digest = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const definition = value =>
  AgentDefinitionSchema.parse(
    Object.fromEntries(
      [
        'id',
        'name',
        'description',
        'instructions',
        'domain',
        'tools',
        'disallowedTools',
        'skills',
        'subagents',
      ]
        .filter(key => value[key] !== undefined)
        .map(key => [key, value[key]]),
    ),
  );
function view(value) {
  const content = definition(value);
  return {
    ...content,
    source: value.source,
    editable: value.source === 'custom',
    ...(value.packId ? { packId: value.packId, packVersion: value.packVersion } : {}),
    revision: digest({
      ...content,
      source: value.source,
      packId: value.packId,
      packVersion: value.packVersion,
    }),
  };
}
function projectKey(project) {
  return digest([fs.realpathSync(project.path), project.domain]);
}

class AgentProfiles {
  constructor(directory = defaultResourceDirectory()) {
    this.file = path.join(directory, 'agent-profiles.json');
  }
  read() {
    if (!fs.existsSync(this.file)) return { schemaVersion: 1, agents: [], defaults: {} };
    if (fs.lstatSync(this.file).isSymbolicLink())
      throw Error('Agent configuration cannot be a symbolic link.');
    const saved = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    if (
      saved?.schemaVersion !== 1 ||
      !Array.isArray(saved.agents) ||
      saved.agents.length > 128 ||
      !saved.defaults ||
      Array.isArray(saved.defaults) ||
      typeof saved.defaults !== 'object' ||
      Object.values(saved.defaults).some(value => typeof value !== 'string')
    )
      throw Error('Invalid Agent configuration.');
    const ids = new Set();
    for (const agent of saved.agents) {
      AgentDefinitionSchema.parse(agent);
      if (!/^custom:[a-f0-9-]{36}$/.test(agent.id) || ids.has(agent.id))
        throw Error('Invalid custom Agent identity.');
      ids.add(agent.id);
    }
    return saved;
  }
  write(saved) {
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const temporary = `${this.file}.${crypto.randomUUID()}.tmp`;
    try {
      fs.writeFileSync(temporary, JSON.stringify(saved, null, 2) + '\n', {
        flag: 'wx',
        mode: 0o600,
      });
      fs.renameSync(temporary, this.file);
    } finally {
      fs.rmSync(temporary, { force: true });
    }
  }
  mutate(action) {
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const lockFile = `${this.file}.lock.sqlite`;
    if (fs.existsSync(lockFile) && fs.lstatSync(lockFile).isSymbolicLink())
      throw Error('Agent configuration lock cannot be a symbolic link.');
    // An OS-backed SQLite lock serializes Desktop/CLI read-modify-write operations
    // and releases automatically if a process crashes, without stale PID lockfiles.
    const lock = new DatabaseSync(lockFile);
    try {
      fs.chmodSync(lockFile, 0o600);
      lock.exec('PRAGMA busy_timeout = 5000; BEGIN IMMEDIATE');
      const saved = this.read();
      const result = action(saved);
      this.write(saved);
      lock.exec('COMMIT');
      return result;
    } finally {
      lock.close();
    }
  }
  catalog(registry, project, saved = this.read()) {
    const agents = [
      ...builtins,
      ...(registry.agents || []).map(agent => ({ ...agent, source: 'pack' })),
      ...saved.agents.map(agent => ({ ...agent, source: 'custom' })),
    ].map(view);
    if (new Set(agents.map(agent => agent.id)).size !== agents.length)
      throw Error('Duplicate Agent identity.');
    return {
      agents: agents.filter(
        agent => !project || agent.domain === '*' || agent.domain === project.domain,
      ),
      defaultAgentId: project?.path
        ? saved.defaults[projectKey(project)] || DEFAULT_AGENT_ID
        : DEFAULT_AGENT_ID,
      skills: (registry.skills || [])
        .filter(skill => !project || skill.domain === '*' || skill.domain === project.domain)
        .map(({ id, title, domain }) => ({ id, title, domain })),
    };
  }
  snapshot(registry, project, id, saved) {
    const catalog = this.catalog(registry, project, saved);
    const selected = id || catalog.defaultAgentId;
    const profiles = [],
      visiting = new Set(),
      done = new Set();
    const visit = id => {
      if (visiting.has(id)) throw Error('Agent delegation contains a cycle.');
      if (done.has(id)) return;
      const agent = catalog.agents.find(item => item.id === id);
      if (!agent)
        throw Error(`Agent is unavailable for this project: ${id}. Choose another Agent.`);
      if (agent.skills?.some(id => !catalog.skills.some(skill => skill.id === id)))
        throw Error(`Agent ${agent.name} references an unavailable skill.`);
      visiting.add(id);
      profiles.push(agent);
      for (const child of agent.subagents || []) visit(child);
      visiting.delete(id);
      done.add(id);
    };
    visit(selected);
    const agent = profiles[0];
    return {
      schemaVersion: 1,
      id: selected,
      name: agent.name,
      source: agent.source,
      revision: digest(profiles),
      profiles: copy(profiles),
    };
  }
  save(registry, input) {
    return this.mutate(saved => {
      const id = input?.id || `custom:${crypto.randomUUID()}`;
      if (input?.id && !saved.agents.some(agent => agent.id === id))
        throw Error('Only custom Agents can be edited.');
      const agent = AgentDefinitionSchema.parse({ ...input, id });
      if (agent.domain !== '*' && !registry.domains.some(domain => domain.id === agent.domain))
        throw Error('Choose a valid Agent domain.');
      saved.agents = [...saved.agents.filter(item => item.id !== id), agent];
      if (saved.agents.length > 128) throw Error('Custom Agent limit reached.');
      const affected = new Set([id]);
      for (let count = -1; count !== affected.size; ) {
        count = affected.size;
        for (const candidate of saved.agents)
          if (candidate.subagents?.some(child => affected.has(child))) affected.add(candidate.id);
      }
      // '*' is an actual validation scope, independent of installed domain count.
      // Recheck parents so changing a child's domain cannot invalidate their graph.
      for (const candidate of saved.agents.filter(item => affected.has(item.id)))
        this.snapshot(registry, { domain: candidate.domain }, candidate.id, saved);
      return view({ ...agent, source: 'custom' });
    });
  }
  remove(id) {
    this.mutate(saved => {
      if (!saved.agents.some(agent => agent.id === id))
        throw Error('Only custom Agents can be deleted.');
      if (saved.agents.some(agent => agent.subagents?.includes(id)))
        throw Error('Remove this Agent from other Agents before deleting it.');
      saved.agents = saved.agents.filter(agent => agent.id !== id);
      for (const key of Object.keys(saved.defaults))
        if (saved.defaults[key] === id) delete saved.defaults[key];
    });
  }
  setDefault(registry, project, id) {
    return this.mutate(saved => {
      this.snapshot(registry, project, id, saved);
      saved.defaults[projectKey(project)] = id;
      return this.catalog(registry, project, saved);
    });
  }
}

module.exports = { AgentProfiles, DEFAULT_AGENT_ID };
