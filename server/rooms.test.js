'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const zlib = require('node:zlib');
const { createRoomService, validateProfile, RoomError } = require('./rooms');
const { createHTTPServer, MAX_BODY } = require('./http');
const profile = index => ({ avatar: { type: 'preset', index } });
function error(code) { return value => value instanceof RoomError && value.code === code; }
function png({ width = 1, height = 1, text = false, corrupt = false, pixels, idatTail, transparency, palette } = {}) {
  const crc = bytes => {
    let value = 0xffffffff;
    for (const byte of bytes) { value ^= byte; for (let n = 0; n < 8; n++) value = value & 1 ? 0xedb88320 ^ value >>> 1 : value >>> 1; }
    return (value ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const bytes = Buffer.alloc(12 + data.length); bytes.writeUInt32BE(data.length); bytes.write(type, 4); data.copy(bytes, 8);
    bytes.writeUInt32BE(crc(bytes.subarray(4, 8 + data.length)), 8 + data.length); return bytes;
  };
  const head = Buffer.alloc(13); head.writeUInt32BE(width); head.writeUInt32BE(height, 4); head[8] = 8; head[9] = 6;
  const body = pixels || Buffer.from([0, 255, 0, 0, 255]);
  const result = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', head),
    ...(text ? [chunk('tEXt', Buffer.from('GPS\0private location must not leave the server'))] : []),
    ...(transparency ? [chunk('tRNS', transparency)] : []), ...(palette ? [chunk('PLTE', palette)] : []),
    chunk('IDAT', Buffer.concat([zlib.deflateSync(body), idatTail || Buffer.alloc(0)])), chunk('IEND', Buffer.alloc(0))]);
  if (corrupt) result[result.length - 1] ^= 1;
  return { avatar: { type: 'image', data: 'data:image/png;base64,' + result.toString('base64') } };
}
test('two seats share authoritative rules and last taker loses; snapshots never expose tokens', () => {
  const service = createRoomService({ randomFirst: () => 0, now: () => 10000 });
  const host = service.create(profile(0));
  assert.match(host.roomCode, /^[A-HJ-NP-Z2-9]{8}$/); assert.match(host.token, /^[a-f0-9]{64}$/);
  assert.equal(host.room.status, 'waiting'); assert.equal(host.room.game, null);
  assert.throws(() => service.read(host.roomCode), error('UNAUTHORIZED'));
  const guest = service.join(host.roomCode, profile(3));
  assert.equal(guest.seat, 1); assert.notEqual(host.token, guest.token);
  assert.equal(guest.room.game.currentPlayer, 0);
  assert.equal(JSON.stringify(guest.room).includes(host.token), false);
  assert.equal(JSON.stringify(guest.room).includes(guest.token), false);
  assert.throws(() => service.join(host.roomCode, profile(1)), error('ROOM_FULL'));
  let state = guest.room;
  for (const [i, row, count, token] of [[0, 0, 3, host.token], [1, 1, 5, guest.token], [2, 2, 7, host.token]]) {
    state = service.move(host.roomCode, token, { actionId: 'action00' + i, expectedRevision: state.revision, row, count }).room;
  }
  assert.equal(state.status, 'finished'); assert.equal(state.game.winner, 1); assert.equal(state.game.history.length, 3);
  assert.deepEqual(service.read(host.roomCode, guest.token).room.game, state.game);
  state.game.piles[0] = 99; assert.equal(service.read(host.roomCode, host.token).room.game.piles[0], 0);
});
test('server rejects wrong actor, stale revision, forged state, illegal move and replay-ID mutation', () => {
  const s = createRoomService({ randomFirst: () => 0, now: () => 10000 }), a = s.create(profile(0)), b = s.join(a.roomCode, profile(3));
  const move = { actionId: 'stable_action_1', expectedRevision: 1, row: 0, count: 1 };
  assert.throws(() => s.move(a.roomCode, b.token, move), error('OUT_OF_TURN'));
  assert.throws(() => s.move(a.roomCode, a.token, { ...move, expectedRevision: 0 }), error('REVISION_CONFLICT'));
  assert.throws(() => s.move(a.roomCode, a.token, { ...move, winner: 0 }), error('INVALID_MOVE'));
  assert.throws(() => s.move(a.roomCode, a.token, { ...move, count: 9 }), error('ILLEGAL_MOVE'));
  assert.throws(() => s.move(a.roomCode, 'f'.repeat(64), move), error('UNAUTHORIZED'));
  const result = s.move(a.roomCode, a.token, move);
  assert.deepEqual(s.move(a.roomCode, a.token, move), result);
  assert.throws(() => s.move(a.roomCode, a.token, { ...move, count: 2 }), error('ACTION_ID_CONFLICT'));
  assert.equal(s.read(a.roomCode, a.token).room.game.history.length, 1);
});
test('lost move response can be reconciled by the other device without double application', () => {
  const s = createRoomService({ randomFirst: () => 1, now: () => 10000 }), a = s.create(profile(0)), b = s.join(a.roomCode, profile(3));
  const move = { actionId: 'lost_response', expectedRevision: 1, row: 2, count: 4 };
  s.move(a.roomCode, b.token, move); // Simulate response lost by not giving its value to client.
  const recovered = s.read(a.roomCode, b.token).room;
  assert.equal(recovered.revision, 2); assert.deepEqual(recovered.game.piles, [3, 5, 3]);
  assert.deepEqual(s.move(a.roomCode, b.token, move).room, recovered);
  assert.deepEqual(s.read(a.roomCode, a.token).room, recovered);
});
test('room capability is scoped, leave revokes both seats, idle and hard TTL are bounded', () => {
  let time = 0; const s = createRoomService({ now: () => time, idleMs: 100, maxAgeMs: 250 });
  const a = s.create(profile(0)), x = s.create(profile(1));
  assert.throws(() => s.read(x.roomCode, a.token), error('UNAUTHORIZED'));
  time = 99; s.read(a.roomCode, a.token); time = 150;
  assert.throws(() => s.read(x.roomCode, x.token), error('ROOM_NOT_FOUND'));
  s.read(a.roomCode, a.token); time = 249; s.read(a.roomCode, a.token); time = 250;
  assert.throws(() => s.read(a.roomCode, a.token), error('ROOM_NOT_FOUND'));
  const h = s.create(profile(0)), g = s.join(h.roomCode, profile(3));
  assert.deepEqual(s.leave(h.roomCode, g.token), { closed: true });
  assert.throws(() => s.read(h.roomCode, h.token), error('ROOM_NOT_FOUND'));
  assert.equal(s.inspectCounts().rooms, 0);
});
test('unauthorized reads do not prolong private room lifetime; capacity never evicts live rooms', () => {
  let time = 0; const s = createRoomService({ now: () => time, idleMs: 100, capacity: 1 });
  const a = s.create(profile(0)); assert.throws(() => s.create(profile(1)), error('ROOM_CAPACITY'));
  time = 99; assert.throws(() => s.read(a.roomCode, 'a'.repeat(64)), error('UNAUTHORIZED'));
  time = 100; assert.equal(s.inspectCounts().rooms, 0); assert.ok(s.create(profile(1)));
});
test('avatar wire format is bounded decoded PNG and strips metadata; no arbitrary URL or local path', () => {
  const clean = validateProfile(png()), withMetadata = validateProfile(png({ text: true }));
  assert.deepEqual(withMetadata, clean);
  for (const value of [{ avatar: { type: 'url', url: 'https://example.com/a.png' } },
    { avatar: { type: 'image', data: '/tmp/private.jpg' } }, { avatar: { type: 'preset', index: 6 } },
    { avatar: { type: 'image', data: 'data:image/png;base64,AAAA' } }, png({ corrupt: true }), png({ width: 257 }),
    png({ pixels: Buffer.alloc(500000) }), { ...profile(0), token: 'not a profile' }]) {
    assert.throws(() => validateProfile(value), value => value instanceof RoomError && value.status === 400);
  }
});
test('canonical PNG re-encoding discards IDAT trailing metadata, optional palette and rejects RGBA transparency chunks', () => {
  const clean = validateProfile(png());
  const marker = Buffer.from('GPS:30.123,120.456 ORIGINAL_PRIVATE_METADATA');
  const tail = validateProfile(png({ idatTail: marker, palette: marker }));
  assert.deepEqual(tail, clean);
  const wire = Buffer.from(tail.avatar.data.split(',')[1], 'base64');
  assert.equal(wire.includes(marker), false);
  assert.throws(() => validateProfile(png({ transparency: marker })), error('INVALID_AVATAR'));
});
async function httpFixture(t, options = {}) {
  const server = createHTTPServer(options); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const base = 'http://127.0.0.1:' + server.address().port;
  async function call(path, { method = 'GET', data, token, headers = {} } = {}) {
    const response = await fetch(base + path, { method, headers: { ...(data === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...(token ? { Authorization: 'Bearer ' + token } : {}), ...headers }, body: data === undefined ? undefined : JSON.stringify(data) });
    return { status: response.status, body: await response.json(), headers: response.headers };
  }
  return { call };
}
test('actual HTTP two-client lifecycle, token privacy, exact methods and error statuses', async t => {
  const { call } = await httpFixture(t, { randomFirst: () => 0 });
  assert.equal((await call('/healthz')).status, 200);
  const a = await call('/v1/rooms', { method: 'POST', data: { profile: png() } });
  assert.equal(a.status, 200); assert.equal(a.headers.get('cache-control'), 'no-store');
  const path = '/v1/rooms/' + a.body.roomCode;
  assert.equal((await call(path)).status, 401);
  const b = await call(path + '/join', { method: 'POST', data: { profile: profile(3) } }); assert.equal(b.status, 200);
  assert.equal((await call(path, { token: b.body.token })).body.room.players[0].profile.avatar.type, 'image');
  const moved = await call(path + '/moves', { method: 'POST', token: a.body.token,
    data: { actionId: 'http_action01', expectedRevision: 1, row: 0, count: 3 } });
  assert.equal(moved.status, 200); assert.deepEqual(moved.body.room.game.piles, [0, 5, 7]);
  assert.equal((await call(path + '?token=' + a.body.token)).status, 400);
  assert.equal((await call(path, { token: a.body.token, headers: { Origin: 'https://evil.example' } })).status, 403);
  assert.equal((await call(path + '/leave', { method: 'POST', token: b.body.token, data: {} })).status, 200);
  assert.equal((await call(path, { token: a.body.token })).status, 404);
});
test('HTTP rejects oversized bodies, wrong content types, forged profiles and bounded rate', async t => {
  const { call } = await httpFixture(t);
  assert.equal((await call('/v1/rooms', { method: 'POST', data: { profile: profile(0), winner: 0 } })).status, 400);
  assert.equal((await call('/v1/rooms', { method: 'POST', data: { profile: profile(0) }, headers: { 'Content-Type': 'text/plain' } })).status, 415);
  assert.equal((await call('/v1/rooms', { method: 'POST', data: { profile: 'x'.repeat(MAX_BODY) } })).status, 413);
  const statuses = [];
  for (let i = 0; i < 8; i++) statuses.push((await call('/v1/rooms', { method: 'POST', data: { profile: profile(0) } })).status);
  assert.ok(statuses.includes(429));
});
