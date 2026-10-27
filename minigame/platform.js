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
  const hideHandlers = [];
  const showHandlers = [];
  const touch = event => {
    if (!event.changedTouches || event.changedTouches.length !== 1) return;
    const p = event.changedTouches[0];
    touchHandlers.forEach(fn => fn({ x: p.clientX === undefined ? p.pageX : p.clientX, y: p.clientY === undefined ? p.pageY : p.clientY }));
  };
  const hide = () => { if (audio) audio.stop(); hideHandlers.forEach(fn => fn()); };
  const show = () => showHandlers.forEach(fn => fn());
  wx.onTouchEnd(touch);
  wx.onHide(hide);
  wx.onShow(show);
  // Sharing is always optional and never grants rewards or unlocks play.
  const shareData = () => ({ title: '357 · 最后一颗不能拿，你能赢吗？' });
  try { wx.showShareMenu({ menus: ['shareAppMessage'] }); wx.onShareAppMessage(shareData); } catch (_) {}
  return {
    canvas, width, height, dpr,
    safeTop: Math.max(0, (safe.top || 0) - screenTop, menuBottom),
    safeBottom: Math.max(0, height - ((safe.bottom || height + screenTop) - screenTop)),
    storage: {
      get(key) { try { return wx.getStorageSync('357:' + key); } catch (_) { return null; } },
      set(key, value) { try { wx.setStorageSync('357:' + key, value); return true; } catch (_) { return false; } }
    },
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
    onHide(fn) { hideHandlers.push(fn); return () => remove(hideHandlers, fn); },
    onShow(fn) { showHandlers.push(fn); return () => remove(showHandlers, fn); },
    setTimeout, clearTimeout,
    destroy() {
      wx.offTouchEnd(touch); wx.offHide(hide); wx.offShow(show);
      touchHandlers.length = hideHandlers.length = showHandlers.length = 0;
      if (audio) { audio.destroy(); audio = null; }
    }
  };
}
module.exports = { createPlatform };
