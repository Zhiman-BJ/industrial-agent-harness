const fs = require('node:fs');
const path = require('node:path');

const owner = require('@zhiman-bj/industrial-domain-packs');
const skills = [
  {
    id: 'project.work',
    domain: '*',
    title: 'Create, edit and check a project',
    directory: 'project-work',
  },
  ...owner
    .consumerMetadata()
    .skills.map(item => ({ ...item, directory: path.basename(item.resourcePath) })),
];

function listSkills(domain) {
  return skills
    .filter(item => item.domain === '*' || !domain || item.domain === domain)
    .map(({ directory, packId, resourcePath, ...item }) => ({
      ...item,
      enabledByDefault: true,
    }));
}

function skillFile(id) {
  const item = skills.find(skill => skill.id === id);
  if (!item) throw Error(`Unknown repository skill: ${id}`);
  const file = item.packId
    ? path.join(owner.skillResource(id).directory, 'SKILL.md')
    : path.join(__dirname, '..', 'skills', item.directory, 'SKILL.md');
  if (!fs.statSync(file).isFile()) throw Error(`Missing repository skill: ${id}`);
  return file;
}

function integrationSuffix(prefix) {
  return `\n\n## Industrial Harness integration\n\nUse domain_tool_list to discover the current allowed tools. Each native name in this Skill maps to canonical ID ${prefix}<name>; use domain_tool_describe and domain_tool_call with that ID. The backend owns native CAD actions and receipts. Do not bypass it with Shell or direct file edits. A successful tool process or an observation is not engineering acceptance.\n`;
}

function skillPackaging(id) {
  const item = skills.find(skill => skill.id === id);
  if (!item) throw Error(`Unknown repository skill: ${id}`);
  return {
    source: path.dirname(skillFile(id)),
    name: item.directory,
    external: item.external,
  };
}

function skillSource(id, environment = process.env) {
  const resource = skillPackaging(id);
  if (resource.external) {
    const { loadDomainPacks } = require('./packs.cjs');
    const { resourceDirectory } = require('./pack-resources.cjs');
    const provider = loadDomainPacks().find(
      pack => pack.id === resource.external.providerPackId,
    )?.provider;
    if (!provider) throw Error('Skill requires its registered Domain Pack.');
    resource.source = path.join(
      resourceDirectory(provider, environment),
      ...resource.external.resourcePath.split('/'),
    );
    resource.suffix = integrationSuffix(resource.external.nativeToolPrefix);
  }
  return resource;
}

function materializeSkills(scope, directory, environment = process.env) {
  const { materializeSkillDirectories } = require('./skill-resources.cjs');
  return materializeSkillDirectories(
    scope.skills.map(id => skillSource(id, environment)),
    directory,
  );
}

module.exports = {
  listSkills,
  skillFile,
  materializeSkills,
  skillSource,
  skillPackaging,
  integrationSuffix,
};
