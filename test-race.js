/**
 * 竞态修复行为验证（node 直接运行，无依赖）：
 *   node test-race.js
 *
 * 用可触发事件的最小 DOM stub 加载 ui.js，完整模拟交互闭环：
 * 1) 玩家落子 → AI 思考期间「重新开始」→ 旧 AI 任务被丢弃，新局第一手仍归玩家；
 * 2) AI 先手开关开启时，电脑先走第一步，随后轮次交还人类。
 */
'use strict';

require('./js/game.js');
require('./js/ai.js');

const G357 = globalThis.G357;
const assert = require('assert');

// ---- 可触发事件的最小 DOM stub ----
function makeClassList() {
  const set = new Set();
  return {
    add(...c) { c.forEach((x) => set.add(x)); },
    remove(...c) { c.forEach((x) => set.delete(x)); },
    toggle(c, force) {
      if (force === undefined) { set.has(c) ? set.delete(c) : set.add(c); }
      else { force ? set.add(c) : set.delete(c); }
    },
    contains(c) { return set.has(c); }
  };
}

function makeEl(tag) {
  const el = {
    tag,
    className: '',
    children: [],
    dataset: {},
    textContent: '',
    disabled: false,
    checked: false,
    _innerHTML: '',
    style: {},
    scrollTop: 0,
    scrollHeight: 0,
    _listeners: {},
    classList: makeClassList(),
    get innerHTML() { return this._innerHTML; },
    set innerHTML(v) { this._innerHTML = v; if (v === '') this.children = []; },
    addEventListener(type, fn) { (this._listeners[type] = this._listeners[type] || []).push(fn); },
    dispatch(type, ev) { (this._listeners[type] || []).forEach((fn) => fn(ev || {})); },
    appendChild(c) { this.children.push(c); c.parentEl = this; },
    remove() { if (this.parentEl) { const i = this.parentEl.children.indexOf(this); if (i >= 0) this.parentEl.children.splice(i, 1); } },
    querySelectorAll(sel) {
      const out = [];
      (function walk(el) {
        el.children.forEach((c) => {
          const cls = c.className || '';
          if (sel === '.die' && cls.split(/\s+/).includes('die')) out.push(c);
          if (sel === '.row' && cls.split(/\s+/).includes('row')) out.push(c);
          walk(c);
        });
      })(el);
      return out;
    },
    querySelector(sel) {
      const want = sel.replace('.', '');
      let found = null;
      (function walk(el) {
        el.children.forEach((c) => {
          if (found) return;
          if ((c.className || '').split(/\s+/).includes(want)) { found = c; return; }
          walk(c);
        });
      })(el);
      return found;
    },
    closest(sel) {
      const want = sel.replace('.', '');
      let cur = this;
      while (cur) {
        if ((cur.className || '').split(/\s+/).includes(want)) return cur;
        cur = cur.parentEl;
      }
      return null;
    }
  };
  return el;
}

const elCache = {};
const doc = {
  getElementById(id) {
    if (!elCache[id]) elCache[id] = makeEl('div');
    return elCache[id];
  },
  createElement(tag) { return makeEl(tag); }
};
globalThis.document = doc;

// ---- 加载 ui.js ----
require('./js/ui.js');

const board = doc.getElementById('board');
const btnConfirm = doc.getElementById('btn-confirm');
const btnReset = doc.getElementById('btn-reset');
const btnHint = doc.getElementById('btn-hint');
const modePvp = doc.getElementById('mode-pvp');
const modeAi = doc.getElementById('mode-ai');
const aiFirst = doc.getElementById('ai-first');
const aiFirstToggle = doc.getElementById('ai-first-toggle');
const turnText = doc.getElementById('turn-text');
const overlay = doc.getElementById('overlay');

function getPiles() {
  const out = [0, 0, 0];
  board.querySelectorAll('.die').forEach((d) => { out[Number(d.dataset.row)] += 1; });
  return out;
}
function click(el, target) { el.dispatch('click', { target: target || el }); }
function clickDie(row, index) {
  const dies = board.querySelectorAll('.die');
  const d = dies.find((x) => Number(x.dataset.row) === row && Number(x.dataset.index) === index);
  assert.ok(d, `row${row} 应存在第 ${index} 颗骰子`);
  click(board, d);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  // ===== 场景 1：竞态（AI 思考期间重新开始） =====
  click(modeAi); // 切到 AI 模式 → startNewGame
  assert.ok(!aiFirstToggle.classList.contains('hidden'), 'AI 模式下先手开关可见');
  assert.deepStrictEqual(getPiles(), [3, 5, 7], '新局初始局面');

  // 玩家落子：第 3 排拿 1 颗
  clickDie(2, 0);
  assert.strictEqual(btnConfirm.disabled, false, '选中后可确认');
  click(btnConfirm); // 触发 takeDice：320ms 动画 → 落子 → AI 思考 750ms

  await sleep(600); // 已过动画期，玩家落子完成，AI 正在思考

  // AI 思考期间点「重新开始」
  click(btnReset);
  assert.deepStrictEqual(getPiles(), [3, 5, 7], '重置后恢复初始局面');
  assert.ok(turnText.textContent.includes('你'), `新局轮次应归玩家，实际: ${turnText.textContent}`);

  await sleep(1200); // 越过旧 AI 思考窗口（750ms）——若未修复，AI 会抢走新局第一手

  assert.deepStrictEqual(getPiles(), [3, 5, 7], '旧 AI 任务不得在新局落子（竞态已修复）');
  assert.ok(turnText.textContent.includes('你'), `新局第一手仍归玩家，实际: ${turnText.textContent}`);
  clickDie(0, 0);
  assert.strictEqual(btnConfirm.disabled, false, '新局玩家可正常操作');
  assert.ok(overlay.classList.contains('hidden'), '新局未结束（胜负横幅隐藏）');

  // ===== 场景 2：AI 先手 =====
  aiFirst.checked = true;
  click(modeAi); // 重开 AI 模式新局（保留勾选）
  assert.deepStrictEqual(getPiles(), [3, 5, 7], 'AI 先手开局初始局面');

  await sleep(1400); // 电脑思考 750ms + 动画 320ms 后完成第一手

  const piles2 = getPiles();
  assert.notDeepStrictEqual(piles2, [3, 5, 7], '电脑已先走第一步');
  assert.ok(turnText.textContent.includes('你'), `电脑走后轮次归玩家，实际: ${turnText.textContent}`);
  clickDie(0, 0);
  assert.strictEqual(btnConfirm.disabled, false, '轮到人类时可操作');
  // 电脑第一手应为最优：3 颗那排拿 1 颗 → [2,5,7]
  assert.deepStrictEqual(piles2, [2, 5, 7], '电脑首手应为最优 {row:0,count:1}');

  // ===== 场景 3：AI 先手对局中重置 =====
  click(btnReset);
  assert.deepStrictEqual(getPiles(), [3, 5, 7], '重置后回到初始局面');
  await sleep(1400);
  assert.notDeepStrictEqual(getPiles(), [3, 5, 7], 'AI 先手勾选下，重置后电脑再次先走');
  assert.ok(turnText.textContent.includes('你'), '电脑走后轮次归玩家');

  // ===== 场景 4：动画窗口内（确认后 <320ms）重置 =====
  aiFirst.checked = false; // 关掉先手，纯人类 vs AI
  click(modeAi);
  assert.deepStrictEqual(getPiles(), [3, 5, 7], '动画窗口场景初始局面');
  clickDie(2, 0);
  click(btnConfirm); // takeDice 进入 320ms 动画
  await sleep(80);   // 动画尚未完成
  click(btnReset);   // 动画窗口内重置
  assert.deepStrictEqual(getPiles(), [3, 5, 7], '动画期内重置后不落旧子');
  await sleep(800);  // 越过动画 + AI 思考窗口
  assert.deepStrictEqual(getPiles(), [3, 5, 7], '动画期旧任务不得污染新局（第一个 token 守卫生效）');
  assert.ok(turnText.textContent.includes('你'), '新局轮次归玩家');

  // ===== 场景 5：AI 思考期间切换到双人模式 =====
  click(modeAi);
  assert.deepStrictEqual(getPiles(), [3, 5, 7], '切模式场景初始局面');
  clickDie(1, 0);
  click(btnConfirm); // 玩家落子 → AI 思考 750ms
  await sleep(600);  // 玩家落子完成，AI 思考中
  click(modePvp);    // 切到双人模式 → setMode → startNewGame（gameToken+1）
  assert.deepStrictEqual(getPiles(), [3, 5, 7], '切模式后新局初始局面');
  assert.ok(!turnText.textContent.includes('电脑'), `双人模式轮次文案不含电脑，实际: ${turnText.textContent}`);
  await sleep(1200); // 越过旧 AI 思考窗口
  assert.deepStrictEqual(getPiles(), [3, 5, 7], '旧 AI 任务不得在新模式落子');
  clickDie(0, 0);
  assert.strictEqual(btnConfirm.disabled, false, '双人模式玩家 1 可操作');

  console.log('✅ 竞态修复行为验证通过（旧 AI 任务丢弃 / AI 先手 / 重置联动 / 动画窗重置 / 切模式）');
}

main().catch((e) => { console.error('FAIL:', e.stack || e.message); process.exit(1); });
