'use strict';

const engine = require('./core/engine');
const KEYS = { settings: '357.ui.settings.v1', save: '357.ui.save.v1', stats: '357.ui.results.v1' };
const GOLD = '#d8b674', INK = '#f2ecd9', MUTED = '#9ab4a8';
const NAMES = ['小狐', '小熊', '小兔', '小猫', '小蛙', '小企鹅'];
const LEVELS = { easy: '休闲', medium: '挑战', hard: '高手' };
const MOVE_MS = 260, MOVE_RISE = 14, DIE_MAX = 50, ROW_MAX = 106;
const easeOut = t => 1 - Math.pow(1 - t, 3);
const clone = value => JSON.parse(JSON.stringify(value));

/** Canvas coordinates are CSS pixels; platform owns DPR scaling.
 * Inspection API: screen, state, selected, phase, locked, hidden, epoch,
 * modal, hitBoxes, settings, stats, assisted, lastError. Retire with destroy().
 */
class GameUI {
  constructor(platform) {
    if (!platform || !platform.canvas) throw new Error('GameUI 需要有效的 Canvas 平台');
    this.platform = platform;
    this.ctx = platform.canvas.getContext('2d');
    if (!this.ctx) throw new Error('无法创建 Canvas2D 上下文');
    this.width = Number(platform.width) || 320;
    this.height = Number(platform.height) || 568;
    this.top = Math.max(8, Number(platform.safeTop) || 0);
    this.bottom = this.height - Math.max(10, Number(platform.safeBottom) || 0);
    this.screen = 'home'; this.state = null; this.selected = null;
    this.phase = 'idle'; this.locked = false; this.hidden = false; this.destroyed = false;
    this.epoch = 0; this.timers = new Set(); this.unsubscribers = []; this.hitBoxes = [];
    this.modal = null; this.motion = null; this.toast = ''; this.shareStatus = '';
    this.lastError = null; this.storageWarning = false;
    this.assisted = false; this.gameId = null; this.serial = 0;
    this.pressed = null; this.statsDirty = false; this.saveCleared = false; this.bgLayer = undefined;
    this.settings = this.loadSettings();
    this.modeChoice = this.settings.mode; this.difficultyChoice = this.settings.difficulty;
    this.stats = this.loadStats();
    this.resumeCandidate = this.loadSave();
    this.bind('onTouch', point => this.handleTouch(point));
    this.bind('onTouchStart', point => this.handlePress(point));
    this.bind('onTouchCancel', () => this.releasePress());
    this.bind('onHide', () => this.onHide());
    this.bind('onShow', () => this.onShow());
    if (this.resumeCandidate) this.modal = { type: 'restore', page: 0 };
    this.render();
  }

  bind(name, fn) {
    try {
      if (typeof this.platform[name] === 'function') {
        const off = this.platform[name](fn);
        if (typeof off === 'function') this.unsubscribers.push(off);
      }
    } catch (error) { this.lastError = error; }
  }

  readStore(key) {
    try {
      const value = this.platform.storage.get(key);
      return typeof value === 'string' ? JSON.parse(value) : value;
    } catch (error) { this.lastError = error; return null; }
  }

  store(key, value) {
    try {
      if (this.platform.storage.set(key, clone(value)) === false) throw new Error('本地存储写入失败');
      return true;
    } catch (error) {
      this.lastError = error; this.storageWarning = true;
      this.toast = '本地保存失败，本次仍可继续游玩';
      return false;
    }
  }

  loadSettings() {
    const raw = this.readStore(KEYS.settings), value = raw && typeof raw === 'object' ? raw : {};
    const avatars = Array.isArray(value.avatars) && value.avatars.length === 2 &&
      value.avatars.every(n => Number.isInteger(n) && n >= 0 && n < 6) ? value.avatars.slice() : [0, 3];
    if (avatars[0] === avatars[1]) avatars[1] = (avatars[1] + 1) % 6;
    return { sound: value.sound !== false, vibration: value.vibration !== false, aiFirst: value.aiFirst === true,
      mode: value.mode === 'pvp' ? 'pvp' : 'ai',
      difficulty: Object.prototype.hasOwnProperty.call(LEVELS, value.difficulty) ? value.difficulty : 'easy', avatars };
  }

  loadStats() {
    const value = this.readStore(KEYS.stats);
    if (!value || value.version !== 1 || !Array.isArray(value.results)) return { version: 1, results: [] };
    const ids = new Set();
    const results = value.results.filter(item => {
      if (!item || typeof item.id !== 'string' || ids.has(item.id) || ![0, 1].includes(item.winner) ||
          !['ai', 'pvp'].includes(item.mode) || !Object.prototype.hasOwnProperty.call(LEVELS, item.difficulty) ||
          typeof item.assisted !== 'boolean' || !Number.isFinite(item.at)) return false;
      ids.add(item.id); return true;
    });
    return { version: 1, results: results.slice(-100) };
  }

  loadSave() {
    const value = this.readStore(KEYS.save);
    try {
      if (!value || value.version !== 1 || typeof value.id !== 'string' || value.id.length > 120 ||
          typeof value.assisted !== 'boolean' || !engine.validateState(value.state)) return null;
      const state = value.state;
      // A finished game is already in the stats ledger and has nothing left to resume.
      if (state.winner !== null) return null;
      if (!Array.isArray(state.history) || state.history.length > 15) return null;
      // Replay protects even when an engine validator checks only the outer shape.
      let replay = engine.createGame({ mode: state.mode, difficulty: state.difficulty,
        aiFirst: state.aiFirst, avatars: state.avatars });
      for (const step of state.history) {
        if (step.player !== replay.currentPlayer) return null;
        replay = engine.move(replay, step.row, step.count);
        if (!Array.isArray(step.piles) || step.piles.some((n, i) => n !== replay.piles[i])) return null;
      }
      if (replay.currentPlayer !== state.currentPlayer || replay.winner !== state.winner ||
          replay.piles.some((n, i) => n !== state.piles[i])) return null;
      return clone(value);
    } catch (error) { this.lastError = error; return null; }
  }

  save() {
    if (!this.state || !this.gameId) return;
    if (this.state.winner !== null) { this.clearSave(); return; }
    this.saveCleared = false;
    this.store(KEYS.save, { version: 1, id: this.gameId, state: this.state, assisted: this.assisted });
  }

  clearSave() {
    if (this.saveCleared) return;
    try {
      const storage = this.platform.storage;
      const ok = typeof storage.remove === 'function' ? storage.remove(KEYS.save) : storage.set(KEYS.save, null);
      this.saveCleared = ok !== false;
    } catch (error) { this.lastError = error; }
  }

  persistStats() { this.statsDirty = !this.store(KEYS.stats, this.stats); }

  feedback() {
    for (const [setting, method] of [['sound', 'sound'], ['vibration', 'vibrate']]) {
      if (this.settings[setting] && typeof this.platform[method] === 'function') {
        try {
          const result = this.platform[method]();
          if (result && typeof result.catch === 'function') result.catch(error => { this.lastError = error; });
        } catch (error) { this.lastError = error; }
      }
    }
  }

  later(fn, ms) { return this.schedule(fn, ms, false); }
  nextFrame(fn) { return this.schedule(fn, 16, true); }

  schedule(fn, ms, frame) {
    const epoch = this.epoch, p = this.platform, handle = {};
    const run = () => {
      this.timers.delete(handle);
      if (this.destroyed || this.hidden || epoch !== this.epoch) return;
      try { fn(); } catch (error) { this.fail(error); }
    };
    if (frame && typeof p.requestAnimationFrame === 'function') {
      const id = p.requestAnimationFrame(run);
      handle.cancel = () => p.cancelAnimationFrame(id);
    } else {
      const id = (p.setTimeout ? p.setTimeout.bind(p) : setTimeout)(run, ms);
      handle.cancel = () => (p.clearTimeout ? p.clearTimeout.bind(p) : clearTimeout)(id);
    }
    this.timers.add(handle);
    return handle;
  }

  now() { return typeof this.platform.now === 'function' ? this.platform.now() : Date.now(); }

  invalidate() {
    this.epoch += 1;
    this.timers.forEach(handle => { try { handle.cancel(); } catch (error) { this.lastError = error; } });
    this.timers.clear(); this.locked = false; this.phase = 'idle'; this.motion = null;
  }

  fail(error) {
    this.lastError = error; this.invalidate();
    this.toast = '操作未完成，请重新选择或重开本局';
    this.render();
  }

  isAI() { return !!this.state && this.state.mode === 'ai' && this.state.currentPlayer === 1 && this.state.winner === null; }
  canPlay() { return !this.destroyed && !this.hidden && this.screen === 'game' && !!this.state &&
    this.state.winner === null && !this.locked && !this.modal && !this.isAI(); }

  startGame(options) {
    if (this.destroyed) return;
    try {
      const opts = options || { mode: this.modeChoice, difficulty: this.difficultyChoice,
        aiFirst: this.settings.aiFirst, avatars: this.settings.avatars.slice() };
      const next = engine.createGame(opts);
      this.invalidate(); this.state = next;
      this.gameId = Date.now().toString(36) + '-' + (++this.serial) + '-' + Math.random().toString(36).slice(2, 10);
      this.assisted = false; this.selected = null; this.modal = null; this.toast = ''; this.shareStatus = '';
      this.resumeCandidate = null; this.screen = 'game';
      this.save(); this.render(); this.scheduleAI();
    } catch (error) { this.fail(error); }
  }

  restart() {
    if (!this.state) return;
    this.startGame({ mode: this.state.mode, difficulty: this.state.difficulty,
      aiFirst: this.state.aiFirst, avatars: this.state.avatars.slice() });
  }

  restore() {
    const saved = this.resumeCandidate;
    if (!saved) { this.closeModal(); return; }
    this.invalidate(); this.state = clone(saved.state); this.gameId = saved.id;
    this.assisted = saved.assisted; this.selected = null; this.resumeCandidate = null;
    this.modal = null; this.screen = 'game';
    if (this.state.winner !== null) this.finish();
    else { this.render(); this.scheduleAI(); }
  }

  scheduleAI() {
    if (!this.isAI() || this.hidden || this.modal || this.destroyed || this.locked || this.screen !== 'game') return;
    this.phase = 'thinking'; this.locked = true; this.render();
    this.later(() => {
      if (!this.isAI()) { this.locked = false; this.phase = 'idle'; this.render(); return; }
      const choice = engine.chooseMove(this.state.piles.slice(), this.state.difficulty);
      if (!choice) throw new Error('AI 未返回合法走法');
      this.commitMove(choice.row, choice.count);
    }, 650);
  }

  select(row, count) {
    if (!this.canPlay()) return;
    if (!Number.isInteger(row) || row < 0 || row > 2 || !Number.isInteger(count) || count < 1 || count > this.state.piles[row]) return;
    this.selected = { row, count }; this.toast = ''; this.feedback(); this.render();
  }

  confirmMove() {
    if (!this.canPlay() || !this.selected) return;
    try { this.commitMove(this.selected.row, this.selected.count); } catch (error) { this.fail(error); }
  }

  commitMove(row, count) {
    const oldCount = this.state.piles[row], next = engine.move(this.state, row, count);
    // Commit before animation: pause/resume only ever continues from the new position.
    this.state = next; this.selected = null; this.phase = 'animating'; this.locked = true;
    this.motion = { row, from: next.piles[row], to: oldCount, start: this.now(), progress: 0 };
    this.toast = '第 ' + (row + 1) + ' 排取走 ' + count + ' 颗';
    this.feedback(); this.save();
    if (next.winner !== null) this.recordResult();
    this.render();
    const frame = () => {
      if (!this.motion) return;
      this.motion.progress = Math.min(1, Math.max(0, (this.now() - this.motion.start) / MOVE_MS));
      if (this.motion.progress < 1) { this.render(); this.nextFrame(frame); return; }
      this.motion = null; this.locked = false; this.phase = 'idle';
      if (this.state.winner !== null) this.finish();
      else { this.render(); this.scheduleAI(); }
    };
    this.nextFrame(frame);
  }

  recordResult() {
    if (!this.state || this.state.winner === null || this.stats.results.some(item => item.id === this.gameId)) return;
    const item = { id: this.gameId, winner: this.state.winner, mode: this.state.mode,
      difficulty: this.state.difficulty, assisted: this.assisted, at: Date.now() };
    // Ledger atomically combines identity and result; no independent win-counter race.
    this.stats = { version: 1, results: this.stats.results.concat(item).slice(-100) };
    this.persistStats();
  }

  finish() {
    this.locked = false; this.phase = 'idle'; this.motion = null;
    this.recordResult(); if (this.statsDirty) this.persistStats(); this.save();
    this.modal = { type: 'result', page: 0 }; this.render();
  }

  openModal(modal) {
    if (this.destroyed || this.hidden) return;
    this.invalidate(); this.modal = typeof modal === 'string' ? { type: modal, page: 0 } : modal; this.render();
  }

  closeModal() {
    if (this.destroyed) return;
    this.modal = null; this.render();
    if (this.state && this.screen === 'game' && this.state.winner !== null) this.finish();
    else this.scheduleAI();
  }

  goHome() {
    this.invalidate(); this.save(); this.resumeCandidate = this.loadSave();
    this.screen = 'home'; this.modal = null; this.selected = null; this.toast = ''; this.render();
  }

  onHide() {
    if (this.destroyed) return;
    this.hidden = true; this.invalidate(); this.save();
    if (this.state && this.state.winner !== null) { this.recordResult(); if (this.statsDirty) this.persistStats(); }
  }

  onShow() {
    if (this.destroyed || !this.hidden) return;
    this.hidden = false;
    if (this.screen === 'game' && this.state && this.state.winner !== null && !this.modal) this.finish();
    else { this.render(); this.scheduleAI(); }
  }

  destroy() {
    if (this.destroyed) return;
    this.save(); this.invalidate(); this.destroyed = true;
    this.unsubscribers.forEach(off => { try { off(); } catch (error) { this.lastError = error; } });
    this.unsubscribers = []; this.hitBoxes = []; this.selected = null;
  }

  boxAt(point) {
    if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y)) return null;
    for (let i = this.hitBoxes.length - 1; i >= 0; i--) {
      const box = this.hitBoxes[i];
      if (point.x >= box.x && point.x < box.x + box.w && point.y >= box.y && point.y < box.y + box.h) return box;
    }
    return null;
  }

  handlePress(point) {
    if (this.destroyed || this.hidden) return;
    const box = this.boxAt(point), id = box && !box.disabled ? box.id : null;
    if (id !== this.pressed) { this.pressed = id; this.render(); }
  }

  releasePress() {
    if (this.pressed === null) return;
    this.pressed = null; this.render();
  }

  handleTouch(point) {
    const pressed = this.pressed;
    this.pressed = null;
    if (this.destroyed || this.hidden) return;
    const box = this.boxAt(point);
    // A press that slides off its target before release is a cancel, not a tap elsewhere.
    if (pressed !== null && (!box || box.id !== pressed)) { this.render(); return; }
    if (box && !box.disabled) { try { box.action(point); } catch (error) { this.fail(error); } }
    if (pressed !== null) this.render();
  }

  hit(id, x, y, w, h, action, disabled) { this.hitBoxes.push({ id, x, y, w, h, action, disabled: !!disabled }); }

  roundPath(x, y, w, h, radius) {
    const c = this.ctx, r = Math.max(0, Math.min(radius, w / 2, h / 2));
    c.beginPath(); c.moveTo(x + r, y); c.lineTo(x + w - r, y);
    c.quadraticCurveTo(x + w, y, x + w, y + r); c.lineTo(x + w, y + h - r);
    c.quadraticCurveTo(x + w, y + h, x + w - r, y + h); c.lineTo(x + r, y + h);
    c.quadraticCurveTo(x, y + h, x, y + h - r); c.lineTo(x, y + r);
    c.quadraticCurveTo(x, y, x + r, y); c.closePath();
  }

  panel(x, y, w, h, fill, border, radius) {
    const c = this.ctx;
    this.roundPath(x, y, w, h, radius === undefined ? 14 : radius); c.fillStyle = fill; c.fill();
    if (border) { c.strokeStyle = border; c.lineWidth = 1; c.stroke(); }
  }

  text(value, x, y, size, color, align, weight, maxWidth) {
    const c = this.ctx;
    c.font = (weight || 'normal') + ' ' + (size || 14) + 'px sans-serif';
    c.textAlign = align || 'left'; c.textBaseline = 'middle'; c.fillStyle = color || INK;
    if (maxWidth) c.fillText(String(value), x, y, maxWidth); else c.fillText(String(value), x, y);
  }

  button(id, label, x, y, w, h, action, options) {
    const opts = options || {}, disabled = !!opts.disabled, pressed = !disabled && this.pressed === id;
    this.panel(x, y, w, h, disabled ? '#1b352e' : opts.primary ? (pressed ? '#bf9d5c' : GOLD) : pressed ? '#28523f' : '#193e32',
      disabled ? '#2e493f' : opts.primary ? '#efd397' : pressed ? GOLD : '#416250', 11);
    this.text(label, x + w / 2, y + h / 2, opts.size || 14,
      disabled ? '#789085' : opts.primary ? '#172b23' : INK, 'center', opts.primary ? 'bold' : 'normal', w - 12);
    this.hit(id, x, y, w, h, action, disabled);
  }

  circle(x, y, r, color) {
    const c = this.ctx; c.beginPath(); c.arc(x, y, r, 0, Math.PI * 2); c.fillStyle = color; c.fill();
  }

  avatar(index, x, y, size) {
    // Six local vector mascots. No emoji, image downloads, fonts or network.
    const c = this.ctx;
    c.save(); c.translate(x, y); c.scale(size / 64, size / 64); this.circle(32, 32, 31, '#233f35');
    const colors = ['#d89457', '#b39372', '#edc9c2', '#a8b4c4', '#8eaf74', '#637f8b'];
    const face = colors[index] || colors[0];
    if (index === 2) {
      this.panel(15, 1, 11, 31, face, null, 6); this.panel(38, 1, 11, 31, face, null, 6);
      this.panel(18, 5, 5, 20, '#ba8487', null, 3); this.panel(41, 5, 5, 20, '#ba8487', null, 3);
    } else if (index === 0 || index === 3) {
      c.beginPath(); c.moveTo(10, 32); c.lineTo(9, 7); c.lineTo(29, 22);
      c.moveTo(35, 22); c.lineTo(55, 7); c.lineTo(54, 33); c.fillStyle = face; c.fill();
    } else if (index === 1) {
      this.circle(13, 19, 10, face); this.circle(51, 19, 10, face);
      this.circle(13, 19, 5, '#755a48'); this.circle(51, 19, 5, '#755a48');
    } else if (index === 4) { this.circle(17, 20, 11, face); this.circle(47, 20, 11, face); }
    this.circle(32, 36, 24, face);
    if (index === 0 || index === 5) {
      this.circle(32, 42, 17, '#ede4cc');
      if (index === 0) { this.circle(18, 37, 9, '#ede4cc'); this.circle(46, 37, 9, '#ede4cc'); }
    }
    const eyeY = index === 4 ? 23 : 32;
    if (index === 4) { this.circle(17, eyeY, 6, '#f3efda'); this.circle(47, eyeY, 6, '#f3efda'); }
    this.circle(index === 4 ? 17 : 23, eyeY, 2.6, '#17291f');
    this.circle(index === 4 ? 47 : 41, eyeY, 2.6, '#17291f');
    this.circle(22, 31, 0.9, '#ffffff'); this.circle(40, 31, 0.9, '#ffffff');
    if (index === 5) {
      c.beginPath(); c.moveTo(26, 39); c.lineTo(38, 39); c.lineTo(32, 46); c.closePath(); c.fillStyle = GOLD; c.fill();
    } else {
      this.circle(32, 40, index === 4 ? 1.6 : 2.8, '#4a3b30');
      c.beginPath(); c.moveTo(27, 45); c.quadraticCurveTo(32, 49, 37, 45);
      c.strokeStyle = '#564439'; c.lineWidth = 1.6; c.stroke();
    }
    this.circle(15, 41, 3, '#cf8b7a'); this.circle(49, 41, 3, '#cf8b7a'); c.restore();
  }

  dice(x, y, size, value, selected, ghost) {
    const c = this.ctx;
    if (!ghost) this.panel(x + 1, y + 3, size - 2, size - 1, '#09261c', null, 6);
    this.panel(x, y, size, size, ghost ? '#16392c' : selected ? '#e1b96c' : '#eee8d6',
      selected ? '#ffe4a4' : ghost ? '#2d5140' : '#b5b6a2', 6);
    if (ghost) return;
    const p = [[0.27, 0.27], [0.73, 0.27], [0.27, 0.5], [0.73, 0.5], [0.27, 0.73], [0.73, 0.73], [0.5, 0.5]];
    const maps = { 1: [6], 2: [0, 5], 3: [0, 6, 5], 4: [0, 1, 4, 5], 5: [0, 1, 4, 5, 6], 6: [0, 1, 2, 3, 4, 5] };
    maps[value].forEach(i => this.circle(x + p[i][0] * size, y + p[i][1] * size,
      Math.max(1.8, size * 0.064), value === 1 ? '#b64b39' : '#264536'));
    if (selected) {
      c.strokeStyle = '#fff0c4'; c.lineWidth = 2;
      this.roundPath(x - 1, y - 1, size + 2, size + 2, 7); c.stroke();
    }
  }

  paintBackground(c) {
    const g = c.createLinearGradient(0, 0, this.width, this.height);
    g.addColorStop(0, '#153b2d'); g.addColorStop(0.55, '#0b281e'); g.addColorStop(1, '#061a15');
    c.fillStyle = g; c.fillRect(0, 0, this.width, this.height);
    c.fillStyle = 'rgba(202,218,181,0.025)';
    for (let y = 0; y < this.height; y += 9) for (let x = (y % 18 ? 4 : 0); x < this.width; x += 9) c.fillRect(x, y, 1, 1);
  }

  // The dotted texture costs thousands of fillRect calls, so it is painted once offscreen.
  backgroundLayer() {
    if (this.bgLayer !== undefined) return this.bgLayer;
    this.bgLayer = null;
    try {
      if (typeof this.platform.createCanvas !== 'function' || typeof this.ctx.drawImage !== 'function') return null;
      const dpr = Number(this.platform.dpr) || 1, layer = this.platform.createCanvas();
      layer.width = Math.round(this.width * dpr); layer.height = Math.round(this.height * dpr);
      const lc = layer.getContext('2d'); lc.scale(dpr, dpr); this.paintBackground(lc);
      this.bgLayer = layer;
    } catch (error) { this.lastError = error; }
    return this.bgLayer;
  }

  background() {
    const c = this.ctx, layer = this.backgroundLayer();
    c.clearRect(0, 0, this.width, this.height);
    if (layer) c.drawImage(layer, 0, 0, this.width, this.height); else this.paintBackground(c);
    this.panel(7, this.top, this.width - 14, this.bottom - this.top, 'rgba(0,0,0,0)', '#36513a', 21);
  }

  render() {
    if (this.destroyed || this.hidden) return;
    this.hitBoxes = [];
    const c = this.ctx; c.save();
    try {
      this.background();
      if (this.screen === 'game' && this.state) this.drawGame(); else this.drawHome();
      if (this.modal) {
        this.hitBoxes = []; // Never route through a modal to the underlying board.
        c.fillStyle = 'rgba(0,10,7,0.78)'; c.fillRect(0, 0, this.width, this.height); this.drawModal();
      }
    } finally { c.restore(); }
  }

  drawHome() {
    const w = this.width, x = 20, span = w - 40, half = (span - 8) / 2;
    const compact = this.bottom - this.top < 470, step = compact ? 48 : 52;
    const contentHeight = (compact ? 8 + 56 : 14 + 68) + 114 + step * 3 + 52 + 44;
    // Leave room for the status line below the last buttons; center whatever space is left.
    const spare = this.bottom - this.top - contentHeight - 28;
    let y = this.top + (compact ? 8 : 14) + Math.max(0, spare / 2);
    this.text('357', w / 2, y + 19, compact ? 34 : 40, GOLD, 'center', 'bold');
    this.text('经 典 取 骰 游 戏', w / 2, y + (compact ? 44 : 51), 12, MUTED, 'center');
    y += compact ? 56 : 68;
    const modes = [ ['pvp', 'easy', '同屏双人', '与身边的人切磋'], ['ai', 'easy', 'AI · 休闲', '轻松熟悉规则'],
      ['ai', 'medium', 'AI · 挑战', '多想一步'], ['ai', 'hard', 'AI · 高手', '更高难度对手'] ];
    modes.forEach((item, i) => {
      const bx = x + (i % 2) * (half + 8), by = y + Math.floor(i / 2) * 56;
      const active = this.modeChoice === item[0] && (item[0] === 'pvp' || this.difficultyChoice === item[1]);
      const pressed = this.pressed === 'mode-' + i;
      this.panel(bx, by, half, 50, pressed ? '#3a5f45' : active ? '#31513a' : '#15372b', active || pressed ? GOLD : '#3a5544', 12);
      this.text(item[2], bx + 13, by + 16, 15, active ? GOLD : INK, 'left', 'bold');
      this.text(item[3], bx + 13, by + 37, 12, MUTED, 'left', 'normal', half - 20);
      this.hit('mode-' + i, bx, by, half, 50, () => {
        this.modeChoice = item[0]; this.settings.mode = item[0];
        if (item[0] === 'ai') { this.difficultyChoice = item[1]; this.settings.difficulty = item[1]; }
        this.store(KEYS.settings, this.settings); this.render();
      });
    });
    y += 114;
    this.button('ai-first', '电脑先手  ' + (this.settings.aiFirst ? '已开启' : '已关闭'), x, y, span, 44, () => {
      this.settings.aiFirst = !this.settings.aiFirst; this.store(KEYS.settings, this.settings); this.render();
    }, { disabled: this.modeChoice === 'pvp' });
    y += step;
    [0, 1].forEach(player => {
      const bx = x + player * (half + 8);
      if (this.pressed === 'avatar-' + player) this.panel(bx, y, half, 44, '#1f4636', null, 12);
      this.avatar(this.settings.avatars[player], bx + 2, y, 44);
      this.text(player === 0 ? '玩家一' : this.modeChoice === 'ai' ? '电脑' : '玩家二', bx + 54, y + 12, 13, INK);
      this.text('更换形象 ›', bx + 54, y + 33, 12, GOLD);
      this.hit('avatar-' + player, bx, y, half, 44, () => this.openModal({ type: 'avatars', player, page: 0 }));
    });
    y += step;
    this.button('sound', '声音 ' + (this.settings.sound ? '开' : '关'), x, y, half, 44, () => this.toggleSetting('sound'));
    this.button('vibration', '振动 ' + (this.settings.vibration ? '开' : '关'), x + half + 8, y, half, 44, () => this.toggleSetting('vibration'));
    y += step;
    this.button('start', '开始对局', x, y, span, 48, () => {
      if (this.resumeCandidate) this.openModal('restore'); else this.startGame();
    }, { primary: true, size: 17 });
    y += 52;
    this.button('rules', '简短规则', x, y, half, 44, () => this.openModal('rules'));
    this.button('stats', '本地战绩', x + half + 8, y, half, 44, () => this.openModal('stats'));
    if ((this.toast || this.storageWarning) && y + 60 < this.bottom)
      this.text(this.toast || '本地存储不可用，进度可能无法保留', w / 2, y + 58, 12, GOLD, 'center', 'normal', span);
  }

  toggleSetting(key) {
    this.settings[key] = !this.settings[key]; this.store(KEYS.settings, this.settings);
    if (this.settings[key]) this.feedback();
    this.render();
  }

  playerName(player) { return this.state.mode === 'ai' ? (player === 1 ? '电脑' : '你') : (player === 0 ? '玩家一' : '玩家二'); }

  drawGame() {
    const w = this.width, x = 20, span = w - 40;
    // Rows grow up to ROW_MAX on tall screens; any height left over centers the whole layout.
    const gap = 5, size = Math.min(DIE_MAX, (span - 12 - gap * 6) / 7), boardDisabled = !this.canPlay();
    const available = this.bottom - this.top - 278;
    const rowHeight = Math.min(Math.max(73, Math.min(ROW_MAX, size + 56)), Math.max(55, available / 3));
    let y = this.top + 10 + Math.max(0, (available - rowHeight * 3) / 2);
    this.button('back', '返回', x, y, 58, 44, () => this.openModal('leave'));
    this.text('357', w / 2, y + 14, 24, GOLD, 'center', 'bold');
    this.text(this.state.mode === 'pvp' ? '同屏双人' : 'AI · ' + LEVELS[this.state.difficulty], w / 2, y + 36, 12, MUTED, 'center');
    this.button('restart', '重开', w - 78, y, 58, 44, () => this.openModal('restart'));
    y += 52;
    const half = (span - 8) / 2;
    [0, 1].forEach(player => {
      const bx = x + player * (half + 8), active = this.state.currentPlayer === player && this.state.winner === null;
      this.panel(bx, y, half, 58, active ? '#2c4b34' : '#123127', active ? GOLD : '#34513e', 12);
      this.avatar(this.state.avatars[player], bx + 5, y + 7, 43);
      this.text(this.playerName(player), bx + 56, y + 19, 14, active ? GOLD : INK, 'left', 'bold');
      this.text(active ? '当前回合' : this.state.winner === player ? '获胜' : '等待', bx + 56, y + 40, 12, MUTED);
    });
    y += 73;
    const status = this.state.winner !== null ? '本局结束 · 拿最后一颗的人输' : this.phase === 'thinking' ? '电脑正在思考…' :
      this.phase === 'animating' ? this.toast : this.selected ? '第 ' + (this.selected.row + 1) + ' 排 · 已选前 ' + this.selected.count + ' 颗' :
      this.playerName(this.state.currentPlayer) + '：点一颗骰子，选中该排前 N 颗';
    this.text(status, w / 2, y, 13, GOLD, 'center', 'normal', span); y += 17;
    // Seven dice remain a single line; full-row hit strips are >=50px tall.
    [3, 5, 7].forEach((initial, row) => {
      const by = y + row * rowHeight;
      this.panel(x, by, span, rowHeight - 5, '#103a29', '#33533d', 12);
      const count = this.state.piles[row], total = initial * size + (initial - 1) * gap;
      const sx = (w - total) / 2, dy = by + (rowHeight - 5 - size) / 2;
      for (let index = 0; index < initial; index++) {
        const dx = sx + index * (size + gap), value = (index + row) % 6 + 1;
        this.dice(dx, dy, size, value, !!this.selected && this.selected.row === row && index < this.selected.count, index >= count);
        if (this.motion && this.motion.row === row && index >= this.motion.from && index < this.motion.to) {
          const t = easeOut(this.motion.progress);
          this.ctx.save(); this.ctx.globalAlpha = Math.max(0, 1 - t);
          this.dice(dx, dy - t * MOVE_RISE, size, value, true, false); this.ctx.restore();
        }
      }
      this.hit('row-' + row, x, by, span, rowHeight - 5, point => {
        if (!count) return;
        const index = Math.floor((point.x - sx) / (size + gap));
        if (index < 0 || index >= count) return;
        this.select(row, index + 1);
      }, boardDisabled || count === 0);
    });
    y += rowHeight * 3 + 3;
    this.button('cancel', '取消', x, y, 60, 46, () => { this.selected = null; this.render(); }, { disabled: !this.selected || boardDisabled });
    this.button('confirm', this.selected ? '确认取 ' + this.selected.count + ' 颗' : '确认拿取', x + 68, y, span - 68, 46,
      () => this.confirmMove(), { primary: true, disabled: !this.selected || boardDisabled });
    y += 54;
    this.button('rules', '游戏规则', x, y, (span - 8) / 2, 44, () => this.openModal('rules'));
    this.button('history', '走子记录 · ' + this.state.history.length, x + (span + 8) / 2, y, (span - 8) / 2, 44,
      () => this.openModal('history'));
    if (y + 61 < this.bottom) this.text(this.storageWarning ? '本地保存失败 · 进度可能无法保留' :
      '一次只取一排 · 取最后一颗者输', w / 2, y + 59, 12, MUTED, 'center', 'normal', span);
  }

  wrap(text, width, size) {
    this.ctx.font = (size || 14) + 'px sans-serif';
    const lines = [];
    String(text).split('\n').forEach(paragraph => {
      if (!paragraph) { lines.push(''); return; }
      let line = '';
      for (const char of paragraph) {
        if (line && this.ctx.measureText(line + char).width > width) { lines.push(line); line = char; } else line += char;
      }
      lines.push(line);
    });
    return lines;
  }

  drawModal() {
    const modal = this.modal, w = this.width - 32, x = 16;
    const h = Math.min(470, this.bottom - this.top - 20), y = this.top + (this.bottom - this.top - h) / 2;
    this.panel(x, y, w, h, '#112e24', '#9c8753', 19);
    const titles = { restore: '发现本地对局', rules: '三句话，开始取骰', stats: '本地战绩', avatars: '选择本地形象',
      leave: '返回首页？', restart: '重新开始？', history: '走子记录', result: '本局结束' };
    this.text(titles[modal.type] || '357', x + 18, y + 30, 19, GOLD, 'left', 'bold', w - 84);
    if (!['restore', 'result'].includes(modal.type))
      this.button('modal-close', '关闭', x + w - 68, y + 9, 56, 44, () => this.closeModal());
    const bottomY = y + h - 60, innerX = x + 19, innerW = w - 38;
    let content = '', actions = [];
    switch (modal.type) {
      case 'restore':
        content = '有一局已安全保存在这台设备上。\n\n继续对局会恢复棋盘和回合；重新开始会覆盖旧存档。\n\n离开应用时会自动暂停，不会在后台替你落子。';
        actions = [['重新开始', () => { this.resumeCandidate = null; this.startGame(); }], ['继续对局', () => this.restore()]];
        break;
      case 'rules':
        content = '① 双方轮流，每回合只能从一排拿至少一颗。\n\n② 拿最后一颗的人输。\n\n③ 点击骰子选中该排前 N 颗，确认拿取 / 取消。';
        break;
      case 'leave':
        content = '当前对局会保留在本机。\n\n返回后可从首页继续，也可选择新开一局。';
        actions = [['继续玩', () => this.closeModal()], ['保存并返回', () => this.goHome()]];
        break;
      case 'restart':
        content = '将放弃当前棋盘，按相同模式、先手和头像重新开始。\n\n未结束的对局不会计入战绩。';
        actions = [['继续本局', () => this.closeModal()], ['确认重开', () => this.restart()]];
        break;
      case 'history':
        content = this.state.history.length ? this.state.history.map((step, index) =>
          (index + 1) + '. ' + this.playerName(step.player) + ' · 第' + (step.row + 1) + '排取' + step.count + '颗\n   剩余 ' + step.piles.join(' / ')).join('\n\n') : '还没有落子，第一手由你书写。';
        break;
      case 'stats': {
        const results = this.stats.results, solo = results.filter(item => item.mode === 'ai');
        const wins = solo.filter(item => item.winner === 0).length;
        content = '仅记录本机最近 100 局，终局只计一次。\n' +
          '共 ' + results.length + ' 局\n' +
          '人机：' + wins + ' 胜 / ' + (solo.length - wins) + ' 负\n\n' +
          (results.length ? results.slice().reverse().map(item => {
            const date = new Date(item.at);
            return (date.getMonth() + 1) + '/' + date.getDate() + ' · ' +
              (item.mode === 'ai' ? 'AI ' + LEVELS[item.difficulty] + ' · ' + (item.winner === 0 ? '你获胜' : '电脑获胜') : '双人 · 玩家' + (item.winner + 1) + '胜');
          }).join('\n\n') : '暂无战绩。完成第一局试试看。');
        break;
      }
      case 'result': {
        // Fixed, short summary lines, all drawn on one page. Never paginate without navigation.
        modal.page = 0; modal.pages = 1;
        this.text(this.playerName(this.state.winner) + '获胜！', innerX, y + 76, 22, GOLD, 'left', 'bold', innerW);
        this.text(this.playerName(1 - this.state.winner) + '拿到了最后一颗骰子。', innerX, y + 109, 14, INK, 'left', 'normal', innerW);
        this.text('共 ' + this.state.history.length + ' 手',
          innerX, y + 136, 14, INK, 'left', 'normal', innerW);
        this.text(this.storageWarning ? '本地保存失败，记录暂留本次运行' : '战绩已计入本机记录。',
          innerX, y + 163, 13, this.storageWarning ? GOLD : MUTED, 'left', 'normal', innerW);
        if (this.shareStatus) this.text(this.shareStatus, innerX, y + 190, 13, GOLD, 'left', 'normal', innerW);
        const by = bottomY - 106;
        this.button('again', '再来一局', innerX, by, innerW, 44, () => this.restart(), { primary: true });
        this.button('share', '分享这次挑战', innerX, by + 52, innerW, 44, () => this.share());
        this.button('result-home', '返回首页', innerX, by + 104, innerW, 44, () => this.goHome());
        return;
      }
      case 'avatars': {
        const cellW = (innerW - 16) / 3, cellH = Math.min(100, (h - 150) / 2);
        for (let index = 0; index < 6; index++) {
          const bx = innerX + (index % 3) * (cellW + 8), by = y + 76 + Math.floor(index / 3) * (cellH + 12);
          const chosen = this.settings.avatars[modal.player] === index;
          this.panel(bx, by, cellW, cellH, chosen ? '#35513a' : '#183a2d', chosen ? GOLD : '#385743', 12);
          const size = Math.min(54, cellH - 28);
          this.avatar(index, bx + (cellW - size) / 2, by + 5, size);
          this.text(NAMES[index], bx + cellW / 2, by + cellH - 14, 12, chosen ? GOLD : INK, 'center');
          this.hit('choose-avatar-' + index, bx, by, cellW, cellH, () => {
            const other = 1 - modal.player, previous = this.settings.avatars[modal.player];
            // Choosing the other mascot swaps them: each side stays identifiable.
            if (this.settings.avatars[other] === index) this.settings.avatars[other] = previous;
            this.settings.avatars[modal.player] = index; this.store(KEYS.settings, this.settings); this.closeModal();
          });
        }
        this.text('选择相同形象会互换 · 仅用于新对局', x + w / 2, bottomY + 20, 12, MUTED, 'center', 'normal', innerW);
        return;
      }
      default: content = '请关闭后重试。';
    }
    const contentBottom = actions.length ? bottomY - 56 : bottomY - 4, navY = actions.length ? bottomY - 50 : bottomY;
    this.drawPagedText(content, innerX, y + 72, innerW, contentBottom - (y + 72), modal, true, navY);
    if (actions.length) {
      const half = (innerW - 8) / 2;
      actions.forEach((action, i) => this.button('modal-action-' + i, action[0], innerX + i * (half + 8), bottomY,
        half, 44, action[1], { primary: i === 1, size: 13 }));
    }
  }

  drawPagedText(content, x, y, width, height, modal, navigation, navY) {
    const lines = this.wrap(content || '', width, 14), lineHeight = 23;
    const perPage = Math.max(1, Math.floor(Math.max(0, height) / lineHeight)), pages = Math.max(1, Math.ceil(lines.length / perPage));
    modal.page = Math.max(0, Math.min(modal.page || 0, pages - 1)); modal.pages = pages;
    lines.slice(modal.page * perPage, (modal.page + 1) * perPage).forEach((line, i) =>
      this.text(line, x, y + i * lineHeight + 8, 14, INK, 'left', 'normal', width));
    if (navigation && pages > 1) {
      this.button('page-prev', '上一页', x, navY, 76, 44, () => { modal.page--; this.render(); }, { disabled: modal.page === 0, size: 12 });
      this.text((modal.page + 1) + ' / ' + pages, x + width / 2, navY + 22, 12, MUTED, 'center');
      this.button('page-next', '下一页', x + width - 76, navY, 76, 44, () => { modal.page++; this.render(); },
        { disabled: modal.page === pages - 1, size: 12 });
    }
  }

  share() {
    const failed = error => {
      if (this.destroyed) return;
      this.lastError = error; this.shareStatus = '分享未完成，可稍后再试'; this.render();
    };
    try {
      if (typeof this.platform.share !== 'function') throw new Error('分享暂不可用');
      const result = this.platform.share();
      if (result && typeof result.catch === 'function') result.catch(failed);
    } catch (error) { failed(error); }
  }
}

module.exports = GameUI;
module.exports.GameUI = GameUI;
