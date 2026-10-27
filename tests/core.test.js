'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createGame, move, chooseMove, isWinning, validateState, explain } =
  require('../minigame/core/engine');

const copy = value => JSON.parse(JSON.stringify(value));
const sum = piles => piles.reduce((a, b) => a + b, 0);
// Independent closed-form misère Nim oracle, not the engine's recursive DP.
function oracle(piles) {
  if (piles.every(n => n <= 1)) return sum(piles) % 2 === 0;
  return piles.reduce((xor, n) => xor ^ n, 0) !== 0;
}
function freeze(value) {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}
function sequence(values) {
  let index = 0;
  return () => { assert.ok(index < values.length, 'unexpected RNG call'); return values[index++]; };
}
function legal(piles, choice) {
  assert.ok(Number.isInteger(choice.row) && choice.row >= 0 && choice.row < 3);
  assert.ok(Number.isInteger(choice.count) && choice.count >= 1 && choice.count <= piles[choice.row]);
}

test('creation defaults, independent arrays, modes and options', () => {
  assert.deepEqual(createGame(), {
    version: 1, piles: [3, 5, 7], currentPlayer: 0, mode: 'ai',
    difficulty: 'easy', aiFirst: false, avatars: [0, 3], history: [], winner: null
  });
  for (const mode of ['ai', 'pvp']) for (const aiFirst of [true, false]) {
    const state = createGame({ mode, aiFirst });
    assert.equal(state.currentPlayer, mode === 'ai' && aiFirst ? 1 : 0);
    assert.ok(validateState(state));
  }
  const avatars = [1, 5];
  const game = createGame({ avatars });
  avatars[0] = 4;
  assert.deepEqual(game.avatars, [1, 5]);
  game.piles[0] = 0;
  assert.deepEqual(createGame().piles, [3, 5, 7]);
  for (const options of [{ mode: 'bad' }, { difficulty: '' }, { aiFirst: 1 },
    { avatars: [0] }, { avatars: [0, 6] }, { avatars: [-1, 3] }, { avatars: ['0', 3] }]) {
    assert.throws(() => createGame(options), Error);
  }
});

test('all 192 actual positions match independent oracle; every hard move is exact', () => {
  let positions = 0;
  for (let a = 0; a <= 3; a++) for (let b = 0; b <= 5; b++) for (let c = 0; c <= 7; c++) {
    const piles = freeze([a, b, c]);
    positions++;
    assert.equal(isWinning(piles), oracle(piles), `oracle at ${piles}`);
    const best = chooseMove(piles, 'hard', () => { throw new Error('hard must not use RNG'); });
    if (!sum(piles)) {
      assert.equal(best, null);
      continue;
    }
    legal(piles, best);
    const next = piles.slice();
    next[best.row] -= best.count;
    if (oracle(piles)) assert.equal(oracle(next), false, `optimal at ${piles}`);
    for (const difficulty of ['easy', 'medium']) for (const sample of [0, 0.699999999, 0.7, 0.999999999]) {
      const choice = chooseMove(piles, difficulty, () => sample);
      legal(piles, choice);
      if (sum(piles) > 1) assert.notEqual(choice.count, sum(piles));
      if (difficulty === 'medium') {
        const randomChoice = chooseMove(piles, 'medium', sequence([0.7, sample]));
        assert.deepEqual(randomChoice, chooseMove(piles, 'easy', sequence([sample])));
      }
    }
    assert.match(explain(piles), /[\u4e00-\u9fff]/);
  }
  assert.equal(positions, 192);
});

test('all legal moves in all 192 reachable positions preserve replay invariants', () => {
  let transitions = 0;
  for (let a = 0; a <= 3; a++) for (let b = 0; b <= 5; b++) for (let c = 0; c <= 7; c++) {
    const target = [a, b, c];
    let state = createGame();
    target.forEach((remaining, row) => {
      const count = state.piles[row] - remaining;
      if (count) state = move(state, row, count);
    });
    assert.deepEqual(state.piles, target);
    assert.ok(validateState(state));
    freeze(state);
    for (let row = 0; row < 3; row++) for (let count = 1; count <= target[row]; count++) {
      const next = move(state, row, count);
      const expected = target.slice();
      expected[row] -= count;
      assert.deepEqual(next.piles, expected);
      assert.equal(next.winner, sum(expected) === 0 ? 1 - state.currentPlayer : null);
      assert.ok(validateState(next));
      transitions++;
    }
  }
  assert.equal(transitions, 1440);
});

test('move validates, preserves frozen input, deep-isolates history and ends with opponent winner', () => {
  for (const options of [{}, { aiFirst: true }, { mode: 'pvp', aiFirst: true }]) {
    let state = freeze(createGame(options));
    for (const row of [0, 1, 2]) {
      const before = copy(state);
      const player = state.currentPlayer;
      const count = state.piles[row];
      const next = move(state, row, count);
      assert.deepEqual(state, before);
      assert.notEqual(next, state);
      assert.notEqual(next.avatars, state.avatars);
      assert.notEqual(next.history, state.history);
      assert.notEqual(next.piles, next.history.at(-1).piles);
      if (state.history.length) {
        assert.notEqual(next.history[0], state.history[0]);
        assert.notEqual(next.history[0].piles, state.history[0].piles);
      }
      assert.deepEqual(next.history.at(-1), { player, row, count, piles: next.piles });
      assert.ok(validateState(copy(next)));
      assert.equal(next.currentPlayer, row === 2 ? player : 1 - player);
      assert.equal(next.winner, row === 2 ? 1 - player : null);
      state = freeze(next);
    }
    assert.throws(() => move(state, 0, 1), Error);
  }
  const state = freeze(createGame());
  for (const [row, count] of [[-1, 1], [3, 1], [0.5, 1], ['0', 1], [NaN, 1],
    [0, 0], [0, -1], [0, 4], [0, 1.5], [0, '1'], [0, Infinity]]) {
    assert.throws(() => move(state, row, count), Error);
  }
  assert.throws(() => move(move(state, 0, 3), 0, 1), Error);
  assert.throws(() => move({}, 0, 1), Error);
});

test('replay accepts up to 15 turns and rejects save tampering', () => {
  let state = createGame({ aiFirst: true });
  for (const row of [0, 1, 2]) while (state.piles[row]) {
    state = move(state, row, 1);
    assert.ok(validateState(copy(state)));
  }
  assert.equal(state.history.length, 15);
  const valid = move(move(createGame(), 0, 2), 1, 3);
  const corruptions = [
    s => { s.version = 2; }, s => { delete s.version; }, s => { s.extra = true; },
    s => { s.piles[0] = 2; }, s => { s.piles[0] = -1; }, s => { s.piles[1] = 6; },
    s => { s.piles = [1, 2]; }, s => { s.piles[0] = '1'; },
    s => { s.currentPlayer = 1; }, s => { s.currentPlayer = false; },
    s => { s.winner = 1; }, s => { s.mode = 'invalid'; }, s => { s.aiFirst = true; },
    s => { s.difficulty = 'impossible'; }, s => { s.avatars[1] = 6; },
    s => { s.history[0].player = 1; }, s => { s.history[0].row = 3; },
    s => { s.history[0].count = 4; }, s => { s.history[0].piles[0] = 0; },
    s => { s.history[1].count = 0; }, s => { s.history[1].extra = 1; },
    s => { s.history.reverse(); }, s => { s.history.pop(); },
    s => { s.history = new Array(2); }, s => { s.piles = new Array(3); },
    s => { s.history.push(null); }, s => { s.piles.extra = 1; },
    s => { Object.defineProperty(s, 'mode', { get() { throw Error('getter'); } }); }
  ];
  for (const corrupt of corruptions) {
    const saved = copy(valid);
    corrupt(saved);
    assert.equal(validateState(saved), false, String(corrupt));
  }
  for (const value of [null, undefined, 1, 'save', [], Object.create(valid),
    new Proxy({}, { ownKeys() { throw Error('proxy'); } })]) assert.equal(validateState(value), false);
  const afterEnd = copy(state);
  afterEnd.history.push({ player: state.winner, row: 0, count: 1, piles: [0, 0, 0] });
  assert.equal(validateState(afterEnd), false);
  const wrongWinner = copy(state);
  wrongWinner.winner = 1 - state.winner;
  assert.equal(validateState(wrongWinner), false);
});

test('difficulty probability boundaries and RNG contract', () => {
  // [0,0,3]: take two is uniquely optimal; both random branches exclude taking all.
  const piles = [0, 0, 3];
  assert.deepEqual(chooseMove(piles), { row: 2, count: 2 });
  assert.deepEqual(chooseMove(piles, 'medium', sequence([0])), { row: 2, count: 2 });
  assert.deepEqual(chooseMove(piles, 'medium', sequence([0.699999999])), { row: 2, count: 2 });
  assert.deepEqual(chooseMove(piles, 'medium', sequence([0.7, 0.999999999])), { row: 2, count: 2 });
  assert.deepEqual(chooseMove([0, 0, 1], 'medium', sequence([0.7, 0])), { row: 2, count: 1 });
  assert.deepEqual(chooseMove(piles, 'medium', sequence([0.999999999, 0])), { row: 2, count: 1 });
  assert.deepEqual(chooseMove(piles, 'easy', sequence([0])), { row: 2, count: 1 });
  assert.deepEqual(chooseMove(piles, 'easy', sequence([0.999999999])), { row: 2, count: 2 });
  assert.deepEqual(chooseMove([0, 0, 1], 'easy', () => 0), { row: 2, count: 1 });
  for (const difficulty of ['easy', 'medium', 'hard']) {
    assert.equal(chooseMove([0, 0, 0], difficulty, () => { throw Error('terminal RNG'); }), null);
  }
  for (const n of [-0.1, 1, Infinity, NaN, '0', undefined]) {
    assert.throws(() => chooseMove(piles, 'easy', () => n), Error);
    assert.throws(() => chooseMove(piles, 'medium', () => n), Error);
  }
  assert.throws(() => chooseMove(piles, 'bad'), Error);
  assert.throws(() => chooseMove(piles, 'hard', null), Error);
  for (const invalid of [null, [], [4, 0, 0], [0, 6, 0], [0, 0, 8], [1.5, 0, 0], [-1, 0, 0], ['1', 0, 0]]) {
    for (const fn of [isWinning, chooseMove, explain]) assert.throws(() => fn(invalid), Error);
  }
  assert.match(explain([0, 0, 0]), /结束/);
  assert.match(explain([0, 0, 1]), /输/);
});
