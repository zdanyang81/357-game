'use strict';

// Pure CommonJS misère Nim: the player taking the last die loses.
const INITIAL = [3, 5, 7];
const DIFFICULTIES = ['easy', 'medium', 'hard'];
const STATE_KEYS = ['version', 'piles', 'currentPlayer', 'mode', 'difficulty',
  'aiFirst', 'avatars', 'history', 'winner'];
const wins = new Map();

function record(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return false;
  const own = Reflect.ownKeys(value);
  return own.length === keys.length && keys.every(key => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor && descriptor.enumerable && 'value' in descriptor;
  });
}

function array(value, length, predicate) {
  if (!Array.isArray(value) || value.length !== length ||
      Reflect.ownKeys(value).length !== length + 1) return false;
  for (let i = 0; i < length; i++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(i));
    if (!descriptor || !('value' in descriptor) || !predicate(descriptor.value, i)) return false;
  }
  return true;
}

function validPiles(piles) {
  return array(piles, 3, (n, i) => Number.isInteger(n) && n >= 0 && n <= INITIAL[i]);
}

function assertPiles(piles) {
  if (!validPiles(piles)) throw new Error('非法骰子局面');
}

function same(a, b) { return a.every((n, i) => n === b[i]); }
function total(piles) { return piles[0] + piles[1] + piles[2]; }
function validDifficulty(difficulty) { return DIFFICULTIES.includes(difficulty); }
function validAvatars(avatars) {
  return array(avatars, 2, n => Number.isInteger(n) && n >= 0 && n < 6);
}

function createGame({ mode = 'ai', difficulty = 'easy', aiFirst = false,
  avatars = [0, 3] } = {}) {
  if (!['ai', 'pvp'].includes(mode) || !validDifficulty(difficulty) ||
      typeof aiFirst !== 'boolean' || !validAvatars(avatars)) {
    throw new Error('非法游戏选项');
  }
  return { version: 1, piles: INITIAL.slice(),
    currentPlayer: mode === 'ai' && aiFirst ? 1 : 0,
    mode, difficulty, aiFirst, avatars: avatars.slice(), history: [], winner: null };
}

// Terminal convention: no dice means the previous mover lost, so this side won.
function solve(piles) {
  const key = piles.join(',');
  if (wins.has(key)) return wins.get(key);
  let winning = total(piles) === 0;
  outer: for (let row = 0; !winning && row < 3; row++) {
    for (let count = 1; count <= piles[row]; count++) {
      const next = piles.slice();
      next[row] -= count;
      if (!solve(next)) { winning = true; break outer; }
    }
  }
  wins.set(key, winning);
  return winning;
}

function isWinning(piles) {
  assertPiles(piles);
  return solve(piles);
}

function validateState(value) {
  // A validator must return false even for accessors/proxies or cyclic junk.
  try {
    if (!record(value, STATE_KEYS) || value.version !== 1 ||
        !['ai', 'pvp'].includes(value.mode) || !validDifficulty(value.difficulty) ||
        typeof value.aiFirst !== 'boolean' || !validAvatars(value.avatars) ||
        !validPiles(value.piles) || ![0, 1].includes(value.currentPlayer) ||
        ![null, 0, 1].includes(value.winner) || !Array.isArray(value.history) ||
        value.history.length > 15 || !array(value.history, value.history.length, () => true)) return false;
    const piles = INITIAL.slice();
    let player = value.mode === 'ai' && value.aiFirst ? 1 : 0;
    let winner = null;
    for (const entry of value.history) {
      if (winner !== null || !record(entry, ['player', 'row', 'count', 'piles']) ||
          entry.player !== player || !Number.isInteger(entry.row) || entry.row < 0 || entry.row > 2 ||
          !Number.isInteger(entry.count) || entry.count < 1 || entry.count > piles[entry.row] ||
          !validPiles(entry.piles)) return false;
      piles[entry.row] -= entry.count;
      if (!same(piles, entry.piles)) return false;
      if (total(piles) === 0) winner = 1 - player;
      else player = 1 - player;
    }
    return same(piles, value.piles) && player === value.currentPlayer && winner === value.winner;
  } catch (_) { return false; }
}

function move(state, row, count) {
  if (!validateState(state)) throw new Error('非法游戏存档');
  if (state.winner !== null) throw new Error('游戏已结束');
  if (!Number.isInteger(row) || row < 0 || row > 2 ||
      !Number.isInteger(count) || count < 1 || count > state.piles[row]) {
    throw new Error('非法走子：只能从一排拿走至少一颗骰子');
  }
  const piles = state.piles.slice();
  piles[row] -= count;
  const over = total(piles) === 0;
  return { ...state, piles, avatars: state.avatars.slice(),
    currentPlayer: over ? state.currentPlayer : 1 - state.currentPlayer,
    winner: over ? 1 - state.currentPlayer : null,
    history: state.history.map(entry => ({ ...entry, piles: entry.piles.slice() }))
      .concat({ player: state.currentPlayer, row, count, piles: piles.slice() }) };
}

function randomIndex(length, rng) {
  const value = rng();
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value >= 1) {
    throw new Error('随机数必须在 [0,1) 内');
  }
  return Math.floor(value * length);
}

function chooseMove(piles, difficulty = 'hard', rng = Math.random) {
  assertPiles(piles);
  if (!validDifficulty(difficulty) || typeof rng !== 'function') throw new Error('非法 AI 选项');
  const moves = [];
  const optimal = [];
  for (let row = 0; row < 3; row++) {
    for (let count = 1; count <= piles[row]; count++) {
      const choice = { row, count };
      moves.push(choice);
      const next = piles.slice();
      next[row] -= count;
      if (!solve(next)) optimal.push(choice);
    }
  }
  if (!moves.length) return null;
  // Forced-loss positions retain the reference AI's deterministic one-die fallback.
  const best = optimal.length ? optimal[0] : moves[0];
  if (difficulty === 'hard') return best;
  if (difficulty === 'medium' && randomIndex(10, rng) < 7) return best;
  const safe = moves.filter(choice => choice.count !== total(piles));
  // Both easy and medium's random branch avoid taking the last die if possible.
  const candidates = safe.length ? safe : moves;
  return candidates[randomIndex(candidates.length, rng)];
}

function explain(piles) {
  assertPiles(piles);
  if (!total(piles)) return '本局结束：拿走最后一颗的人输。';
  if (total(piles) === 1) return '只剩最后一颗，本轮只能拿走并认输。';
  const choice = chooseMove(piles);
  if (solve(piles)) return `可从第${choice.row + 1}排拿${choice.count}颗，给对手留下必败局面；别拿最后一颗。`;
  return '当前是必败局面，先少拿一颗，等待对手失误；拿最后一颗的人输。';
}

module.exports = { createGame, move, chooseMove, isWinning, validateState, explain };
