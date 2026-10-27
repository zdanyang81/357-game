'use strict';
const assert = require('node:assert/strict');
const calls = [];
const ctx = new Proxy({
  createLinearGradient: () => ({ addColorStop() {} }),
  measureText: text => ({ width: String(text).length * 8 }),
}, { get(target, key) { return key in target ? target[key] : () => {}; }, set(target, key, value) { target[key] = value; return true; } });
global.wx = {
  getWindowInfo: () => ({ windowWidth: 320, windowHeight: 568, pixelRatio: 2, safeArea: { top: 24, bottom: 534 } }),
  getMenuButtonBoundingClientRect: () => ({ bottom: 76 }),
  createCanvas: () => ({ getContext: () => ctx }),
  getStorageSync: () => null, setStorageSync() {},
  onTouchEnd: fn => calls.push(fn), onHide() {}, onShow() {},
  offTouchEnd() {}, offHide() {}, offShow() {}, showShareMenu() {}, onShareAppMessage() {}
};
global.GameGlobal = {};
require('../minigame/game');
assert.equal(GameGlobal.game357.ui.screen, 'home');
assert.equal(calls.length, 1);
assert.equal(GameGlobal.game357.ui.lastError, null);
GameGlobal.game357.destroy();
assert.equal(GameGlobal.game357.ui.destroyed, true);
delete global.wx; delete global.GameGlobal;
console.log('WeChat entry wiring smoke test passed (mock API, not device acceptance)');
