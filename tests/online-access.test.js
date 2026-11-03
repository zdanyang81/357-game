'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { OnlineSession, inviteCode } = require('../minigame/online');
const { createRoomService } = require('../server/rooms');
test('preview cohort capability goes only in request header, never invitation/query/profile or seat identity', async () => {
  const service = createRoomService(), requests = [], timers = new Map();
  const key = 'a'.repeat(64), profile = { avatar: { type: 'preset', index: 0 } };
  const platform = { request(options) {
    requests.push(options); return Promise.resolve({ statusCode: 201, data: service.create(options.data.profile) });
  }, setTimeout(fn) { timers.set(1, fn); return 1; }, clearTimeout(id) { timers.delete(id); } };
  const session = new OnlineSession(platform, 'https://rooms.example.test', () => {}, key);
  assert.equal(await session.enter('', profile), true);
  assert.equal(requests[0].header['X-357-Access-Key'], key);
  assert.equal(requests[0].header['Content-Type'], 'application/json');
  assert.equal(requests[0].url, 'https://rooms.example.test/v1/rooms');
  assert.equal(Object.hasOwn(requests[0].header, 'Authorization'), false);
  assert.equal(JSON.stringify(requests[0].data).includes(key), false);
  assert.notEqual(session.token, key);
  assert.equal(inviteCode({ room: session.room.code, accessKey: key, token: 'bad', apiBase: 'https://evil.example' }), session.room.code);
  session.destroy(); assert.equal(timers.size, 0);
});
