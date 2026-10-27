'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const engine = require('../minigame/core/engine');

// Execute the actual legacy Web/Android scripts unchanged, without a browser or
// leaking their global exports into this test process. No reimplementation.
const context = vm.createContext({});
for (const relative of ['js/game.js', 'js/ai.js']) {
  const filename = path.resolve(__dirname, '..', relative);
  vm.runInContext(fs.readFileSync(filename, 'utf8'), context, { filename });
}
const legacy = context.G357;
const legacyAI = context.G357AI;
const sum = piles => piles.reduce((a, b) => a + b, 0);
const clone = value => JSON.parse(JSON.stringify(value));
const initial = [3, 5, 7];

function* positions() {
  for (let a = 0; a <= 3; a++) for (let b = 0; b <= 5; b++) for (let c = 0; c <= 7; c++) {
    yield [a, b, c];
  }
}

// Independent closed-form oracle guards against both implementations agreeing
// on the same wrong answer (including the special empty-position convention).
function oracle(piles) {
  if (piles.every(n => n <= 1)) return sum(piles) % 2 === 0;
  return piles.reduce((xor, n) => xor ^ n, 0) !== 0;
}

function assertParity(oldState, newState) {
  assert.deepEqual(Array.from(oldState.piles), newState.piles);
  assert.equal(oldState.currentPlayer - 1, newState.currentPlayer);
  assert.equal(oldState.winner === null ? null : oldState.winner - 1, newState.winner);
  assert.equal(legacy.isOver(oldState), newState.winner !== null);
  assert.equal(oldState.moveCount, newState.history.length);
  assert.ok(engine.validateState(newState));
}

// Construct reachable positions by applying the same setup moves to both
// engines. New-engine snapshots must carry genuine replayable history.
function reachable(piles, aiFirst) {
  const oldState = legacy.createGame(aiFirst ? 'ai' : 'pvp');
  // Legacy UI can select the AI to start; map legacy IDs 1/2 to engine IDs 0/1.
  oldState.currentPlayer = aiFirst ? legacy.PLAYER_2 : legacy.PLAYER_1;
  let newState = engine.createGame({ mode: aiFirst ? 'ai' : 'pvp', aiFirst });
  assertParity(oldState, newState);
  piles.forEach((remaining, row) => {
    const count = initial[row] - remaining;
    if (count) {
      assert.equal(legacy.makeMove(oldState, row, count).ok, true);
      newState = engine.move(newState, row, count);
      assertParity(oldState, newState);
    }
  });
  return { oldState, newState };
}

test('legacy/new winning tables agree with independent oracle on all 192 positions', () => {
  let checked = 0;
  for (const piles of positions()) {
    const expected = oracle(piles);
    assert.equal(legacyAI._isWin(...piles), expected, `legacy ${piles}`);
    assert.equal(engine.isWinning(piles), expected, `engine ${piles}`);
    checked++;
  }
  assert.equal(checked, 192);
});

test('legacy AI and new hard recommendations have equivalent legal/optimal semantics', () => {
  let checked = 0;
  for (const piles of positions()) {
    const before = piles.slice();
    const oldChoice = legacyAI.getMove({ piles });
    const newChoice = engine.chooseMove(piles, 'hard');
    assert.deepEqual(piles, before, 'neither recommendation mutates piles');
    if (!sum(piles)) {
      assert.equal(oldChoice, null);
      assert.equal(newChoice, null);
    } else {
      for (const choice of [oldChoice, newChoice]) {
        assert.ok(choice && Number.isInteger(choice.row) && Number.isInteger(choice.count));
        assert.ok(choice.row >= 0 && choice.row < 3);
        assert.ok(choice.count >= 1 && choice.count <= piles[choice.row]);
        assert.equal(legacy.isValidMove({ piles, winner: null }, choice.row, choice.count), true);
        const after = piles.slice();
        after[choice.row] -= choice.count;
        // Do not require identical tie-breaking: only the move's outcome matters.
        assert.equal(oracle(after), !oracle(piles), `recommendation at ${piles}`);
      }
    }
    checked++;
  }
  assert.equal(checked, 192);
});

test('every reachable legal move preserves legacy winner and current-player mapping', () => {
  let checkedPositions = 0;
  let transitions = 0;
  for (const aiFirst of [false, true]) for (const piles of positions()) {
    const { oldState, newState } = reachable(piles, aiFirst);
    checkedPositions++;
    assertParity(oldState, newState);
    if (!sum(piles)) {
      assert.equal(legacy.isValidMove(oldState, 0, 1), false);
      assert.equal(legacy.makeMove(oldState, 0, 1).ok, false);
      assert.throws(() => engine.move(newState, 0, 1), Error);
      continue;
    }
    for (let row = 0; row < 3; row++) for (let count = 1; count <= piles[row]; count++) {
      const oldNext = clone(oldState);
      const before = clone(newState);
      assert.equal(legacy.isValidMove(oldNext, row, count), true);
      const result = legacy.makeMove(oldNext, row, count);
      const newNext = engine.move(newState, row, count);
      assert.equal(result.ok, true);
      assert.equal(result.winner === null ? null : result.winner - 1, newNext.winner);
      assertParity(oldNext, newNext);
      assert.deepEqual(newState, before, 'new move keeps its source snapshot unchanged');
      const finished = sum(newNext.piles) === 0;
      assert.equal(newNext.currentPlayer, finished ? newState.currentPlayer : 1 - newState.currentPlayer);
      assert.equal(newNext.winner, finished ? 1 - newState.currentPlayer : null);
      const entry = newNext.history.at(-1);
      assert.deepEqual(clone(oldNext.lastMove), { player: entry.player + 1, row: entry.row, count: entry.count });
      transitions++;
    }
  }
  assert.equal(checkedPositions, 384); // 192 positions for each starting player.
  assert.equal(transitions, 2880); // All 1440 legal transitions, both player mappings.
});
