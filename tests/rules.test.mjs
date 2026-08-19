// rules.test.mjs — unit tests for the pure rules engine (js/rules.js) and the
// session wrapper behaviors that are rules-adjacent (settle, clock, concede).

import assert from 'node:assert/strict';
import {
  SCORE, TERMINAL,
  canonicalStringify, hashState, cloneState,
  cellXY, cellIndex, neighbors, directionBetween, effectiveEdges,
  createInitialState, analyzeBoard, emptyCellCount, isSolved, terminalCondition,
  validateCommand, applyCommand, applyInvalid, quantizeElapsed, listLegalCommands,
  compareResults,
} from '../js/rules.js';
import { generatePuzzle, instantiate } from '../js/content.js';
import { Session } from '../js/session.js';
import { test, solveSession } from './helpers.mjs';

let seq = 0;
function makeState(params, seed) {
  return createInitialState(generatePuzzle('rules-' + seq, 'rules-seed-' + seq++, params));
}
function makeSession(params, opts = {}, seed) {
  const content = generatePuzzle('rules-' + seq, 'rules-seed-' + seq++, params);
  return new Session(content, { mode: 'practice', sessionId: 'rules-s-' + seq, ...opts });
}

// ---------------------------------------------------------------------------
// canonicalStringify / hashState / quantizeElapsed
// ---------------------------------------------------------------------------

test('canonicalStringify sorts object keys recursively, preserves array order', () => {
  assert.equal(canonicalStringify({ b: 1, a: 2 }), '{"a":2,"b":1}');
  assert.equal(canonicalStringify({ b: { d: 1, c: 2 }, a: [3, 1] }), '{"a":[3,1],"b":{"c":2,"d":1}}');
  assert.equal(canonicalStringify([{ z: 1, y: 2 }]), '[{"y":2,"z":1}]');
  assert.equal(canonicalStringify(null), 'null');
  assert.equal(canonicalStringify('x'), '"x"');
});

test('hashState is stable, key-order independent, and change-sensitive', () => {
  const a = makeState({ w: 3, h: 3, palette: 3, removed: 3 });
  const b = makeState({ w: 3, h: 3, palette: 3, removed: 3 }, undefined); // different seed -> different state
  const same = cloneState(a);
  assert.match(hashState(a), /^[0-9a-f]{8}$/);
  assert.equal(hashState(a), hashState(same));
  // key insertion order must not matter
  const reordered = JSON.parse(canonicalStringify(a));
  assert.equal(hashState(a), hashState(reordered));
  // a mutation changes the hash
  same.tick += 1;
  assert.notEqual(hashState(a), hashState(same));
  assert.notEqual(hashState(a), hashState(b));
});

test('quantizeElapsed rounds to 100ms and clamps at 0', () => {
  assert.equal(quantizeElapsed(0), 0);
  assert.equal(quantizeElapsed(49), 0);
  assert.equal(quantizeElapsed(50), 100);
  assert.equal(quantizeElapsed(149), 100);
  assert.equal(quantizeElapsed(150), 200);
  assert.equal(quantizeElapsed(-400), 0);
  assert.equal(quantizeElapsed(undefined), 0);
  assert.equal(quantizeElapsed(null), 0);
});

// ---------------------------------------------------------------------------
// geometry + effectiveEdges rotation math
// ---------------------------------------------------------------------------

test('geometry helpers: cellXY/cellIndex/neighbors/directionBetween', () => {
  const st = makeState({ w: 4, h: 3, palette: 3, removed: 0 });
  assert.deepEqual(cellXY(st, 6), { x: 2, y: 1 });
  assert.equal(cellIndex(st, 2, 1), 6);
  assert.equal(cellIndex(st, -1, 0), -1);
  assert.equal(cellIndex(st, 4, 0), -1);
  assert.deepEqual(neighbors(st, 0), [1, 4]);            // corner: E, S
  assert.deepEqual(neighbors(st, 5), [1, 6, 9, 4]);      // interior: N, E, S, W
  assert.equal(directionBetween(st, 5, 1), 0);           // N
  assert.equal(directionBetween(st, 5, 6), 1);           // E
  assert.equal(directionBetween(st, 5, 9), 2);           // S
  assert.equal(directionBetween(st, 5, 4), 3);           // W
  assert.equal(directionBetween(st, 0, 5), -1);          // not adjacent
});

test('effectiveEdges applies quarter-turn rotation math', () => {
  const card = { edges: [10, 11, 12, 13], rot: 0 };
  assert.deepEqual(effectiveEdges(card), [10, 11, 12, 13]);
  card.rot = 1; assert.deepEqual(effectiveEdges(card), [13, 10, 11, 12]);
  card.rot = 2; assert.deepEqual(effectiveEdges(card), [12, 13, 10, 11]);
  card.rot = 3; assert.deepEqual(effectiveEdges(card), [11, 12, 13, 10]);
  card.rot = 4; assert.deepEqual(effectiveEdges(card), [10, 11, 12, 13]); // wraps
  card.rot = -1; assert.deepEqual(effectiveEdges(card), [11, 12, 13, 10]); // mod-normalized
});

// ---------------------------------------------------------------------------
// command happy paths (every command type)
// ---------------------------------------------------------------------------

test('place: tray card moves into an empty cell, counts a move', () => {
  const st = makeState({ w: 3, h: 3, palette: 3, removed: 2 });
  const tray = st.tray.findIndex((t) => t !== null);
  const cell = st.cells.findIndex((c) => c === null);
  const id = st.tray[tray];
  assert.equal(validateCommand(st, { type: 'place', tray, cell }).ok, true);
  const events = applyCommand(st, { type: 'place', tray, cell });
  assert.equal(st.tray[tray], null);
  assert.equal(st.cells[cell], id);
  assert.equal(st.movesUsed, 1);
  assert.equal(st.tick, 1);
  assert.deepEqual(events[0], { type: 'place', card: id, tray, cell });
  assert.equal(events.at(-1).type, 'board');
});

test('recall: placed unlocked card returns to its own tray slot', () => {
  const st = makeState({ w: 3, h: 3, palette: 3, removed: 2 });
  const tray = st.tray.findIndex((t) => t !== null);
  const cell = st.cells.findIndex((c) => c === null);
  const id = st.tray[tray];
  applyCommand(st, { type: 'place', tray, cell });
  const events = applyCommand(st, { type: 'recall', cell });
  assert.equal(st.cells[cell], null);
  assert.equal(st.tray[tray], id);
  assert.deepEqual(events[0], { type: 'recall', card: id, cell, tray });
});

test('swap: two placed unlocked cards exchange cells', () => {
  const st = makeState({ w: 3, h: 3, palette: 3, removed: 2 });
  const t1 = st.tray.findIndex((t) => t !== null);
  const c1 = st.cells.findIndex((c) => c === null);
  applyCommand(st, { type: 'place', tray: t1, cell: c1 });
  const t2 = st.tray.findIndex((t) => t !== null);
  const c2 = st.cells.findIndex((c) => c === null);
  applyCommand(st, { type: 'place', tray: t2, cell: c2 });
  const idA = st.cells[c1], idB = st.cells[c2];
  const events = applyCommand(st, { type: 'swap', a: c1, b: c2 });
  assert.equal(st.cells[c1], idB);
  assert.equal(st.cells[c2], idA);
  assert.equal(st.swapsUsed, 1);
  assert.equal(st.score.swapPenalty, SCORE.SWAP_PENALTY);
  assert.deepEqual(events[0], { type: 'swap', a: c1, b: c2, cardA: idA, cardB: idB });
});

test('rotateTray: quarter-turns a tray card mod 4 (rotation mechanic)', () => {
  const st = makeState({ w: 3, h: 3, palette: 3, removed: 2, rotation: true });
  const tray = st.tray.findIndex((t) => t !== null);
  const id = st.tray[tray];
  const before = st.cards[id].rot;
  const events = applyCommand(st, { type: 'rotateTray', tray });
  assert.equal(st.cards[id].rot, (before + 1) % 4);
  assert.deepEqual(events[0], { type: 'rotateTray', card: id, tray, rot: st.cards[id].rot });
  applyCommand(st, { type: 'rotateTray', tray });
  applyCommand(st, { type: 'rotateTray', tray });
  applyCommand(st, { type: 'rotateTray', tray });
  assert.equal(st.cards[id].rot, before); // four turns = identity
});

test('lock: fully-matching placed card locks, scores PER_LOCK', () => {
  const content = generatePuzzle('rules-lock', 'rules-lock-seed', { w: 3, h: 3, palette: 3, removed: 3, lock: true });
  const session = new Session(content, { mode: 'practice', sessionId: 'rules-lock-s' });
  solveSession(session, { lock: true, idPrefix: 'lk' });
  assert.equal(session.result.terminalReason, TERMINAL.COMPLETE);
  assert.ok(session.state.lockedCount >= 1);
  assert.equal(session.state.score.locks, session.state.lockedCount * SCORE.PER_LOCK);
});

test('settle: finalizes a solved board (terminal complete)', () => {
  const content = generatePuzzle('rules-settle', 'rules-settle-seed', { w: 2, h: 2, palette: 2, removed: 2 });
  const session = new Session(content, { mode: 'practice', sessionId: 'rules-settle-s' });
  solveSession(session, { idPrefix: 'st' });
  assert.equal(session.result.terminalReason, TERMINAL.COMPLETE);
  // the auto-settle went through the real command pipeline and is in the log
  assert.equal(session.commands.at(-1).type, 'settle');
  assert.equal(session.state.status, 'terminal');
});

test('concede: abandons the round (terminal conceded)', () => {
  const session = makeSession({ w: 3, h: 3, palette: 3, removed: 3 });
  const r = session.concede(5000);
  assert.equal(r.ok, true);
  assert.equal(session.result.terminalReason, TERMINAL.CONCEDED);
  assert.equal(session.state.status, 'terminal');
});

// ---------------------------------------------------------------------------
// invalid reasons (every one)
// ---------------------------------------------------------------------------

test('unknown-command: bad type and non-object commands', () => {
  const st = makeState({ w: 3, h: 3, palette: 3, removed: 2 });
  assert.equal(validateCommand(st, { type: 'nope' }).reason, 'unknown-command');
  assert.equal(validateCommand(st, {}).reason, 'unknown-command');
  assert.equal(validateCommand(st, null).reason, 'unknown-command');
  assert.equal(validateCommand(st, undefined).reason, 'unknown-command');
  assert.equal(validateCommand(st, 'place').reason, 'unknown-command');
  assert.equal(validateCommand(st, 42).reason, 'unknown-command');
});

test('round-over: no commands validate on a terminal state', () => {
  const session = makeSession({ w: 3, h: 3, palette: 3, removed: 3 });
  session.concede(0);
  assert.equal(validateCommand(session.state, { type: 'place', tray: 0, cell: 0 }).reason, 'round-over');
  assert.equal(validateCommand(session.state, { type: 'concede' }).reason, 'round-over');
  const r = session.dispatch({ type: 'place', tray: 0, cell: 0 }, 100);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'round-over');
});

test('bad-tray-slot: out-of-range / non-integer tray indices', () => {
  const st = makeState({ w: 3, h: 3, palette: 3, removed: 2, rotation: true });
  const cell = st.cells.findIndex((c) => c === null);
  for (const tray of [-1, 999, 1.5, NaN, '0']) {
    assert.equal(validateCommand(st, { type: 'place', tray, cell }).reason, 'bad-tray-slot', 'tray=' + tray);
    assert.equal(validateCommand(st, { type: 'rotateTray', tray }).reason, 'bad-tray-slot', 'rotate tray=' + tray);
  }
});

test('bad-cell: out-of-range / non-integer cell indices', () => {
  const st = makeState({ w: 3, h: 3, palette: 3, removed: 2, lock: true });
  const tray = st.tray.findIndex((t) => t !== null);
  for (const cell of [-1, 999, 2.5, NaN, '0']) {
    assert.equal(validateCommand(st, { type: 'place', tray, cell }).reason, 'bad-cell', 'place cell=' + cell);
    assert.equal(validateCommand(st, { type: 'recall', cell }).reason, 'bad-cell', 'recall cell=' + cell);
    assert.equal(validateCommand(st, { type: 'swap', a: cell, b: 0 }).reason, 'bad-cell', 'swap a=' + cell);
    assert.equal(validateCommand(st, { type: 'swap', a: 0, b: cell }).reason, 'bad-cell', 'swap b=' + cell);
    assert.equal(validateCommand(st, { type: 'lock', cell }).reason, 'bad-cell', 'lock cell=' + cell);
  }
});

test('tray-slot-empty: cannot place or rotate from an empty slot', () => {
  const st = makeState({ w: 3, h: 3, palette: 3, removed: 2, rotation: true });
  const tray = st.tray.findIndex((t) => t !== null);
  const cell = st.cells.findIndex((c) => c === null);
  applyCommand(st, { type: 'place', tray, cell });
  const cell2 = st.cells.findIndex((c) => c === null);
  assert.equal(validateCommand(st, { type: 'place', tray, cell: cell2 }).reason, 'tray-slot-empty');
  assert.equal(validateCommand(st, { type: 'rotateTray', tray }).reason, 'tray-slot-empty');
});

test('cell-occupied: cannot place into an occupied cell', () => {
  const st = makeState({ w: 3, h: 3, palette: 3, removed: 2 });
  const occupied = st.cells.findIndex((c) => c !== null); // anchored card
  const tray = st.tray.findIndex((t) => t !== null);
  assert.ok(occupied >= 0);
  assert.equal(validateCommand(st, { type: 'place', tray, cell: occupied }).reason, 'cell-occupied');
});

test('cell-empty: recall/swap/lock need cards in the cells', () => {
  const st = makeState({ w: 3, h: 3, palette: 3, removed: 2, lock: true });
  const empty = st.cells.findIndex((c) => c === null);
  const occupied = st.cells.findIndex((c) => c !== null);
  assert.equal(validateCommand(st, { type: 'recall', cell: empty }).reason, 'cell-empty');
  assert.equal(validateCommand(st, { type: 'swap', a: empty, b: occupied }).reason, 'cell-empty');
  assert.equal(validateCommand(st, { type: 'swap', a: occupied, b: empty }).reason, 'cell-empty');
  assert.equal(validateCommand(st, { type: 'lock', cell: empty }).reason, 'cell-empty');
});

test('card-locked: locked cards cannot be recalled or swapped', () => {
  const st = instantiate(generatePuzzle('rules-locked', 'rules-locked-seed', {
    w: 3, h: 3, palette: 3, removed: 2, lock: true, prelocked: 1,
  }));
  const lockedCell = st.cells.findIndex((id) => id !== null && st.cards[id].locked);
  const otherOccupied = st.cells.findIndex((id) => id !== null && !st.cards[id].locked);
  assert.ok(lockedCell >= 0 && otherOccupied >= 0);
  assert.equal(validateCommand(st, { type: 'recall', cell: lockedCell }).reason, 'card-locked');
  assert.equal(validateCommand(st, { type: 'swap', a: lockedCell, b: otherOccupied }).reason, 'card-locked');
  assert.equal(validateCommand(st, { type: 'swap', a: otherOccupied, b: lockedCell }).reason, 'card-locked');
});

test('same-cell: swap requires two distinct cells', () => {
  const st = makeState({ w: 3, h: 3, palette: 3, removed: 2 });
  assert.equal(validateCommand(st, { type: 'swap', a: 0, b: 0 }).reason, 'same-cell');
});

test('no-tray-slot: anchored cards cannot be recalled (regression: card vanished into tray[-1])', () => {
  const st = makeState({ w: 3, h: 3, palette: 3, removed: 2 });
  const anchored = st.cells.findIndex((id) => id !== null && st.cards[id].slot < 0 && !st.cards[id].locked);
  assert.ok(anchored >= 0);
  assert.equal(validateCommand(st, { type: 'recall', cell: anchored }).reason, 'no-tray-slot');
  // listLegalCommands must not propose it either
  assert.ok(!listLegalCommands(st).some((c) => c.type === 'recall' && c.cell === anchored));
});

test('rotation-disabled: rotateTray rejected without the rotation mechanic', () => {
  const st = makeState({ w: 3, h: 3, palette: 3, removed: 2, rotation: false });
  const tray = st.tray.findIndex((t) => t !== null);
  assert.equal(validateCommand(st, { type: 'rotateTray', tray }).reason, 'rotation-disabled');
});

test('lock-disabled: lock rejected without the lock mechanic', () => {
  const st = makeState({ w: 3, h: 3, palette: 3, removed: 2, lock: false });
  const cell = st.cells.findIndex((c) => c !== null);
  assert.equal(validateCommand(st, { type: 'lock', cell }).reason, 'lock-disabled');
});

test('already-locked: locking a locked card is rejected', () => {
  const st = instantiate(generatePuzzle('rules-alock', 'rules-alock-seed', {
    w: 3, h: 3, palette: 3, removed: 2, lock: true, prelocked: 1,
  }));
  const lockedCell = st.cells.findIndex((id) => id !== null && st.cards[id].locked);
  assert.equal(validateCommand(st, { type: 'lock', cell: lockedCell }).reason, 'already-locked');
});

test('neighbors-mismatch: lock requires all placed neighbors to match', () => {
  const content = generatePuzzle('rules-nm', 'rules-nm-seed', { w: 3, h: 3, palette: 2, removed: 9, lock: true });
  const st = createInitialState(content);
  // place the solution card for cell 0
  const sol0 = content.solution[0];
  const tray0 = st.cards[sol0.card].slot;
  assert.equal(validateCommand(st, { type: 'place', tray: tray0, cell: 0 }).ok, true);
  applyCommand(st, { type: 'place', tray: tray0, cell: 0 });
  // find a tray card that mismatches cell 0 on the shared edge, place adjacent
  const eff0 = effectiveEdges(st.cards[sol0.card]);
  let placed = false;
  for (let tray = 0; tray < st.tray.length && !placed; tray++) {
    const id = st.tray[tray];
    if (id === null) continue;
    for (const n of neighbors(st, 0)) {
      const dir = directionBetween(st, 0, n);
      if (effectiveEdges(st.cards[id])[(dir + 2) % 4] !== eff0[dir]) {
        assert.equal(validateCommand(st, { type: 'place', tray, cell: n }).ok, true);
        applyCommand(st, { type: 'place', tray, cell: n });
        placed = true;
        break;
      }
    }
  }
  assert.ok(placed, 'test data must contain a mismatching neighbor placement');
  assert.equal(validateCommand(st, { type: 'lock', cell: 0 }).reason, 'neighbors-mismatch');
});

test('lock validation agrees with analyzeBoard on a fully solved board', () => {
  // regression: directionBetween had N/S swapped, rejecting every lock
  const content = generatePuzzle('rules-lc', 'rules-lc-seed', { w: 3, h: 3, palette: 3, removed: 4, lock: true });
  const st = createInitialState(content);
  for (let cell = 0; cell < st.cells.length; cell++) {
    const sol = content.solution[cell];
    if (!sol || st.cells[cell] !== null) continue;
    applyCommand(st, { type: 'place', tray: st.cards[sol.card].slot, cell });
  }
  assert.ok(isSolved(st));
  for (let cell = 0; cell < st.cells.length; cell++) {
    assert.equal(validateCommand(st, { type: 'lock', cell }).ok, true, 'cell ' + cell);
  }
});

// ---------------------------------------------------------------------------
// scoring components
// ---------------------------------------------------------------------------

test('scoring: matched edges score PER_MATCHED_EDGE live', () => {
  const content = generatePuzzle('rules-sm', 'rules-sm-seed', { w: 3, h: 3, palette: 3, removed: 9 });
  const st = createInitialState(content);
  // place solution cards for cells 0 and 1 (adjacent, matching in solution)
  for (const cell of [0, 1]) {
    const sol = content.solution[cell];
    applyCommand(st, { type: 'place', tray: st.cards[sol.card].slot, cell });
  }
  const a = analyzeBoard(st);
  assert.equal(st.score.matched, a.matched * SCORE.PER_MATCHED_EDGE);
  assert.ok(a.matched >= 1, 'solution-adjacent cards must match');
});

test('scoring: lock bonus = lockedCount * PER_LOCK', () => {
  const content = generatePuzzle('rules-sl', 'rules-sl-seed', { w: 3, h: 3, palette: 3, removed: 3, lock: true });
  const session = new Session(content, { mode: 'practice', sessionId: 'rules-sl-s' });
  solveSession(session, { lock: true, idPrefix: 'sl' });
  assert.ok(session.state.lockedCount >= 1);
  assert.equal(session.result.score.locks, session.state.lockedCount * SCORE.PER_LOCK);
});

test('scoring: completion = COMPLETION_BASE + PER_CELL * cells', () => {
  const content = generatePuzzle('rules-sc', 'rules-sc-seed', { w: 2, h: 2, palette: 2, removed: 2 });
  const session = new Session(content, { mode: 'practice', sessionId: 'rules-sc-s' });
  solveSession(session, { idPrefix: 'sc' });
  assert.equal(session.result.score.completion, SCORE.COMPLETION_BASE + SCORE.COMPLETION_PER_CELL * 4);
});

test('scoring: swap penalty subtracts PER_SWAP per swap', () => {
  const content = generatePuzzle('rules-ss', 'rules-ss-seed', { w: 3, h: 3, palette: 3, removed: 2 });
  const session = new Session(content, { mode: 'practice', sessionId: 'rules-ss-s' });
  const st = session.state;
  const t1 = st.tray.findIndex((t) => t !== null);
  const c1 = st.cells.findIndex((c) => c === null);
  session.dispatch({ type: 'place', tray: t1, cell: c1 }, 0);
  const t2 = st.tray.findIndex((t) => t !== null);
  const c2 = st.cells.findIndex((c) => c === null);
  session.dispatch({ type: 'place', tray: t2, cell: c2 }, 0);
  session.dispatch({ type: 'swap', a: c1, b: c2 }, 0);
  assert.equal(st.swapsUsed, 1);
  assert.equal(st.score.swapPenalty, SCORE.SWAP_PENALTY);
  const s = st.score;
  assert.equal(s.total, Math.max(0, s.matched + s.locks + s.completion + s.timeBonus - s.swapPenalty - s.invalidPenalty));
});

test('scoring: invalid penalty = invalidCount * INVALID_PENALTY, total floors at 0', () => {
  const session = makeSession({ w: 3, h: 3, palette: 3, removed: 2 });
  const r = session.dispatch({ type: 'place', tray: 999, cell: 0 }, 0);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'bad-tray-slot');
  assert.equal(session.state.invalidCount, 1);
  assert.equal(session.state.score.invalidPenalty, SCORE.INVALID_PENALTY);
  for (let i = 0; i < 50; i++) session.dispatch({ type: 'place', tray: 999, cell: 0 }, 0);
  assert.equal(session.state.score.total, 0, 'total never goes negative');
});

test('scoring: time bonus in a timed puzzle = floor((limit - elapsed)/1000)', () => {
  const content = generatePuzzle('rules-tb', 'rules-tb-seed', {
    w: 2, h: 2, palette: 2, removed: 2, timeLimitMs: 60000,
  });
  const session = new Session(content, { mode: 'challenge', sessionId: 'rules-tb-s' });
  solveSession(session, { idPrefix: 'tb', stepMs: 500 });
  const res = session.result;
  assert.equal(res.terminalReason, TERMINAL.COMPLETE);
  const expected = Math.floor((60000 - res.elapsedMs) / 1000);
  assert.ok(expected > 0);
  assert.equal(res.score.timeBonus, expected);
});

test('scoring: total = sum of components', () => {
  const content = generatePuzzle('rules-tot', 'rules-tot-seed', {
    w: 3, h: 3, palette: 3, removed: 3, lock: true, timeLimitMs: 120000,
  });
  const session = new Session(content, { mode: 'challenge', sessionId: 'rules-tot-s' });
  solveSession(session, { lock: true, idPrefix: 'tot', stepMs: 500 });
  const s = session.result.score;
  assert.equal(s.total, s.matched + s.locks + s.completion + s.timeBonus - s.swapPenalty - s.invalidPenalty);
});

// ---------------------------------------------------------------------------
// terminal reasons
// ---------------------------------------------------------------------------

test('terminal: complete when the mosaic is solved', () => {
  const content = generatePuzzle('rules-tc', 'rules-tc-seed', { w: 3, h: 3, palette: 3, removed: 3 });
  const session = new Session(content, { mode: 'practice', sessionId: 'rules-tc-s' });
  solveSession(session, { idPrefix: 'tc' });
  assert.equal(session.result.terminalReason, TERMINAL.COMPLETE);
  assert.ok(isSolved(session.state));
});

test('terminal: moves-exhausted when the move limit lapses unsolved', () => {
  const content = generatePuzzle('rules-tm', 'rules-tm-seed', {
    w: 3, h: 3, palette: 3, removed: 2, moveLimit: 2,
  });
  const session = new Session(content, { mode: 'challenge', sessionId: 'rules-tm-s' });
  const st = session.state;
  // place the first tray card into the *other* empty cell (legal, unsolved)
  const emptyCells = st.cells.map((c, i) => (c === null ? i : -1)).filter((i) => i >= 0);
  const tray = st.tray.findIndex((t) => t !== null);
  const wrongCell = emptyCells.find((c) => content.solution[c].card !== st.tray[tray]);
  session.dispatch({ type: 'place', tray, cell: wrongCell }, 0);   // move 1
  assert.equal(session.result, null);
  session.dispatch({ type: 'recall', cell: wrongCell }, 0);        // move 2 -> limit, unsolved
  assert.equal(session.result.terminalReason, TERMINAL.MOVES_EXHAUSTED);
  assert.equal(session.state.score.completion, 0);
});

test('terminal: time-up via clockUpdate in a timed puzzle', () => {
  const content = generatePuzzle('rules-tt', 'rules-tt-seed', {
    w: 3, h: 3, palette: 3, removed: 3, timeLimitMs: 60000,
  });
  const session = new Session(content, { mode: 'daily', sessionId: 'rules-tt-s' });
  assert.equal(session.clockUpdate(59999), null);
  const res = session.clockUpdate(60000);
  assert.equal(res.terminalReason, TERMINAL.TIME_UP);
  assert.equal(session.state.status, 'terminal');
  assert.equal(session.clockUpdate(70000), null, 'clock after terminal is inert');
});

test('terminal: conceded via concede()', () => {
  const session = makeSession({ w: 3, h: 3, palette: 3, removed: 3 });
  session.concede(12345);
  assert.equal(session.result.terminalReason, TERMINAL.CONCEDED);
  assert.equal(session.result.score.completion, 0);
  assert.equal(session.state.elapsedMs, quantizeElapsed(12345));
});

test('terminalCondition: completion outranks exhaustion', () => {
  const content = generatePuzzle('rules-tp', 'rules-tp-seed', {
    w: 2, h: 2, palette: 2, removed: 1, moveLimit: 1,
  });
  const st = instantiate(content);
  const sol = content.solution[st.cells.findIndex((c) => c === null)];
  const cell = Number(Object.keys(content.solution).find((k) => content.solution[k] === sol));
  applyCommand(st, { type: 'place', tray: st.cards[sol.card].slot, cell });
  assert.equal(terminalCondition(st), TERMINAL.COMPLETE); // solved on the last move
});

// ---------------------------------------------------------------------------
// analyzeBoard / listLegalCommands
// ---------------------------------------------------------------------------

test('analyzeBoard: counts matched/mismatched/open pairs', () => {
  const solved = instantiate(generatePuzzle('rules-ab1', 'rules-ab1-seed', { w: 3, h: 3, palette: 3, removed: 0 }));
  const a1 = analyzeBoard(solved);
  assert.equal(a1.pairs.length, 12);           // 3x3: 6 horizontal + 6 vertical
  assert.equal(a1.matched, 12);
  assert.equal(a1.mismatched, 0);
  assert.equal(a1.open, 0);

  const empty = createInitialState(generatePuzzle('rules-ab2', 'rules-ab2-seed', { w: 3, h: 3, palette: 3, removed: 9 }));
  const a2 = analyzeBoard(empty);
  assert.equal(a2.open, 12);
  assert.equal(a2.matched, 0);
  assert.equal(emptyCellCount(empty), 9);

  // partial: one matching pair placed
  const content = generatePuzzle('rules-ab3', 'rules-ab3-seed', { w: 3, h: 3, palette: 3, removed: 9 });
  const st = createInitialState(content);
  for (const cell of [0, 1]) {
    const sol = content.solution[cell];
    applyCommand(st, { type: 'place', tray: st.cards[sol.card].slot, cell });
  }
  const a3 = analyzeBoard(st);
  assert.equal(a3.matched + a3.mismatched + a3.open, 12);
  assert.ok(a3.matched >= 1);
  assert.ok(a3.open >= 1);
  for (const p of a3.pairs) {
    if (p.open) assert.equal(p.matched, false);
  }
});

test('listLegalCommands: enumerates valid commands, empty when terminal', () => {
  const st = makeState({ w: 3, h: 3, palette: 3, removed: 2, rotation: true });
  const legal = listLegalCommands(st);
  const trayCards = st.tray.filter((t) => t !== null).length;
  const emptyCells = st.cells.filter((c) => c === null).length;
  const recallable = st.cells.filter((id) => id !== null && !st.cards[id].locked && st.cards[id].slot >= 0).length;
  const places = legal.filter((c) => c.type === 'place').length;
  const rotates = legal.filter((c) => c.type === 'rotateTray').length;
  const recalls = legal.filter((c) => c.type === 'recall').length;
  assert.equal(places, trayCards * emptyCells);
  assert.equal(rotates, trayCards);
  assert.equal(recalls, recallable);
  for (const cmd of legal) assert.equal(validateCommand(st, cmd).ok, true, canonicalStringify(cmd));
  // terminal -> no legal commands
  st.status = 'terminal';
  assert.deepEqual(listLegalCommands(st), []);
});

// ---------------------------------------------------------------------------
// compareResults tiebreak order
// ---------------------------------------------------------------------------

test('compareResults: completion > score > fewer invalids > lower elapsed > session id', () => {
  const mk = (over) => ({
    terminalReason: TERMINAL.COMPLETE, score: { total: 100 },
    invalidCount: 0, elapsedMs: 1000, sessionId: 'a', ...over,
  });
  // completion dominates everything
  assert.ok(compareResults(mk({}), mk({ terminalReason: TERMINAL.CONCEDED, score: { total: 99999 } })) < 0);
  // then higher total
  assert.ok(compareResults(mk({ score: { total: 200 } }), mk({ score: { total: 100 } })) < 0);
  // then fewer invalids
  assert.ok(compareResults(mk({ invalidCount: 1 }), mk({ invalidCount: 2 })) < 0);
  // then lower elapsed
  assert.ok(compareResults(mk({ elapsedMs: 500 }), mk({ elapsedMs: 900 })) < 0);
  // then session id
  assert.ok(compareResults(mk({ sessionId: 'aaa' }), mk({ sessionId: 'bbb' })) < 0);
  assert.ok(compareResults(mk({ sessionId: 'bbb' }), mk({ sessionId: 'aaa' })) > 0);
  assert.equal(compareResults(mk({}), mk({})), 0);
});
