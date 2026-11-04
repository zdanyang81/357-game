'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('357 targets the registered game account without disabling URL checks', () => {
  const config = JSON.parse(fs.readFileSync(path.join(__dirname, '../project.config.json'), 'utf8'));
  assert.equal(config.appid, 'wx46a3b29052435339');
  assert.equal(config.compileType, 'game');
  assert.equal(config.miniprogramRoot, 'minigame/');
  assert.equal(config.setting.urlCheck, true);
});
