'use strict';

const crypto = require('node:crypto');
const zlib = require('node:zlib');
const engine = require('../minigame/core/engine');
const CODE = /^[A-HJ-NP-Z2-9]{8}$/;
const TOKEN = /^[a-f0-9]{64}$/;
const MAX_IMAGE = 128 * 1024;
const clone = value => JSON.parse(JSON.stringify(value));
class RoomError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}
function fail(status, code, message) { throw new RoomError(status, code, message); }
function object(value, keys) {
  return !!value && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}
function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let n = 0; n < 8; n++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function sanitizePNG(bytes) {
  const signature = Buffer.from('89504e470d0a1a0a', 'hex');
  if (!bytes.subarray(0, 8).equals(signature)) fail(400, 'INVALID_AVATAR', '头像不是有效PNG图片');
  const idats = [];
  let header, raw;
  let pos = 8, width = 0, height = 0, channels = 0, ended = false, sawIDAT = false;
  while (pos + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(pos), end = pos + 12 + length;
    if (end > bytes.length) fail(400, 'INVALID_AVATAR', '头像图片不完整');
    const type = bytes.toString('ascii', pos + 4, pos + 8), data = bytes.subarray(pos + 8, pos + 8 + length);
    if (!/^[A-Za-z]{4}$/.test(type) || crc32(bytes.subarray(pos + 4, pos + 8 + length)) !== bytes.readUInt32BE(pos + 8 + length)) {
      fail(400, 'INVALID_AVATAR', '头像图片校验失败');
    }
    if (!width && type !== 'IHDR') fail(400, 'INVALID_AVATAR', '头像缺少图片头');
    if (type === 'IHDR') {
      if (width || length !== 13) fail(400, 'INVALID_AVATAR', '头像图片头无效');
      width = data.readUInt32BE(0); height = data.readUInt32BE(4);
      if (!width || !height || width > 256 || height > 256 || data[8] !== 8 || ![2, 6].includes(data[9]) || data[10] || data[11] || data[12]) {
        fail(400, 'INVALID_AVATAR', '请先将头像压缩为不超过256像素的普通PNG');
      }
      channels = data[9] === 6 ? 4 : 3; header = Buffer.from(data);
    } else if (type === 'IDAT') { idats.push(data); sawIDAT = true; }
    else if (type === 'IEND') {
      if (length || !sawIDAT || end !== bytes.length) fail(400, 'INVALID_AVATAR', '头像图片结尾无效');
      ended = true;
    } else if (type === 'tRNS') fail(400, 'INVALID_AVATAR', '请使用Canvas转换后的RGB或RGBA头像');
    else if (type[0] === type[0].toUpperCase() && type !== 'PLTE') fail(400, 'INVALID_AVATAR', '头像PNG编码不支持');
    // No ancillary or optional palette bytes are forwarded. Rebuild from bounded pixels below.
    pos = end; if (ended) break;
  }
  if (!ended) fail(400, 'INVALID_AVATAR', '头像图片不完整');
  try {
    const stride = width * channels + 1;
    raw = zlib.inflateSync(Buffer.concat(idats), { maxOutputLength: stride * height });
    if (raw.length !== stride * height) throw new Error('size');
    for (let row = 0; row < height; row++) if (raw[row * stride] > 4) throw new Error('filter');
  } catch (_) { fail(400, 'INVALID_AVATAR', '头像像素数据无效'); }
  function chunk(type, data) {
    const result = Buffer.alloc(12 + data.length); result.writeUInt32BE(data.length); result.write(type, 4); data.copy(result, 8);
    result.writeUInt32BE(crc32(result.subarray(4, 8 + data.length)), 8 + data.length); return result;
  }
  // inflate may ignore bytes after its first zlib stream. Never forward the input IDAT:
  // fresh deflation and CRCs ensure only validated pixel/filter bytes cross to the opponent.
  const canonical = Buffer.concat([signature, chunk('IHDR', header), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
  if (canonical.length > MAX_IMAGE) fail(400, 'INVALID_AVATAR', '请进一步压缩头像');
  return canonical;
}
function validateProfile(profile = { avatar: { type: 'preset', index: 0 } }) {
  if (!object(profile, ['avatar'])) fail(400, 'INVALID_PROFILE', '玩家资料格式无效');
  const avatar = profile.avatar;
  if (object(avatar, ['type', 'index']) && avatar.type === 'preset' && Number.isInteger(avatar.index) && avatar.index >= 0 && avatar.index < 6) return clone(profile);
  if (!object(avatar, ['type', 'data']) || avatar.type !== 'image' || typeof avatar.data !== 'string' || avatar.data.length > MAX_IMAGE * 4 / 3 + 64) {
    fail(400, 'INVALID_AVATAR', '头像须为内置头像或压缩后的图片');
  }
  // Clients rasterize both album and WeChat source images to PNG. Restrict the wire format
  // so the dependency-free server can fully bound/decompress pixel data, not trust JPEG markers.
  const match = /^data:image\/(png);base64,([A-Za-z0-9+/]+={0,2})$/.exec(avatar.data);
  if (!match || match[2].length % 4 !== 0) fail(400, 'INVALID_AVATAR', '头像图片格式无效');
  const bytes = Buffer.from(match[2], 'base64');
  if (!bytes.length || bytes.length > MAX_IMAGE || bytes.toString('base64') !== match[2]) fail(400, 'INVALID_AVATAR', '头像图片过大或编码无效');
  const clean = sanitizePNG(bytes);
  return { avatar: { type: 'image', data: `data:image/${match[1]};base64,${clean.toString('base64')}` } };
}
function createRoomService(options = {}) {
  const now = options.now || Date.now, idleMs = options.idleMs || 30 * 60 * 1000, maxAgeMs = options.maxAgeMs || 4 * 60 * 60 * 1000;
  const capacity = options.capacity || 100, rooms = new Map();
  const randomFirst = options.randomFirst || (() => crypto.randomInt(2));
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  function sweep() {
    const time = now();
    for (const [code, room] of rooms) if (time >= room.expiresAt) rooms.delete(code);
  }
  function touch(room) { room.expiresAt = Math.min(now() + idleMs, room.createdAt + maxAgeMs); }
  function get(code) {
    sweep();
    if (!CODE.test(code || '') || !rooms.has(code)) fail(404, 'ROOM_NOT_FOUND', '房间不存在、已离开或已过期');
    return rooms.get(code);
  }
  function member(room, token) {
    if (!TOKEN.test(token || '')) fail(401, 'UNAUTHORIZED', '需要有效房间会话');
    const seat = room.members.findIndex(item => item.token === token);
    if (seat < 0) fail(401, 'UNAUTHORIZED', '房间会话无效');
    return seat;
  }
  function snapshot(room) {
    return clone({ code: room.code, revision: room.revision, status: room.status,
      players: room.members.map((item, seat) => ({ seat, profile: item.profile })), game: room.game, expiresAt: room.expiresAt });
  }
  function credentials(room, seat) { return { roomCode: room.code, seat, token: room.members[seat].token, room: snapshot(room) }; }
  return {
    create(profile) {
      const clean = validateProfile(profile); sweep();
      if (rooms.size >= capacity) fail(503, 'ROOM_CAPACITY', '当前内测房间已满，请稍后再试');
      let code;
      do { code = Array.from(crypto.randomBytes(8), byte => alphabet[byte & 31]).join(''); } while (rooms.has(code));
      const room = { code, createdAt: now(), expiresAt: 0, revision: 0, status: 'waiting', game: null,
        members: [{ token: crypto.randomBytes(32).toString('hex'), profile: clean, actions: new Map() }] };
      touch(room); rooms.set(code, room); return credentials(room, 0);
    },
    join(code, profile) {
      const clean = validateProfile(profile), room = get(code);
      if (room.members.length !== 1 || room.status !== 'waiting') fail(409, 'ROOM_FULL', '该房间已有两人或已开始');
      const first = randomFirst();
      if (first !== 0 && first !== 1) throw new Error('Invalid server random source');
      room.members.push({ token: crypto.randomBytes(32).toString('hex'), profile: clean, actions: new Map() });
      room.game = engine.createGame({ mode: 'pvp', aiFirst: first === 1,
        avatars: room.members.map((m, seat) => m.profile.avatar.type === 'preset' ? m.profile.avatar.index : seat ? 3 : 0) });
      room.status = 'playing'; room.revision++; touch(room); return credentials(room, 1);
    },
    read(code, token) { const room = get(code); member(room, token); touch(room); return { room: snapshot(room) }; },
    move(code, token, body) {
      const room = get(code), seat = member(room, token);
      if (!object(body, ['actionId', 'expectedRevision', 'row', 'count']) || !/^[A-Za-z0-9_-]{8,80}$/.test(body.actionId || '') ||
          !Number.isSafeInteger(body.expectedRevision) || body.expectedRevision < 0 || !Number.isInteger(body.row) || !Number.isInteger(body.count)) {
        fail(400, 'INVALID_MOVE', '落子请求格式无效');
      }
      const fingerprint = JSON.stringify([body.expectedRevision, body.row, body.count]);
      const actions = room.members[seat].actions;
      if (actions.has(body.actionId)) {
        if (actions.get(body.actionId) !== fingerprint) fail(409, 'ACTION_ID_CONFLICT', '同一落子编号不能用于不同操作');
        touch(room); return { room: snapshot(room) };
      }
      if (room.status !== 'playing') fail(409, 'GAME_NOT_PLAYING', '当前房间不在对局中');
      if (body.expectedRevision !== room.revision) fail(409, 'REVISION_CONFLICT', '棋局已更新，请先刷新');
      if (room.game.currentPlayer !== seat) fail(409, 'OUT_OF_TURN', '尚未轮到你落子');
      let next;
      try { next = engine.move(room.game, body.row, body.count); } catch (_) { fail(400, 'ILLEGAL_MOVE', '每次只能从一排拿至少一颗骰子'); }
      room.game = next; room.revision++; if (next.winner !== null) room.status = 'finished';
      actions.set(body.actionId, fingerprint); // At most 15 legal moves exist in a match.
      touch(room); return { room: snapshot(room) };
    },
    leave(code, token) { const room = get(code); member(room, token); rooms.delete(code); return { closed: true }; },
    sweep,
    inspectCounts() { sweep(); return { rooms: rooms.size }; } // Local tests/operations only; never an HTTP listing.
  };
}
module.exports = { createRoomService, RoomError, validateProfile, CODE, MAX_IMAGE };
