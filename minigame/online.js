'use strict';
const engine = require('./core/engine');
const CODE = /^[A-HJ-NP-Z2-9]{8}$/;
const normalizeCode = value => typeof value === 'string' ? value.trim().toUpperCase() : '';
function inviteCode(query) { const code = normalizeCode(query && query.room); return CODE.test(code) ? code : ''; }
function validRoom(room) {
  return !!room && CODE.test(room.code) && Number.isSafeInteger(room.revision) && room.revision >= 0 &&
    ['waiting', 'playing', 'finished'].includes(room.status) && Array.isArray(room.players) &&
    room.players.length >= 1 && room.players.length <= 2 && room.players.every((p, i) => p.seat === i && p.profile) &&
    (room.status === 'waiting' ? room.game === null : engine.validateState(room.game) && room.game.mode === 'pvp' &&
      (room.status === 'finished') === (room.game.winner !== null));
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
    if (this.hidden || this.destroyed || this.expired || !this.token || this.busy || this.reading || this.room.status === 'finished') return;
    this.timer = this.p.setTimeout(() => { this.timer = null; this.refresh(); }, 1500);
  }
  request(method, path, data, auth) {
    if (!this.enabled) return Promise.reject(new Error('联网内测未开放：尚未配置 HTTPS 服务'));
    const header = auth ? { Authorization: 'Bearer ' + this.token } : {};
    if (data !== undefined) header['Content-Type'] = 'application/json';
    if (this.accessKey) header['X-357-Access-Key'] = this.accessKey;
    return this.p.request({ url: this.base + path, method, data, header, timeout: 8000 }).then(res => {
      if (!res || res.statusCode < 200 || res.statusCode >= 300) {
        const detail = res && res.data && res.data.error;
        const error = new Error(detail && detail.message || '服务暂不可用');
        error.code = detail && detail.code; error.statusCode = res && res.statusCode; error.definite = !!res && res.statusCode >= 400 && res.statusCode < 500; throw error;
      }
      return res.data;
    });
  }
  accept(room) {
    if (!validRoom(room) || (this.room && room.code !== this.room.code)) throw new Error('房间响应格式错误');
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
      if (!validRoom(data.room) || data.roomCode !== data.room.code || ![0, 1].includes(data.seat) ||
          typeof data.token !== 'string' || data.token.length < 16) throw new Error('房间响应格式错误');
      this.accept(data.room); this.token = data.token; this.seat = data.seat; this.uncertain = false; this.expired = false;
      return true;
    } catch (error) {
      if (epoch === this.epoch && !this.destroyed) {
        this.creationUnknown = this.enabled && !error.definite;
        this.error = this.creationUnknown ? '创建/加入结果未知，已停止操作；请等待房间过期后重进内测' : error.message;
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
    const epoch = this.epoch; this.busy = true; this.stopTimer(); this.notify();
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
      if (epoch === this.epoch) { this.error = '离开结果未确认；请刷新核实或等待过期'; this.busy = false; this.uncertain = true; this.notify(); }
      return false;
    }
  }
  setHidden(hidden) { this.hidden = hidden; this.stopTimer(); if (!hidden) this.refresh(); }
  destroy() { this.stopTimer(); this.epoch++; this.destroyed = true; this.token = ''; this.room = null; }
}
module.exports = { OnlineSession, inviteCode, normalizeCode, validRoom, CODE };
