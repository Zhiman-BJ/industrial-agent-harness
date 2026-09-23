const capabilities = require('./capabilities.cjs');
const {listDomains} = require('./domains.cjs');
const {listSkills, materializeSkills} = require('./registry.cjs');

module.exports = {capabilities, listDomains, listSkills, materializeSkills};
