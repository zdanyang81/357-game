'use strict';
require('./js/game.js');
require('./js/ai.js');
const assert = require('assert');

function makeClassList() {
  const set = new Set();
  return {
    add(...c) { c.forEach((x) => set.add(x)); },
    remove(...c) { c.forEach((x) => set.delete(x)); },
    toggle(c, force) { force === undefined ? (set.has(c) ? set.delete(c) : set.add(c)) : (force ? set.add(c) : set.delete(c)); },
    contains(c) { return set.has(c); }
  };
}
function makeEl(tag) {
  const el = {
    tag, className: '', children: [], dataset: {}, textContent: '', disabled: false,
    checked: false, _innerHTML: '', style: {}, scrollTop: 0, scrollHeight: 0, _listeners: {},
    classList: makeClassList(),
    get innerHTML() { return this._innerHTML; },
    set innerHTML(v) {
      this._innerHTML = v;
      // 模拟浏览器：innerHTML 设置后 textContent 反映解析后的纯文本
      this.textContent = String(v).replace(/<[^>]*>/g, '');
      if (v === '') this.children = [];
    },
    addEventListener(type, fn) { (this._listeners[type] = this._listeners[type] || []).push(fn); },
    dispatch(type, ev) { (this._listeners[type] || []).forEach((fn) => fn(ev || {})); },
    setAttribute(k, v) { this.dataset[k] = String(v); },
    getAttribute(k) { return this.dataset[k] !== undefined ? this.dataset[k] : null; },
    appendChild(c) { this.children.push(c); c.parentEl = this; },
    remove() { if (this.parentEl) { const i = this.parentEl.children.indexOf(this); if (i >= 0) this.parentEl.children.splice(i, 1); } },
    querySelectorAll(sel) {
      const out = [];
      (function walk(el) {
        el.children.forEach((c) => {
          const cls = c.className || '';
          if (sel === '.die' && cls.split(/\s+/).includes('die')) out.push(c);
          if (sel === '.row' && cls.split(/\s+/).includes('row')) out.push(c);
          if (sel === '.avatar-btn' && cls.split(/\s+/).includes('avatar-btn')) out.push(c);
          if (sel === '.log-empty' && cls.split(/\s+/).includes('log-empty')) out.push(c);
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
      while (cur) { if ((cur.className || '').split(/\s+/).includes(want)) return cur; cur = cur.parentEl; }
      return null;
    }
  };
  return el;
}
const elCache = {};
const doc = { getElementById(id) { if (!elCache[id]) elCache[id] = makeEl('div'); return elCache[id]; }, createElement(t) { return makeEl(t); } };
globalThis.document = doc;
require('./js/ui.js');

const modePvp = doc.getElementById('mode-pvp');
const modeAi = doc.getElementById('mode-ai');
const avatarP1Side = doc.getElementById('avatar-p1-side');
const avatarP2Side = doc.getElementById('avatar-p2-side');
const avatarP1 = doc.getElementById('avatar-p1');
const avatarP2 = doc.getElementById('avatar-p2');
const turnText = doc.getElementById('turn-text');
const board = doc.getElementById('board');
const btnConfirm = doc.getElementById('btn-confirm');
const logList = doc.getElementById('log-list');
// 不再模拟初始 hidden：ui.js 启动时按 game.mode（默认 PvP）决定显隐

function avButtons(box) { return box.querySelectorAll('.avatar-btn'); }
function isActive(box, i) { return (avButtons(box)[i].className || '').split(/\s+/).includes('active'); }
function clickBtn(box, i) { avButtons(box)[i].dispatch('click'); }
// 递归收集元素文本（stub 的 textContent 不聚合子节点，真实浏览器会）
function textOf(el) {
  return (el.children || []).reduce((s, c) => s + (c.textContent || '') + textOf(c), '');
}
function clickDie(row, index) {
  const d = board.querySelectorAll('.die').find((x) => Number(x.dataset.row) === row && Number(x.dataset.index) === index);
  assert.ok(d, `row${row} 应存在第 ${index} 颗骰子`);
  board.dispatch('click', { target: d });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  // ---- 1. 面板显隐（左右两侧同步） ----
  const sideHidden = () => avatarP1Side.classList.contains('hidden') && avatarP2Side.classList.contains('hidden');
  const sideShown = () => !avatarP1Side.classList.contains('hidden') && !avatarP2Side.classList.contains('hidden');
  assert.ok(sideShown(), '默认 PvP 模式首屏形象面板即显示（两侧）');
  modePvp.dispatch('click');
  assert.ok(sideShown(), '切 PvP 后形象面板显示');
  modeAi.dispatch('click');
  assert.ok(sideHidden(), '切 AI 后形象面板隐藏（两侧）');
  modePvp.dispatch('click');

  // ---- 2. 默认选择：玩家一=0 玩家二=3 ----
  assert.strictEqual(avButtons(avatarP1).length, 6, '玩家一有 6 个候选');
  assert.strictEqual(avButtons(avatarP2).length, 6, '玩家二有 6 个候选');
  // 选择面板渲染卡通头像 <img>（不再是 emoji 文本）
  assert.ok(avButtons(avatarP1)[0].innerHTML.includes('avatar-0.svg'), '选择面板按钮渲染 SVG 头像');
  assert.ok(avButtons(avatarP1)[0].innerHTML.includes('<img'), '选择面板按钮含 <img>');
  assert.ok(avButtons(avatarP1)[0].innerHTML.includes('商务男'), 'img alt 带具体形象名');
  assert.ok(isActive(avatarP1, 0), '玩家一默认选中 0');
  assert.ok(isActive(avatarP2, 3), '玩家二默认选中 3');
  assert.ok(turnText.innerHTML.includes('avatar-0.svg'), `当前轮次(玩家1)显示其卡通形象: ${turnText.innerHTML}`);

  // ---- 3. 冲突拦截 ----
  assert.strictEqual(avButtons(avatarP1)[3].disabled, true, '玩家一不能选玩家二已占用形象(3)');
  assert.strictEqual(avButtons(avatarP2)[0].disabled, true, '玩家二不能选玩家一已占用形象(0)');
  clickBtn(avatarP1, 1);
  assert.ok(isActive(avatarP1, 1), '玩家一改选成功');
  assert.strictEqual(avButtons(avatarP1)[3].disabled, true, '玩家一仍不能占用玩家二形象');
  assert.strictEqual(avButtons(avatarP2)[1].disabled, true, '玩家二侧同步禁用');
  // stub 的 dispatch 不模拟 disabled 抑制 click，正好直接派发以覆盖回调内
  // `if (idx === theirs) return;` 防御分支（程序化派发也不能改到对方形象）
  avButtons(avatarP2)[1].dispatch('click');
  assert.ok(isActive(avatarP2, 3), '防御分支拦截：程序化派发后玩家二仍是 3');
  clickBtn(avatarP1, 0); // 释放 1
  assert.strictEqual(avButtons(avatarP2)[1].disabled, false, '释放后可再选');

  // ---- 4. 走子日志显示双方形象（PvP 各走一步） ----
  clickDie(0, 0); // 玩家1 选第1排1颗
  btnConfirm.dispatch('click');
  await sleep(600); // 动画 320ms
  const logHtml = () => logList.children.map((li) => li.innerHTML).join('|');
  assert.ok(logHtml().includes('avatar-0.svg'), `日志显示玩家1卡通形象: ${logHtml()}`);
  clickDie(0, 0); // 玩家2（当前轮次）
  btnConfirm.dispatch('click');
  await sleep(600);
  assert.ok(logHtml().includes('avatar-3.svg'), `日志显示玩家2卡通形象: ${logHtml()}`);

  // ---- 5. AI 模式不变（回合条 + 日志均无形象前缀） ----
  modeAi.dispatch('click');
  assert.ok(turnText.innerHTML.includes('🙋'), `AI 模式回合条显示 🙋: ${turnText.innerHTML}`);
  assert.ok(!turnText.innerHTML.includes('avatar-'), 'AI 模式回合条不使用 PvP 卡通形象');
  assert.ok(sideHidden(), 'AI 模式形象面板隐藏（两侧）');
  // AI 模式走一步，日志保持纯文字（无 🙋 前缀）
  clickDie(0, 0);
  btnConfirm.dispatch('click');
  await sleep(600);
  const aiLog = logList.children.map((li) => li.innerHTML).join('|');
  assert.ok(aiLog.includes('你：从第 1 排拿走 1 颗'), `AI 日志为纯文字: ${aiLog}`);
  assert.ok(!aiLog.includes('🙋'), 'AI 日志无形象前缀');

  // ---- 6. PvP 胜负横幅显示获胜者形象 ----
  modePvp.dispatch('click');
  // 把局面直接推进到只剩 1 颗且轮到玩家1：先手动走子到 [0,0,1] 前
  // 玩家1 拿完倒数第二颗，玩家2 被迫拿最后一颗 → 玩家1 胜
  // 快速路径：连点确认走完前两排，再模拟终局
  clickDie(0, 2); btnConfirm.dispatch('click'); await sleep(400); // 第1排3颗全拿 → [0,5,7]
  clickDie(1, 4); btnConfirm.dispatch('click'); await sleep(400); // 第2排5颗全拿 → [0,0,7]
  clickDie(2, 5); btnConfirm.dispatch('click'); await sleep(400); // 第3排拿6颗 → [0,0,1]，轮到玩家2
  clickDie(2, 0); btnConfirm.dispatch('click'); await sleep(600); // 玩家2 拿最后一颗 → 玩家2输，玩家1胜
  const resultIcon = doc.getElementById('result-icon');
  assert.ok(resultIcon.innerHTML.includes('avatar-0.svg'), `横幅显示玩家1卡通形象(获胜者): ${resultIcon.innerHTML}`);

  console.log('✅ 形象选择行为验证通过（首屏显隐/默认/冲突拦截/释放/双方日志形象/AI不变/横幅形象）');
}
main().catch((e) => { console.error('FAIL:', e.message); process.exit(1); });
