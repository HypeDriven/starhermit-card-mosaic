// replay.test.mjs — property test: random content x random legal command
// sequences must serialize/replay/restore/undo deterministically.

import assert from 'node:assert/strict';
import {
  JOURNEY, journeyContent, dailyKey, dailyContent,
  PRACTICE_DIFFICULTIES, practiceContent, CHALLENGES, challengeContent,
  validateContent,
} from '../js/content.js';
import { hashState } from '../js/rules.js';
import { Session } from '../js/session.js';
import { test, createRng, playRandom } from './helpers.mjs';

function pickContent(rng, i) {
  const kind = rng.pick(['journey', 'practice', 'challenge', 'daily']);
  switch (kind) {
    case 'journey': {
      const idx = rng.int(JOURNEY.length);
      return { content: journeyContent(idx), mode: 'journey', label: `journey-${idx}` };
    }
    case 'practice': {
      const d = rng.pick(PRACTICE_DIFFICULTIES);
      const seed = 'rp-' + rng.int(100000);
      return { content: practiceContent(d.id, seed), mode: 'practice', label: `practice-${d.id}` };
    }
    case 'challenge': {
      const c = rng.pick(CHALLENGES);
      const seed = 'rc-' + rng.int(100000);
      return { content: challengeContent(c.id, seed), mode: 'challenge', label: `challenge-${c.id}` };
    }
    case 'daily': {
      const day = 19000 + rng.int(2000); // arbitrary deterministic epoch days
      const key = dailyKey(new Date(day * 86400000));
      return { content: dailyContent(key), mode: 'daily', label: `daily-${key}` };
    }
  }
}

test('property: replay/restore/undo/determinism across 40 random sessions', () => {
  const rng = createRng('replay-property-v1');
  let terminalCount = 0;

  for (let i = 0; i < 40; i++) {
    const { content, mode, label } = pickContent(rng, i);
    assert.equal(validateContent(content).ok, true, label + ' content invalid');
    const session = new Session(content, { mode, sessionId: 'prop-' + i });
    const initialHash = session.stateHash;
    const count = rng.intRange(2, 30);
    playRandom(session, rng, count, { invalidRate: 0.2, idPrefix: 'p' + i });
    // move-limited content: keep playing randomly until the budget lapses,
    // so the terminal path (auto-settle) is exercised by the property run
    let guard = 0;
    while (!session.result && session.state.moveLimit !== null && guard++ < 300) {
      playRandom(session, rng, 1, { invalidRate: 0.1, idPrefix: 'p' + i + 'x' + guard });
    }
    const tag = `#${i} ${label} cmds=${session.commands.length}`;

    // 1) serializeReplay -> Session.replay: ok and identical hash
    const envelope = session.serializeReplay();
    const replayed = Session.replay(content, envelope);
    assert.equal(replayed.ok, true, tag + ' replay mismatches: ' + JSON.stringify(replayed.mismatches));
    assert.equal(replayed.hash, session.stateHash, tag + ' replay hash');

    // 2) snapshot -> restore: identical hash
    const snap = session.snapshot();
    const restored = Session.restore(JSON.parse(JSON.stringify(snap)));
    assert.ok(restored, tag + ' restore returned null');
    assert.equal(restored.stateHash, session.stateHash, tag + ' restore hash');

    // 3) same commands into a fresh session -> identical hash (pure determinism)
    const twin = new Session(content, { mode, sessionId: 'twin-' + i });
    for (const raw of session.commands) {
      const cmd = { ...raw };
      delete cmd.invalid;
      twin.dispatch(cmd, cmd.elapsed ?? cmd.elapsedMs ?? 0);
    }
    assert.equal(twin.stateHash, session.stateHash, tag + ' twin hash');

    // 4) undo to start -> initial hash (only where mode rules allow undo and
    //    the round is live; otherwise undo must be refused)
    if (!session.undoAllowed) {
      assert.equal(session.undo().ok, false, tag + ' undo must be disallowed in mode ' + mode);
    } else if (session.result) {
      terminalCount++;
      assert.equal(session.undo().ok, false, tag + ' undo must be unavailable after terminal');
      assert.equal(restored.undo().ok, false, tag + ' restored undo after terminal');
    } else {
      while (session.undo().ok) { /* pop everything */ }
      assert.equal(session.stateHash, initialHash, tag + ' undo-to-start hash');
      assert.equal(session.commands.length, 0, tag + ' undo empties the log');
    }

    // state must always stay JSON-serializable
    assert.equal(hashState(JSON.parse(JSON.stringify(session.state))), session.stateHash, tag + ' JSON round-trip');
  }

  // sanity: the mix should reach both live and terminal outcomes
  assert.ok(terminalCount > 0, 'expected some sessions to reach terminal');
  assert.ok(terminalCount < 40, 'expected some sessions to stay live');
});
