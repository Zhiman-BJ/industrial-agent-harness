const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

function defaultResourceDirectory(environment = process.env) {
  return environment.INDUSTRIAL_HARNESS_CONFIG_DIR || path.join(os.homedir(), '.industrial-agent-harness');
}
function projectKey(directory) {return crypto.createHash('sha256').update(fs.realpathSync(directory)).digest('hex');}
function emptyOverrides() {return {skills: {}, mcpServers: {}};}
function effectiveResourcePolicy(catalog, global = {}, overrides = emptyOverrides()) {
  const result = {skills: [], mcpServers: []};
  for (const kind of ['skills', 'mcpServers']) {
    const disabled = new Set(global[kind] || []);
    result[kind] = catalog[kind].filter(item => {
      const explicit = overrides[kind]?.[item.id];
      return explicit === false || (explicit !== true && (disabled.has(item.id) || item.enabledByDefault === false));
    }).map(item => item.id).sort();
  }
  return result;
}

class ResourceSettings {
  constructor(directory = defaultResourceDirectory()) {this.file = path.join(directory, 'resource-settings.json');}
  read() {
    let saved;
    try {saved = JSON.parse(fs.readFileSync(this.file, 'utf8'));}
    catch (error) {if (error.code === 'ENOENT') return {schemaVersion: 1, global: {skills: [], mcpServers: []}, projects: {}}; throw Error('Cannot read resource settings; fix the configuration file before changing resources.');}
    if (saved?.schemaVersion !== 1 || !saved.global || !saved.projects || typeof saved.projects !== 'object' || Array.isArray(saved.projects)) throw Error('Invalid resource settings.');
    for (const kind of ['skills', 'mcpServers']) {
      if (!Array.isArray(saved.global[kind]) || saved.global[kind].some(id => typeof id !== 'string')) throw Error('Invalid global resource settings.');
    }
    for (const overrides of Object.values(saved.projects)) for (const kind of ['skills', 'mcpServers']) {
      if (!overrides?.[kind] || typeof overrides[kind] !== 'object' || Array.isArray(overrides[kind]) || Object.values(overrides[kind]).some(enabled => typeof enabled !== 'boolean')) throw Error('Invalid project resource settings.');
    }
    return saved;
  }
  write(saved) {
    fs.mkdirSync(path.dirname(this.file), {recursive: true, mode: 0o700});
    const temporary = `${this.file}.${crypto.randomUUID()}.tmp`;
    try {
      fs.writeFileSync(temporary, JSON.stringify(saved, null, 2), {flag: 'wx', mode: 0o600});
      fs.renameSync(temporary, this.file);
    } finally {fs.rmSync(temporary, {force: true});}
  }
  migrate(projects) {
    const saved = this.read();
    let changed = false;
    for (const project of projects) {
      if (!project.disabledSkills?.length && !project.disabledMcpServers?.length) continue;
      let key;
      try {key = projectKey(project.path);} catch {continue;}
      if (Object.hasOwn(saved.projects, key)) continue;
      saved.projects[key] = {skills: Object.fromEntries((project.disabledSkills || []).map(id => [id, false])), mcpServers: Object.fromEntries((project.disabledMcpServers || []).map(id => [id, false]))};
      changed = true;
    }
    if (changed) this.write(saved);
  }
  snapshot(catalog, projectDirectory) {
    const saved = this.read();
    const overrides = projectDirectory ? saved.projects[projectKey(projectDirectory)] || emptyOverrides() : emptyOverrides();
    return {catalog, global: saved.global, overrides, effective: effectiveResourcePolicy(catalog, saved.global, overrides)};
  }
  set(catalog, {kind, id, mode}, projectDirectory) {
    const key = kind === 'skill' ? 'skills' : kind === 'mcp' ? 'mcpServers' : null;
    if (!key || !['enabled', 'disabled', 'inherit'].includes(mode) || typeof id !== 'string' || !catalog[key].some(item => item.id === id)) throw Error('Unknown resource or invalid setting.');
    if (!projectDirectory && mode === 'inherit') throw Error('Global resources must be enabled or disabled.');
    const saved = this.read();
    if (projectDirectory) {
      const project = projectKey(projectDirectory);
      saved.projects[project] ||= emptyOverrides();
      if (mode === 'inherit') delete saved.projects[project][key][id];
      else saved.projects[project][key][id] = mode === 'enabled';
    } else {
      const disabled = new Set(saved.global[key]);
      if (mode === 'enabled') disabled.delete(id); else disabled.add(id);
      saved.global[key] = [...disabled].sort();
    }
    this.write(saved);
    return this.snapshot(catalog, projectDirectory);
  }
}
module.exports = {ResourceSettings, defaultResourceDirectory, effectiveResourcePolicy};
