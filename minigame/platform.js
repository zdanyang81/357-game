'use strict';
const { CODE } = require('./online');

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
  const show = options => showHandlers.forEach(fn => fn(options || {}));
  const call = (name, options) => new Promise((resolve, reject) => {
    if (typeof wx[name] !== 'function') { reject(new Error('当前微信能力不可用：' + name)); return; }
    try { wx[name]({ ...options, success: resolve, fail: e => reject(new Error(e && e.errMsg || name + '失败')) }); }
    catch (error) { reject(error); }
  });
  let userButton = null, destroyed = false;
  const privacyListener = resolve => {
    call('openPrivacyContract', {}).then(() => {
      if (destroyed) { resolve({ event: 'disagree' }); return; }
      resolve({ event: 'exposureAuthorization' });
      return call('showModal', { title: '头像隐私授权（可拒绝）',
        content: '仅处理你选择的头像；确认入房后发送到357内测服务，仅向房间对手展示，房间过期清除。拒绝仍可用内置形象游玩。',
        confirmText: '同意', cancelText: '拒绝' }).then(result => resolve({ event: result.confirm ? 'agree' : 'disagree' }));
    }).catch(() => resolve({ event: 'disagree' }));
  };
  if (typeof wx.onNeedPrivacyAuthorization === 'function') wx.onNeedPrivacyAuthorization(privacyListener);
  const privacy = () => call('requirePrivacyAuthorize', {});
  const compressAvatar = source => new Promise((resolve, reject) => {
    let timer, done = false;
    const finish = (error, result) => { if (done) return; done = true; clearTimeout(timer); error ? reject(error) : resolve(result); };
    timer = setTimeout(() => finish(new Error('头像图片加载超时')), 10000);
    try {
      const image = wx.createImage();
      image.onerror = () => finish(new Error('头像图片无法加载，请选相册或内置形象'));
      image.onload = () => {
        try {
          if (!image.width || !image.height || image.width * image.height > 40000000) throw new Error('图片尺寸过大或无效');
          const layer = wx.createCanvas(); layer.width = layer.height = 96;
          const context = layer.getContext('2d'), edge = Math.min(image.width, image.height);
          context.drawImage(image, (image.width - edge) / 2, (image.height - edge) / 2, edge, edge, 0, 0, 96, 96);
          const data = layer.toDataURL('image/png');
          if (!/^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(data) || data.length > 174786) throw new Error('头像压缩失败或图片过大');
          finish(null, { avatar: { type: 'image', data } });
        } catch (error) { finish(error); }
      };
      image.src = source;
    } catch (error) { finish(error); }
  });
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
    // Let the UI report synchronous unavailability; sharing never gates play.
    share() { return wx.shareAppMessage(shareData()); },
    request(options) {
      return new Promise((resolve, reject) => {
        if (typeof wx.request !== 'function') { reject(new Error('网络能力不可用')); return; }
        try { wx.request({ ...options, success: resolve, fail: e => reject(new Error(e && e.errMsg || '网络中断')) }); }
        catch (error) { reject(error); }
      });
    },
    launchQuery() { try { return wx.getLaunchOptionsSync().query || {}; } catch (_) { return {}; } },
    inviteRoom(code) {
      if (!CODE.test(code)) throw new Error('房间码无效');
      // Keep conversation selection available when launched from a group toolbar.
      return wx.shareAppMessage({ title: '邀请你来357对战', query: 'room=' + encodeURIComponent(code), toCurrentGroup: false });
    },
    async inputRoomCode() {
      const result = await call('showModal', { title: '加入357房间', editable: true,
        placeholderText: '8位房间码', confirmText: '预填', cancelText: '取消' });
      return result.confirm ? result.content : null;
    },
    async confirmProfile() {
      const result = await call('showModal', { title: '确认进入内测房间',
        content: '自选头像将发送到357内测服务并仅向本房间对手展示，房间过期清除。内置形象不含你的个人头像。是否继续？',
        confirmText: '确认进入', cancelText: '取消' });
      return !!result.confirm;
    },
    async chooseAlbumAvatar() {
      await privacy();
      const modern = typeof wx.chooseMedia === 'function';
      const result = await call(modern ? 'chooseMedia' : 'chooseImage', modern
        ? { count: 1, mediaType: ['image'], sourceType: ['album'], sizeType: ['compressed'] }
        : { count: 1, sourceType: ['album'], sizeType: ['compressed'] });
      const source = modern ? result.tempFiles && result.tempFiles[0] && result.tempFiles[0].tempFilePath
        : result.tempFilePaths && result.tempFilePaths[0];
      if (!source) throw new Error('没有选择图片');
      return compressAvatar(source);
    },
    async beginWechatAvatar(style, callback) {
      await privacy();
      if (destroyed) throw new Error('界面已关闭');
      if (typeof wx.createUserInfoButton !== 'function') throw new Error('微信头像能力暂不可用，请用相册或内置形象');
      if (userButton) userButton.destroy();
      userButton = wx.createUserInfoButton({ type: 'text', text: '自愿授权微信头像', withCredentials: false, lang: 'zh_CN', style });
      userButton.onTap(result => {
        const source = result && result.userInfo && result.userInfo.avatarUrl;
        if (!source || !/^https:\/\//.test(source)) { callback(new Error('未取得头像，可选相册或内置形象')); return; }
        compressAvatar(source).then(profile => callback(null, profile), callback);
      });
    },
    cancelWechatAvatar() { if (userButton) { userButton.destroy(); userButton = null; } },
    loadAvatar(data, callback) {
      const image = wx.createImage(); image.onload = () => callback(null, image);
      image.onerror = () => callback(new Error('头像加载失败')); image.src = data;
    },
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
      destroyed = true;
      if (userButton) { userButton.destroy(); userButton = null; }
      if (typeof wx.offNeedPrivacyAuthorization === 'function') wx.offNeedPrivacyAuthorization(privacyListener);
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
