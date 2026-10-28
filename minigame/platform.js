'use strict';

// All WeChat-dependent behavior lives here; core and UI have no wx dependency.
function remove(list, fn) { const index = list.indexOf(fn); if (index >= 0) list.splice(index, 1); }

function createPlatform(wx) {
  const info = typeof wx.getWindowInfo === 'function' ? wx.getWindowInfo() : wx.getSystemInfoSync();
  const canvas = wx.createCanvas();
  const width = info.windowWidth;
  const height = info.windowHeight;
  const dpr = Math.min(info.pixelRatio || 1, 3);
  canvas.width = Math.round(width * dpr);
  canvas.height = Math.round(height * dpr);
  canvas.getContext('2d').scale(dpr, dpr);
  const screenTop = Number(info.screenTop) || 0;
  const safe = info.safeArea || { top: screenTop, bottom: screenTop + height };
  let menuBottom = 0;
  try { menuBottom = Math.max(0, wx.getMenuButtonBoundingClientRect().bottom - screenTop + 8); } catch (_) {}
  let audio = null;
  const touchHandlers = [];
  const pressHandlers = [];
  const cancelHandlers = [];
  const hideHandlers = [];
  const showHandlers = [];
  const point = event => {
    if (!event.changedTouches || event.changedTouches.length !== 1) return null;
    const p = event.changedTouches[0];
    return { x: p.clientX === undefined ? p.pageX : p.clientX, y: p.clientY === undefined ? p.pageY : p.clientY };
  };
  const touch = event => { const p = point(event); if (p) touchHandlers.forEach(fn => fn(p)); };
  const press = event => { const p = point(event); if (p) pressHandlers.forEach(fn => fn(p)); };
  const cancelTouch = () => cancelHandlers.forEach(fn => fn());
  const hide = () => { if (audio) audio.stop(); hideHandlers.forEach(fn => fn()); };
  const show = () => showHandlers.forEach(fn => fn());
  const optional = (name, fn) => { if (typeof wx[name] === 'function') wx[name](fn); };
  wx.onTouchEnd(touch);
  optional('onTouchStart', press);
  optional('onTouchCancel', cancelTouch);
  wx.onHide(hide);
  wx.onShow(show);
  const raf = typeof requestAnimationFrame === 'function' ? requestAnimationFrame : null;
  const caf = typeof cancelAnimationFrame === 'function' ? cancelAnimationFrame : null;
  // Sharing is always optional and never grants rewards or unlocks play.
  const shareData = () => ({ title: '357 · 最后一颗不能拿，你能赢吗？' });
  try { wx.showShareMenu({ menus: ['shareAppMessage'] }); wx.onShareAppMessage(shareData); } catch (_) {}
  return {
    canvas, width, height, dpr,
    safeTop: Math.max(0, (safe.top || 0) - screenTop, menuBottom),
    safeBottom: Math.max(0, height - ((safe.bottom || height + screenTop) - screenTop)),
    storage: {
      get(key) { try { return wx.getStorageSync('357:' + key); } catch (_) { return null; } },
      set(key, value) { try { wx.setStorageSync('357:' + key, value); return true; } catch (_) { return false; } },
      remove(key) { try { wx.removeStorageSync('357:' + key); return true; } catch (_) { return false; } }
    },
    // Later wx.createCanvas() calls return offscreen canvases.
    createCanvas() { return wx.createCanvas(); },
    sound() {
      try {
        if (!audio) {
          if (typeof wx.setInnerAudioOption === 'function') {
            wx.setInnerAudioOption({ obeyMuteSwitch: true, mixWithOther: true, fail() {} });
          }
          audio = wx.createInnerAudioContext();
          audio.src = 'assets/tap.wav';
          audio.obeyMuteSwitch = true;
          audio.onError(() => {});
        }
        audio.stop(); audio.play();
      } catch (_) { /* Audio is optional, never block a move. */ }
    },
    vibrate() { try { wx.vibrateShort({ type: 'light', fail() {} }); } catch (_) {} },
    share() { try { wx.shareAppMessage(shareData()); } catch (_) {} },
    onTouch(fn) { touchHandlers.push(fn); return () => remove(touchHandlers, fn); },
    onTouchStart(fn) { pressHandlers.push(fn); return () => remove(pressHandlers, fn); },
    onTouchCancel(fn) { cancelHandlers.push(fn); return () => remove(cancelHandlers, fn); },
    onHide(fn) { hideHandlers.push(fn); return () => remove(hideHandlers, fn); },
    onShow(fn) { showHandlers.push(fn); return () => remove(showHandlers, fn); },
    setTimeout, clearTimeout,
    requestAnimationFrame: raf ? fn => raf(fn) : fn => setTimeout(fn, 16),
    cancelAnimationFrame: raf && caf ? id => caf(id) : id => clearTimeout(id),
    now: () => Date.now(),
    destroy() {
      wx.offTouchEnd(touch); wx.offHide(hide); wx.offShow(show);
      if (typeof wx.offTouchStart === 'function') wx.offTouchStart(press);
      if (typeof wx.offTouchCancel === 'function') wx.offTouchCancel(cancelTouch);
      touchHandlers.length = pressHandlers.length = cancelHandlers.length = 0;
      hideHandlers.length = showHandlers.length = 0;
      if (audio) { audio.destroy(); audio = null; }
    }
  };
}
module.exports = { createPlatform };
