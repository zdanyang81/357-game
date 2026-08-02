/**
 * 357 最小逻辑测试（node 直接运行，无依赖）：
 *   node test.js
 *
 * 固化 misère 语义与 AI 最优策略的边界行为。
 */
'use strict';

const assert = require('assert');

// 加载纯逻辑模块（IIFE 挂到 globalThis）
require('./js/game.js');
require('./js/ai.js');

const G357 = globalThis.G357;
const G357AI = globalThis.G357AI;

// ---- isWin（轮到当前玩家是否必胜，misère 语义）----
assert.strictEqual(G357AI._isWin(0, 0, 0), true, 'isWin(0,0,0)：无子可走=上一手拿最后一颗输了→当前玩家胜');
assert.strictEqual(G357AI._isWin(0, 0, 1), false, 'isWin(0,0,1)：只剩 1 颗，轮到自己拿=输');
assert.strictEqual(G357AI._isWin(0, 1, 1), true, 'isWin(0,1,1)：拿 1 颗送对方必败');
assert.strictEqual(G357AI._isWin(1, 1, 1), false, 'isWin(1,1,1)：misère 临界局面');
assert.strictEqual(G357AI._isWin(3, 5, 7), true, 'isWin(3,5,7)：初始局面先手必胜');

// ---- bestMove 最优走法 ----
const m = G357AI.getMove({ piles: [3, 5, 7] });
assert.deepStrictEqual(m, { row: 0, count: 1 }, 'bestMove([3,5,7]) 应为先手必胜首手 {row:0,count:1}');

// 必胜局面应把对手送入必败态
for (const piles of [[0, 1, 2], [1, 1, 2]]) {
  const mv = G357AI.getMove({ piles: piles.slice() });
  assert.ok(mv, `${piles} 是必胜局面，应有走法`);
  const next = piles.slice();
  next[mv.row] -= mv.count;
  assert.strictEqual(G357AI._isWin(...next), false, `${piles} 走 ${JSON.stringify(mv)} 后对手应处于必败态`);
}

// ---- 核心规则：misère 胜负判定 ----
const g = G357.createGame(G357.MODE_PVP);
assert.deepStrictEqual(g.piles, [3, 5, 7], '初始局面');

// 拿走最后一颗的人输，对手获胜
const g2 = G357.createGame(G357.MODE_PVP);
g2.piles = [0, 0, 1];
const r = G357.makeMove(g2, 2, 1);
assert.strictEqual(r.ok, true);
assert.strictEqual(r.winner, G357.PLAYER_2, 'PLAYER_1 拿最后一颗 → PLAYER_2 获胜');

// 非法走子
const g3 = G357.createGame(G357.MODE_PVP);
assert.strictEqual(G357.makeMove(g3, 0, 8).ok, false, '拿超过该排数量应非法');
assert.strictEqual(G357.makeMove(g3, 3, 1).ok, false, '行号越界应非法');
assert.strictEqual(G357.makeMove(g3, 0, 0).ok, false, '拿 0 颗应非法');

console.log('✅ 全部测试通过（misère 语义 / AI 最优策略 / 走子校验）');
