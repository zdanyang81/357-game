'use strict';
const { OnlineSession, inviteCode, normalizeCode, codeIssue, CODE, LEGACY_ALPHABET } = require('./online');
const config = require('./online-config');
module.exports = {
  initOnline() {
    this.onlineMode = false; this.onlineCode = ''; this.codePad = false; this.codeLegacy = false; this.codePadPage = 0; this.profileGeneration = 0; this.avatarOperation = null;
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
      const deadline = typeof room.turnDeadline === 'number' ? room.turnDeadline : null;
      if (room.status === 'playing' && deadline !== this.seenTurnDeadline) {
        this.seenTurnDeadline = deadline;
        this.armTurnClock();
      }
      if (room.status !== 'playing') {
        this.seenTurnDeadline = null;
        this.turnClockToken = (this.turnClockToken || 0) + 1;
      }
    } else {
      // Retire the result view before its authoritative game state disappears.
      if (this.modal && this.modal.type === 'online-result') this.modal = null;
      this.seenTurnDeadline = null;
      this.turnClockToken = (this.turnClockToken || 0) + 1;
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
      this.online.error = '系统输入不可用，请用屏幕数字键逐位输入';
      this.render();
    }
  },
  openCodePad() {
    if (this.online.room || this.online.busy || this.profileBusy) return;
    this.cancelOnlineAvatar();
    this.codePad = true; this.online.error = ''; this.render();
  },
  appendRoomCode(char) {
    const limit = this.codeLegacy ? 8 : 4;
    const allowed = this.codeLegacy ? LEGACY_ALPHABET : '0123456789';
    if (this.online.busy || this.onlineCode.length >= limit || !allowed.includes(char)) return;
    this.onlineCode += char; this.online.error = ''; this.render();
  },
  editRoomCode(mode) {
    if (this.online.busy) return;
    this.onlineCode = mode === 'clear' ? '' : this.onlineCode.slice(0, -1);
    this.online.error = ''; this.render();
  },
  async copyOnlineCode() {
    const code = this.online.room && this.online.room.code;
    try {
      await this.platform.copyRoomCode(code);
      if (this.destroyed || !this.onlineMode) return;
      this.online.error = '房间码已复制。发给另一位已打开本游戏的微信，让对方逐位输入。不是微信号或手机号。';
    } catch (_) {
      if (this.destroyed || !this.onlineMode) return;
      this.online.error = '复制不可用。请按格子逐位核对。数字是画出来的，不会消失。';
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
  // Drawn segments, not font glyphs. WeChat canvas fonts can omit digits while letters remain.
  drawDigit(digit, x, y, w, h) {
    const c = this.ctx, on = '#f2ecd9', t = Math.max(4, Math.min(w, h) * 0.16);
    const seg = (sx, sy, sw, sh) => { c.fillStyle = on; c.fillRect(sx, sy, sw, sh); };
    const mask = [0x3f, 0x06, 0x5b, 0x4f, 0x66, 0x6d, 0x7d, 0x07, 0x7f, 0x6f][digit] || 0;
    const x1 = x + 2, x2 = x + w - t - 2, y1 = y + 2, y2 = y + h / 2 - t / 2, y3 = y + h - t - 2;
    const horiz = yb => seg(x1 + t, yb, Math.max(1, w - t * 2 - 4), t);
    const vert = (xb, yb) => seg(xb, yb, t, Math.max(1, h / 2 - t - 4));
    if (mask & 0x01) horiz(y1);
    if (mask & 0x02) vert(x2, y1 + t);
    if (mask & 0x04) vert(x2, y2 + t);
    if (mask & 0x08) horiz(y3);
    if (mask & 0x10) vert(x1, y2 + t);
    if (mask & 0x20) vert(x1, y1 + t);
    if (mask & 0x40) horiz(y2);
  },
  drawCodeSlots(code, x, y, span, h, slots) {
    const count = slots || Math.max(code.length, 4), gap = count > 4 ? 3 : 8;
    const cell = (span - gap * (count - 1)) / count;
    for (let i = 0; i < count; i++) {
      const cx = x + i * (cell + gap);
      this.panel(cx, y, cell, h, '#183a2d', i < code.length ? '#d8b674' : '#385743', 6);
      const ch = code[i] || '';
      if (ch) this.text(ch, cx + cell / 2, y + h / 2, Math.min(22, cell * 0.62), '#f2ecd9', 'center', 'bold');
    }
  },
  drawCodePad() {
    const w = this.width, x = 24, span = w - 48, gap = 6, half = (span - 8) / 2;
    let y = this.top + 6;
    this.text(this.codeLegacy ? '输入8位旧房间码' : '输入4位房间码', w / 2, y + 8, 16, '#d8b674', 'center', 'bold'); y += 24;
    this.drawCodeSlots(this.onlineCode, x, y, span, this.codeLegacy ? 40 : 52, this.codeLegacy ? 8 : 4); y += this.codeLegacy ? 46 : 58;
    const limit = this.codeLegacy ? 8 : 4;
    if (this.codeLegacy) {
      const cols = 4, keyH = 44, keyW = (span - gap * (cols - 1)) / cols;
      const keys = [...LEGACY_ALPHABET].slice(this.codePadPage ? 16 : 0, this.codePadPage ? 32 : 16);
      keys.forEach((ch, i) => {
        const col = i % cols, row = Math.floor(i / cols);
        this.button('code-key-' + ch, ch, x + col * (keyW + gap), y + row * (keyH + gap), keyW, keyH,
          () => this.appendRoomCode(ch), { disabled: this.online.busy || this.onlineCode.length >= limit, size: 18 });
      });
      y += 4 * keyH + 3 * gap + 6;
    } else {
      const cols = 5, keyH = 44, keyW = (span - gap * (cols - 1)) / cols;
      '0123456789'.split('').forEach((ch, i) => {
        const col = i % cols, row = Math.floor(i / cols);
        this.button('code-key-' + ch, ch, x + col * (keyW + gap), y + row * (keyH + gap), keyW, keyH,
          () => this.appendRoomCode(ch), { disabled: this.online.busy || this.onlineCode.length >= limit, size: 20 });
      });
      y += 2 * keyH + gap + 6;
    }
    const third = (span - gap * 2) / 3;
    this.button('code-delete', '退格', x, y, third, 44, () => this.editRoomCode('delete'), { disabled: !this.onlineCode, size: 14 });
    this.button('code-clear', '清空', x + third + gap, y, third, 44, () => this.editRoomCode('clear'), { disabled: !this.onlineCode, size: 14 });
    this.button(this.codeLegacy ? 'code-page' : 'code-system', this.codeLegacy ? (this.codePadPage ? '前半' : '后半') : '键盘',
      x + (third + gap) * 2, y, third, 44, () => {
        if (this.codeLegacy) { this.codePadPage = this.codePadPage ? 0 : 1; this.render(); }
        else this.inputOnlineCode();
      }, { disabled: !this.codeLegacy && this.online.busy, size: 14 });
    y += 50;
    const ready = CODE.test(this.onlineCode) && this.online.enabled && !this.online.busy && !this.online.creationUnknown && !this.profileBusy;
    this.button('online-join', '确认加入', x, y, span, 44, () => this.enterOnline(true), { disabled: !ready, primary: true }); y += 50;
    this.button('code-pad-back', '返回', x, y, half, 44, () => { this.codePad = false; this.render(); });
    this.button('code-mode', this.codeLegacy ? '改输4位' : '8位旧码', x + half + 8, y, half, 44, () => {
      this.codeLegacy = !this.codeLegacy; this.codePadPage = 0; this.onlineCode = ''; this.online.error = ''; this.render();
    }, { size: 14 });
    y += 48;
    const message = this.online.error || codeIssue(this.onlineCode) ||
      (this.codeLegacy ? '旧码8位，不含I/O和0/1。不是微信号。' : '新房间是4位数字。不是手机号，也不是微信号。');
    this.wrap(message, span, 12).slice(0, Math.max(1, Math.floor((this.bottom - y) / 18))).forEach((line, i) =>
      this.text(line, x, y + i * 18, 12, '#d8b674'));
  },
  drawOnline() {
    if (!this.online.room && this.codePad) { this.drawCodePad(); return; }
    const w = this.width, x = 24, span = w - 48, room = this.online.room, half = (span - 8) / 2;
    let y = this.top + 12;
    this.text('好友联网', w / 2, y + 10, 19, '#d8b674', 'center', 'bold'); y += 32;
    if (room) {
      const slots = room.code.length, slotH = slots > 4 ? 46 : 64;
      this.drawCodeSlots(room.code, x, y, span, slotH, slots); y += slotH + 8;
      this.text(slots > 4 ? '对方点「8位旧码」逐位输入' : '对方输入这4位数字', w / 2, y, 13, '#f2ecd9', 'center', 'normal', span); y += 22;
      this.button('online-invite', '邀请微信好友', x, y, span, 44, () => {
        try { this.platform.inviteRoom(room.code); } catch (_) { this.online.error = '微信分享发不出去。请复制房间码，让对方逐位输入。'; this.render(); }
      }); y += 52;
      this.button('online-copy', '复制房间码', x, y, half, 44, () => this.copyOnlineCode(), { disabled: this.online.busy });
      this.button('online-refresh', '刷新房间', x + half + 8, y, half, 44, () => this.online.refresh(), { disabled: this.online.busy }); y += 52;
    } else {
      this.onlineAvatar(this.onlineProfile, 0, w / 2 - 22, y, 44); y += 50;
      this.button('online-preset', '内置形象（可直接玩）', x, y, span, 44, () => {
        this.cancelOnlineAvatar(); const a = this.onlineProfile.avatar;
        this.onlineProfile = { avatar: { type: 'preset', index: a.type === 'preset' ? (a.index + 1) % 6 : 0 } }; this.render();
      }, { disabled: this.online.busy }); y += 46;
      this.button('online-album', '自选相册图片', x, y, half, 44, () => this.chooseOnlineAvatar('album'), { disabled: this.profileBusy || this.online.busy });
      this.button('online-wechat', '自愿微信头像', x + half + 8, y, half, 44, () => this.chooseOnlineAvatar('wechat'), { disabled: this.profileBusy || this.online.busy }); y += 46;
      this.button('online-avatar-cancel', '取消授权入口 / 继续用当前形象', x, y, span, 44, () => { this.cancelOnlineAvatar(); this.render(); }); y += 46;
      this.button('online-code', '输入4位房间码', x, y, span, 44, () => this.openCodePad(), { disabled: this.online.busy }); y += 46;
      const disabled = this.online.busy || this.profileBusy || this.online.creationUnknown || !this.online.enabled;
      this.button('online-create', '随机创建房间', x, y, span, 44, () => this.enterOnline(false), { disabled, primary: true }); y += 52;
    }
    this.button('online-back', room ? '离开并关闭房间' : '返回离线玩法', x, y, span, 44, () => this.leaveOnline(), { disabled: this.online.busy }); y += 48;
    const issue = this.onlineCode && !CODE.test(this.onlineCode) ? codeIssue(this.onlineCode) : '';
    const message = issue || this.online.error || (!this.online.enabled ? '联网未开放：尚未配置HTTPS服务' :
      room ? (room.code.length > 4 ? '分享发不出去时，复制这8位。数字是画出来的。不是微信号或手机号。' :
        '这是4位房间码，不是微信号或手机号。分享发不出去时，复制数字让对方逐位输入。') :
      '两个微信都打开本游戏。创建后把房间码发给对方。不能用微信号或手机号查找。');
    this.wrap(message, span, 12).slice(0, Math.max(1, Math.floor((this.bottom - y) / 18))).forEach((line, i) =>
      this.text(line, x, y + i * 18, 12, '#d8b674'));
  }
};
