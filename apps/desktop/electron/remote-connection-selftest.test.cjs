const test = require('node:test');
const assert = require('node:assert/strict');
const { createConnectionFixture } = require('./remote-connection-selftest.cjs');

test('connection-only UI fixture binds loopback, authenticates and rejects every mutation', async t => {
  const fixture = await createConnectionFixture();
  t.after(() => fixture.close());
  assert.equal(new URL(fixture.url).hostname, '127.0.0.1');
  const headers = { Authorization: `Bearer ${fixture.token}` };
  const info = new URL('/v1/service-info', fixture.url);
  assert.equal((await fetch(info)).status, 401);
  assert.deepEqual(
    await fetch(info, { headers }).then(response => response.json()),
    fixture.current,
  );
  for (const route of ['/v1/service-info', '/v1/projects', '/v1/mcp/test']) {
    assert.equal(
      (await fetch(new URL(route, fixture.url), { method: 'POST', headers })).status,
      405,
    );
  }
  fixture.setInfo({ ...fixture.current, version: '1.4.0' });
  assert.equal(
    await fetch(info, { headers })
      .then(response => response.json())
      .then(value => value.version),
    '1.4.0',
  );
});
