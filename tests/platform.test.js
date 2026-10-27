'use strict';
const assert = require('node:assert/strict');
const { createPlatform } = require('../minigame/platform');
const handlers = {};
const stored = {};
const calls = [];
const wx = {
  getWindowInfo: () => ({ windowWidth: 375, windowHeight: 812, pixelRatio: 4, safeArea: { top: 44, bottom: 778 } }),
  getMenuButtonBoundingClientRect: () => ({ bottom: 76 }),
  createCanvas: () => ({ getContext: () => ({ scale: (...args) => calls.push(['scale', ...args]) }) }),
  onTouchEnd: fn => { handlers.touch = fn; }, onHide: fn => { handlers.hide = fn; }, onShow: fn => { handlers.show = fn; },
  offTouchEnd: fn => { assert.equal(fn, handlers.touch); }, offHide: fn => { assert.equal(fn, handlers.hide); }, offShow: fn => { assert.equal(fn, handlers.show); },
  getStorageSync: key => stored[key], setStorageSync: (key, value) => { stored[key] = value; },
  showShareMenu: () => {}, onShareAppMessage: fn => { handlers.share = fn; },
  shareAppMessage: data => calls.push(['share', data]), vibrateShort: () => calls.push(['vibrate']),
  setInnerAudioOption: options => { assert.equal(options.obeyMuteSwitch, true); calls.push(['audio-options']); },
  createInnerAudioContext: () => ({ stop: () => calls.push(['stop']), play: () => calls.push(['play']), destroy: () => calls.push(['destroy']), onError: () => {} })
};
const p = createPlatform(wx);
assert.equal(p.width, 375); assert.equal(p.canvas.width, 1125); assert.equal(p.safeTop, 84); assert.equal(p.safeBottom, 34);
assert.deepEqual(calls[0], ['scale', 3, 3]);
p.storage.set('save', { a: 1 }); assert.deepEqual(p.storage.get('save'), { a: 1 }); assert.ok(stored['357:save']);
let points = []; let hidden = 0; let shown = 0;
p.onTouch(point => points.push(point)); p.onHide(() => hidden++); p.onShow(() => shown++);
handlers.touch({ changedTouches: [{ clientX: 12, clientY: 30 }] });
handlers.touch({ changedTouches: [{ pageX: 20, pageY: 40 }] });
handlers.touch({ changedTouches: [{}, {}] });
assert.deepEqual(points, [{ x: 12, y: 30 }, { x: 20, y: 40 }]);
let removedTouches = 0;
const unsubscribe = p.onTouch(() => removedTouches++); unsubscribe();
handlers.touch({ changedTouches: [{ clientX: 1, clientY: 1 }] });
assert.equal(removedTouches, 0, 'unsubscribed listeners must not fire');
p.sound(); p.vibrate(); p.share(); handlers.hide(); handlers.show();
assert.equal(hidden, 1); assert.equal(shown, 1); assert.ok(handlers.share().title.includes('357'));
assert.ok(calls.some(c => c[0] === 'play')); p.destroy(); assert.ok(calls.some(c => c[0] === 'destroy'));
wx.getStorageSync = wx.setStorageSync = () => { throw Error('storage unavailable'); };
assert.equal(p.storage.get('x'), null); assert.equal(p.storage.set('x', {}), false);
wx.getWindowInfo = () => ({ windowWidth: 320, windowHeight: 544, screenTop: 24, pixelRatio: 1, safeArea: { top: 24, bottom: 534 } });
const offsetPlatform = createPlatform(wx);
assert.equal(offsetPlatform.safeTop, 60, 'screen coordinates must be translated to window coordinates');
assert.equal(offsetPlatform.safeBottom, 34);
offsetPlatform.destroy();
console.log('Platform adapter tests passed');
