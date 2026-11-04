'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const engine = require('../minigame/core/engine');
const { OnlineSession, inviteCode, normalizeCode, codeIssue, CODE, ALPHABET } = require('../minigame/online');
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
  assert.equal(normalizeCode(' 房间码：ａｂｃｄｅｆｇ２ '), 'ABCDEFG2');
  assert.equal(inviteCode({ room: '房间码 ABCDEFG2' }), 'ABCDEFG2');
  assert.equal(normalizeCode('ABCDEFG0'), 'ABCDEFG0');
  assert.match(codeIssue('ABCDEFG0'), /0\/1/);
  assert.match(codeIssue('ABC'), /3位/);
  assert.equal(codeIssue('ABCDEFG2'), '');
  assert.equal(ALPHABET.length, 32);
  assert.equal(/[IO01]/.test(ALPHABET), false);
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

test('WeChat string body and omitted null game still open the created room', async () => {
  const h = setup();
  const payload = JSON.stringify({ roomCode: code, token, seat: '0', room: { code, revision: '0', status: 'waiting', players: [{ seat: '0', profile: preset }] } });
  const pending = h.s.enter('', preset);
  h.respond(payload, 201);
  assert.equal(await pending, true);
  assert.equal(h.s.seat, 0);
  assert.equal(h.s.room.game, null);
  assert.equal(h.s.creationUnknown, false);
  h.s.destroy();
});
test('WeChat playing response with omitted null winner is accepted after the seat is taken', async () => {
  const h = setup();
  const game = engine.createGame({ mode: 'pvp', aiFirst: false, avatars: [0, 3] });
  delete game.winner;
  const pending = h.s.enter(code, preset);
  h.respond({ roomCode: code, token, seat: 1, room: { code, revision: 1, status: 'playing', players: [{ seat: 0, profile: preset }, { seat: 1, profile: preset }], game } }, 200);
  assert.equal(await pending, true);
  assert.equal(h.s.seat, 1);
  assert.equal(h.s.room.game.winner, null);
  h.s.destroy();
});
test('a received but unusable room body does not freeze another attempt', async () => {
  const h = setup();
  const pending = h.s.enter('', preset);
  h.respond({ roomCode: code, token, seat: 0, room: { code, revision: 0, status: 'waiting', players: [] } }, 200);
  assert.equal(await pending, false);
  assert.equal(h.s.creationUnknown, false);
  assert.match(h.s.error, /格式错误（200 object players）/);
  h.s.destroy();
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
test('unknown entry keeps a visible network cause but redacts capabilities and still forbids retry', async () => {
  const h = setup(); const capability = 'a'.repeat(64); h.s.accessKey = capability;
  const pending = h.s.enter('', preset);
  h.queue.shift().reject(new Error('request:fail url not in domain list; capability=' + capability + '; Bearer private-seat-token'));
  await pending;
  assert.equal(h.s.creationUnknown, true); assert.match(h.s.error, /url not in domain list/);
  assert.equal(h.s.error.includes(capability), false); assert.equal(h.s.error.includes('private-seat-token'), false);
  await h.s.enter('', preset); assert.equal(h.calls.length, 1);
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
  const calls = h.calls.length;
  assert.equal(await h.s.leave(), true); assert.equal(h.calls.length, calls, 'expired session exits locally');
  assert.equal(h.s.token, ''); assert.equal(h.s.room, null); h.s.destroy();
});

test('unknown leave resumes read-only polling and never blindly resends leave or moves', async () => {
  const h = setup(); await entered(h); const before = h.s.room;
  const pending = h.s.leave(); h.fail(); assert.equal(await pending, false);
  assert.equal(h.s.room, before); assert.equal(h.s.uncertain, true);
  assert.match(h.s.error, /离开结果未确认/); assert.equal(h.s.canMove(), false);
  assert.equal(h.timers.size, 1, 'failed leave must not strand the session without polling');
  await h.s.move(0, 1);
  const retry = h.s.leave();
  assert.equal(h.calls.at(-1).method, 'GET', 'another leave tap only checks authority while uncertain');
  h.respond({ room: room(2) }); assert.equal(await retry, false);
  assert.equal(h.s.uncertain, false); assert.equal(h.s.room.revision, 2);
  assert.equal(h.calls.filter(c => c.url.endsWith('/leave')).length, 1);
  assert.equal(h.calls.filter(c => c.url.endsWith('/moves')).length, 0); h.s.destroy();
});

test('lost leave response reconciles closed authority without retransmitting mutation', async () => {
  const h = setup(); await entered(h);
  const pending = h.s.leave(); h.respond({ error: { message: 'unavailable' } }, 503); await pending;
  assert.equal(h.timers.size, 1);
  const tick = [...h.timers.values()][0]; h.timers.clear(); tick();
  assert.equal(h.calls.at(-1).method, 'GET');
  h.respond({ error: { message: 'closed' } }, 410); await Promise.resolve(); await Promise.resolve();
  assert.equal(h.s.expired, true); assert.equal(h.s.uncertain, true);
  assert.equal(h.timers.size, 0); assert.match(h.s.error, /已关闭/);
  assert.equal(h.calls.filter(c => c.url.endsWith('/leave')).length, 1); h.s.destroy();
});

test('pre-leave GET cannot clear unknown leave or replace its snapshot', async () => {
  const h = setup(); await entered(h); const before = h.s.room;
  const read = h.s.refresh(), stale = h.queue.shift();
  const leave = h.s.leave(); h.fail(); await leave;
  stale.resolve({ statusCode: 200, data: { room: room(2) } }); await read;
  assert.equal(h.s.room, before); assert.equal(h.s.uncertain, true); assert.equal(h.s.reading, false);
  assert.equal(h.timers.size, 1); assert.equal(h.s.canMove(), false); h.s.destroy();
});

test('finished-room unknown leave keeps polling through GET failure, pauses hidden and retires on destroy', async () => {
  const h = setup(); await entered(h);
  let game = engine.createGame({ mode: 'pvp' });
  while (game.winner === null) game = engine.move(game, game.piles.findIndex(n => n > 0), 1);
  h.s.accept(room(2, game)); h.s.schedule(); assert.equal(h.timers.size, 0);
  const leave = h.s.leave(); h.fail(); await leave; assert.equal(h.timers.size, 1);
  const read = h.s.refresh(); h.fail(); await read;
  assert.equal(h.s.uncertain, true); assert.equal(h.timers.size, 1); assert.match(h.s.error, /刷新/);
  h.s.setHidden(true); assert.equal(h.timers.size, 0); h.s.setHidden(false);
  assert.equal(h.calls.at(-1).method, 'GET');
  h.respond({ room: room(2, game) }); await Promise.resolve(); await Promise.resolve();
  assert.equal(h.s.uncertain, false); assert.equal(h.timers.size, 0);
  const late = h.s.leave(); h.s.destroy(); h.fail(); await late;
  assert.equal(h.s.room, null); assert.equal(h.timers.size, 0);
  assert.equal(h.calls.filter(c => c.url.endsWith('/moves')).length, 0);
});

test('out-of-turn seat cannot send any move', async () => {
  const h = setup(); await entered(h); h.s.seat = 1; await h.s.move(0, 1);
  assert.equal(h.calls.length, 1); h.s.destroy();
});
