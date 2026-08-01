/**
 * 357 AI 策略（misère Nim 精确解）
 *
 * 用动态规划对全部局面（每排 0..7 颗，共 8³=512 个状态）预计算胜负表，
 * 走子时选一手把对手送入必败局面的走法；若当前已是必败局面则拖延（拿 1 颗）。
 *
 * 比单纯"异或归零"更准确：misère 规则下，临界局面（如 [0,1,2]）
 * 直接走异或归零会把"偶数个单骰堆"送给对手（对手必胜），必须特殊处理，
 * 而 DP 天然覆盖所有边界。
 *
 * 胜负判定基准：无子可走视为当前玩家胜——因为上一手刚拿走最后一颗骰子（输了）。
 */
(function (global) {
  'use strict';

  const G357AI = {};

  const SIZE = 8; // 单排最多 7 颗（0..7）
  const winTable = new Array(SIZE * SIZE * SIZE);
  const computed = new Uint8Array(SIZE * SIZE * SIZE);

  function keyOf(a, b, c) { return (a * SIZE + b) * SIZE + c; }

  /** 轮到当前玩家时，该局面是否必胜 */
  function isWin(a, b, c) {
    const k = keyOf(a, b, c);
    if (computed[k]) return winTable[k];
    computed[k] = 1;

    let w = false;
    if (a + b + c === 0) {
      w = true; // 无子可走 = 上一手拿最后一颗输了 → 当前玩家胜
    } else {
      const piles = [a, b, c];
      outer:
      for (let i = 0; i < 3; i++) {
        for (let take = 1; take <= piles[i]; take++) {
          const next = piles.slice();
          next[i] -= take;
          if (!isWin(next[0], next[1], next[2])) { w = true; break outer; }
        }
      }
    }
    winTable[k] = w;
    return w;
  }

  // 预热：一次性算完全部状态，此后走子为 O(1) 查表
  (function precompute() {
    for (let a = 0; a < SIZE; a++) {
      for (let b = 0; b < SIZE; b++) {
        for (let c = 0; c < SIZE; c++) isWin(a, b, c);
      }
    }
  })();

  /**
   * 选择一手走子：优先把对手送入必败局面；必败局面下拖延（拿 1 颗）。
   * @param {number[]} piles 当前三排骰子数
   * @returns {{ row: number, count: number } | null}
   */
  function bestMove(piles) {
    for (let i = 0; i < 3; i++) {
      for (let take = 1; take <= piles[i]; take++) {
        const next = piles.slice();
        next[i] -= take;
        if (!isWin(next[0], next[1], next[2])) {
          return { row: i, count: take };
        }
      }
    }
    for (let i = 0; i < 3; i++) {
      if (piles[i] > 0) return { row: i, count: 1 };
    }
    return null;
  }

  /**
   * 计算 AI 的一手走子。
   * @param {object} game 由 G357.createGame 创建的游戏对象
   */
  G357AI.getMove = function (game) {
    return bestMove(game.piles);
  };

  // 暴露内部方法便于测试
  G357AI._isWin = isWin;

  global.G357AI = G357AI;
})(typeof window !== 'undefined' ? window : globalThis);
