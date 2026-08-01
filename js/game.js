/**
 * 357 游戏核心逻辑（纯逻辑，不依赖 DOM）
 *
 * 规则：三排骰子 [3, 5, 7]，双方轮流从任意一排拿走任意数量（至少 1 颗）。
 * misère 规则：拿到最后一颗骰子的人输，另一方获胜。
 */
(function (global) {
  'use strict';

  const G357 = {};

  // 三排初始骰子数
  G357.INITIAL_PILES = [3, 5, 7];

  // 玩家
  G357.PLAYER_1 = 1;
  G357.PLAYER_2 = 2;

  // 模式
  G357.MODE_PVP = 'pvp';
  G357.MODE_AI = 'ai';

  /**
   * 创建一局新游戏。
   * @param {string} mode G357.MODE_PVP | G357.MODE_AI
   */
  G357.createGame = function (mode) {
    return {
      mode: mode || G357.MODE_PVP,
      piles: G357.INITIAL_PILES.slice(),
      currentPlayer: G357.PLAYER_1,
      winner: null,          // null = 未结束；否则为获胜玩家
      lastMove: null,        // { row, count, player }
      moveCount: 0
    };
  };

  /** 剩余骰子总数 */
  G357.totalDice = function (game) {
    return game.piles.reduce(function (sum, n) { return sum + n; }, 0);
  };

  /**
   * 校验走子是否合法：只能从某一排拿走 1..piles[row] 颗。
   */
  G357.isValidMove = function (game, row, count) {
    if (game.winner !== null) return false;
    if (!Number.isInteger(row) || row < 0 || row >= game.piles.length) return false;
    if (!Number.isInteger(count) || count < 1) return false;
    return count <= game.piles[row];
  };

  /**
   * 落子。
   * @returns {{ ok: boolean, winner: number|null, message?: string }}
   */
  G357.makeMove = function (game, row, count) {
    if (!G357.isValidMove(game, row, count)) {
      return { ok: false, message: '非法走子：只能从一排拿走 1 到该排剩余数量的骰子' };
    }

    game.piles[row] -= count;
    game.lastMove = { row: row, count: count, player: game.currentPlayer };
    game.moveCount += 1;

    // misère 判定：这一手拿走最后一颗骰子的人输，对手获胜
    if (G357.totalDice(game) === 0) {
      game.winner = game.currentPlayer === G357.PLAYER_1
        ? G357.PLAYER_2
        : G357.PLAYER_1;
      return { ok: true, winner: game.winner };
    }

    game.currentPlayer = game.currentPlayer === G357.PLAYER_1
      ? G357.PLAYER_2
      : G357.PLAYER_1;
    return { ok: true, winner: null };
  };

  /** 对局是否已结束 */
  G357.isOver = function (game) {
    return game.winner !== null;
  };

  /** 重置为初始状态 */
  G357.reset = function (game, mode) {
    if (mode !== undefined) game.mode = mode;
    game.piles = G357.INITIAL_PILES.slice();
    game.currentPlayer = G357.PLAYER_1;
    game.winner = null;
    game.lastMove = null;
    game.moveCount = 0;
    return game;
  };

  global.G357 = G357;
})(typeof window !== 'undefined' ? window : globalThis);
