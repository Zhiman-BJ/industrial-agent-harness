const {resolve} = require('@industrial-agent-harness/capability-broker');
const {capabilities, listDomains} = require('@industrial-agent-harness/domain-skills');

function resolveProjectTask(domain, request, previous, registry = capabilities) {
  if (!listDomains(registry).some(item => item.id === domain)) throw Error('Choose a valid project domain.');
  if (request?.domain && request.domain !== domain) throw Error(`This project is fixed to the ${domain} domain.`);
  return resolve({...request, domain}, registry, previous);
}

module.exports = {resolveProjectTask};
