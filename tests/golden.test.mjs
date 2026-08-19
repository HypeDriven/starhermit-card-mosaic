// golden.test.mjs — end-to-end golden sessions: solver-completed games with
// exact score accounting, snapshot/restore continuity, interrupted rounds,
// resumed dailies, and lesson playthroughs.

import assert from 'node:assert/strict';
import { SCORE, TERMINAL } from '../js/rules.js';
import { journeyContent, dailyContent, lessonContent, LESSONS } from '../js/content.js';
import { Session } from '../js/session.js';
import {
  test, makeCtx, placeNextSolutionCard, solveSession,
} from './helpers.mjs';

function assertComponentsAddUp(result) {
  const s = result.score;
  assert.equal(
    s.total,
    Math.max(0, s.matched + s.locks + s.completion + s.timeBonus - s.swapPenalty - s.invalidPenalty),
    'score components must add up to total',
  );
}

function assertResultShape(result) {
  for (const key of ['contentId', 'seed', 'contentVersion', 'sessionId', 'assists']) {
    assert.ok(result[key] !== undefined && result[key] !== null, 'result.' + key);
  }
  assert.equal(typeof result.assists.hints, 'number');
  assert.equal(typeof result.assists.undos, 'number');
}

// ---------------------------------------------------------------------------
// solved golden sessions
// ---------------------------------------------------------------------------

test('golden easy: journey stage 4 solves to exactly 265', () => {
  const content = journeyContent(3); // 3x3, no mechanics
  const session = new Session(content, { mode: 'journey', sessionId: 'golden-easy' });
  solveSession(session, { idPrefix: 'ge', stepMs: 1000 });
  const res = session.result;
  assert.equal(res.terminalReason, TERMINAL.COMPLETE);
  assert.equal(res.score.matched, 12 * SCORE.PER_MATCHED_EDGE);       // 12 internal pairs
  assert.equal(res.score.completion, SCORE.COMPLETION_BASE + SCORE.COMPLETION_PER_CELL * 9);
  assert.equal(res.score.locks, 0);
  assert.equal(res.score.timeBonus, 0);                               // untimed
  assert.equal(res.score.total, 265);
  assertComponentsAddUp(res);
  assertResultShape(res);
});

test('golden medium: lock-mechanic stage with decoy, prelocks and lock bonus', () => {
  const content = journeyContent(13); // 4x4, rotation+lock, 1 decoy, 3 prelocked
  const session = new Session(content, { mode: 'journey', sessionId: 'golden-medium' });
  solveSession(session, { idPrefix: 'gm', stepMs: 1000, lock: true });
  const res = session.result;
  assert.equal(res.terminalReason, TERMINAL.COMPLETE);
  assert.ok(res.score.locks >= (3 + 1) * SCORE.PER_LOCK, 'prelocked + solver locks: ' + res.score.locks);
  assert.equal(res.score.locks, session.state.lockedCount * SCORE.PER_LOCK);
  assert.equal(res.score.matched, 24 * SCORE.PER_MATCHED_EDGE);       // 4x4: 24 pairs
  assertComponentsAddUp(res);
  assertResultShape(res);
});

test('golden hard: 6x5 full lift with decoys solves completely', () => {
  const content = journeyContent(24); // 6x5, removed 30, 3 decoys
  const session = new Session(content, { mode: 'journey', sessionId: 'golden-hard' });
  solveSession(session, { idPrefix: 'gh', stepMs: 800 });
  const res = session.result;
  assert.equal(res.terminalReason, TERMINAL.COMPLETE);
  assert.equal(res.score.matched, 49 * SCORE.PER_MATCHED_EDGE);       // 6x5: 30+... 5*5+6*4=49
  assert.equal(res.score.completion, SCORE.COMPLETION_BASE + SCORE.COMPLETION_PER_CELL * 30);
  // decoys never left the tray
  assert.ok(session.state.tray.filter((id) => id !== null && id.startsWith('x')).length === 3);
  assertComponentsAddUp(res);
  assertResultShape(res);
});

test('golden: mid-game snapshot -> restore -> finish matches uninterrupted run', () => {
  const content = journeyContent(13);
  // uninterrupted reference run; its command log is the deterministic script
  const ref = new Session(content, { mode: 'journey', sessionId: 'golden-resume' });
  solveSession(ref, { idPrefix: 'gr', stepMs: 1000, lock: true });
  const log = ref.commands.map((c) => ({ ...c }));

  // resumable run: replay the script up to the midpoint, snapshot, restore,
  // then play the remainder — must land on the exact same final hash
  const live = new Session(content, { mode: 'journey', sessionId: 'golden-resume' });
  const mid = Math.floor(log.length / 2);
  for (const c of log.slice(0, mid)) live.dispatch({ ...c }, c.elapsed);
  const snap = JSON.parse(JSON.stringify(live.snapshot())); // through the wire
  const restored = Session.restore(snap);
  assert.ok(restored, 'restore must succeed');
  assert.equal(restored.stateHash, live.stateHash, 'restored hash');
  for (const c of log.slice(mid)) restored.dispatch({ ...c }, c.elapsed);
  assert.ok(restored.result);
  assert.equal(restored.result.terminalReason, TERMINAL.COMPLETE);
  assert.equal(restored.stateHash, ref.stateHash, 'same final hash after resume');
  assert.deepEqual(restored.result, ref.result);
  assertComponentsAddUp(restored.result);
});

// ---------------------------------------------------------------------------
// interrupted / resumed sessions
// ---------------------------------------------------------------------------

test('golden interrupted: concede yields conceded with zero completion', () => {
  const content = journeyContent(8);
  const session = new Session(content, { mode: 'journey', sessionId: 'golden-stop' });
  const ctx = makeCtx({ idPrefix: 'gs' });
  placeNextSolutionCard(session, ctx);
  placeNextSolutionCard(session, ctx);
  const r = session.concede(ctx.tick());
  assert.equal(r.ok, true);
  const res = session.result;
  assert.equal(res.terminalReason, TERMINAL.CONCEDED);
  assert.equal(res.score.completion, 0);
  assert.equal(res.score.timeBonus, 0);
  assertComponentsAddUp(res);
  assertResultShape(res);
});

test('golden resumed daily: two fresh sessions, identical commands -> identical results', () => {
  const content = dailyContent('2026-08-18');
  const run = () => {
    const session = new Session(content, { mode: 'daily', sessionId: 'golden-daily' });
    solveSession(session, { idPrefix: 'gd', stepMs: 1000, lock: true });
    return session;
  };
  const a = run();
  const b = run();
  assert.equal(a.stateHash, b.stateHash);
  assert.deepEqual(a.result, b.result);
  // and through the replay envelope as well
  const replayed = Session.replay(content, a.serializeReplay());
  assert.equal(replayed.ok, true, JSON.stringify(replayed.mismatches));
  assert.equal(replayed.hash, a.stateHash);
  assert.equal(a.result.terminalReason, TERMINAL.COMPLETE);
  assertResultShape(a.result);
});

// ---------------------------------------------------------------------------
// lessons: every required command type appears in the log
// ---------------------------------------------------------------------------

test('golden lessons: each lesson plays through its steps to terminal', () => {
  for (const l of LESSONS) {
    const { lesson, content } = lessonContent(l.id);
    const session = new Session(content, { mode: 'learn', lesson, sessionId: 'golden-' + l.id });
    const ctx = makeCtx({ idPrefix: l.id, stepMs: 1000 });
    const tag = l.id;
    let lastPlaced = null;

    const doCmd = (cmd) => {
      const r = session.dispatch({ ...cmd, id: ctx.id() }, ctx.tick());
      assert.equal(r.ok, true, tag + ': ' + cmd.type + ' rejected: ' + r.reason);
    };

    for (const step of lesson.steps) {
      const need = step.require.type;
      if (need === 'terminal') {
        while (!session.result && placeNextSolutionCard(session, ctx) !== null) { /* solve */ }
        assert.ok(session.result, tag + ': terminal step reached no result');
        continue;
      }
      if (need === 'place') {
        lastPlaced = placeNextSolutionCard(session, ctx);
        assert.notEqual(lastPlaced, null, tag + ': nothing to place');
      } else if (need === 'rotateTray') {
        const tray = session.state.tray.findIndex((t) => t !== null);
        assert.ok(tray >= 0, tag + ': no tray card to rotate');
        doCmd({ type: 'rotateTray', tray });
      } else if (need === 'recall') {
        // recall the tray-originated card we just placed (anchored cards own
        // no tray slot and cannot be recalled)
        if (lastPlaced === null || session.state.cells[lastPlaced] === null) {
          lastPlaced = placeNextSolutionCard(session, ctx);
          assert.notEqual(lastPlaced, null, tag + ': place before recall');
        }
        doCmd({ type: 'recall', cell: lastPlaced });
        lastPlaced = null;
      } else if (need === 'lock') {
        let guard = 0;
        while (!session.legalCommands().some((c) => c.type === 'lock')) {
          assert.notEqual(placeNextSolutionCard(session, ctx), null, tag + ': place before lock');
          assert.ok(++guard < 50, tag + ': lock never became legal');
        }
        doCmd(session.legalCommands().find((c) => c.type === 'lock'));
      }
    }

    // finish whatever remains
    while (!session.result && placeNextSolutionCard(session, ctx) !== null) { /* solve */ }
    assert.ok(session.result, tag + ': lesson must complete');
    assert.equal(session.result.terminalReason, TERMINAL.COMPLETE, tag);

    const logged = new Set(session.commands.map((c) => c.type));
    for (const step of lesson.steps) {
      const need = step.require.type;
      if (need === 'terminal') assert.ok(session.result, tag + ': terminal requirement');
      else assert.ok(logged.has(need), tag + ': required command ' + need + ' missing from log');
    }
    assertComponentsAddUp(session.result);
  }
});
