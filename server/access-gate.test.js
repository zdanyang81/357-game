'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { createHTTPServer } = require('./http');
const key = 'a'.repeat(64), preset = { avatar: { type: 'preset', index: 0 } };
test('deployment gate protects create/join/read; cohort capability never replaces seat credentials', async t => {
  const server = createHTTPServer({ accessKey: key });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const base = 'http://127.0.0.1:' + server.address().port;
  async function request(path, { method = 'GET', access, token, data } = {}) {
    const result = await fetch(base + path, { method,
      headers: { ...(access ? { 'X-357-Access-Key': access } : {}), ...(token ? { Authorization: 'Bearer ' + token } : {}),
        ...(data ? { 'Content-Type': 'application/json' } : {}) }, body: data ? JSON.stringify(data) : undefined });
    return { status: result.status, data: await result.json() };
  }
  assert.equal((await request('/healthz')).status, 200);
  for (const access of [undefined, 'short', 'b'.repeat(64)]) {
    const failed = await request('/v1/rooms', { method: 'POST', access, data: { profile: preset } });
    assert.equal(failed.status, 403); assert.equal(failed.data.error.code, 'INTERNAL_TEST_ONLY');
    assert.equal(JSON.stringify(failed.data).includes(key), false);
  }
  const host = await request('/v1/rooms', { method: 'POST', access: key, data: { profile: preset } });
  assert.equal(host.status, 200);
  const path = '/v1/rooms/' + host.data.roomCode;
  assert.equal((await request(path + '/join', { method: 'POST', data: { profile: preset } })).status, 403);
  assert.equal((await request(path, { access: key })).status, 401);
  assert.equal((await request(path, { token: host.data.token })).status, 403);
  const read = await request(path, { access: key, token: host.data.token });
  assert.equal(read.status, 200); assert.equal(JSON.stringify(read.data).includes(key), false);
});
test('deployed main refuses empty or malformed access key before binding a room listener', () => {
  for (const value of ['', 'wrong']) {
    const result = spawnSync(process.execPath, [require.resolve('./http')], {
      env: { ...process.env, ROOMS_ACCESS_KEY: value }, encoding: 'utf8', timeout: 5000 });
    assert.notEqual(result.status, 0); assert.match(result.stderr, /Internal-test access key is required/);
  }
  assert.throws(() => createHTTPServer({ accessKey: 'invalid' }), /Invalid internal-test access configuration/);
});
