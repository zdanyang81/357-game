'use strict';
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const config = JSON.parse(fs.readFileSync(path.join(root, 'project.config.json'), 'utf8'));
assert.equal(config.compileType, 'minigame');
assert.equal(config.miniprogramRoot, 'minigame/');
const privatePath = path.join(root, 'project.private.config.json');
const local = fs.existsSync(privatePath) ? JSON.parse(fs.readFileSync(privatePath, 'utf8')) : {};
const effectiveAppId = local.appid || config.appid;
const game = JSON.parse(fs.readFileSync(path.join(root, 'minigame/game.json'), 'utf8'));
assert.equal(game.deviceOrientation, 'portrait');
let size = 0; let files = 0;
function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(file);
    else {
      assert(!/\.(apk|keystore|pem|key|html)$/i.test(entry.name), 'Unexpected runtime payload: ' + file);
      size += fs.statSync(file).size; files++;
      if (entry.name.endsWith('.js')) {
        const source = fs.readFileSync(file, 'utf8');
        assert(!/\b(document|localStorage)\s*\./.test(source), 'Browser-only API: ' + file);
        assert(!/\beval\s*\(/.test(source), 'Dynamic code execution: ' + file);
        assert(!/\bwx\.(request|connectSocket|login|getUserProfile)\s*\(/.test(source), 'Unexpected network/identity dependency: ' + file);
      }
    }
  }
}
walk(path.join(root, 'minigame'));
assert(size < 2 * 1024 * 1024, 'Exceeded our conservative 2 MiB development budget');
console.log(`Package preflight passed: ${files} files, ${size} bytes (own budget 2 MiB, not platform certification)`);
if (effectiveAppId === 'touristappid') console.log('NOT RELEASE READY: real game AppID, platform qualifications, and WeChat device acceptance still required.');
if (process.argv.includes('--release')) {
  assert(/^wx[a-f0-9]{16}$/.test(effectiveAppId), 'Real WeChat AppID required; no upload attempted');
  console.log('AppID syntax only checked; ownership and publish eligibility are not verified.');
}
