'use strict';
const { createPlatform } = require('./platform');
const GameUI = require('./ui');
const platform = createPlatform(wx);
const ui = new GameUI(platform);
// Development-only inspection reference. Online mode sends only explicitly confirmed room data.
GameGlobal.game357 = { ui, destroy() { ui.destroy(); platform.destroy(); } };
