'use strict';
const { createPlatform } = require('./platform');
const GameUI = require('./ui');
const platform = createPlatform(wx);
const ui = new GameUI(platform);
// A development-only reference; no data is sent off device.
GameGlobal.game357 = { ui, destroy() { ui.destroy(); platform.destroy(); } };
