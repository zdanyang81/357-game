'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const engine = require('../minigame/core/engine');
const { OnlineSession, inviteCode, CODE } = require('../minigame/online');
const { createRoomService, CODE: SERVER_CODE } = require('../server/rooms');
const code = 'ABCDEFG2', token = 'test-token-000000000000000000';
const preset = { avatar: { type: 'preset', index: 0 } };
const room = (revision = 1, game = engine.createGame({ mode: 'pvp' })) => ({ code, revision, status: game.winner === null ? 'playing' : 'finished', players: [{ seat: 0, profile: preset }, { seat: 1, profile: preset }], game });
function setup() {
  const calls = [], queue = [], timers = new Map(); let id = 0;
  const p = { request(options) { calls.push(options); return new Promise((resolve, reject) => queue.push({ resolve, reject })); },
    setTimeout(fn) { timers.set(++id, fn); return id; }, clearTimeout(id) { timers.delete(id); } };
  const s = new OnlineSession(p, 'https://rooms.example.test', () => {});
  return { s, calls, queue, timers, respond(data, statusCode = 200) { queue.shift().resolve({ statusCode, data }); }, fail() { queue.shift().reject(new Error('lost')); } };
}
async function entered(h) {
  const pending = h.s.enter(code, preset);
  h.respond({ roomCode: code, token, seat: 0, room: room() }); await pending;
}
test('all code validators match server alphabet including 8/9 and excluding I/O/0/1', () => {
  for (const char of 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789/_-') {
    const value = 'ABCDEF' + char + char;
    assert.equal(CODE.test(value), SERVER_CODE.test(value), value);
    assert.equal(inviteCode({ room: value }), SERVER_CODE.test(value) ? value : '', value);
  }
  assert.equal(inviteCode({ room: ' abcdef89 ' }), 'ABCDEF89');
});

test('real room service responses with 8/9 flow through two OnlineSessions end to end', async t => {
  const crypto = require('node:crypto'), randomBytes = crypto.randomBytes;
  // Force a real service-generated invitation containing the previously rejected digits.
  t.mock.method(crypto, 'randomBytes', size => size === 8 ? Buffer.from([0, 1, 2, 3, 4, 5, 30, 31]) : randomBytes(size));
  const service = createRoomService({ randomFirst: () => 0 });
  const calls = [];
  const platform = {
    setTimeout() { return 1; }, clearTimeout() {},
    async request(options) {
      calls.push(options);
      const path = new URL(options.url).pathname, parts = path.split('/');
      const auth = options.header.Authorization && options.header.Authorization.slice(7);
      try {
        let data;
        if (path === '/v1/rooms') data = service.create(options.data.profile);
        else if (parts[4] === 'join') data = service.join(parts[3], options.data.profile);
        else if (parts[4] === 'moves') data = service.move(parts[3], auth, options.data);
        else if (parts[4] === 'leave') data = service.leave(parts[3], auth);
        else data = service.read(parts[3], auth);
        return { statusCode: path === '/v1/rooms' ? 201 : 200, data };
      } catch (error) { return { statusCode: error.status || 500, data: { error: { code: error.code, message: error.message } } }; }
    }
  };
  const host = new OnlineSession(platform, 'https://test.invalid'), guest = new OnlineSession(platform, 'https://test.invalid');
  t.after(() => { host.destroy(); guest.destroy(); });
  assert.equal(await host.enter('', preset), true);
  assert.equal(host.room.code, 'ABCDEF89'); assert.equal(host.creationUnknown, false);
  assert.equal(await guest.enter(host.room.code, preset), true);
  assert.equal(guest.seat, 1); await host.refresh(); assert.equal(host.canMove(), true);
  await host.move(0, 1); await guest.refresh();
  assert.deepEqual(guest.room.game, host.room.game); assert.equal(guest.canMove(), true);
  await guest.move(1, 2); await host.refresh(); assert.deepEqual(host.room.game, guest.room.game);
  const credentials = [host.token, guest.token];
  assert.equal(await host.leave(), true); await guest.refresh(); assert.equal(guest.expired, true);
  assert.ok(calls.every(call => credentials.every(secret => !call.url.includes(secret))));
});

test('invitations validate only room code; never accept external endpoint/token', () => {
  assert.equal(inviteCode({ room: ' abcdefg2 ', apiBase: 'https://evil', token }), code);
  for (const value of ['12345678', 'ABCD/EFG', '', null, 123]) assert.equal(inviteCode({ room: value }), '');
});
test('empty/non-HTTPS base disables network without touching request', async () => {
  for (const base of ['', 'http://example.test', 'javascript:evil']) {
    const s = new OnlineSession({ request() { assert.fail(); }, clearTimeout() {} }, base);
    assert.equal(await s.enter('', preset), false); assert.match(s.error, /未开放/); assert.equal(s.creationUnknown, false);
  }
});
test('join keeps credentials in Authorization only and accepts authoritative state', async () => {
  const h = setup(); await entered(h); assert.equal(h.s.seat, 0); assert.equal(h.s.canMove(), true);
  const pending = h.s.refresh(); assert.equal(h.calls[1].header.Authorization, 'Bearer ' + token);
  assert.ok(!h.calls.some(c => c.url.includes(token))); h.respond({ room: room() }); await pending; h.s.destroy();
});
test('unknown creation stops, never automatically retries or makes another room', async () => {
  const h = setup(); const pending = h.s.enter('', preset); h.fail(); await pending;
  assert.equal(h.s.creationUnknown, true); await h.s.enter('', preset); assert.equal(h.calls.length, 1); assert.equal(h.timers.size, 0);
});
test('definite entry rejection permits correction without marking unknown', async () => {
  const h = setup(); const pending = h.s.enter(code, preset); h.respond({ error: { code: 'FULL', message: '房间已满' } }, 409); await pending;
  assert.match(h.s.error, /已满/); assert.equal(h.s.creationUnknown, false);
});
test('unknown move does not update optimistically or resend; first rechecks state', async () => {
  const h = setup(); await entered(h); const before = h.s.room;
  const pending = h.s.move(0, 1); assert.equal(h.s.room, before); assert.equal(h.s.canMove(), false);
  const move = h.calls[1]; assert.deepEqual(Object.keys(move.data).sort(), ['actionId', 'count', 'expectedRevision', 'row']);
  h.fail(); await Promise.resolve(); await Promise.resolve();
  assert.equal(h.calls[2].method, 'GET'); assert.equal(h.s.uncertain, true);
  h.respond({ room: room(2, engine.move(before.game, 0, 1)) }); await pending;
  assert.equal(h.s.room.revision, 2); assert.equal(h.s.canMove(), false);
  assert.equal(h.calls.filter(c => c.url.endsWith('/moves')).length, 1); h.s.destroy();
});
test('revision conflict refreshes and never replays stale selected move', async () => {
  const h = setup(); await entered(h); const pending = h.s.move(0, 1);
  h.respond({ error: { code: 'REVISION_CONFLICT', message: '冲突' } }, 409);
  await Promise.resolve(); await Promise.resolve();
  h.respond({ room: room(2, engine.move(h.s.room.game, 1, 1)) }); await pending;
  assert.equal(h.calls.filter(c => c.method === 'POST').length, 2); assert.equal(h.s.room.game.piles[1], 4); h.s.destroy();
});
test('old snapshots cannot rewind revisions; hidden timer stops, showing rechecks', async () => {
  const h = setup(); await entered(h); h.s.accept(room(3)); h.s.accept(room(2)); assert.equal(h.s.room.revision, 3);
  assert.equal(h.timers.size, 1); h.s.setHidden(true); assert.equal(h.timers.size, 0);
  await h.s.refresh(); assert.equal(h.calls.length, 1);
  h.s.setHidden(false); assert.equal(h.calls.length, 2); h.respond({ room: room(3) }); await Promise.resolve(); h.s.destroy();
});
test('destroy rejects already queued room response and removes polling jobs', async () => {
  const h = setup(); const pending = h.s.enter('', preset); h.s.destroy();
  h.respond({ roomCode: code, token, seat: 0, room: room() }); await pending;
  assert.equal(h.s.room, null); assert.equal(h.s.token, ''); assert.equal(h.timers.size, 0);
});
test('server 5xx creation and expired room fail closed without retry polling', async () => {
  const unknown = setup(); const enter = unknown.s.enter('', preset);
  unknown.respond({ error: { code: 'INTERNAL', message: 'error' } }, 500); await enter;
  assert.equal(unknown.s.creationUnknown, true);
  const h = setup(); await entered(h); const refresh = h.s.refresh();
  h.respond({ error: { code: 'NOT_FOUND', message: 'expired' } }, 404); await refresh;
  assert.equal(h.s.canMove(), false); assert.equal(h.timers.size, 0); assert.match(h.s.error, /过期/);
  const leave = h.s.leave(); h.respond({ error: { code: 'NOT_FOUND', message: 'expired' } }, 404);
  assert.equal(await leave, true); assert.equal(h.s.token, ''); assert.equal(h.s.room, null); h.s.destroy();
});

test('out-of-turn seat cannot send any move', async () => {
  const h = setup(); await entered(h); h.s.seat = 1; await h.s.move(0, 1);
  assert.equal(h.calls.length, 1); h.s.destroy();
});
