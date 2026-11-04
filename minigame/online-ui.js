'use strict';
const { OnlineSession, inviteCode, normalizeCode, codeIssue, CODE, ALPHABET } = require('./online');
const config = require('./online-config');
module.exports = {
  initOnline() {
    this.onlineMode = false; this.onlineCode = ''; this.codePad = false; this.codePadPage = 0;
    this.profileGeneration = 0; this.avatarOperation = null;
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
    this.invalidate(); this.modal = null; this.onlineMode = true; this.codePad = false;
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
    if (join && !CODE.test(this.onlineCode)) { this.showOnlineMessage(codeIssue(this.onlineCode)); return; }
    this.codePad = false;
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
      this.onlineCode = normalizeCode(result);
      this.online.error = codeIssue(this.onlineCode);
      this.render();
    } catch (_) {
      this.codePad = true;
      this.online.error = '系统输入不可用，请用屏幕键盘逐位输入';
      this.render();
    }
  },
  openCodePad() {
    if (this.online.room || this.online.busy || this.profileBusy) return;
    this.cancelOnlineAvatar();
    this.codePad = true; this.online.error = ''; this.render();
  },
  appendRoomCode(char) {
    if (this.online.busy || this.onlineCode.length >= 8 || !ALPHABET.includes(char)) return;
    this.onlineCode += char; this.online.error = ''; this.render();
  },
  editRoomCode(mode) {
    if (this.online.busy) return;
    if (mode === 'clear') this.onlineCode = '';
    else this.onlineCode = this.onlineCode.slice(0, -1);
    this.online.error = ''; this.render();
  },
  async copyOnlineCode() {
    const code = this.online.room && this.online.room.code;
    try {
      await this.platform.copyRoomCode(code);
      if (this.destroyed || !this.onlineMode) return;
      this.online.error = '房间码已复制。发给另一位已打开本游戏的微信，让对方逐位输入。';
    } catch (_) {
      if (this.destroyed || !this.onlineMode) return;
      this.online.error = '复制不可用。请按格子里的8位逐字核对，对方用屏幕键盘点入。';
    }
    this.render();
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
    this.onlineMode = false; this.codePad = false; this.state = null; this.gameId = null; this.modal = null;
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
  drawCodeSlots(code, x, y, span, h) {
    const gap = 4, cell = (span - gap * 7) / 8;
    for (let i = 0; i < 8; i++) {
      const cx = x + i * (cell + gap);
      this.panel(cx, y, cell, h, '#183a2d', i < code.length ? '#d8b674' : '#385743', 8);
      if (code[i]) this.text(code[i], cx + cell / 2, y + h / 2, Math.min(20, cell * 0.62), '#f2ecd9', 'center', 'bold');
    }
  },
  drawCodePad() {
    const w = this.width, x = 24, span = w - 48, gap = 6;
    let y = this.top + 8;
    this.text('输入房间码', w / 2, y + 10, 18, '#d8b674', 'center', 'bold'); y += 28;
    this.drawCodeSlots(this.onlineCode, x, y, span, 40); y += 48;
    const cols = 4, keyH = 44, keyW = (span - gap * (cols - 1)) / cols;
    const keys = [...ALPHABET].slice(this.codePadPage ? 16 : 0, this.codePadPage ? 32 : 16);
    keys.forEach((ch, i) => {
      const col = i % cols, row = Math.floor(i / cols);
      this.button('code-key-' + ch, ch, x + col * (keyW + gap), y + row * (keyH + gap), keyW, keyH,
        () => this.appendRoomCode(ch), { disabled: this.online.busy || this.onlineCode.length >= 8, size: 16 });
    });
    y += 4 * keyH + 3 * gap + 8;
    const quarter = (span - gap * 3) / 4;
    this.button('code-delete', '退格', x, y, quarter, 44, () => this.editRoomCode('delete'), { disabled: !this.onlineCode, size: 13 });
    this.button('code-clear', '清空', x + quarter + gap, y, quarter, 44, () => this.editRoomCode('clear'), { disabled: !this.onlineCode, size: 13 });
    this.button('code-page', this.codePadPage ? '前半' : '后半', x + (quarter + gap) * 2, y, quarter, 44,
      () => { this.codePadPage = this.codePadPage ? 0 : 1; this.render(); }, { size: 13 });
    this.button('code-system', '键盘', x + (quarter + gap) * 3, y, quarter, 44, () => this.inputOnlineCode(), { disabled: this.online.busy, size: 13 });
    y += 52;
    const ready = CODE.test(this.onlineCode) && this.online.enabled && !this.online.busy && !this.online.creationUnknown && !this.profileBusy;
    this.button('online-join', '确认加入', x, y, span, 44, () => this.enterOnline(true), { disabled: !ready, primary: true }); y += 52;
    this.button('code-pad-back', '返回大厅', x, y, span, 44, () => { this.codePad = false; this.render(); }); y += 48;
    const message = this.online.error || codeIssue(this.onlineCode) || '只使用这些字符。没有字母I/O，也没有数字0/1。';
    this.wrap(message, span, 12).slice(0, Math.max(1, Math.floor((this.bottom - y) / 18))).forEach((line, i) =>
      this.text(line, x, y + i * 18, 12, '#d8b674'));
  },
  drawOnline() {
    if (!this.online.room && this.codePad) { this.drawCodePad(); return; }
    const w = this.width, x = 24, span = w - 48, room = this.online.room, half = (span - 8) / 2;
    let y = this.top + 16;
    this.text('好友联网', w / 2, y + 10, 19, '#d8b674', 'center', 'bold'); y += 36;
    if (room) {
      this.drawCodeSlots(room.code, x, y, span, 44); y += 52;
      this.text('发给另一位已打开本游戏的微信', w / 2, y, 13, '#f2ecd9', 'center', 'normal', span); y += 28;
      this.button('online-invite', '邀请微信好友', x, y, span, 44, () => {
        try { this.platform.inviteRoom(room.code); } catch (_) { this.online.error = '邀请暂不可用，可复制房间码让对方逐位输入'; this.render(); }
      }); y += 52;
      this.button('online-copy', '复制房间码', x, y, half, 44, () => this.copyOnlineCode(), { disabled: this.online.busy });
      this.button('online-refresh', '刷新房间', x + half + 8, y, half, 44, () => this.online.refresh(), { disabled: this.online.busy }); y += 52;
    } else {
      this.onlineAvatar(this.onlineProfile, 0, w / 2 - 22, y, 44); y += 54;
      this.button('online-preset', '内置形象（可直接玩）', x, y, span, 44, () => {
        this.cancelOnlineAvatar(); const a = this.onlineProfile.avatar;
        this.onlineProfile = { avatar: { type: 'preset', index: a.type === 'preset' ? (a.index + 1) % 6 : 0 } }; this.render();
      }, { disabled: this.online.busy }); y += 46;
      this.button('online-album', '自选相册图片', x, y, half, 44, () => this.chooseOnlineAvatar('album'), { disabled: this.profileBusy || this.online.busy });
      this.button('online-wechat', '自愿微信头像', x + half + 8, y, half, 44, () => this.chooseOnlineAvatar('wechat'), { disabled: this.profileBusy || this.online.busy }); y += 46;
      this.button('online-avatar-cancel', '取消授权入口 / 继续用当前形象', x, y, span, 44, () => { this.cancelOnlineAvatar(); this.render(); }); y += 48;
      this.button('online-code', this.onlineCode ? '修改房间码 ' + this.onlineCode : '输入房间码加入', x, y, span, 44, () => this.openCodePad(), { disabled: this.online.busy }); y += 46;
      const disabled = this.online.busy || this.profileBusy || this.online.creationUnknown || !this.online.enabled;
      this.button('online-create', '随机创建房间', x, y, half, 44, () => this.enterOnline(false), { disabled, primary: true });
      this.button('online-join', '确认加入', x + half + 8, y, half, 44, () => this.enterOnline(true), { disabled: disabled || !CODE.test(this.onlineCode) }); y += 52;
    }
    this.button('online-back', room ? '离开并关闭房间' : '返回离线玩法', x, y, span, 44, () => this.leaveOnline(), { disabled: this.online.busy }); y += 52;
    const issue = this.onlineCode && !CODE.test(this.onlineCode) ? codeIssue(this.onlineCode) : '';
    const message = issue || this.online.error || (!this.online.enabled ? '联网未开放：尚未配置HTTPS服务' :
      room ? '不能用微信号或手机号查找。对方须打开同一游戏，再输入这8位房间码。' : '两个微信都打开本游戏。创建后把房间码发给对方，对方逐位输入再确认加入。');
    this.wrap(message, span, 12).slice(0, Math.max(1, Math.floor((this.bottom - y) / 18))).forEach((line, i) =>
      this.text(line, x, y + i * 18, 12, '#d8b674'));
  }
};
