const test = require('node:test');
const assert = require('node:assert/strict');
const { projectRegistryOptions } = require('./project-registry.cjs');

test('project registry reads execution location from the authoritative remote settings', () => {
  const project = { id: 'project', path: '/project', domain: 'fixture' };
  const calls = [];
  const settings = {
    project(directory, domain) {
      calls.push([directory, domain]);
      return { location: 'remote' };
    },
  };
  assert.deepEqual(projectRegistryOptions(project, settings), {
    projectDir: '/project',
    remote: true,
  });
  assert.deepEqual(calls, [['/project', 'fixture']]);
  settings.project = () => ({ location: 'local' });
  assert.deepEqual(projectRegistryOptions({ ...project, executionLocation: 'remote' }, settings), {
    projectDir: '/project',
    remote: false,
  });
  assert.deepEqual(
    projectRegistryOptions(undefined, {
      project() {
        throw Error('No project settings should be read.');
      },
    }),
    { projectDir: undefined, remote: false },
  );
});
