'use strict';
const engine = require('./core/engine');
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE = /^[A-HJ-NP-Z2-9]{8}$/;
function normalizeCode(value) {
  if (typeof value !== 'string') return '';
  // Fullwidth IME digits/letters are common when two people read a code across WeChat.
  // Strip only a label and whitespace; never drop I/O/0/1, or a mistype could join another room.
  return value.trim()
    .replace(/[Ａ-Ｚａ-ｚ０-９]/g, ch => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0))
    .toUpperCase()
    .replace(/^房间码[:：]?/, '')
    .replace(/\s+/g, '');
}
function codeIssue(value) {
  const code = normalizeCode(value);
  if (CODE.test(code)) return '';
  if (!code) return '请先输入8位房间码';
  if (/[IO01]/.test(code)) return '房间码不含字母I/O和数字0/1，请逐位核对';
  if (code.length !== 8) return '房间码必须是8位，当前' + code.length + '位';
  return '房间码只能是大写字母和数字，且不含I/O、0/1';
}
function inviteCode(query) { const code = normalizeCode(query && query.room); return CODE.test(code) ? code : ''; }
function validRoom(room) {
  return !!room && CODE.test(room.code) && Number.isSafeInteger(room.revision) && room.revision >= 0 &&
    ['waiting', 'playing', 'finished'].includes(room.status) && Array.isArray(room.players) &&
    room.players.length >= 1 && room.players.length <= 2 && room.players.every((p, i) => p.seat === i && p.profile) &&
    (room.status === 'waiting' ? room.game == null : engine.validateState(room.game) && room.game.mode === 'pvp' &&
      (room.status === 'finished') === (room.game.winner !== null));
}
function decodeBody(data) {
  if (typeof data !== 'string') return data;
  const text = data.trim();
  if (!text.startsWith('{')) return data;
  try { return JSON.parse(text); } catch (_) { return data; }
}
function normalizePayload(data) {
  data = decodeBody(data);
  if (!data || typeof data !== 'object') return data;
  if (typeof data.seat === 'string' && /^[01]$/.test(data.seat)) data.seat = Number(data.seat);
  const room = data.room;
  if (room && typeof room === 'object') {
    if (typeof room.revision === 'string' && /^\d+$/.test(room.revision)) room.revision = Number(room.revision);
    if (room.status === 'waiting' && (room.game == null || room.game === '')) room.game = null;
    // WeChat JSON drops null. A started game then lacks winner and fails validation
    // after the server has already seated the guest.
    if (room.game && typeof room.game === 'object' && !Array.isArray(room.game) && !Object.hasOwn(room.game, 'winner')) room.game.winner = null;
    if (Array.isArray(room.players)) room.players.forEach((player, index) => {
      if (player && typeof player.seat === 'string' && Number(player.seat) === index) player.seat = index;
    });
  }
  return data;
}
function formatError(data, status) {
  const body = data && typeof data === 'object' ? data : null;
  const room = body && body.room;
  const kind = data == null ? 'empty' : Array.isArray(data) ? 'array' : typeof data;
  let check = 'shape';
  if (body && body.error && body.error.code) check = 'err';
  else if (!body || !body.room) check = 'noroom';
  else if (body.roomCode !== room.code) check = 'code';
  else if (![0, 1].includes(body.seat)) check = 'seat';
  else if (typeof body.token !== 'string' || body.token.length < 16) check = 'token';
  else if (!CODE.test(room.code || '')) check = 'roomcode';
  else if (!Number.isSafeInteger(room.revision)) check = 'revision';
  else if (!['waiting', 'playing', 'finished'].includes(room.status)) check = 'status';
  else check = 'players';
  const error = new Error('房间响应格式错误（' + (status || '?') + ' ' + kind + ' ' + check + '）');
  error.definite = true;
  return error;
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
    return this.p.request({ url: this.base + path, method, data, header, timeout: 8000, dataType: 'json' }).then(res => {
      const body = normalizePayload(res && res.data);
      const status = Number(res && (res.statusCode != null ? res.statusCode : res.status));
      const detail = body && body.error;
      const completed = Number.isInteger(status) && status >= 200 && status < 300;
      if (!res || !completed || (detail && !body.room)) {
        const error = new Error(detail && detail.message || '服务暂不可用');
        error.code = detail && detail.code; error.statusCode = status;
        error.definite = (status >= 400 && status < 500) || (completed && !!(detail && detail.message));
        throw error;
      }
      return body;
    });
  }
  accept(room) {
    if (!validRoom(room) || (this.room && room.code !== this.room.code)) throw formatError({ room }, 200);
    if (this.room && room.revision < this.room.revision) return;
    this.room = room;
  }
  async enter(code, profile) {
    if (this.busy || this.token || this.creationUnknown || this.destroyed) return false;
    const normalized = normalizeCode(code);
    if (code && !CODE.test(normalized)) { this.error = '请输入8位房间码（不含I/O、0/1）'; this.notify(); return false; }
    const epoch = this.epoch; this.busy = true; this.error = ''; this.notify();
    try {
      const data = await this.request('POST', code ? '/v1/rooms/' + normalized + '/join' : '/v1/rooms', { profile }, false);
      if (epoch !== this.epoch || this.destroyed) return false;
      if (!data || !validRoom(data.room) || data.roomCode !== data.room.code || ![0, 1].includes(data.seat) ||
          typeof data.token !== 'string' || data.token.length < 16) throw formatError(data, 200);
      this.accept(data.room); this.token = data.token; this.seat = data.seat; this.uncertain = false; this.expired = false;
      return true;
    } catch (error) {
      if (epoch === this.epoch && !this.destroyed) {
        this.creationUnknown = this.enabled && !error.definite;
        let reason = error && typeof error.message === 'string' ? error.message : '网络请求未确认';
        for (const secret of [this.token, this.accessKey]) if (secret) reason = reason.split(secret).join('[已隐藏]');
        reason = reason.replace(/\bBearer\s+[A-Za-z0-9_.~+\/-]+/gi, 'Bearer [已隐藏]').slice(0, 180);
        this.error = this.creationUnknown ? '创建/加入结果未知，已停止重复操作。\n原因：' + reason + '\n请先核对网络或配置；不要反复创建。' : reason;
      }
      return false;
    } finally { if (epoch === this.epoch) { this.busy = false; this.notify(); this.schedule(); } }
  }
  async refresh() {
    if (!this.token || this.reading || this.busy || this.hidden || this.destroyed) return;
    const epoch = this.epoch; this.reading = true;
    try {
      const data = await this.request('GET', '/v1/rooms/' + this.room.code, undefined, true);
      if (epoch !== this.epoch || this.destroyed) return;
      this.accept(data.room); this.uncertain = false; this.expired = false; this.error = '';
    } catch (error) {
      if (epoch === this.epoch && !this.destroyed) {
        this.expired = [401, 404, 410].includes(error.statusCode);
        this.error = this.expired ? '房间已关闭/过期或会话失效，请离开房间' : error.message + '；可手动刷新';
        this.uncertain = true;
      }
    } finally { if (epoch === this.epoch) { this.reading = false; this.notify(); this.schedule(); } }
  }
  async move(row, count) {
    if (!this.canMove()) return;
    const epoch = this.epoch;
    const data = { actionId: 'move_' + Date.now().toString(36) + '_' + (++this.serial),
      expectedRevision: this.room.revision, row, count };
    this.busy = true; this.stopTimer(); this.error = ''; this.notify(); let recheck = false;
    try {
      const result = await this.request('POST', '/v1/rooms/' + this.room.code + '/moves', data, true);
      if (epoch === this.epoch && !this.destroyed) this.accept(result.room);
    } catch (error) {
      if (epoch === this.epoch && !this.destroyed) {
        this.error = '走子未确认，正在核对权威棋盘'; this.uncertain = true; recheck = true;
      }
    } finally {
      if (epoch === this.epoch) {
        this.busy = false; this.notify();
        if (recheck) { this.reading = false; await this.refresh(); } else this.schedule();
      }
    }
  }
  canMove() { return !!this.token && !this.busy && !this.uncertain && !this.hidden && !this.destroyed &&
    this.room.status === 'playing' && this.room.game.currentPlayer === this.seat; }
  async leave() {
    if (!this.token || this.busy || this.destroyed) return false;
    if (this.expired) {
      // Authority already confirmed this session is gone: discard locally, never resend leave.
      this.stopTimer(); this.epoch++; this.token = ''; this.room = null; this.seat = null;
      this.reading = false; this.uncertain = false; this.error = ''; this.notify(); return true;
    }
    if (this.uncertain) { await this.refresh(); return false; }
    // A GET started before this mutation cannot confirm its outcome.
    const epoch = ++this.epoch; this.reading = false;
    this.busy = true; this.stopTimer(); this.error = ''; this.notify();
    try {
      await this.request('POST', '/v1/rooms/' + this.room.code + '/leave', {}, true);
      if (epoch !== this.epoch || this.destroyed) return false;
      this.epoch++; this.token = ''; this.room = null; this.seat = null; this.error = ''; this.uncertain = false;
      this.reading = false; this.busy = false; this.notify(); return true;
    } catch (error) {
      if (epoch === this.epoch && [401, 404, 410].includes(error.statusCode)) {
        this.epoch++; this.token = ''; this.room = null; this.seat = null; this.busy = false; this.reading = false;
        this.error = '房间或会话已失效'; this.notify(); return true;
      }
      if (epoch === this.epoch && !this.destroyed) {
        this.error = '离开结果未确认；正在只读核对房间，可手动刷新';
        this.busy = false; this.uncertain = true; this.notify(); this.schedule();
      }
      return false;
    }
  }
  setHidden(hidden) { this.hidden = hidden; this.stopTimer(); if (!hidden) this.refresh(); }
  destroy() { this.stopTimer(); this.epoch++; this.destroyed = true; this.token = ''; this.room = null; }
}
module.exports = { OnlineSession, inviteCode, normalizeCode, codeIssue, validRoom, CODE, ALPHABET };
