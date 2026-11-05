'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const engine = require('../minigame/core/engine');
const { OnlineSession, inviteCode, CODE } = require('../minigame/online');
const { createRoomService, CODE: SERVER_CODE } = require('../server/rooms');
const code = '2468', token = 'test-token-000000000000000000';
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
test('room codes are exactly 4 digits and match the server', () => {
  for (let n = 0; n < 10000; n += 137) {
    const value = String(n).padStart(4, '0');
    assert.equal(CODE.test(value), true, value);
    assert.equal(CODE.test(value), SERVER_CODE.test(value), value);
    assert.equal(inviteCode({ room: value }), value);
  }
  for (const value of ['12345', '123', '12a4', 'ABCDEFIO', '']) assert.equal(inviteCode({ room: value }), '');
  assert.equal(inviteCode({ room: 'abcdefgh' }), 'ABCDEFGH');
  assert.equal(inviteCode({ room: '12 48' }), '1248');
  assert.equal(inviteCode({ room: ' ０２４６ ' }), '0246');
  assert.equal(inviteCode({ room: '房间码：1357' }), '1357');
});

test('real room service responses flow through two OnlineSessions end to end', async t => {
  const crypto = require('node:crypto');
  t.mock.method(crypto, 'randomInt', () => 2589);
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
  assert.equal(host.room.code, '2589'); assert.equal(host.creationUnknown, false);
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
  assert.equal(inviteCode({ room: ' 2468 ', apiBase: 'https://evil', token }), code);
  for (const value of ['12345678', '12a4', '', null, 123, 'ABCDEFIO', '13800138000']) assert.equal(inviteCode({ room: value }), '');
  assert.equal(inviteCode({ room: 'ABCDEFG2', apiBase: 'https://evil', token }), 'ABCDEFG2');
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

test('WeChat text responses that omit null, false, empty history and seat 0 still enter', async () => {
  const h = setup();
  const created = h.s.enter('', preset);
  h.respond(JSON.stringify({ roomCode: '0246', token, room: { code: '0246', status: 'waiting', players: [{ profile: preset }] } }));
  assert.equal(await created, true);
  assert.equal(h.s.seat, 0); assert.equal(h.s.room.game, null); assert.equal(h.s.room.revision, 0);
  h.s.destroy();
  const guest = setup();
  const game = engine.createGame({ mode: 'pvp', aiFirst: false });
  delete game.winner; delete game.aiFirst; delete game.history;
  game.currentPlayer = '0'; game.piles = game.piles.map(String);
  const joined = guest.s.enter('1357', preset);
  guest.queue.shift().resolve({ data: JSON.stringify({ roomCode: '1357', token, seat: '1', room: {
    code: '1357', revision: '1', status: 'playing',
    players: [{ profile: preset }, { seat: '1', profile: preset }], game } }) });
  assert.equal(await joined, true);
  assert.equal(guest.s.seat, 1); assert.equal(guest.s.room.game.winner, null);
  assert.equal(guest.s.room.game.aiFirst, false); assert.deepEqual(guest.s.room.game.history, []);
  assert.equal(guest.s.canMove(), false); guest.s.destroy();
});

test('current 8-character server codes still enter while 4-digit rooms are rolling out', async () => {
  const h = setup();
  const legacy = 'ABCDEFG2';
  const pending = h.s.enter(legacy, preset);
  h.respond({ roomCode: legacy, token, seat: 0, room: { code: legacy, revision: 0, status: 'waiting', players: [{ seat: 0, profile: preset }], game: null } });
  assert.equal(await pending, true);
  assert.equal(h.s.room.code, legacy); h.s.destroy();
});

test('a full room tells both phones to create a new code instead of rejoining', async () => {
  const h = setup();
  const pending = h.s.enter(code, preset);
  h.respond({ error: { code: 'ROOM_FULL', message: '该房间已有两人或已开始' } }, 409);
  await pending;
  assert.match(h.s.error, /新建一个房间码/); assert.equal(h.s.creationUnknown, false);
});

test('server snapshot countdown uses relative time, RTT and rejects older snapshots', async () => {
  const h = setup(); let relative = 1000, wall = 900000000;
  h.s.relativeNow = () => relative; h.s.p.now = () => wall;
  const enter = h.s.enter(code, preset);
  relative += 400;
  h.respond({ roomCode: code, token, seat: 0, room: { ...room(), turnDeadline: 130000, serverNow: 100000 } });
  await enter;
  assert.equal(h.s.remainingTurnMs(), 29800);
  relative += 1000; wall -= 500000000;
  assert.equal(h.s.remainingTurnMs(), 28800, 'wall-clock changes do not affect the timer');
  const refresh = h.s.refresh(); relative += 200;
  h.respond({ room: { ...room(), turnDeadline: 130000, serverNow: 102000 } }); await refresh;
  assert.equal(h.s.remainingTurnMs(), 27900, 'same revision recalibrates');
  const rollback = h.s.refresh();
  h.respond({ room: { ...room(), turnDeadline: 130000, serverNow: 99000 } }); await rollback;
  assert.equal(h.s.remainingTurnMs(), 31000, 'new response accepts server clock rollback');
  const generation = h.s.clockGeneration;
  h.s.accept({ ...room(0), turnDeadline: 180000, serverNow: 103000 });
  assert.equal(h.s.clockGeneration, generation, 'older revision is ignored');
  h.s.destroy();
});

test('old server without serverNow retains wall-clock compatibility and relative ticking', async () => {
  const h = setup(); let relative = 10, wall = 5000;
  h.s.relativeNow = () => relative; h.s.p.now = () => wall;
  const enter = h.s.enter(code, preset);
  h.respond({ roomCode: code, token, seat: 0, room: { ...room(), turnDeadline: 35000 } }); await enter;
  assert.equal(h.s.remainingTurnMs(), 30000);
  relative += 2000; wall += 3600000;
  assert.equal(h.s.remainingTurnMs(), 28000);
  h.s.destroy();
});

test('out of order requests use dispatch order only for equal revisions', async () => {
  const h = setup(); await entered(h); h.s.relativeNow = () => 1000;
  const old = h.s.request('GET', '/old', undefined, true);
  const newer = h.s.request('GET', '/new', undefined, true);
  const first = h.queue.shift(), second = h.queue.shift();
  second.resolve({ statusCode: 200, data: { room: { ...room(), turnDeadline: 50000, serverNow: 30000 } } });
  const newData = await newer; h.s.accept(newData.room, newData);
  first.resolve({ statusCode: 200, data: { room: { ...room(), turnDeadline: 50000, serverNow: 10000 } } });
  const oldData = await old; const generation = h.s.clockGeneration;
  h.s.accept(oldData.room, oldData); assert.equal(h.s.clockGeneration, generation);
  assert.equal(h.s.remainingTurnMs(), 20000);
  h.s.accept({ ...oldData.room, revision: 2 }, oldData);
  assert.equal(h.s.room.revision, 2, 'higher revision wins despite older dispatch');
  h.s.destroy();
});

test('pre-move GET cannot resolve an unknown move or retire its recheck', async () => {
  const h = setup(); await entered(h);
  const staleRead = h.s.refresh(); const stale = h.queue.shift();
  const move = h.s.move(0, 1); h.fail();
  await Promise.resolve(); await Promise.resolve();
  assert.equal(h.s.uncertain, true); assert.equal(h.s.reading, true);
  assert.equal(h.calls.at(-1).method, 'GET');
  stale.resolve({ statusCode: 200, data: { room: room() } }); await staleRead;
  assert.equal(h.s.uncertain, true); assert.equal(h.s.reading, true); assert.equal(h.s.canMove(), false);
  await h.s.move(0, 1);
  assert.equal(h.calls.filter(c => c.url.endsWith('/moves')).length, 1);
  h.respond({ room: room(2, engine.move(h.s.room.game, 0, 1)) }); await move;
  assert.equal(h.s.uncertain, false); assert.equal(h.s.reading, false); assert.equal(h.s.room.revision, 2);
  h.s.destroy();
});

test('hide retires in-flight GET and show immediately starts a fresh sample', async () => {
  const h = setup(); await entered(h); let now = 0; h.s.relativeNow = () => now;
  const old = h.s.refresh(), stale = h.queue.shift();
  h.s.setHidden(true); now = 100000; h.s.setHidden(false);
  assert.equal(h.s.reading, true); assert.equal(h.calls.length, 3);
  stale.resolve({ statusCode: 200, data: { room: { ...room(), turnDeadline: 80000, serverNow: 50000 } } }); await old;
  assert.equal(h.s.reading, true); assert.equal(h.s.clockSample, null);
  now += 200; h.respond({ room: { ...room(), turnDeadline: 80000, serverNow: 50000 } });
  await Promise.resolve(); await Promise.resolve();
  assert.equal(h.s.reading, false); assert.equal(h.s.remainingTurnMs(), 29900);
  h.s.destroy();
});

for (const returnHidden of [true, false]) test('move across background refreshes after authoritative response: hidden=' + returnHidden, async () => {
  const h = setup(); await entered(h); let now = 0; h.s.relativeNow = () => now;
  const game = engine.move(h.s.room.game, 0, 1);
  const move = h.s.move(0, 1); h.s.setHidden(true); now = 120000;
  if (!returnHidden) h.s.setHidden(false);
  h.respond({ room: { ...room(2, game), turnDeadline: 130000, serverNow: 100000 } });
  await Promise.resolve(); await Promise.resolve();
  assert.equal(h.s.room.revision, 2); assert.equal(h.s.remainingTurnMs(), null);
  if (returnHidden) { await move; assert.equal(h.calls.length, 2); h.s.setHidden(false); }
  assert.equal(h.calls.at(-1).method, 'GET');
  now += 200; h.respond({ room: { ...room(2, game), turnDeadline: 130000, serverNow: 100000 } });
  if (!returnHidden) await move; else { await Promise.resolve(); await Promise.resolve(); }
  assert.equal(h.s.remainingTurnMs(), 29900);
  assert.equal(h.calls.filter(c => c.url.endsWith('/moves')).length, 1); h.s.destroy();
});

test('failed background move stays uncertain until visible recheck without resending', async () => {
  const h = setup(); await entered(h);
  const move = h.s.move(0, 1); h.s.setHidden(true); h.fail(); await move;
  assert.equal(h.s.uncertain, true); assert.equal(h.calls.length, 2);
  h.s.setHidden(false); assert.equal(h.calls.at(-1).method, 'GET');
  assert.equal(h.s.canMove(), false);
  h.respond({ room: room() }); await Promise.resolve(); await Promise.resolve();
  assert.equal(h.s.uncertain, false);
  assert.equal(h.calls.filter(c => c.url.endsWith('/moves')).length, 1); h.s.destroy();
});

test('join across background preserves credentials and rechecks without polluted RTT', async () => {
  const h = setup(); let now = 0; h.s.relativeNow = () => now;
  const enter = h.s.enter(code, preset); h.s.setHidden(true); now = 120000; h.s.setHidden(false);
  h.respond({ roomCode: code, token, seat: 0, room: { ...room(), turnDeadline: 130000, serverNow: 100000 } });
  assert.equal(await enter, true); assert.equal(h.s.token, token); assert.equal(h.s.remainingTurnMs(), null);
  assert.equal(h.calls.at(-1).method, 'GET'); now += 100;
  h.respond({ room: { ...room(), turnDeadline: 130000, serverNow: 100000 } });
  await Promise.resolve(); await Promise.resolve(); assert.equal(h.s.remainingTurnMs(), 29950); h.s.destroy();
});

test('background leave success does not rejoin or refresh; unknown leave rechecks once visible', async () => {
  const success = setup(); await entered(success);
  const leaving = success.s.leave(); success.s.setHidden(true); success.s.setHidden(false);
  success.respond({}); assert.equal(await leaving, true); assert.equal(success.s.token, '');
  assert.equal(success.calls.length, 2); success.s.destroy();
  const failed = setup(); await entered(failed);
  const unknown = failed.s.leave(); failed.s.setHidden(true); failed.s.setHidden(false); failed.fail();
  assert.equal(await unknown, false); assert.equal(failed.s.uncertain, true);
  assert.equal(failed.calls.at(-1).method, 'GET');
  assert.equal(failed.calls.filter(c => c.url.endsWith('/leave')).length, 1);
  failed.respond({ room: room() }); await Promise.resolve(); await Promise.resolve();
  assert.equal(failed.s.uncertain, false); failed.s.destroy();
});

test('background recovery locks moves through notifications, stale reads and failed reads', async () => {
  const h = setup(); await entered(h); const notifications = [];
  h.s.changed = () => notifications.push(h.s.canMove());
  h.s.setHidden(true); h.s.setHidden(false);
  assert.equal(h.s.recoveryPending, true); assert.equal(h.s.canMove(), false);
  const stale = h.queue.shift();
  h.s.setHidden(true); h.s.setHidden(false);
  stale.resolve({ statusCode: 200, data: { room: room() } });
  await Promise.resolve(); await Promise.resolve();
  assert.equal(h.s.reading, true); assert.equal(h.s.canMove(), false);
  h.fail(); await Promise.resolve(); await Promise.resolve();
  assert.equal(h.s.recoveryPending, true); assert.equal(h.s.uncertain, true); assert.equal(h.s.canMove(), false);
  await h.s.move(0, 1); assert.equal(h.calls.filter(c => c.url.endsWith('/moves')).length, 0);
  const read = h.s.refresh(); h.respond({ room: room() }); await read;
  assert.equal(h.s.recoveryPending, false); assert.equal(h.s.canMove(), true);
  assert.ok(notifications.slice(0, -1).every(value => !value)); h.s.destroy();
});

test('background move never unlocks during notification before recovery GET', async () => {
  const h = setup(); await entered(h); const seen = [];
  h.s.changed = () => seen.push({ busy: h.s.busy, canMove: h.s.canMove() });
  const move = h.s.move(0, 1); h.s.setHidden(true); h.s.setHidden(false);
  h.respond({ room: room() }); await Promise.resolve(); await Promise.resolve();
  assert.equal(h.s.reading, true); assert.equal(h.s.canMove(), false);
  assert.ok(seen.filter(value => !value.busy).every(value => !value.canMove));
  h.respond({ room: room() }); await move;
  assert.equal(h.s.canMove(), true); h.s.destroy();
});

test('background join locks immediately on successful response until recheck succeeds', async () => {
  const h = setup(); const seen = []; h.s.changed = () => seen.push({ token: !!h.s.token, canMove: h.s.canMove() });
  const join = h.s.enter(code, preset); h.s.setHidden(true); h.s.setHidden(false);
  h.respond({ roomCode: code, token, seat: 0, room: room() }); assert.equal(await join, true);
  assert.equal(h.s.canMove(), false); assert.ok(seen.filter(x => x.token).every(x => !x.canMove));
  h.respond({ room: room() }); await Promise.resolve(); await Promise.resolve();
  assert.equal(h.s.canMove(), true); h.s.destroy();
});

test('recovery state retires on leave and destroy without accepting late read', async () => {
  const h = setup(); await entered(h); h.s.setHidden(true); h.s.setHidden(false);
  const stale = h.queue.shift(); const leaving = h.s.leave(); h.respond({});
  assert.equal(await leaving, true); assert.equal(h.s.recoveryPending, false);
  stale.resolve({ statusCode: 200, data: { room: room() } }); await Promise.resolve(); await Promise.resolve();
  assert.equal(h.s.room, null); assert.equal(h.s.token, '');
  h.s.destroy(); assert.equal(h.s.recoveryPending, false);
  const live = setup(); await entered(live); live.s.setHidden(true); live.s.setHidden(false);
  const late = live.queue.shift(); assert.equal(live.s.recoveryPending, true);
  live.s.destroy(); assert.equal(live.s.recoveryPending, false); assert.equal(live.s.refreshAfterBusy, false);
  late.resolve({ statusCode: 200, data: { room: room() } }); await Promise.resolve(); await Promise.resolve();
  assert.equal(live.s.room, null); assert.equal(live.s.token, ''); assert.equal(live.s.canMove(), false);
});
