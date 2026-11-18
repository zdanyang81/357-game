'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { execFileSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');

test('generated preview boots the actual UI and online modules at high DPI', () => {
  const output = execFileSync(process.execPath, ['scripts/preview-minigame.js', '375', '812', 'home'], { cwd: root, encoding: 'utf8' }).trim();
  const html = fs.readFileSync(output, 'utf8');
  const source = html.match(/<script>([\s\S]*)<\/script>/)[1];
  const labels = [], scales = [];
  const context = new Proxy({
    measureText: text => ({ width: String(text).length * 14 }),
    createLinearGradient: () => ({ addColorStop() {} }),
    fillText: text => labels.push(text),
    scale: (...args) => scales.push(args)
  }, { get: (obj, key) => key in obj ? obj[key] : () => {} });
  const canvas = () => ({ style: {}, getContext: () => context, addEventListener() {} });
  const main = canvas();
  const window = { devicePixelRatio: 3 };
  vm.runInNewContext(source, {
    window, document: { getElementById: () => main, createElement: canvas, addEventListener() {} },
    performance: { now: () => 0 }, setTimeout, clearTimeout,
    requestAnimationFrame: () => 1, cancelAnimationFrame() {}
  });
  assert.ok(window.ui, 'missing dependency must fail instead of producing a blank screenshot');
  assert.equal(main.width, 1125); assert.equal(main.height, 2436);
  assert.equal(main.style.width, '375px'); assert.equal(main.style.height, '812px');
  assert.deepEqual(scales[0], [3, 3]);
  assert.ok(labels.includes('357取骰'));
  assert.ok(labels.includes('好友联网'));
  window.ui.destroy();
});

test('web title and visible heading match the filing name', () => {
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  assert.match(html, /<title>357取骰<\/title>/);
  assert.match(html, /<h1 class="title">357取骰<\/h1>/);
});
