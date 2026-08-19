// rules.js — pure deterministic rules engine for Card Mosaic.
// No rendering, no wall clock, no globals. All transitions go through
// validateCommand + applyCommand. State is JSON-serializable at all times.
//
// Board model:
//   - grid w×h, row-major cell indices 0..w*h-1
//   - each card has 4 edges [N, E, S, W], each an integer motif 0..palette-1
//   - a card carries a rotation 0..3 (quarter turns clockwise, applied at render
//     and match time via effectiveEdges)
//   - tray slots are stable: every card owns a fixed `slot` index it returns to
//
// Commands (all carry an optional client-supplied `id` for idempotent dedupe):
//   { type:'place',      tray, cell }          tray slot -> empty cell
//   { type:'recall',     cell }                placed, unlocked card -> its tray slot
//   { type:'swap',       a, b }                exchange two placed, unlocked cards
//   { type:'rotateTray', tray }                quarter-turn a tray card (rotation mechanic)
//   { type:'lock',       cell }                lock a fully-matching placed card (lock mechanic)
//   { type:'settle',     elapsedMs }           terminal: finalize score & status
//   { type:'concede',    elapsedMs }           terminal: abandon the round

export const RULES_VERSION = 1;
export const SCHEMA_VERSION = 1;

export const SCORE = Object.freeze({
  PER_MATCHED_EDGE: 10,
  PER_LOCK: 15,
  COMPLETION_BASE: 100,
  COMPLETION_PER_CELL: 5,
  SWAP_PENALTY: 5,
  INVALID_PENALTY: 2,
});

export const TERMINAL = Object.freeze({
  COMPLETE: 'complete',
  MOVES_EXHAUSTED: 'moves-exhausted',
  TIME_UP: 'time-up',
  CONCEDED: 'conceded',
});

const COMMAND_TYPES = new Set(['place', 'recall', 'swap', 'rotateTray', 'lock', 'settle', 'concede']);

// ---------------------------------------------------------------------------
// canonical serialization + hashing
// ---------------------------------------------------------------------------

/** Stable JSON stringify: object keys sorted recursively. */
export function canonicalStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonicalStringify).join(',') + ']';
  const keys = Object.keys(value).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonicalStringify(value[k])).join(',') + '}';
}

/** FNV-1a hex hash of the canonical serialization. Deterministic across platforms. */
export function hashState(state) {
  const s = canonicalStringify(state);
  let h = 0x811c9dc5 >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return ('0000000' + h.toString(16)).slice(-8);
}

export function cloneState(state) {
  return JSON.parse(JSON.stringify(state));
}

// ---------------------------------------------------------------------------
// geometry helpers
// ---------------------------------------------------------------------------

export function cellXY(state, cell) { return { x: cell % state.grid.w, y: Math.floor(cell / state.grid.w) }; }
export function cellIndex(state, x, y) {
  if (x < 0 || y < 0 || x >= state.grid.w || y >= state.grid.h) return -1;
  return y * state.grid.w + x;
}

/** Orthogonal neighbor cell indices. */
export function neighbors(state, cell) {
  const { x, y } = cellXY(state, cell);
  const out = [];
  const n = cellIndex(state, x, y - 1); if (n >= 0) out.push(n);
  const e = cellIndex(state, x + 1, y); if (e >= 0) out.push(e);
  const s = cellIndex(state, x, y + 1); if (s >= 0) out.push(s);
  const w = cellIndex(state, x - 1, y); if (w >= 0) out.push(w);
  return out;
}

/** Direction index between adjacent cells: 0=N,1=E,2=S,3=W (from a's perspective). */
export function directionBetween(state, a, b) {
  const pa = cellXY(state, a), pb = cellXY(state, b);
  if (pa.x === pb.x && pa.y === pb.y + 1) return 0;
  if (pa.x === pb.x - 1 && pa.y === pb.y) return 1;
  if (pa.x === pb.x && pa.y === pb.y - 1) return 2;
  if (pa.x === pb.x + 1 && pa.y === pb.y) return 3;
  return -1;
}

/** Effective edge motifs of a card after applying its quarter-turn rotation. */
export function effectiveEdges(card) {
  const r = ((card.rot % 4) + 4) % 4;
  const e = card.edges;
  // rotating clockwise by r: edge shown on side d was originally side (d - r mod 4)
  return [e[(0 - r + 4) % 4], e[(1 - r + 4) % 4], e[(2 - r + 4) % 4], e[(3 - r + 4) % 4]];
}

// ---------------------------------------------------------------------------
// state construction
// ---------------------------------------------------------------------------

/**
 * Build initial rules state from a validated content document.
 * The content doc owns card identity/solution; rules state owns play.
 */
export function createInitialState(content) {
  const cards = {};
  for (const c of content.cards) {
    cards[c.id] = { id: c.id, edges: c.edges.slice(), rot: 0, slot: c.slot, locked: false };
  }
  // initial tray rotations (rotation mechanic) are part of the content seed
  if (content.initialRotations) {
    for (const id of Object.keys(content.initialRotations)) {
      if (cards[id]) cards[id].rot = content.initialRotations[id];
    }
  }
  const tray = new Array(content.traySize).fill(null);
  for (const c of content.cards) {
    if (c.slot >= 0) tray[c.slot] = c.id;
  }
  const cells = new Array(content.grid.w * content.grid.h).fill(null);
  for (const c of content.cards) {
    if (c.cell >= 0) cells[c.cell] = c.id;
  }
  return {
    rulesVersion: RULES_VERSION,
    contentId: content.contentId,
    contentVersion: content.version,
    seed: content.seed,
    tick: 0,
    status: 'active',               // 'active' | 'terminal'
    terminalReason: null,
    grid: { w: content.grid.w, h: content.grid.h },
    palette: content.palette,
    tray,
    cells,
    cards,
    mechanics: {
      rotation: !!content.mechanics.rotation,
      lock: !!content.mechanics.lock,
      decoys: !!content.mechanics.decoys,
    },
    moveLimit: content.goals.moveLimit ?? null,
    timeLimitMs: content.goals.timeLimitMs ?? null,
    movesUsed: 0,
    swapsUsed: 0,
    invalidCount: 0,
    lockedCount: 0,
    elapsedMs: 0,
    score: { matched: 0, locks: 0, completion: 0, swapPenalty: 0, invalidPenalty: 0, timeBonus: 0, total: 0 },
    appliedCommandIds: [],          // bounded dedupe window (last 64)
  };
}

// ---------------------------------------------------------------------------
// match analysis
// ---------------------------------------------------------------------------

/**
 * Analyze all internal adjacencies.
 * Returns { pairs: [{a,b,dir,matched}], matched, mismatched, open }
 * `open` pairs have at least one empty side.
 */
export function analyzeBoard(state) {
  const pairs = [];
  let matched = 0, mismatched = 0, open = 0;
  const totalCells = state.grid.w * state.grid.h;
  for (let cell = 0; cell < totalCells; cell++) {
    const { x, y } = cellXY(state, cell);
    // only E and S to visit each pair once
    for (const [dx, dy, dir] of [[1, 0, 1], [0, 1, 2]]) {
      const other = cellIndex(state, x + dx, y + dy);
      if (other < 0) continue;
      const idA = state.cells[cell];
      const idB = state.cells[other];
      if (idA === null || idB === null) {
        open++;
        pairs.push({ a: cell, b: other, dir, matched: false, open: true });
        continue;
      }
      const ea = effectiveEdges(state.cards[idA])[dir];
      const eb = effectiveEdges(state.cards[idB])[(dir + 2) % 4];
      const ok = ea === eb;
      if (ok) matched++; else mismatched++;
      pairs.push({ a: cell, b: other, dir, matched: ok, open: false });
    }
  }
  return { pairs, matched, mismatched, open };
}

/** Count of empty cells. */
export function emptyCellCount(state) {
  let n = 0;
  for (const c of state.cells) if (c === null) n++;
  return n;
}

/** True when every cell is occupied and every internal adjacency matches. */
export function isSolved(state) {
  if (emptyCellCount(state) !== 0) return false;
  const a = analyzeBoard(state);
  return a.mismatched === 0 && a.open === 0;
}

/**
 * Terminal condition after a non-terminal command, or null if play continues.
 * Completion outranks exhaustion.
 */
export function terminalCondition(state, nowElapsedMs = state.elapsedMs) {
  if (state.status === 'terminal') return state.terminalReason;
  if (isSolved(state)) return TERMINAL.COMPLETE;
  if (state.moveLimit !== null && state.movesUsed >= state.moveLimit) return TERMINAL.MOVES_EXHAUSTED;
  if (state.timeLimitMs !== null && nowElapsedMs >= state.timeLimitMs) return TERMINAL.TIME_UP;
  return null;
}

// ---------------------------------------------------------------------------
// validation
// ---------------------------------------------------------------------------

/**
 * Validate a command against state without mutating.
 * Returns { ok:true } or { ok:false, reason } where reason is a stable,
 * user-explainable machine string.
 */
export function validateCommand(state, cmd) {
  if (!cmd || typeof cmd !== 'object' || !COMMAND_TYPES.has(cmd.type)) {
    return { ok: false, reason: 'unknown-command' };
  }
  if (state.status === 'terminal') return { ok: false, reason: 'round-over' };
  if (cmd.type === 'concede') return { ok: true };
  if (cmd.type === 'settle') {
    // settle is host-only: legal only when a genuine terminal condition holds
    // (prevents clients forging a completion on a live board)
    return terminalCondition(state, cmd.elapsedMs ?? state.elapsedMs)
      ? { ok: true }
      : { ok: false, reason: 'not-terminal' };
  }

  switch (cmd.type) {
    case 'place': {
      const { tray, cell } = cmd;
      if (!Number.isInteger(tray) || tray < 0 || tray >= state.tray.length) return { ok: false, reason: 'bad-tray-slot' };
      if (!Number.isInteger(cell) || cell < 0 || cell >= state.cells.length) return { ok: false, reason: 'bad-cell' };
      if (state.tray[tray] === null) return { ok: false, reason: 'tray-slot-empty' };
      if (state.cells[cell] !== null) return { ok: false, reason: 'cell-occupied' };
      return { ok: true };
    }
    case 'recall': {
      const { cell } = cmd;
      if (!Number.isInteger(cell) || cell < 0 || cell >= state.cells.length) return { ok: false, reason: 'bad-cell' };
      const id = state.cells[cell];
      if (id === null) return { ok: false, reason: 'cell-empty' };
      if (state.cards[id].locked) return { ok: false, reason: 'card-locked' };
      // anchored cards were never lifted: they own no tray slot to return to
      if (state.cards[id].slot < 0) return { ok: false, reason: 'no-tray-slot' };
      return { ok: true };
    }
    case 'swap': {
      const { a, b } = cmd;
      if (!Number.isInteger(a) || a < 0 || a >= state.cells.length) return { ok: false, reason: 'bad-cell' };
      if (!Number.isInteger(b) || b < 0 || b >= state.cells.length) return { ok: false, reason: 'bad-cell' };
      if (a === b) return { ok: false, reason: 'same-cell' };
      const idA = state.cells[a], idB = state.cells[b];
      if (idA === null || idB === null) return { ok: false, reason: 'cell-empty' };
      if (state.cards[idA].locked || state.cards[idB].locked) return { ok: false, reason: 'card-locked' };
      return { ok: true };
    }
    case 'rotateTray': {
      const { tray } = cmd;
      if (!state.mechanics.rotation) return { ok: false, reason: 'rotation-disabled' };
      if (!Number.isInteger(tray) || tray < 0 || tray >= state.tray.length) return { ok: false, reason: 'bad-tray-slot' };
      if (state.tray[tray] === null) return { ok: false, reason: 'tray-slot-empty' };
      return { ok: true };
    }
    case 'lock': {
      const { cell } = cmd;
      if (!state.mechanics.lock) return { ok: false, reason: 'lock-disabled' };
      if (!Number.isInteger(cell) || cell < 0 || cell >= state.cells.length) return { ok: false, reason: 'bad-cell' };
      const id = state.cells[cell];
      if (id === null) return { ok: false, reason: 'cell-empty' };
      if (state.cards[id].locked) return { ok: false, reason: 'already-locked' };
      // every placed neighbor must match
      const eff = effectiveEdges(state.cards[id]);
      for (const n of neighbors(state, cell)) {
        const nid = state.cells[n];
        if (nid === null) continue;
        const dir = directionBetween(state, cell, n);
        if (eff[dir] !== effectiveEdges(state.cards[nid])[(dir + 2) % 4]) {
          return { ok: false, reason: 'neighbors-mismatch' };
        }
      }
      return { ok: true };
    }
  }
  return { ok: false, reason: 'unknown-command' };
}

// ---------------------------------------------------------------------------
// application
// ---------------------------------------------------------------------------

export function refreshScore(state) {
  const a = analyzeBoard(state);
  const s = state.score;
  s.matched = a.matched * SCORE.PER_MATCHED_EDGE;
  s.locks = state.lockedCount * SCORE.PER_LOCK;
  s.swapPenalty = state.swapsUsed * SCORE.SWAP_PENALTY;
  s.invalidPenalty = state.invalidCount * SCORE.INVALID_PENALTY;
  // completion + timeBonus are assigned by settle; recompute total live
  s.total = Math.max(0, s.matched + s.locks + s.completion + s.timeBonus - s.swapPenalty - s.invalidPenalty);
  return a;
}

/**
 * Apply a *valid* command. Returns a new event list; state is mutated in place
 * (callers clone beforehand when they need history). Never call without
 * validateCommand, except trusted replays that assert validation first.
 */
export function applyCommand(state, cmd) {
  const events = [];

  // idempotent duplicate rejection by command id (before any state mutation,
  // so a rejected retry leaves the state hash untouched)
  if (cmd.id !== undefined && cmd.id !== null) {
    if (state.appliedCommandIds.includes(cmd.id)) {
      return [{ type: 'duplicate', id: cmd.id }];
    }
    state.appliedCommandIds.push(cmd.id);
    if (state.appliedCommandIds.length > 64) state.appliedCommandIds.shift();
  }

  state.tick += 1;

  switch (cmd.type) {
    case 'place': {
      const id = state.tray[cmd.tray];
      state.tray[cmd.tray] = null;
      state.cells[cmd.cell] = id;
      state.movesUsed += 1;
      events.push({ type: 'place', card: id, tray: cmd.tray, cell: cmd.cell });
      break;
    }
    case 'recall': {
      const id = state.cells[cmd.cell];
      state.cells[cmd.cell] = null;
      state.tray[state.cards[id].slot] = id;
      state.movesUsed += 1;
      events.push({ type: 'recall', card: id, cell: cmd.cell, tray: state.cards[id].slot });
      break;
    }
    case 'swap': {
      const idA = state.cells[cmd.a], idB = state.cells[cmd.b];
      state.cells[cmd.a] = idB;
      state.cells[cmd.b] = idA;
      state.movesUsed += 1;
      state.swapsUsed += 1;
      events.push({ type: 'swap', a: cmd.a, b: cmd.b, cardA: idA, cardB: idB });
      break;
    }
    case 'rotateTray': {
      const id = state.tray[cmd.tray];
      state.cards[id].rot = (state.cards[id].rot + 1) % 4;
      events.push({ type: 'rotateTray', card: id, tray: cmd.tray, rot: state.cards[id].rot });
      break;
    }
    case 'lock': {
      const id = state.cells[cmd.cell];
      state.cards[id].locked = true;
      state.lockedCount += 1;
      state.movesUsed += 1;
      events.push({ type: 'lock', card: id, cell: cmd.cell });
      break;
    }
    case 'concede': {
      state.elapsedMs = quantizeElapsed(cmd.elapsedMs);
      state.status = 'terminal';
      state.terminalReason = TERMINAL.CONCEDED;
      refreshScore(state);
      events.push({ type: 'terminal', reason: state.terminalReason, score: cloneScore(state.score) });
      return events;
    }
    case 'settle': {
      state.elapsedMs = quantizeElapsed(cmd.elapsedMs);
      // validateCommand guarantees a condition holds; the CONCEDED fallback
      // only triggers on trusted-path misuse and never awards completion
      const reason = terminalCondition(state, state.elapsedMs) || TERMINAL.CONCEDED;
      state.status = 'terminal';
      state.terminalReason = reason;
      if (reason === TERMINAL.COMPLETE) {
        const totalCells = state.grid.w * state.grid.h;
        state.score.completion = SCORE.COMPLETION_BASE + SCORE.COMPLETION_PER_CELL * totalCells;
        // speed component only in timed/par contexts
        const par = state.timeLimitMs;
        if (par && state.elapsedMs < par) {
          state.score.timeBonus = Math.floor((par - state.elapsedMs) / 1000);
        }
      }
      refreshScore(state);
      events.push({ type: 'terminal', reason, score: cloneScore(state.score) });
      return events;
    }
  }

  const analysis = refreshScore(state);
  // Session compares against its own previous count to emit deltas.
  events.push({ type: 'board', matched: analysis.matched, mismatched: analysis.mismatched, open: analysis.open });

  const cond = terminalCondition(state);
  if (cond) events.push({ type: 'terminal-pending', reason: cond });
  return events;
}

function cloneScore(s) { return { ...s }; }

/** Authoritative elapsed time is quantized to 100 ms before entering state. */
export function quantizeElapsed(ms) {
  if (!Number.isFinite(ms)) return 0; // NaN/Infinity/non-numeric never enter state
  return Math.max(0, Math.round(ms / 100) * 100);
}

/**
 * Record an invalid attempt: reversible, penalized, never mutates layout.
 * Used by the session so illegal tries are part of the auditable log.
 */
export function applyInvalid(state, cmd, reason) {
  state.tick += 1;
  state.invalidCount += 1;
  refreshScore(state);
  return [{ type: 'invalid', reason, command: cmd ? cmd.type : null }];
}

// ---------------------------------------------------------------------------
// legal action enumeration (used by hints, tutorials, keyboard nav, validators)
// ---------------------------------------------------------------------------

/**
 * Enumerate every currently legal non-terminal command.
 * This is the single source of truth for tutorials and hints.
 */
export function listLegalCommands(state) {
  if (state.status === 'terminal') return [];
  const out = [];
  for (let t = 0; t < state.tray.length; t++) {
    if (state.tray[t] === null) continue;
    for (let c = 0; c < state.cells.length; c++) {
      if (state.cells[c] === null) out.push({ type: 'place', tray: t, cell: c });
    }
    if (state.mechanics.rotation) out.push({ type: 'rotateTray', tray: t });
  }
  for (let c = 0; c < state.cells.length; c++) {
    const id = state.cells[c];
    if (id === null) continue;
    if (!state.cards[id].locked && state.cards[id].slot >= 0) {
      out.push({ type: 'recall', cell: c });
      for (let d = c + 1; d < state.cells.length; d++) {
        const jd = state.cells[d];
        if (jd !== null && !state.cards[jd].locked) out.push({ type: 'swap', a: c, b: d });
      }
    }
    if (state.mechanics.lock && !state.cards[id].locked) {
      if (validateCommand(state, { type: 'lock', cell: c }).ok) out.push({ type: 'lock', cell: c });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// leaderboard tie-breaking: completion, fewer invalids, lower elapsed, session id
// ---------------------------------------------------------------------------

export function compareResults(a, b) {
  const doneA = a.terminalReason === TERMINAL.COMPLETE ? 1 : 0;
  const doneB = b.terminalReason === TERMINAL.COMPLETE ? 1 : 0;
  if (doneA !== doneB) return doneB - doneA;
  if (a.score.total !== b.score.total) return b.score.total - a.score.total;
  if (a.invalidCount !== b.invalidCount) return a.invalidCount - b.invalidCount;
  if (a.elapsedMs !== b.elapsedMs) return a.elapsedMs - b.elapsedMs;
  return String(a.sessionId).localeCompare(String(b.sessionId));
}
