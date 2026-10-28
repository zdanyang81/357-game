'use strict';

// Run: node --test tests/ui.test.js
// No DOM, wx, browser, image/font dependency or real timers. Rules use the real engine.
const test = require('node:test');
const assert = require('node:assert/strict');
const GameUI = require('../minigame/ui');
const engine = require('../minigame/core/engine');
const KEYS = { settings: '357.ui.settings.v1', save: '357.ui.save.v1', stats: '357.ui.results.v1' };
const copy = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value));

function harness(options = {}) {
  const data = options.data || {};
  const calls = [], timers = new Map();
  const listeners = { touch: new Set(), touchStart: new Set(), touchCancel: new Set(), hide: new Set(), show: new Set() };
  const alphaStack = [];
  let serial = 0, clock = 0, depth = 0, sound = 0, vibration = 0, share = 0, alpha = 1;
  const ctx = {
    createLinearGradient() { return { addColorStop() {} }; },
    measureText(value) {
      return { width: [...String(value)].reduce((sum, char) => sum + (char.charCodeAt(0) > 255 ? 14 : 7), 0) };
    },
    save() { depth++; alphaStack.push(alpha); },
    restore() { assert.ok(depth > 0); depth--; alpha = alphaStack.pop(); },
    fillText(...args) { calls.push({ method: 'fillText', args }); }
  };
  Object.defineProperty(ctx, 'globalAlpha', {
    get() { return alpha; },
    set(value) { alpha = value; calls.push({ method: 'globalAlpha', args: [value] }); }
  });
  for (const method of ['clearRect', 'fillRect', 'beginPath', 'moveTo', 'lineTo',
    'quadraticCurveTo', 'closePath', 'fill', 'stroke', 'arc', 'translate', 'scale']) {
    ctx[method] = (...args) => calls.push({ method, args });
  }
  // roundRect deliberately does not exist: older Mini Game Canvas must work.
  const register = type => fn => {
    listeners[type].add(fn);
    return () => listeners[type].delete(fn);
  };
  const platform = {
    canvas: { getContext: type => { assert.equal(type, '2d'); return ctx; } },
    width: options.width || 320, height: options.height || 568, dpr: options.dpr || 3,
    safeTop: options.safeTop === undefined ? 44 : options.safeTop,
    safeBottom: options.safeBottom === undefined ? 34 : options.safeBottom,
    storage: {
      get(key) { return copy(data[key]); },
      set(key, value) {
        if (options.storageFailure === 'false') return false;
        if (options.storageFailure === 'throw') throw new Error('storage full');
        data[key] = copy(value); return true;
      }
    },
    sound() { sound++; }, vibrate() { vibration++; }, share() { share++; },
    onTouch: register('touch'), onTouchStart: register('touchStart'), onTouchCancel: register('touchCancel'),
    onHide: register('hide'), onShow: register('show'),
    setTimeout(fn, delay) { const id = ++serial; timers.set(id, { fn, due: clock + delay }); return id; },
    clearTimeout(id) { timers.delete(id); },
    now() { return clock; }
  };
  const ui = new GameUI(platform);
  const h = {
    ui, platform, data, calls, timers, listeners, ctx,
    get depth() { return depth; },
    get feedback() { return { sound, vibration, share }; },
    emit(type, value) { [...listeners[type]].forEach(fn => fn(value)); },
    center(id) {
      const box = ui.hitBoxes.find(item => item.id === id);
      assert.ok(box, 'missing hit target ' + id);
      return { x: box.x + box.w / 2, y: box.y + box.h / 2 };
    },
    touch(id) { this.emit('touch', this.center(id)); },
    die(row, count) {
      const strip = ui.hitBoxes.find(item => item.id === 'row-' + row);
      assert.ok(strip);
      const size = Math.min(50, (platform.width - 40 - 12 - 5 * 6) / 7);
      const initial = [3, 5, 7][row], total = initial * size + (initial - 1) * 5;
      const [lo, hi] = ui.rowSpans()[row];
      const position = ui.state.currentPlayer === 0 ? lo + count - 1 : hi - count;
      const x = (platform.width - total) / 2 + position * (size + 5) + size / 2;
      this.emit('touch', { x, y: strip.y + strip.h / 2 });
    },
    step() {
      const next = [...timers.entries()].sort((a, b) => a[1].due - b[1].due || a[0] - b[0])[0];
      if (!next) return false;
      timers.delete(next[0]); clock = next[1].due; next[1].fn(); return true;
    },
    flush(limit = 200) {
      let steps = 0;
      while (timers.size && steps++ < limit) this.step();
      assert.equal(timers.size, 0, 'timer loop did not settle');
    },
    toPhase(phase) {
      for (let tries = 0; ui.phase !== phase && tries < 30; tries++) assert.ok(this.step());
      assert.equal(ui.phase, phase);
    }
  };
  assert.equal(depth, 0, 'render must balance Canvas save/restore');
  return h;
}

function withinSafeArea(h, name) {
  const u = h.ui;
  for (const b of u.hitBoxes) {
    assert.ok(b.x >= 0 && b.y >= u.top && b.x + b.w <= u.width && b.y + b.h <= u.bottom,
      name + ': target outside safe area: ' + b.id + ' ' + JSON.stringify([b.x, b.y, b.w, b.h]));
    assert.ok(b.h >= 44, name + ': target shorter than 44px: ' + b.id);
    assert.ok(b.w >= 44, name + ': target narrower than 44px: ' + b.id);
  }
  for (let i = 0; i < u.hitBoxes.length; i++) for (let j = i + 1; j < u.hitBoxes.length; j++) {
    const a = u.hitBoxes[i], b = u.hitBoxes[j];
    assert.ok(!(a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y),
      name + ': overlapping targets ' + a.id + '/' + b.id);
  }
  assert.equal(h.depth, 0);
}

function pvp(h) {
  h.ui.startGame({ mode: 'pvp', difficulty: 'hard', aiFirst: false, avatars: [0, 3] });
}
function finishPvp(h, winner = 1) {
  for (const row of [0, 1, 2]) {
    h.ui.select(row, h.ui.state.piles[row]); h.ui.confirmMove(); h.flush();
  }
  assert.equal(h.ui.state.winner, winner); // The player taking the last die loses.
}

test('exports class directly and by name; constructor validates Canvas', () => {
  assert.equal(GameUI.GameUI, GameUI);
  assert.throws(() => new GameUI(null), /Canvas/);
  assert.throws(() => new GameUI({ canvas: { getContext() { return null; } } }), /Canvas2D/);
});

test('touch selects front N, cancel clears, illegal and out-of-bounds touches are inert', t => {
  const h = harness(); t.after(() => h.ui.destroy()); pvp(h);
  h.die(2, 4); assert.deepEqual(h.ui.selected, { row: 2, count: 4 });
  assert.deepEqual(h.ui.state.piles, [3, 5, 7]);
  h.touch('cancel'); assert.equal(h.ui.selected, null);
  h.ui.select(-1, 1); h.ui.select(3, 1); h.ui.select(0, 4); h.ui.select(0, 0);
  for (const point of [null, {}, { x: NaN, y: 1 }, { x: -20, y: -20 }, { x: 320, y: 568 }]) h.emit('touch', point);
  assert.equal(h.ui.selected, null);
  h.die(0, 2); h.touch('confirm'); h.flush();
  assert.deepEqual(h.ui.state.piles, [1, 5, 7]);
  assert.ok(engine.validateState(h.ui.state));
});

test('rapid confirm taps cannot double-commit during animation or AI thinking', t => {
  const h = harness(); t.after(() => h.ui.destroy()); h.ui.startGame();
  h.die(0, 1); h.touch('confirm');
  for (let i = 0; i < 20; i++) { h.touch('confirm'); h.die(1, 2); h.ui.confirmMove(); }
  assert.equal(h.ui.state.history.length, 1); assert.equal(h.ui.phase, 'animating');
  h.toPhase('thinking');
  for (let i = 0; i < 20; i++) { h.ui.scheduleAI(); h.touch('confirm'); h.die(2, 3); }
  assert.equal(h.timers.size, 1); assert.equal(h.ui.state.history.length, 1);
  h.flush(); assert.equal(h.ui.state.history.length, 2); assert.equal(h.ui.state.currentPlayer, 0);
  assert.equal(h.ui.locked, false); assert.equal(h.ui.selected, null);
});

test('epoch rejects stale AI and animation callbacks after restart', t => {
  const h = harness(); t.after(() => h.ui.destroy());
  h.ui.startGame({ mode: 'ai', difficulty: 'hard', aiFirst: true, avatars: [0, 3] });
  const oldAI = [...h.timers.values()][0].fn, epoch = h.ui.epoch, oldId = h.ui.gameId;
  h.touch('restart'); assert.equal(h.timers.size, 0);
  h.touch('modal-action-1'); assert.ok(h.ui.epoch > epoch); assert.notEqual(h.ui.gameId, oldId);
  oldAI(); assert.equal(h.ui.state.history.length, 0); assert.equal(h.timers.size, 1);
  h.step(); assert.equal(h.ui.state.history.length, 1);
  const oldAnimation = [...h.timers.values()][0].fn;
  h.ui.restart(); oldAnimation();
  assert.equal(h.ui.state.history.length, 0); assert.equal(h.ui.motion, null);
  h.flush(); assert.equal(h.ui.state.history.length, 1);
});

test('hide cancels pending AI; repeated show resumes exactly once', t => {
  const h = harness(); t.after(() => h.ui.destroy());
  h.ui.startGame({ mode: 'ai', difficulty: 'hard', aiFirst: true, avatars: [0, 3] });
  const stale = [...h.timers.values()][0].fn;
  h.emit('hide'); assert.equal(h.timers.size, 0); assert.equal(h.ui.hidden, true);
  stale(); assert.equal(h.ui.state.history.length, 0);
  h.emit('show'); h.emit('show'); h.emit('show'); assert.equal(h.timers.size, 1);
  h.flush(); assert.equal(h.ui.state.history.length, 1);
  h.emit('show'); h.flush(); assert.equal(h.ui.state.history.length, 1);
});

test('hide during human animation resumes next AI, not the human move', t => {
  const h = harness(); t.after(() => h.ui.destroy()); h.ui.startGame();
  h.ui.select(0, 1); h.ui.confirmMove(); const stale = [...h.timers.values()][0].fn;
  assert.equal(h.ui.state.history.length, 1);
  h.emit('hide'); h.emit('show'); stale();
  assert.equal(h.ui.state.history.length, 1); assert.equal(h.timers.size, 1);
  h.flush(); assert.equal(h.ui.state.history.length, 2);
});

test('hide after committed AI animation never repeats its move', t => {
  const h = harness(); t.after(() => h.ui.destroy());
  h.ui.startGame({ mode: 'ai', difficulty: 'hard', aiFirst: true, avatars: [0, 3] });
  h.step(); assert.equal(h.ui.state.history.length, 1); assert.equal(h.ui.phase, 'animating');
  const stale = [...h.timers.values()][0].fn;
  h.emit('hide'); h.emit('show'); stale(); h.flush();
  assert.equal(h.ui.state.history.length, 1); assert.equal(h.ui.state.currentPlayer, 0); assert.equal(h.ui.locked, false);
});

test('modal isolates board touches, pauses AI, and resumes on close only', t => {
  const h = harness(); t.after(() => h.ui.destroy());
  h.ui.startGame({ mode: 'ai', difficulty: 'hard', aiFirst: true, avatars: [0, 3] });
  const stale = [...h.timers.values()][0].fn;
  h.touch('history'); assert.equal(h.ui.modal.type, 'history'); assert.equal(h.timers.size, 0);
  assert.ok(h.ui.hitBoxes.every(b => !['back', 'row-0', 'confirm', 'hint'].includes(b.id)));
  h.ui.select(0, 1); stale(); h.emit('hide'); h.emit('show');
  assert.equal(h.timers.size, 0); assert.equal(h.ui.selected, null);
  h.touch('modal-close'); assert.equal(h.timers.size, 1); h.flush(); assert.equal(h.ui.state.history.length, 1);
});

test('restore prompt keeps saved board and identity; AI schedules only after acceptance', t => {
  const h = harness(); h.ui.startGame(); h.ui.select(0, 1); h.ui.confirmMove();
  const id = h.ui.gameId; h.emit('hide'); h.ui.destroy();
  const next = harness({ data: h.data }); t.after(() => next.ui.destroy());
  assert.equal(next.ui.screen, 'home'); assert.equal(next.ui.modal.type, 'restore'); assert.equal(next.timers.size, 0);
  next.touch('modal-action-1'); assert.equal(next.ui.gameId, id); assert.equal(next.ui.state.history.length, 1);
  assert.equal(next.ui.selected, null); assert.equal(next.timers.size, 1); next.flush();
  assert.equal(next.ui.state.history.length, 2); assert.ok(engine.validateState(next.ui.state));
});

test('declining restore replaces old game; abandoned games do not count', t => {
  const h = harness(); pvp(h); h.ui.select(0, 1); h.ui.confirmMove();
  const id = h.ui.gameId; h.ui.destroy();
  const next = harness({ data: h.data }); t.after(() => next.ui.destroy());
  next.touch('modal-action-0'); assert.notEqual(next.ui.gameId, id); assert.equal(next.ui.state.history.length, 0);
  assert.equal(next.ui.stats.results.length, 0);
});

test('terminal result is counted once across finish, hide/show, and restored processes', t => {
  const h = harness({ safeTop: 88 }); pvp(h); finishPvp(h);
  assert.equal(h.ui.stats.results.length, 1); assert.equal(h.ui.stats.results[0].winner, 1);
  assert.equal(h.ui.stats.results[0].assisted, false); assert.equal(h.ui.modal.type, 'result');
  for (let i = 0; i < 5; i++) { h.ui.finish(); h.emit('hide'); h.emit('show'); }
  assert.equal(h.ui.stats.results.length, 1); withinSafeArea(h, 'terminal');
  assert.equal(h.data[KEYS.save], null, 'a finished game clears its resumable save');
  h.ui.destroy(); const next = harness({ data: h.data }); t.after(() => next.ui.destroy());
  assert.equal(next.ui.modal, null); assert.equal(next.ui.resumeCandidate, null);
  assert.equal(next.ui.stats.results.length, 1);
  next.touch('start'); assert.equal(next.ui.stats.results.length, 1);
  assert.equal(next.ui.state.winner, null); assert.equal(next.ui.state.history.length, 0);
});

test('finished games are never offered as "continue": home, relaunch and legacy terminal saves', t => {
  const h = harness(); pvp(h); finishPvp(h); h.touch('result-home');
  assert.equal(h.ui.resumeCandidate, null); h.touch('start');
  assert.equal(h.ui.modal, null); assert.equal(h.ui.screen, 'game'); assert.equal(h.ui.state.history.length, 0);
  h.ui.destroy();
  let state = engine.createGame({ mode: 'pvp', difficulty: 'hard' });
  for (const row of [0, 1, 2]) state = engine.move(state, row, state.piles[row]);
  assert.ok(engine.validateState(state)); assert.notEqual(state.winner, null);
  const legacy = harness({ data: { [KEYS.save]: { version: 1, id: 'old-finished', state, assisted: false } } });
  t.after(() => legacy.ui.destroy());
  assert.equal(legacy.ui.modal, null); assert.equal(legacy.ui.resumeCandidate, null);
  legacy.touch('start'); assert.equal(legacy.ui.screen, 'game'); assert.equal(legacy.ui.state.winner, null);
});

test('press highlights its target; sliding off or cancelling before release does not tap', t => {
  const h = harness(); t.after(() => h.ui.destroy());
  h.emit('touchStart', h.center('start')); assert.equal(h.ui.pressed, 'start');
  h.emit('touch', h.center('rules'));
  assert.equal(h.ui.pressed, null); assert.equal(h.ui.modal, null); assert.equal(h.ui.screen, 'home');
  h.emit('touchStart', h.center('start')); h.emit('touchCancel');
  assert.equal(h.ui.pressed, null); assert.equal(h.ui.screen, 'home');
  h.emit('touchStart', h.center('start')); h.emit('touch', h.center('start'));
  assert.equal(h.ui.screen, 'game'); assert.equal(h.ui.pressed, null);
  h.emit('touchStart', h.center('confirm')); assert.equal(h.ui.pressed, null, 'disabled targets never look pressed');
  h.emit('touch', h.center('confirm')); assert.equal(h.ui.state.history.length, 0);
  assert.equal(h.depth, 0);
});

test('terminal hide before animation finishes still records exactly once', t => {
  const h = harness(); t.after(() => h.ui.destroy()); pvp(h);
  for (const row of [0, 1]) { h.ui.select(row, h.ui.state.piles[row]); h.ui.confirmMove(); h.flush(); }
  h.ui.select(2, 7); h.ui.confirmMove(); const stale = [...h.timers.values()][0].fn;
  h.emit('hide'); h.emit('show'); stale(); h.flush();
  assert.equal(h.ui.modal.type, 'result'); assert.equal(h.ui.stats.results.length, 1);
});

test('legacy assisted saves and results remain valid without classification labels', t => {
  const state = engine.move(engine.createGame({ mode: 'pvp', difficulty: 'hard' }), 0, 1);
  const legacy = { id: 'legacy-result', mode: 'ai', difficulty: 'hard', winner: 0, assisted: true, at: 1 };
  const data = {
    [KEYS.save]: { version: 1, id: 'legacy-save', state, assisted: true },
    [KEYS.stats]: { version: 1, results: [legacy] }
  };
  const h = harness({ data });
  assert.equal(h.ui.modal.type, 'restore'); h.touch('modal-action-1');
  assert.equal(h.ui.gameId, 'legacy-save'); assert.deepEqual(h.ui.state, state);
  assert.equal(h.ui.assisted, true); assert.deepEqual(h.ui.stats.results, [legacy]);
  h.touch('rules'); h.touch('modal-close'); h.ui.save();
  assert.equal(data[KEYS.save].assisted, true); assert.deepEqual(data[KEYS.save].state, state);
  h.ui.destroy();
  const next = harness({ data }); t.after(() => next.ui.destroy()); next.touch('modal-action-1');
  assert.equal(next.ui.assisted, true); assert.deepEqual(next.ui.state, state);
  finishPvp(next, 0); assert.equal(next.ui.stats.results.length, 2);
  next.ui.openModal('stats');
  const text = next.calls.filter(c => c.method === 'fillText').map(c => c.args[0]).join('\n');
  assert.doesNotMatch(text, /提示辅助|独立思考|无辅助/);
  assert.match(text, /人机：1 胜/);
  assert.deepEqual(data[KEYS.stats].results[0], legacy);
});

test('corrupt, forged and unsupported saves are safely ignored', t => {
  const valid = engine.createGame();
  const saves = [null, '{not-json', {}, { version: 2, id: 'bad', assisted: false, state: valid },
    { version: 1, id: 'bad', assisted: false, state: { ...valid, piles: [-1, 5, 7] } },
    { version: 1, id: 'bad', assisted: false, state: { ...valid, winner: 0 } },
    { version: 1, id: 'bad', assisted: false, state: { ...valid, currentPlayer: 1 } },
    { version: 1, id: 'bad', assisted: false, state: { ...valid, history: [{ player: 0, row: 0, count: 2, piles: [1, 5, 7] }] } },
    { version: 1, id: 'bad', assisted: 'yes', state: valid }];
  for (const saved of saves) {
    const h = harness({ data: { [KEYS.save]: saved } }); t.after(() => h.ui.destroy());
    assert.equal(h.ui.resumeCandidate, null); assert.equal(h.ui.modal, null); assert.equal(h.ui.screen, 'home');
    h.touch('start'); assert.equal(h.ui.screen, 'game'); assert.ok(engine.validateState(h.ui.state));
  }
});

test('settings remember difficulty/mode/AI-first/sound/vibration and distinct avatars', t => {
  const h = harness(); h.touch('mode-3'); h.touch('ai-first'); h.touch('sound'); h.touch('vibration');
  h.touch('avatar-0'); h.touch('choose-avatar-3');
  assert.deepEqual(h.ui.settings.avatars, [3, 0]);
  h.touch('avatar-1'); h.touch('choose-avatar-3'); assert.deepEqual(h.ui.settings.avatars, [0, 3]);
  h.touch('mode-0'); assert.equal(h.ui.settings.difficulty, 'hard'); h.ui.destroy();
  const next = harness({ data: h.data }); t.after(() => next.ui.destroy());
  assert.equal(next.ui.settings.mode, 'pvp'); assert.equal(next.ui.modeChoice, 'pvp');
  assert.equal(next.ui.difficultyChoice, 'hard'); assert.equal(next.ui.settings.aiFirst, true);
  assert.equal(next.ui.settings.sound, false); assert.equal(next.ui.settings.vibration, false);
  next.ui.startGame(); next.ui.select(0, 1); next.ui.confirmMove(); next.flush();
  assert.deepEqual(next.feedback, { sound: 0, vibration: 0, share: 0 });
  const ai = harness({ data: { [KEYS.settings]: { mode: 'ai', difficulty: 'medium', avatars: [5, 5] } } });
  t.after(() => ai.ui.destroy()); assert.equal(ai.ui.difficultyChoice, 'medium');
  assert.notEqual(ai.ui.settings.avatars[0], ai.ui.settings.avatars[1]);
  ai.touch('start'); assert.equal(ai.ui.state.difficulty, 'medium');
});

test('storage false and thrown failures are visible, nonfatal, and do not duplicate results', t => {
  for (const storageFailure of ['false', 'throw']) {
    const h = harness({ storageFailure }); t.after(() => h.ui.destroy()); pvp(h); finishPvp(h);
    assert.equal(h.ui.storageWarning, true); assert.match(h.ui.toast, /保存失败/); assert.ok(h.ui.lastError);
    assert.ok(h.calls.some(call => call.method === 'fillText' && String(call.args[0]).includes('本地保存失败')));
    assert.ok(engine.validateState(h.ui.state)); h.ui.finish(); assert.equal(h.ui.stats.results.length, 1);
  }
});

test('320x568 safe areas, four modes, seven-die single line, and paged overlays stay in bounds', t => {
  for (const safeTop of [0, 24, 44, 84, 88]) {
    const h = harness({ safeTop, safeBottom: 34 }); t.after(() => h.ui.destroy()); withinSafeArea(h, 'home ' + safeTop);
    for (const id of ['mode-0', 'mode-1', 'mode-2', 'mode-3']) h.touch(id);
    for (const type of ['rules', 'stats', 'avatars']) {
      if (type === 'avatars') h.touch('avatar-0'); else h.touch(type);
      withinSafeArea(h, type);
      while (h.ui.modal.page < h.ui.modal.pages - 1) { h.touch('page-next'); withinSafeArea(h, type + ' page'); }
      h.touch('modal-close');
    }
    pvp(h); withinSafeArea(h, 'game');
    const originalDice = h.ui.dice, dice = [];
    h.ui.dice = function (...args) { dice.push(args); return originalDice.apply(this, args); };
    h.ui.render(); h.ui.dice = originalDice;
    assert.equal(dice.length, 15);
    const rows = new Map();
    for (const die of dice) { if (!rows.has(die[1])) rows.set(die[1], []); rows.get(die[1]).push(die); }
    assert.deepEqual([...rows.values()].map(row => row.length), [3, 5, 7]);
    for (const row of rows.values()) for (const die of row) assert.ok(die[0] >= 20 && die[0] + die[2] <= 300);
    h.ui.stats.results = Array.from({ length: 100 }, (_, i) => ({
      id: 'result-' + i, mode: 'ai', difficulty: 'hard', winner: i % 2, assisted: i % 2 === 0, at: i
    }));
    h.ui.openModal('stats'); assert.ok(h.ui.modal.pages > 1);
    while (h.ui.modal.page < h.ui.modal.pages - 1) { withinSafeArea(h, 'long stats'); h.touch('page-next'); }
    withinSafeArea(h, 'last page'); h.touch('modal-close');
    for (const modal of ['leave', 'restart', 'history']) { h.ui.openModal(modal); withinSafeArea(h, modal); h.touch('modal-close'); }
    finishPvp(h); withinSafeArea(h, 'result'); assert.equal(h.ui.modal.pages, 1);
  }
});

test('home and game share fixed single-page rules without changing a selected position', t => {
  const h = harness({ safeTop: 84, safeBottom: 34 }); t.after(() => h.ui.destroy());
  const readRules = () => {
    h.calls.length = 0; h.touch('rules');
    assert.equal(h.ui.modal.type, 'rules'); assert.equal(h.ui.modal.pages, 1);
    assert.equal(h.ui.modal.page, 0); assert.ok(h.ui.hitBoxes.every(b => !b.id.startsWith('page-')));
    withinSafeArea(h, 'single-page rules');
    const dim = h.calls.findLastIndex(c => c.method === 'fillRect' && c.args[2] === 320 && c.args[3] === 568);
    return h.calls.slice(dim + 1).filter(c => c.method === 'fillText').map(c => c.args[0]).join('');
  };
  const homeRules = readRules();
  for (const phrase of ['双方轮流', '每回合只能从一排拿至少一颗', '拿最后一颗的人输', '左边的一方从左往右拿', '右边的一方从右往左拿', '确认拿取 / 取消'])
    assert.ok(homeRules.includes(phrase), phrase);
  h.touch('modal-close'); pvp(h); h.die(1, 3);
  const state = copy(h.ui.state), selected = copy(h.ui.selected), saved = copy(h.data[KEYS.save]);
  const id = h.ui.gameId;
  const cancel = h.ui.hitBoxes.find(b => b.id === 'cancel'), confirm = h.ui.hitBoxes.find(b => b.id === 'confirm');
  assert.equal(cancel.y, confirm.y); assert.ok(confirm.w > cancel.w * 2);
  assert.equal(readRules(), homeRules); h.ui.select(0, 1); h.touch('modal-close');
  assert.deepEqual(h.ui.state, state); assert.deepEqual(h.ui.selected, selected);
  assert.deepEqual(h.data[KEYS.save], saved); assert.equal(h.ui.gameId, id);
  assert.equal(h.ui.assisted, false); assert.equal(h.ui.stats.results.length, 0); assert.equal(h.timers.size, 0);
  h.touch('confirm'); h.flush(); assert.deepEqual(h.ui.state.piles, [3, 2, 7]);
});

test('all reachable UI excludes strategy explanations, recommendations and assistance labels', t => {
  const h = harness(); t.after(() => h.ui.destroy());
  assert.equal(typeof h.ui.hint, 'undefined'); assert.equal(typeof h.ui.strategyText, 'undefined');
  for (const type of ['rules', 'stats']) { h.touch(type); h.touch('modal-close'); }
  pvp(h);
  assert.ok(h.ui.hitBoxes.every(b => !['hint', 'teaching'].includes(b.id)));
  for (const type of ['rules', 'history', 'restart', 'leave']) { h.touch(type === 'leave' ? 'back' : type); h.touch('modal-close'); }
  // Removed modal types cannot display even externally supplied strategy text.
  for (const type of ['hint', 'teaching']) { h.ui.openModal({ type, text: '推荐走法：策略课堂' }); h.touch('modal-close'); }
  finishPvp(h); h.touch('result-home'); h.touch('stats');
  const text = h.calls.filter(c => c.method === 'fillText').map(c => c.args[0]).join('\n');
  assert.doesNotMatch(text, /二进制|异或|必胜|必败|算法|推荐走法|建议从|课堂|策略|提示辅助|独立思考|无辅助|misère|Nim/);
});

test('narrow result draws every status directly, never creates unreachable pages', t => {
  for (const safeTop of [84, 88]) for (const assisted of [false, true]) for (const failed of [false, true]) {
    const h = harness({ safeTop, safeBottom: 34, storageFailure: failed ? 'false' : undefined });
    t.after(() => h.ui.destroy()); pvp(h);
    // Simulate the internal flag restored from an older saved game.
    h.ui.assisted = assisted;
    finishPvp(h);
    h.ui.shareStatus = '分享未完成，可稍后再试'; h.calls.length = 0; h.ui.render();
    assert.equal(h.ui.modal.page, 0); assert.equal(h.ui.modal.pages, 1);
    assert.ok(h.ui.hitBoxes.every(b => !b.id.startsWith('page-')));
    withinSafeArea(h, 'full terminal');
    // Only inspect overlay draws after its full-screen dim rectangle.
    const dimIndex = h.calls.findLastIndex(c => c.method === 'fillRect' && c.args[0] === 0 && c.args[1] === 0 && c.args[2] === 320 && c.args[3] === 568);
    const text = h.calls.slice(dimIndex + 1).filter(c => c.method === 'fillText');
    assert.ok(text.every(c => !/提示辅助|独立思考/.test(String(c.args[0]))));
    for (const phrase of ['玩家二获胜', '玩家一拿到了最后一颗', '共 3 手',
      failed ? '本地保存失败' : '战绩已计入', '分享未完成']) assert.ok(text.some(c => String(c.args[0]).includes(phrase)), phrase);
    const firstAction = h.ui.hitBoxes.find(b => b.id === 'again');
    for (const line of text.filter(c => !['本局结束', '再来一局', '分享这次挑战', '返回首页'].includes(c.args[0]))) {
      assert.ok(line.args[2] + 12 < firstAction.y, 'summary overlaps action buttons');
      assert.ok(line.args[2] - 12 >= h.ui.top && line.args[2] + 12 <= h.ui.bottom);
    }
  }
});

test('actual move animation highlights, rises and fades frame by frame; not only a phase lock', t => {
  const h = harness(); t.after(() => h.ui.destroy()); pvp(h); h.ui.select(0, 2);
  const originalDice = h.ui.dice, overlays = [];
  h.ui.dice = function (...args) {
    if (this.motion && args[4]) overlays.push({ progress: this.motion.progress, x: args[0], y: args[1], alpha: h.ctx.globalAlpha });
    return originalDice.apply(this, args);
  };
  h.ui.confirmMove(); assert.equal(h.ui.phase, 'animating'); assert.equal(h.ui.state.history.length, 1);
  assert.ok([...h.timers.values()].every(timer => timer.due <= 16), 'frames are scheduled at display rate');
  h.flush(); h.ui.dice = originalDice;
  assert.equal(h.ui.motion, null); assert.equal(h.ui.phase, 'idle'); assert.equal(h.ui.state.history.length, 1);
  const progress = [...new Set(overlays.map(o => o.progress))];
  assert.equal(progress[0], 0); assert.ok(progress.length >= 10, 'smooth animation draws many frames');
  for (let i = 1; i < progress.length; i++) assert.ok(progress[i] > progress[i - 1] && progress[i] < 1);
  const first = overlays.filter(o => o.progress === 0), last = overlays.filter(o => o.progress === progress.at(-1));
  assert.equal(first.length, 2); assert.equal(last.length, 2);
  for (let i = 0; i < first.length; i++) {
    assert.equal(first[i].alpha, 1); assert.ok(last[i].alpha >= 0 && last[i].alpha < 0.1);
    assert.ok(last[i].y < first[i].y - 10); assert.equal(last[i].x, first[i].x);
  }
  assert.equal(h.ctx.globalAlpha, 1); assert.equal(h.depth, 0);
});

function boardDice(h) {
  const originalDice = h.ui.dice, dice = [];
  assert.equal(h.ui.motion, null, 'inspect the board between animations');
  h.ui.dice = function (...args) {
    dice.push({ x: args[0], y: args[1], value: args[3], selected: args[4], ghost: args[5] });
    return originalDice.apply(this, args);
  };
  h.ui.render(); h.ui.dice = originalDice;
  const ys = [...new Set(dice.map(d => d.y))].sort((a, b) => a - b);
  return ys.map(y => dice.filter(d => d.y === y));
}

function liftedDice(h, act) {
  const originalDice = h.ui.dice, lifted = new Set();
  h.ui.dice = function (...args) {
    if (this.motion && args[4] && !args[5]) lifted.add(args[0]);
    return originalDice.apply(this, args);
  };
  act(); h.flush(); h.ui.dice = originalDice;
  return [...lifted].sort((a, b) => a - b);
}

test('each side picks and takes from its own end; the dice taken are exactly the highlighted ones', t => {
  const h = harness(); t.after(() => h.ui.destroy()); pvp(h);
  const positions = row => row.map((d, i) => d.selected ? i : -1).filter(i => i >= 0);
  const ghosts = row => row.map((d, i) => d.ghost ? i : -1).filter(i => i >= 0);
  h.die(2, 3);
  const start = boardDice(h)[2];
  assert.deepEqual(positions(start), [0, 1, 2], 'left player highlights from the left');
  const lifted = liftedDice(h, () => h.touch('confirm'));
  assert.deepEqual(lifted, [0, 1, 2].map(i => start[i].x), 'animation lifts the highlighted dice');
  let row = boardDice(h)[2];
  assert.deepEqual(ghosts(row), [0, 1, 2], 'empty slots are where the picked dice were');
  assert.equal(h.ui.state.currentPlayer, 1);
  h.die(2, 2);
  assert.deepEqual(positions(boardDice(h)[2]), [5, 6], 'right player highlights from the right');
  h.emit('touch', { x: row[3].x + 2, y: h.ui.hitBoxes.find(b => b.id === 'row-2').y + 20 });
  assert.deepEqual(h.ui.selected, { row: 2, count: 4 }, 'right player tapping the leftmost remaining die takes all four');
  h.die(2, 2); liftedDice(h, () => h.touch('confirm'));
  row = boardDice(h)[2];
  assert.deepEqual(ghosts(row), [0, 1, 2, 5, 6]);
  assert.deepEqual(row.filter(d => !d.ghost).map(d => [d.x, d.value]), [3, 4].map(i => [start[i].x, start[i].value]),
    'remaining dice keep their place and faces');
  h.emit('touch', { x: row[0].x + 2, y: h.ui.hitBoxes.find(b => b.id === 'row-2').y + 20 });
  assert.equal(h.ui.selected, null, 'tapping an empty slot changes nothing');
  h.die(2, 1); assert.deepEqual(positions(boardDice(h)[2]), [3], 'left player resumes at the first remaining die');
});

test('the computer takes from the right end, and restored games redraw both ends', t => {
  const h = harness();
  h.ui.startGame({ mode: 'ai', difficulty: 'hard', aiFirst: true, avatars: [0, 3] });
  h.flush();
  const aiStep = h.ui.state.history[0];
  assert.equal(aiStep.player, 1);
  const initial = [3, 5, 7][aiStep.row];
  const aiRow = boardDice(h)[aiStep.row];
  assert.deepEqual(aiRow.map((d, i) => d.ghost ? i : -1).filter(i => i >= 0),
    Array.from({ length: aiStep.count }, (_, k) => initial - aiStep.count + k), 'computer empties the right end');
  const row = aiStep.row === 2 ? 1 : 2;
  h.die(row, 1); h.touch('confirm'); h.flush();
  const before = boardDice(h).map(r => r.map(d => [d.value, d.ghost]));
  h.emit('hide'); h.ui.destroy();
  const next = harness({ data: h.data }); t.after(() => next.ui.destroy());
  next.touch('modal-action-1');
  assert.deepEqual(boardDice(next).map(r => r.map(d => [d.value, d.ghost])), before);
});

test('tall screens use larger dice and center content instead of leaving the bottom empty', t => {
  const h = harness({ width: 375, height: 812, safeTop: 84, safeBottom: 34 }); t.after(() => h.ui.destroy());
  withinSafeArea(h, 'tall home');
  const homeLast = h.ui.hitBoxes.find(b => b.id === 'stats');
  assert.ok(h.ui.bottom - (homeLast.y + homeLast.h) < 160, 'home content is vertically centered');
  pvp(h); withinSafeArea(h, 'tall game');
  const originalDice = h.ui.dice, sizes = [];
  h.ui.dice = function (...args) { sizes.push(args[2]); return originalDice.apply(this, args); };
  h.ui.render(); h.ui.dice = originalDice;
  assert.ok(sizes.every(size => size > 40), 'dice grow beyond the old 36px cap');
  const gameLast = h.ui.hitBoxes.find(b => b.id === 'history');
  assert.ok(h.ui.bottom - (gameLast.y + gameLast.h) < 120, 'board is vertically centered');
});

test('destroy cancels timers, unsubscribes callbacks, and rejects already queued input', () => {
  const h = harness(); h.ui.startGame({ mode: 'ai', difficulty: 'hard', aiFirst: true, avatars: [0, 3] });
  const timer = [...h.timers.values()][0].fn, touch = [...h.listeners.touch][0], show = [...h.listeners.show][0];
  h.ui.destroy(); h.ui.destroy(); timer(); touch({ x: 100, y: 100 }); show();
  assert.equal(h.timers.size, 0); assert.equal(h.ui.hitBoxes.length, 0); assert.equal(h.ui.state.history.length, 0);
  for (const set of Object.values(h.listeners)) assert.equal(set.size, 0);
  assert.equal(h.ui.destroyed, true);
});
