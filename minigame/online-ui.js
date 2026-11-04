'use strict';
const { OnlineSession, inviteCode, normalizeCode, CODE } = require('./online');
const config = require('./online-config');
module.exports = {
  initOnline() {
    this.onlineMode = false; this.onlineCode = ''; this.profileGeneration = 0; this.avatarOperation = null;
    this.onlineProfile = { avatar: { type: 'preset', index: 0 } }; this.avatarImages = new Map();
    this.online = new OnlineSession(this.platform, config.apiBase, () => this.onlineChanged(), config.accessKey);
    this.receiveInvite(this.platform.launchQuery ? this.platform.launchQuery() : {});
  },
  receiveInvite(query) {
    const code = inviteCode(query);
    if (!code) return;
    this.onlineCode = code;
    this.toast = '收到房间邀请，点击「好友联网」后确认加入';
    if (this.onlineMode && !this.online.room) this.online.error = '邀请已预填，请本人点击加入';
    if (this.online) this.render();
  },
  openOnline() {
    this.invalidate(); this.modal = null; this.onlineMode = true;
    this.state = null; this.gameId = null; this.screen = 'online'; this.render();
  },
  onlineChanged() {
    if (!this.onlineMode || this.destroyed) return;
    const room = this.online.room;
    if (room && room.game) {
      const changed = !this.state || this.state.history.length !== room.game.history.length;
      this.state = room.game; this.screen = 'game';
      if (changed) this.selected = null;
      if (room.status === 'finished' && !this.modal) this.modal = { type: 'online-result' };
    } else {
      // Retire the result view before its authoritative game state disappears.
      if (this.modal && this.modal.type === 'online-result') this.modal = null;
      this.state = null; this.screen = 'online';
    }
    this.render();
  },
  enterOnline(join) {
    if (this.destroyed || this.hidden || !this.onlineMode || this.screen !== 'online' || this.modal ||
        this.online.busy || this.online.creationUnknown || this.online.room || this.profileBusy) return;
    if (join && !CODE.test(this.onlineCode)) { this.showOnlineMessage('请先输入有效房间码'); return; }
    this.cancelOnlineAvatar();
    // Snapshot only the chosen room/profile, not credentials. No request before a second explicit tap.
    this.openModal({ type: 'online-consent', generation: this.profileGeneration, join: !!join,
      code: join ? this.onlineCode : '', profile: JSON.parse(JSON.stringify(this.onlineProfile)), page: 0 });
  },
  async confirmOnlineConsent(consent) {
    if (this.modal !== consent || consent.type !== 'online-consent' || consent.generation !== this.profileGeneration ||
        this.destroyed || this.hidden || !this.onlineMode || this.screen !== 'online' || this.online.busy ||
        this.online.creationUnknown || this.online.room || this.profileBusy || (consent.join && !CODE.test(consent.code))) return;
    this.modal = null; this.profileBusy = true; this.render();
    try {
      const entered = await this.online.enter(consent.code, consent.profile);
      if (!entered && this.online.error && !this.destroyed && this.onlineMode && consent.generation === this.profileGeneration)
        this.showOnlineMessage(this.online.error);
    } catch (_) {
      // Session normally catches transport failures. Unexpected failures are not retried.
      if (!this.destroyed && this.onlineMode && consent.generation === this.profileGeneration)
        this.showOnlineMessage('入房结果未确认，请停止重复操作并稍后查询');
    } finally { this.profileBusy = false; if (!this.destroyed) this.render(); }
  },
  showOnlineMessage(message) {
    this.online.error = typeof message === 'string' ? message.slice(0, 400) : '操作未完成，请稍后查询';
    if (!this.destroyed && !this.hidden && this.onlineMode)
      this.openModal({ type: 'online-message', message: this.online.error, page: 0 });
  },
  async inputOnlineCode() {
    try {
      const result = await this.platform.inputRoomCode();
      if (!this.onlineMode || this.destroyed || result === null) return;
      this.onlineCode = normalizeCode(result); this.render();
    } catch (_) { this.online.error = '房间码输入不可用，请在支持原生输入的微信重试'; this.render(); }
  },
  async chooseOnlineAvatar(kind) {
    if (this.online.room || this.profileBusy) return;
    this.cancelOnlineAvatar(); const generation = this.profileGeneration;
    const operation = { kind, generation }; this.avatarOperation = operation;
    this.profileBusy = true; this.online.error = ''; this.render();
    const accept = (error, profile) => {
      if (this.destroyed || !this.onlineMode || generation !== this.profileGeneration || this.avatarOperation !== operation) return;
      this.profileBusy = false;
      if (error) {
        // Album selection resolves once; a live WeChat authorization button can be tapped again.
        if (kind === 'album') this.avatarOperation = null;
        this.online.error = error.message;
      } else { this.avatarOperation = null; this.onlineProfile = profile; this.online.error = '头像仅在确认入房后发送；微信头像是否非灰以实际预览为准'; this.cancelOnlineAvatar(); }
      this.render();
    };
    try {
      if (kind === 'album') accept(null, await this.platform.chooseAlbumAvatar());
      else {
        await this.platform.beginWechatAvatar({ left: 30, top: this.top + 76, width: this.width - 60,
          height: 44, backgroundColor: '#d8b674', color: '#172b23', textAlign: 'center', fontSize: 16, lineHeight: 44 }, accept);
        if (generation !== this.profileGeneration || !this.onlineMode || this.hidden || this.destroyed) this.platform.cancelWechatAvatar();
        else { this.profileBusy = false; this.online.error = '点击上方原生按钮自愿授权；下方可取消授权入口'; this.render(); }
      }
    } catch (error) { accept(error); }
  },
  hasPendingAlbumOperation() {
    const operation = this.avatarOperation;
    return !!operation && operation.kind === 'album' && operation.generation === this.profileGeneration &&
      this.profileBusy && this.onlineMode && this.screen === 'online' && !this.online.room && !this.destroyed;
  },
  cancelOnlineAvatar() {
    this.profileGeneration++; this.avatarOperation = null; this.profileBusy = false;
    if (this.modal && this.modal.type === 'online-consent') this.modal = null;
    if (this.platform.cancelWechatAvatar) this.platform.cancelWechatAvatar();
  },
  async leaveOnline() {
    this.cancelOnlineAvatar();
    if (this.online.room && !await this.online.leave()) {
      if (!this.destroyed && this.onlineMode && this.online.error) this.showOnlineMessage(this.online.error);
      return;
    }
    if (this.destroyed) return;
    this.onlineMode = false; this.state = null; this.gameId = null; this.modal = null;
    this.screen = 'home'; this.selected = null; this.invalidate(); this.render();
  },
  onlineAvatar(profile, fallback, x, y, size) {
    const avatar = profile && profile.avatar;
    if (!avatar || avatar.type !== 'image' || !/^data:image\/(png|jpeg);base64,/.test(avatar.data) || avatar.data.length > 174800) {
      this.avatar(avatar && avatar.type === 'preset' ? avatar.index : fallback, x, y, size); return;
    }
    const key = avatar.data;
    let cached = this.avatarImages.get(key);
    if (!cached) {
      cached = { image: null }; this.avatarImages.set(key, cached);
      // At most the local preview and two members. Retire unrelated source caches.
      if (this.avatarImages.size > 3) this.avatarImages.delete(this.avatarImages.keys().next().value);
      if (this.platform.loadAvatar) this.platform.loadAvatar(key, (error, image) => {
        if (this.destroyed || this.avatarImages.get(key) !== cached) return;
        if (!error) cached.image = image;
        this.render();
      });
    }
    if (cached.image) {
      try { this.ctx.drawImage(cached.image, x, y, size, size); return; } catch (_) { cached.image = null; }
    }
    this.avatar(fallback, x, y, size);
  },
  drawOnline() {
    const w = this.width, x = 24, span = w - 48, room = this.online.room;
    let y = this.top + 20;
    this.text('好友联网 · 隔离内测', w / 2, y + 12, 19, '#d8b674', 'center', 'bold'); y += 48;
    this.text('可见时约1.5秒轮询 · 未实测低延迟', w / 2, y, 12, '#9ab4a8', 'center', 'normal', span); y += 30;
    if (room) {
      this.text('房间码 ' + room.code, w / 2, y + 24, 24, '#f2ecd9', 'center', 'bold'); y += 72;
      this.text('等待另一位玩家确认加入', w / 2, y, 15, '#f2ecd9', 'center'); y += 32;
      this.button('online-invite', '邀请微信好友', x, y, span, 44, () => {
        try { this.platform.inviteRoom(room.code); } catch (_) { this.online.error = '邀请暂不可用，可手输房间码加入'; this.render(); }
      }); y += 54;
      this.button('online-refresh', '刷新房间', x, y, span, 44, () => this.online.refresh(), { disabled: this.online.busy }); y += 56;
    } else {
      this.onlineAvatar(this.onlineProfile, 0, w / 2 - 22, y, 44); y += 54;
      this.button('online-preset', '内置形象（可直接玩）', x, y, span, 44, () => {
        this.cancelOnlineAvatar(); const a = this.onlineProfile.avatar;
        this.onlineProfile = { avatar: { type: 'preset', index: a.type === 'preset' ? (a.index + 1) % 6 : 0 } }; this.render();
      }, { disabled: this.online.busy }); y += 46;
      const half = (span - 8) / 2;
      this.button('online-album', '自选相册图片', x, y, half, 44, () => this.chooseOnlineAvatar('album'), { disabled: this.profileBusy || this.online.busy });
      this.button('online-wechat', '自愿微信头像', x + half + 8, y, half, 44, () => this.chooseOnlineAvatar('wechat'), { disabled: this.profileBusy || this.online.busy }); y += 46;
      this.button('online-avatar-cancel', '取消授权入口 / 继续用当前形象', x, y, span, 44, () => { this.cancelOnlineAvatar(); this.render(); }); y += 48;
      this.button('online-code', '加入房间码：' + (this.onlineCode || '仅加入时填写'), x, y, span, 44, () => this.inputOnlineCode(), { disabled: this.online.busy }); y += 46;
      const disabled = this.online.busy || this.profileBusy || this.online.creationUnknown || !this.online.enabled;
      this.button('online-create', '随机创建房间', x, y, half, 44, () => this.enterOnline(false), { disabled, primary: true });
      this.button('online-join', '确认加入', x + half + 8, y, half, 44, () => this.enterOnline(true), { disabled: disabled || !CODE.test(this.onlineCode) }); y += 52;
    }
    this.button('online-back', room ? '离开并关闭房间' : '返回离线玩法', x, y, span, 44, () => this.leaveOnline(), { disabled: this.online.busy }); y += 52;
    const message = this.online.error || (!this.online.enabled ? '联网未开放：尚未配置HTTPS服务' : '创建自动生成随机码；加入才需填写房间码');
    this.wrap(message, span, 12).slice(0, Math.max(1, Math.floor((this.bottom - y) / 18))).forEach((line, i) =>
      this.text(line, x, y + i * 18, 12, '#d8b674'));
  }
};
