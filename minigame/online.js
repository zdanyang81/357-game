'use strict';
const engine = require('./core/engine');
const SHORT = /^[0-9]{4}$/;
const LEGACY = /^[A-HJ-NP-Z2-9]{8}$/;
const CODE = { test: value => SHORT.test(value) || LEGACY.test(value) };
const LEGACY_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function normalizeCode(value) {
  if (typeof value !== 'string') return '';
  // Fullwidth digits and letters are common when a code is read across two WeChat chats.
  // Do not drop letters or digits: stripping them could join a different room.
  return value.trim()
    .replace(/[Ａ-Ｚａ-ｚ０-９]/g, ch => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0))
    .toUpperCase()
    .replace(/^房间码[:：]?/, '')
    .replace(/\s+/g, '');
}
function codeIssue(value) {
  const code = normalizeCode(value);
  if (CODE.test(code)) return '';
  if (!code) return '请先输入房间码';
  if (/[IO01]/.test(code) && /[A-Z]/.test(code)) return '8位旧码不含字母I/O和数字0/1。新房间是4位数字。不是微信号或手机号。';
  if (code.length === 11 && /^[0-9]+$/.test(code)) return '这不是手机号。房间码是4位数字，或尚未更新服务时的8位旧码。';
  if (/[A-Z]/.test(code) && code.length !== 8) return '8位旧码必须是8位，当前' + code.length + '位。不是微信号。';
  if (!/[A-Z]/.test(code) && code.length !== 4) return '新房间码是4位数字，当前' + code.length + '位。不是手机号。';
  return '房间码只能是4位数字，或8位旧码。不是微信号或手机号。';
}
function inviteCode(query) { const code = normalizeCode(query && query.room); return CODE.test(code) ? code : ''; }
function asNumber(value, fallback) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && /^-?\d+$/.test(value)) return Number(value);
  return fallback;
}
function decodeBody(data) {
  let value = data;
  for (let i = 0; i < 2 && typeof value === 'string'; i++) {
    const text = value.replace(/^\uFEFF/, '').trim();
    if (!text.startsWith('{') && !text.startsWith('[')) break;
    try { value = JSON.parse(text); } catch (_) { break; }
  }
  return value;
}
function plainMove(entry) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null;
  if (!Array.isArray(entry.piles)) return null;
  return {
    player: asNumber(entry.player), row: asNumber(entry.row), count: asNumber(entry.count),
    piles: entry.piles.map(n => asNumber(n))
  };
}
function acceptGame(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const history = Array.isArray(raw.history) ? raw.history.map(plainMove).filter(Boolean) : [];
  if (!Array.isArray(raw.piles) || !Array.isArray(raw.avatars)) return null;
  let winner = raw.winner;
  if (winner == null || winner === '') winner = null;
  else winner = asNumber(winner);
  const aiKnown = raw.aiFirst === true || raw.aiFirst === false || raw.aiFirst === 0 || raw.aiFirst === 1 ||
    raw.aiFirst === '0' || raw.aiFirst === '1' || raw.aiFirst === 'true' || raw.aiFirst === 'false';
  const aiFlags = aiKnown ? [raw.aiFirst === true || raw.aiFirst === 1 || raw.aiFirst === '1' || raw.aiFirst === 'true'] : [false, true];
  const currents = raw.currentPlayer == null || raw.currentPlayer === '' ? [0, 1] : [asNumber(raw.currentPlayer)];
  for (const aiFirst of aiFlags) {
    for (const currentPlayer of currents) {
      const candidate = {
        version: asNumber(raw.version, 1), piles: raw.piles.map(n => asNumber(n)), currentPlayer,
        mode: raw.mode || 'pvp', difficulty: raw.difficulty || 'easy', aiFirst,
        avatars: raw.avatars.map(n => asNumber(n)), history, winner
      };
      if (engine.validateState(candidate)) return candidate;
    }
  }
  return null;
}
function normalizeRoom(room) {
  if (!room || typeof room !== 'object' || Array.isArray(room)) return room;
  const players = Array.isArray(room.players) ? room.players.map((player, index) => {
    if (!player || typeof player !== 'object') return player;
    const seat = player.seat == null || player.seat === '' ? index : asNumber(player.seat, player.seat);
    return { seat, profile: player.profile };
  }) : room.players;
  const waiting = room.status === 'waiting';
  const rawDeadline = room.turnDeadline;
  const parsedDeadline = rawDeadline == null || rawDeadline === '' ? null : asNumber(rawDeadline, NaN);
  return {
    code: typeof room.code === 'string' ? normalizeCode(room.code) : room.code,
    revision: room.revision == null || room.revision === '' ? (waiting ? 0 : room.revision) : asNumber(room.revision, room.revision),
    status: room.status, players, expiresAt: room.expiresAt,
    turnDeadline: typeof parsedDeadline === 'number' && Number.isFinite(parsedDeadline) ? parsedDeadline : null,
    serverNow: room.serverNow == null || room.serverNow === '' ? null : asNumber(room.serverNow, null),
    game: waiting || room.game == null || room.game === '' ? null : acceptGame(room.game)
  };
}
function normalizePayload(data) {
  data = decodeBody(data);
  if (!data || typeof data !== 'object' || Array.isArray(data)) return data;
  const room = data.room && typeof data.room === 'object' ? normalizeRoom(data.room) : data.room;
  let seat = data.seat;
  if (seat == null || seat === '') {
    if (room && Array.isArray(room.players) && room.players.length === 1) seat = 0;
  } else seat = asNumber(seat, seat);
  const roomCode = typeof data.roomCode === 'string' ? normalizeCode(data.roomCode) : (room && room.code) || data.roomCode;
  return { ...data, seat, room, roomCode };
}
function validRoom(room) {
  const value = normalizeRoom(room);
  return !!value && CODE.test(value.code) && Number.isSafeInteger(value.revision) && value.revision >= 0 &&
    ['waiting', 'playing', 'finished'].includes(value.status) && Array.isArray(value.players) &&
    value.players.length >= 1 && value.players.length <= 2 && value.players.every((p, i) => p && p.seat === i && p.profile) &&
    (value.turnDeadline == null || Number.isFinite(value.turnDeadline)) &&
    (value.status === 'waiting' ? value.game == null : engine.validateState(value.game) && value.game.mode === 'pvp' &&
      (value.status === 'finished') === (value.game.winner !== null));
}
class OnlineSession {
  constructor(platform, base, changed, accessKey) {
    this.p = platform; this.base = typeof base === 'string' ? base.replace(/\/$/, '') : '';
    this.enabled = /^https:\/\/[^/?#]+(?:\/[^?#]*)?$/.test(this.base);
    // A per-preview cohort capability, not player identity. Never share it in invitations.
    this.accessKey = typeof accessKey === 'string' ? accessKey : '';
    this.changed = changed || (() => {}); this.room = null; this.token = ''; this.seat = null;
    this.busy = false; this.hidden = false; this.destroyed = false; this.epoch = 0;
    this.timer = null; this.error = ''; this.uncertain = false; this.serial = 0;
    this.creationUnknown = false; this.reading = false; this.expired = false;
    this.clockSample = null; this.clockGeneration = 0; this.responseSamples = new WeakMap();
    this.requestSequence = 0; this.acceptedSequence = 0; this.readGeneration = 0;
    this.clockEpoch = 0; this.refreshAfterBusy = false; this.recoveryPending = false;
    // WeChat exposes a monotonic clock on supported versions; keep the same clock
    // for the lifetime of this session. Older runtimes fall back to wall time.
    let perf = null;
    try {
      if (typeof wx !== 'undefined' && typeof wx.getPerformance === 'function') perf = wx.getPerformance();
      else if (typeof performance !== 'undefined') perf = performance;
    } catch (_) {}
    this.relativeNow = typeof platform.monotonicNow === 'function' ? () => platform.monotonicNow() :
      perf && typeof perf.now === 'function' ? () => perf.now() :
      typeof platform.now === 'function' ? () => platform.now() : () => Date.now();
  }
  notify() { if (!this.destroyed) this.changed(); }
  stopTimer() { if (this.timer !== null) this.p.clearTimeout(this.timer); this.timer = null; }
  schedule() {
    this.stopTimer();
    if (this.hidden || this.destroyed || this.expired || !this.token || this.busy || this.reading || (this.room.status === 'finished' && !this.uncertain)) return;
    this.timer = this.p.setTimeout(() => { this.timer = null; this.refresh(); }, 1500);
  }
  request(method, path, data, auth) {
    if (!this.enabled) return Promise.reject(new Error('联网内测未开放：尚未配置 HTTPS 服务'));
    const header = auth ? { Authorization: 'Bearer ' + this.token } : {};
    if (data !== undefined) header['Content-Type'] = 'application/json';
    if (this.accessKey) header['X-357-Access-Key'] = this.accessKey;
    const started = this.relativeNow(), sequence = ++this.requestSequence, clockEpoch = this.clockEpoch;
    return this.p.request({ url: this.base + path, method, data, header, timeout: 8000, dataType: 'json' }).then(res => {
      const received = this.relativeNow();
      const body = normalizePayload(res && res.data);
      if (body && typeof body === 'object') this.responseSamples.set(body, { received, sequence, clockEpoch, rtt: Math.max(0, received - started) });
      const rawStatus = res && (res.statusCode != null ? res.statusCode : res.status);
      const status = Number(rawStatus);
      const hasStatus = Number.isInteger(status) && status > 0;
      const detail = body && typeof body === 'object' && !Array.isArray(body) ? body.error : null;
      const completed = hasStatus ? status >= 200 && status < 300 : !!(body && body.room && !detail);
      if (!res || !completed || (detail && !(body && body.room))) {
        const error = new Error(detail && detail.message || '服务暂不可用');
        error.code = detail && detail.code; error.statusCode = hasStatus ? status : 0;
        error.definite = (hasStatus && status >= 400 && status < 500) || (completed && !!(detail && detail.message));
        throw error;
      }
      return body;
    });
  }
  accept(room, response) {
    const normalized = normalizeRoom(room);
    if (!validRoom(normalized) || (this.room && normalized.code !== this.room.code)) throw new Error('房间响应格式错误');
    if (this.room && normalized.revision < this.room.revision) return;
    const serverNow = Number.isFinite(normalized.serverNow) ? normalized.serverNow : null;
    const timing = response && this.responseSamples.get(response);
    // Server wall time may move backwards. Order equal-revision snapshots by
    // request dispatch instead; a higher authoritative revision always wins.
    if (this.room && normalized.revision === this.room.revision && timing && timing.sequence < this.acceptedSequence) return;
    this.room = normalized;
    if (timing) this.acceptedSequence = timing.sequence;
    const received = timing ? timing.received : this.relativeNow();
    if (normalized.status === 'playing' && normalized.turnDeadline != null && (!timing || timing.clockEpoch === this.clockEpoch)) {
      // The snapshot was made during the request; half the RTT is an estimate of
      // response transit. The server remains authoritative if this is early.
      const wallNow = typeof this.p.now === 'function' ? this.p.now() : Date.now();
      const remaining = normalized.turnDeadline - (serverNow == null ? wallNow : serverNow) -
        (serverNow == null || !timing ? 0 : timing.rtt / 2);
      this.clockSample = { serverNow, until: received + Math.max(0, remaining) };
    } else this.clockSample = null;
    this.clockGeneration++;
    return true;
  }
  remainingTurnMs() {
    return this.clockSample ? Math.max(0, this.clockSample.until - this.relativeNow()) : null;
  }
  async enter(code, profile) {
    if (this.busy || this.token || this.creationUnknown || this.destroyed) return false;
    const normalized = normalizeCode(code);
    if (code && !CODE.test(normalized)) { this.error = codeIssue(code); this.notify(); return false; }
    const epoch = this.epoch; this.busy = true; this.error = ''; this.notify();
    try {
      const data = await this.request('POST', code ? '/v1/rooms/' + normalized + '/join' : '/v1/rooms', { profile }, false);
      if (epoch !== this.epoch || this.destroyed) return false;
      const room = data && normalizeRoom(data.room);
      if (!data || !validRoom(room) || data.roomCode !== room.code || ![0, 1].includes(data.seat) ||
          typeof data.token !== 'string' || data.token.length < 16) throw new Error('房间响应格式错误');
      this.accept(room, data); this.token = data.token; this.seat = data.seat; this.uncertain = false; this.expired = false;
      return true;
    } catch (error) {
      if (epoch === this.epoch && !this.destroyed) {
        this.creationUnknown = this.enabled && !error.definite;
        let reason = error && typeof error.message === 'string' ? error.message : '网络请求未确认';
        for (const secret of [this.token, this.accessKey]) if (secret) reason = reason.split(secret).join('[已隐藏]');
        reason = reason.replace(/\bBearer\s+[A-Za-z0-9_.~+\/-]+/gi, 'Bearer [已隐藏]').slice(0, 180);
        if (error && error.code === 'ROOM_FULL') reason = '该房间已有两人或已开始。请新建一个房间码，不要重复加入刚才那个。';
        this.error = this.creationUnknown ? '创建/加入结果未知，已停止重复操作。\n原因：' + reason + '\n请新建房间码，不要重复加入刚才那个。' : reason;
      }
      return false;
    } finally { if (epoch === this.epoch) {
      this.busy = false; this.notify();
      if (!this.token) { this.refreshAfterBusy = false; this.recoveryPending = false; }
      if (this.refreshAfterBusy && !this.hidden && this.token) this.refresh(); else this.schedule();
    } }
  }
  async refresh() {
    if (!this.token || this.reading || this.busy || this.hidden || this.destroyed) return;
    this.refreshAfterBusy = false;
    const epoch = this.epoch, generation = ++this.readGeneration; this.reading = true;
    try {
      const data = await this.request('GET', '/v1/rooms/' + this.room.code, undefined, true);
      if (epoch !== this.epoch || generation !== this.readGeneration || this.destroyed) return;
      if (!this.accept(data.room, data)) throw new Error('房间响应已过期');
      this.recoveryPending = false; this.uncertain = false; this.expired = false; this.error = '';
    } catch (error) {
      if (epoch === this.epoch && generation === this.readGeneration && !this.destroyed) {
        this.expired = [401, 404, 410].includes(error.statusCode);
        this.error = this.expired ? '房间已关闭/过期或会话失效，请离开房间' : error.message + '；可手动刷新';
        this.uncertain = true;
      }
    } finally { if (epoch === this.epoch && generation === this.readGeneration) { this.reading = false; this.notify(); this.schedule(); } }
  }
  async move(row, count) {
    if (!this.canMove()) return;
    const epoch = this.epoch;
    // A pre-move read cannot settle the result of this mutation.
    this.readGeneration++; this.reading = false;
    const data = { actionId: 'move_' + Date.now().toString(36) + '_' + (++this.serial),
      expectedRevision: this.room.revision, row, count };
    this.busy = true; this.stopTimer(); this.error = ''; this.notify(); let recheck = false;
    try {
      const result = await this.request('POST', '/v1/rooms/' + this.room.code + '/moves', data, true);
      if (epoch === this.epoch && !this.destroyed) this.accept(result.room, result);
    } catch (error) {
      if (epoch === this.epoch && !this.destroyed) {
        this.error = '走子未确认，正在核对权威棋盘'; this.uncertain = true; recheck = true;
      }
    } finally {
      if (epoch === this.epoch) {
        this.busy = false; this.notify();
        if (recheck || this.refreshAfterBusy) await this.refresh(); else this.schedule();
      }
    }
  }
  canMove() { return !!this.token && !this.busy && !this.uncertain && !this.recoveryPending && !this.hidden && !this.destroyed &&
    this.room.status === 'playing' && this.room.game.currentPlayer === this.seat; }
  async leave() {
    if (!this.token || this.busy || this.destroyed) return false;
    if (this.expired) {
      // Authority already confirmed this session is gone: discard locally, never resend leave.
      this.stopTimer(); this.epoch++; this.token = ''; this.room = null; this.seat = null;
      this.reading = false; this.uncertain = false; this.recoveryPending = false; this.refreshAfterBusy = false; this.error = ''; this.notify(); return true;
    }
    if (this.uncertain) { await this.refresh(); return false; }
    // A GET started before this mutation cannot confirm its outcome.
    const epoch = ++this.epoch; this.reading = false;
    this.busy = true; this.stopTimer(); this.error = ''; this.notify();
    try {
      await this.request('POST', '/v1/rooms/' + this.room.code + '/leave', {}, true);
      if (epoch !== this.epoch || this.destroyed) return false;
      this.epoch++; this.token = ''; this.room = null; this.seat = null; this.error = ''; this.uncertain = false; this.refreshAfterBusy = false; this.recoveryPending = false;
      this.reading = false; this.busy = false; this.notify(); return true;
    } catch (error) {
      if (epoch === this.epoch && [401, 404, 410].includes(error.statusCode)) {
        this.epoch++; this.token = ''; this.room = null; this.seat = null; this.busy = false; this.reading = false;
        this.recoveryPending = false; this.refreshAfterBusy = false;
        this.error = '房间或会话已失效'; this.notify(); return true;
      }
      if (epoch === this.epoch && !this.destroyed) {
        this.error = '离开结果未确认；正在只读核对房间，可手动刷新';
        this.busy = false; this.uncertain = true; this.notify();
        if (this.refreshAfterBusy && !this.hidden) this.refresh(); else this.schedule();
      }
      return false;
    }
  }
  setHidden(hidden) {
    this.hidden = hidden; this.stopTimer();
    if (hidden) {
      this.clockEpoch++; this.readGeneration++; this.reading = false;
      this.clockSample = null; this.clockGeneration++;
      if (this.token || this.busy) this.recoveryPending = true;
      if (this.busy) this.refreshAfterBusy = true;
    } else this.refresh();
  }
  destroy() { this.stopTimer(); this.epoch++; this.destroyed = true; this.token = ''; this.room = null; this.recoveryPending = false; this.refreshAfterBusy = false; }
}
module.exports = { OnlineSession, inviteCode, normalizeCode, codeIssue, validRoom, normalizePayload, CODE, SHORT, LEGACY, LEGACY_ALPHABET };
