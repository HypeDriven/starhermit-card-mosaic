// helpers.mjs — shared test registry + gameplay helpers for the node suite.
// Imports only environment-agnostic game modules (rules/content/session/rng).

import { listLegalCommands, validateCommand, hashState } from '../js/rules.js';
import { createRng } from '../js/rng.js';

// ---------------------------------------------------------------------------
// tiny test registry (run.mjs drives execution)
// ---------------------------------------------------------------------------

const suites = new Map(); // file -> [{ name, fn }]
let currentFile = '(unregistered)';

export function __setFile(name) { currentFile = name; }
export function __suites() { return suites; }

export function test(name, fn) {
  if (!suites.has(currentFile)) suites.set(currentFile, []);
  suites.get(currentFile).push({ name, fn });
}

// ---------------------------------------------------------------------------
// solver — completes any content doc through real Session commands:
// rotate each tray card to its solution rotation, then place it into its
// solution cell. Deterministic ids/elapsed so sessions are cross-comparable.
// ---------------------------------------------------------------------------

export function makeCtx({ startElapsed = 0, stepMs = 1000, idPrefix = 'cmd' } = {}) {
  let elapsed = startElapsed;
  let n = 0;
  return {
    tick() { elapsed += stepMs; return elapsed; },
    id() { return idPrefix + '-' + n++; },
    get elapsed() { return elapsed; },
  };
}

/**
 * Rotate + place the next not-yet-placed solution card (lowest cell index).
 * Returns the placed cell index, or null when nothing remains to place.
 */
export function placeNextSolutionCard(session, ctx) {
  const { content } = session;
  for (let cell = 0; cell < session.state.cells.length; cell++) {
    const sol = content.solution[cell];
    if (!sol) continue;
    if (session.state.cells[cell] !== null) continue; // anchored or already placed
    const card = session.state.cards[sol.card];
    const target = sol.rot || 0;
    let guard = 0;
    while (session.state.cards[sol.card].rot !== target) {
      if (++guard > 4) throw new Error('solver: rotation loop for ' + sol.card);
      const r = session.dispatch({ type: 'rotateTray', tray: card.slot, id: ctx.id() }, ctx.tick());
      if (!r.ok) throw new Error('solver: rotateTray rejected: ' + r.reason);
    }
    const r = session.dispatch({ type: 'place', tray: card.slot, cell, id: ctx.id() }, ctx.tick());
    if (!r.ok) throw new Error('solver: place rejected at cell ' + cell + ': ' + r.reason);
    return cell;
  }
  return null;
}

/**
 * Solve the puzzle to completion via real commands.
 * opts: { startElapsed, stepMs, idPrefix, lock } — with lock:true, every
 * currently-lockable card is locked after each placement (lock bonus).
 */
export function solveSession(session, opts = {}) {
  const ctx = makeCtx(opts);
  while (!session.result) {
    const placed = placeNextSolutionCard(session, ctx);
    if (opts.lock) {
      for (const cmd of session.legalCommands()) {
        if (cmd.type !== 'lock') continue;
        const r = session.dispatch({ ...cmd, id: ctx.id() }, ctx.tick());
        if (!r.ok) throw new Error('solver: lock rejected: ' + r.reason);
        if (session.result) break;
      }
    }
    if (placed === null) break;
  }
  return session;
}

// ---------------------------------------------------------------------------
// random legal-command player (property / fuzz tests)
// ---------------------------------------------------------------------------

/** A random currently-legal non-terminal command, or null when none exist. */
export function randomLegalCommand(state, rng) {
  const legal = listLegalCommands(state);
  if (legal.length === 0) return null;
  return rng.pick(legal);
}

/** Candidate deliberately-invalid command, or null if none applies here. */
export function randomInvalidCommand(state, rng) {
  const candidates = [
    { type: 'place', tray: 9999, cell: 0 },
    { type: 'place', tray: 0, cell: 9999 },
    { type: 'place', tray: -1, cell: 0 },
    { type: 'place', tray: 0.5, cell: 0 },
    { type: 'swap', a: 0, b: 0 },
    { type: 'recall', cell: 9999 },
    { type: 'definitely-not-a-command' },
  ];
  const emptyCell = state.cells.findIndex((c) => c === null);
  if (emptyCell >= 0) candidates.push({ type: 'recall', cell: emptyCell });
  const emptyTray = state.tray.findIndex((t) => t === null);
  if (emptyTray >= 0 && state.cells.some((c) => c === null)) {
    candidates.push({ type: 'place', tray: emptyTray, cell: state.cells.findIndex((c) => c === null) });
  }
  rng.shuffle(candidates);
  for (const cmd of candidates) {
    if (!validateCommand(state, cmd).ok) return cmd; // guaranteed-invalid pick
  }
  return null;
}

/**
 * Play up to `count` random commands: mostly legal (via listLegalCommands),
 * occasionally deliberately invalid. Stops early on terminal. Deterministic
 * command ids are stamped from idPrefix. Returns the session.
 */
export function playRandom(session, rng, count, { invalidRate = 0.2, idPrefix = 'rnd' } = {}) {
  let n = 0;
  let elapsed = 0;
  for (let i = 0; i < count && !session.result; i++) {
    let cmd = null;
    if (rng.float() < invalidRate) cmd = randomInvalidCommand(session.state, rng);
    if (!cmd) cmd = randomLegalCommand(session.state, rng);
    if (!cmd) break;
    session.dispatch({ ...cmd, id: idPrefix + '-' + n++ }, (elapsed += 700));
  }
  return session;
}

export { createRng, hashState };
