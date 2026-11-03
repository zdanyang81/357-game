'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createPlatform } = require('../minigame/platform');
function fixture() {
  const calls = [], handlers = {}; let button;
  const wx = {
    getWindowInfo: () => ({ windowWidth: 320, windowHeight: 568 }),
    getMenuButtonBoundingClientRect: () => ({ bottom: 60 }),
    onTouchEnd() {}, onHide() {}, onShow(fn) { handlers.show = fn; }, offTouchEnd() {}, offHide() {}, offShow() {},
    createCanvas() { const canvas = { width: 0, height: 0, getContext: () => ({ scale() {}, drawImage(...args) { calls.push(['draw', args]); } }),
      toDataURL(type) { calls.push(['encode', type, canvas.width, canvas.height]); return 'data:image/png;base64,aGVsbG8='; } }; return canvas; },
    createImage() { const image = { width: 800, height: 600 }; Object.defineProperty(image, 'src', { set(value) { calls.push(['source', value]); queueMicrotask(() => image.onload()); } }); return image; },
    requirePrivacyAuthorize(options) { calls.push(['privacy']); options.success({}); },
    chooseMedia(options) { calls.push(['choose', options]); options.success({ tempFiles: [{ tempFilePath: '/temp/large-original.jpeg' }] }); },
    showModal(options) { calls.push(['modal', options]); options.success({ confirm: true, content: 'ABCDEFG2' }); },
    shareAppMessage(options) { calls.push(['share', options]); },
    getLaunchOptionsSync() { return { query: { room: 'ABCDEFG2', token: 'evil' } }; },
    createUserInfoButton(options) { calls.push(['user-button', options]); button = { onTap(fn) { handlers.tap = fn; }, destroy() { calls.push(['button-destroy']); } }; return button; }
  };
  return { wx, calls, handlers, p: createPlatform(wx) };
}
test('album is voluntary, privacy-first image-only album; wire is resized PNG not temporary path', async () => {
  const h = fixture(); const profile = await h.p.chooseAlbumAvatar();
  assert.deepEqual(h.calls[0], ['privacy']);
  const options = h.calls.find(c => c[0] === 'choose')[1];
  assert.equal(options.count, 1); assert.deepEqual(options.mediaType, ['image']); assert.deepEqual(options.sourceType, ['album']);
  assert.deepEqual(h.calls.find(c => c[0] === 'encode'), ['encode', 'image/png', 96, 96]);
  assert.ok(!JSON.stringify(profile).includes('/temp/')); assert.equal(profile.avatar.type, 'image'); h.p.destroy();
});
test('privacy denial never opens album or user-info button; no forced authorization', async () => {
  const h = fixture(); h.wx.requirePrivacyAuthorize = o => o.fail({ errMsg: 'privacy permission is not authorized' });
  await assert.rejects(h.p.chooseAlbumAvatar(), /privacy/);
  await assert.rejects(h.p.beginWechatAvatar({}, () => {}), /privacy/);
  assert.equal(h.calls.filter(c => ['choose', 'user-button'].includes(c[0])).length, 0); h.p.destroy();
});
test('native user button uses no credentials; only tap result avatar image, no nickname', async () => {
  const h = fixture(); let result;
  await h.p.beginWechatAvatar({ left: 10 }, (error, profile) => { result = { error, profile }; });
  assert.equal(h.calls.find(c => c[0] === 'user-button')[1].withCredentials, false);
  assert.equal(h.calls.filter(c => c[0] === 'source').length, 0);
  h.handlers.tap({ userInfo: { avatarUrl: 'https://image.example/avatar', nickName: 'must-not-send' } });
  for (let i = 0; i < 5; i++) await Promise.resolve();
  assert.equal(result.error, null); assert.ok(!JSON.stringify(result.profile).includes('must-not-send'));
  h.p.cancelWechatAvatar(); assert.ok(h.calls.some(c => c[0] === 'button-destroy')); h.p.destroy();
});
test('denied user tap is handled without inventing avatar success', async () => {
  const h = fixture(); let error;
  await h.p.beginWechatAvatar({}, e => { error = e; }); h.handlers.tap({ errMsg: 'deny' });
  assert.match(error.message, /未取得头像/); assert.equal(h.calls.filter(c => c[0] === 'source').length, 0); h.p.destroy();
});
test('cold/hot query forwarded and invitation contains room only, never token', () => {
  const h = fixture(); assert.equal(h.p.launchQuery().room, 'ABCDEFG2'); let shown;
  h.p.onShow(options => { shown = options.query; }); h.handlers.show({ query: { room: 'BCDEFGH2' } });
  assert.equal(shown.room, 'BCDEFGH2'); h.p.inviteRoom('ABCDEFG2');
  assert.deepEqual(h.calls.find(c => c[0] === 'share')[1], { title: '邀请你来357对战', query: 'room=ABCDEFG2' });
  h.p.inviteRoom('ABCDEF89');
  assert.equal(h.calls.filter(c => c[0] === 'share').at(-1)[1].query, 'room=ABCDEF89');
  for (const invalid of ['invalid', 'ABCDEFIO', 'ABCDEF01']) assert.throws(() => h.p.inviteRoom(invalid)); h.p.destroy();
});
test('legacy album fallback remains image-only; unavailable privacy cannot be bypassed', async () => {
  const h = fixture(); delete h.wx.chooseMedia;
  h.wx.chooseImage = o => { assert.deepEqual(o.sourceType, ['album']); o.success({ tempFilePaths: ['/temp/legacy'] }); };
  assert.equal((await h.p.chooseAlbumAvatar()).avatar.type, 'image');
  delete h.wx.requirePrivacyAuthorize; await assert.rejects(h.p.chooseAlbumAvatar(), /不可用/); h.p.destroy();
});
