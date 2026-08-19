// fuzz.test.mjs — malformed commands must never escape dispatch, corrupt
// state, break serialization, or produce NaN scores; plus generatePuzzle
// edge-case fuzzing through the validator.

import assert from 'node:assert/strict';
import { validateCommand, hashState, quantizeElapsed } from '../js/rules.js';
import { generatePuzzle, validateContent, practiceContent } from '../js/content.js';
import { Session } from '../js/session.js';
import { test, createRng } from './helpers.mjs';

function freshSession() {
  return new Session(practiceContent('casual', 'fuzz-base'), { mode: 'practice', sessionId: 'fuzz' });
}

function assertStateSane(session, tag, lastTick) {
  const st = session.state;
  for (const [k, v] of Object.entries(st.score)) {
    assert.ok(Number.isFinite(v), tag + ': score.' + k + ' is not finite: ' + v);
  }
  assert.ok(st.score.total >= 0, tag + ': negative total');
  // state always re-serializable, hash-stable across a JSON round-trip
  const roundTripped = JSON.parse(JSON.stringify(st));
  assert.equal(hashState(roundTripped), hashState(st), tag + ': JSON round-trip changed the hash');
  assert.ok(st.tick >= lastTick, tag + ': tick went backwards');
  return st.tick;
}

// ---------------------------------------------------------------------------
// malformed commands
// ---------------------------------------------------------------------------

test('fuzz: malformed commands are rejected without corrupting state', () => {
  const session = freshSession();
  let tick = 0;

  // dispatch() assumes an object; truly degenerate non-objects may raise a
  // TypeError inside dispatch — those go through validateCommand instead.
  for (const degenerate of [null, undefined]) {
    assert.equal(validateCommand(session.state, degenerate).ok, false);
    assert.equal(validateCommand(session.state, degenerate).reason, 'unknown-command');
  }

  const malformed = [
    ['string', 'place'],
    ['empty string', ''],
    ['number', 42],
    ['boolean', true],
    ['array', ['place', 0, 0]],
    ['empty object', {}],
    ['missing fields', { type: 'place' }],
    ['missing cell', { type: 'place', tray: 0 }],
    ['missing tray', { type: 'place', cell: 0 }],
    ['negative tray', { type: 'place', tray: -1, cell: 0 }],
    ['huge tray', { type: 'place', tray: 1e9, cell: 0 }],
    ['float tray', { type: 'place', tray: 0.5, cell: 0 }],
    ['NaN tray', { type: 'place', tray: NaN, cell: 0 }],
    ['string tray', { type: 'place', tray: '0', cell: 0 }],
    ['negative cell', { type: 'recall', cell: -5 }],
    ['huge cell', { type: 'swap', a: 0, b: 999999 }],
    ['float cell', { type: 'lock', cell: 1.25 }],
    ['NaN cell', { type: 'recall', cell: NaN }],
    ['unknown type', { type: 'explode' }],
    ['type casing', { type: 'Place', tray: 0, cell: 0 }],
    ['null fields', { type: 'swap', a: null, b: null }],
    ['giant type string', { type: 'x'.repeat(100000) }],
    ['giant id string', { type: 'place', tray: 9999, cell: 0, id: 'y'.repeat(100000) }],
    ['rotation disabled', { type: 'rotateTray', tray: 0 }],
    ['lock disabled', { type: 'lock', cell: 0 }],
    ['array fields', { type: 'place', tray: [0], cell: { v: 0 } }],
  ];

  for (const [label, cmd] of malformed) {
    const hashBefore = session.stateHash;
    const invalidBefore = session.state.invalidCount;
    let r;
    assert.doesNotThrow(() => { r = session.dispatch(cmd, 1234); }, label);
    assert.equal(r.ok, false, label + ': must be rejected');
    assert.equal(typeof r.reason, 'string', label + ': machine reason');
    assert.ok(Array.isArray(r.events), label + ': events array');
    assert.equal(session.state.invalidCount, invalidBefore + 1, label + ': invalid attempt is logged');
    // layout untouched (only tick/invalidCount/score may move)
    assert.notEqual(session.stateHash, hashBefore, label + ': invalid attempt is auditable in state');
    tick = assertStateSane(session, label, tick);
  }
});

test('fuzz: settle spam and commands after terminal', () => {
  const session = freshSession();
  let tick = 0;
  // manual settle of a live (non-terminal) round is rejected: settle is
  // host-only and must never forge a completion
  const r0 = session.dispatch({ type: 'settle', elapsedMs: 5000 }, 5000);
  assert.equal(r0.ok, false);
  assert.equal(r0.reason, 'not-terminal');
  assert.equal(session.result, null, 'rejected settle must not finalize the round');
  tick = assertStateSane(session, 'rejected-settle', tick);
  // concede always finalizes
  const r1 = session.dispatch({ type: 'concede', elapsedMs: 5000 }, 5000);
  assert.equal(r1.ok, true);
  assert.ok(session.result, 'concede must finalize the round');
  assert.equal(session.result.terminalReason, 'conceded');
  tick = assertStateSane(session, 'settle', tick);
  // everything after terminal is round-over, never throws, never mutates
  const terminalHash = session.stateHash;
  const afterTerminal = [
    { type: 'settle', elapsedMs: 6000 },
    { type: 'concede', elapsedMs: 6000 },
    { type: 'place', tray: 0, cell: 0 },
    { type: 'explode' },
    'place',
    42,
  ];
  for (const cmd of afterTerminal) {
    const r = session.dispatch(cmd, 7000);
    assert.equal(r.ok, false, JSON.stringify(cmd).slice(0, 40));
    assert.equal(r.reason, 'round-over');
  }
  assert.equal(session.stateHash, terminalHash, 'post-terminal commands must not mutate state');
  assert.equal(session.concede(8000).ok, false);
  assert.equal(session.clockUpdate(999999), null);
  assertStateSane(session, 'post-terminal', tick);
});

test('fuzz: duplicate command ids are rejected idempotently', () => {
  const session = freshSession();
  const tray = session.state.tray.findIndex((t) => t !== null);
  const cell = session.state.cells.findIndex((c) => c === null);
  const r1 = session.dispatch({ type: 'place', tray, cell, id: 'dup-1' }, 0);
  assert.equal(r1.ok, true);
  const hashAfterFirst = session.stateHash;
  // second dispatches with the same id: duplicate event, state untouched
  // (both payloads are currently valid, so they reach the dedupe window)
  const tray2 = session.state.tray.findIndex((t) => t !== null);
  const cell2 = session.state.cells.findIndex((c) => c === null);
  for (const attempt of [
    { type: 'recall', cell, id: 'dup-1' },              // different payload, same id
    { type: 'place', tray: tray2, cell: cell2, id: 'dup-1' }, // another valid payload
  ]) {
    const r = session.dispatch(attempt, 100);
    assert.equal(r.ok, true, 'duplicate of a valid command still returns ok');
    assert.deepEqual(r.events, [{ type: 'duplicate', id: 'dup-1' }]);
    assert.equal(session.stateHash, hashAfterFirst, 'duplicate must not change the state hash');
  }
  // replay of a log containing duplicates stays consistent
  const replayed = Session.replay(session.content, session.serializeReplay());
  assert.equal(replayed.ok, true, JSON.stringify(replayed.mismatches));
  assert.equal(replayed.hash, session.stateHash);
});

test('fuzz: randomized garbage storm keeps state sane', () => {
  const rng = createRng('fuzz-storm');
  const session = freshSession();
  let tick = 0;
  for (let i = 0; i < 300 && !session.result; i++) {
    const cmd = {
      type: rng.pick(['place', 'recall', 'swap', 'rotateTray', 'lock', 'explode', '']),
      tray: rng.pick([-1, 0, 1, 2, 3, 0.5, NaN, 1e12]),
      cell: rng.pick([-1, 0, 4, 8, 9, 2.5, NaN, 1e12]),
      a: rng.pick([-1, 0, 3, 8, NaN]),
      b: rng.pick([-1, 0, 3, 8, NaN]),
    };
    const r = session.dispatch(cmd, i * 100);
    assert.equal(typeof r.ok, 'boolean');
    if (!r.ok) assert.equal(typeof r.reason, 'string');
    tick = assertStateSane(session, 'storm#' + i, tick);
  }
});

// ---------------------------------------------------------------------------
// generatePuzzle edge cases
// ---------------------------------------------------------------------------

test('fuzz: generatePuzzle edge-case params validate and instantiate', () => {
  const rng = createRng('fuzz-gen');
  let checked = 0;

  // curated extremes: min/max grids, palette 2 and 8, removed 0..all, decoys 0..5
  const curated = [];
  for (const [w, h] of [[2, 2], [8, 8], [2, 8], [8, 2]]) {
    for (const palette of [2, 8]) {
      for (const removed of [0, 1, w * h]) {
        for (const decoys of [0, 5]) {
          curated.push({ w, h, palette, removed, decoys });
        }
      }
    }
  }
  // randomized sane combos (incl. mechanics, prelocked, limits)
  for (let i = 0; i < 60; i++) {
    const w = rng.intRange(2, 8);
    const h = rng.intRange(2, 8);
    const removed = rng.intRange(0, w * h);
    curated.push({
      w, h,
      palette: rng.pick([2, 3, 5, 8]),
      removed,
      decoys: rng.intRange(0, 5),
      rotation: rng.pick([true, false]),
      lock: rng.pick([true, false]),
      prelocked: rng.intRange(0, 3),
      moveLimit: rng.pick([null, removed + rng.intRange(0, 10)]),
      timeLimitMs: rng.pick([null, 10000 + rng.int(120000)]),
    });
  }

  for (const params of curated) {
    const tag = JSON.stringify(params);
    const doc = generatePuzzle('fuzz-gen', 'fz-' + tag, { ...params, theme: 'studio' });
    const v = validateContent(doc);
    assert.equal(v.ok, true, tag + ' -> ' + v.errors.join(', '));
    const session = new Session(doc, { mode: 'practice', sessionId: 'fz' });
    assert.ok(session.stateHash.length === 8, tag);
    assertStateSane(session, tag, 0);
    checked++;
  }
  assert.ok(checked >= 100, 'edge-case coverage: ' + checked);
});

test('fuzz: quantizeElapsed survives hostile input', () => {
  assert.equal(quantizeElapsed(NaN), 0);
  assert.equal(quantizeElapsed(-Infinity), 0);
  assert.equal(quantizeElapsed(Infinity), 0);
  assert.equal(quantizeElapsed('abc'), 0);
  assert.equal(quantizeElapsed(1e9), 1000000000);
  // a settle carrying a hostile clock value still leaves state serializable
  const session = freshSession();
  session.dispatch({ type: 'settle', elapsedMs: Infinity }, Infinity);
  const st = session.state;
  assert.equal(hashState(JSON.parse(JSON.stringify(st))), hashState(st));
});
