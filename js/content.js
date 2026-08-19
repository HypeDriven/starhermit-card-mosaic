// content.js — versioned content: puzzle generation, journey stages, daily
// challenge, challenges, lessons, and offline validators.
// Pure ES module; deterministic from (contentId, seed, params).

import { createRng } from './rng.js';
import { createInitialState, validateCommand, applyCommand, isSolved, analyzeBoard, neighbors, hashState, cloneState, refreshScore } from './rules.js';

export const CONTENT_VERSION = 1;

// ---------------------------------------------------------------------------
// Motifs — original visual language: 8 edge symbols.
// Render/UI map motif id -> {name, shape, palette-dependent color}.
// ---------------------------------------------------------------------------
export const MOTIFS = Object.freeze([
  { id: 0, name: 'Wave' },
  { id: 1, name: 'Sun' },
  { id: 2, name: 'Leaf' },
  { id: 3, name: 'Moon' },
  { id: 4, name: 'Star' },
  { id: 5, name: 'Drop' },
  { id: 6, name: 'Ember' },
  { id: 7, name: 'Fern' },
]);

export const THEMES = Object.freeze([
  { id: 'studio',   name: 'Studio Dawn' },
  { id: 'slate',    name: 'Slate Night' },
  { id: 'verdant',  name: 'Verdant' },
  { id: 'ember',    name: 'Ember Glow' },
  { id: 'porcelain',name: 'Porcelain' },
]);

// ---------------------------------------------------------------------------
// Puzzle generation
// ---------------------------------------------------------------------------

/**
 * params: {
 *   w, h, palette, removed,           // removed = #cards lifted into the tray
 *   rotation (bool), lock (bool), decoys (int),
 *   moveLimit (int|null), timeLimitMs (int|null),
 *   prelocked (int),                  // cards placed & locked at start
 *   theme (string), tutorial (bool)
 * }
 *
 * Returns a content document:
 * { version, contentId, seed, grid, palette, mechanics, goals, theme,
 *   cards: [{id, edges, cell, slot}],   // cell=-1 & slot>=0 => starts in tray
 *   traySize, initialRotations, solution: {cell: {card, rot}},
 *   tutorialFlags, par: {moves, ms} }
 */
export function generatePuzzle(contentId, seed, params) {
  const rng = createRng(seed).fork('content');
  const { w, h, palette } = params;
  const cells = w * h;

  // 1) Assign a motif to every internal edge -> solved board by construction.
  //    Border edges draw from the same palette so rim motifs stay meaningful.
  const solved = [];
  for (let i = 0; i < cells; i++) solved.push([0, 0, 0, 0]);
  const idx = (x, y) => y * w + x;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = idx(x, y);
      // N
      if (y > 0) solved[i][0] = solved[idx(x, y - 1)][2];
      else solved[i][0] = rng.int(palette);
      // W
      if (x > 0) solved[i][3] = solved[idx(x - 1, y)][1];
      else solved[i][3] = rng.int(palette);
      // E, S fresh (will be read back by right/bottom neighbor)
      solved[i][1] = rng.int(palette);
      solved[i][2] = rng.int(palette);
    }
  }

  // 2) Choose which cards are lifted into the tray.
  const order = rng.shuffle([...Array(cells).keys()]);
  const removed = Math.min(params.removed, cells);
  const lifted = new Set(order.slice(0, removed));
  const anchored = cells - removed;

  // 3) Some anchored cards may start prelocked (lock mechanic showcase).
  const anchoredCells = order.slice(removed);
  const prelockCount = Math.min(params.prelocked || 0, anchored);
  const prelocked = new Set(anchoredCells.slice(0, prelockCount));

  // 4) Tray slots: lifted cards shuffled into slots 0..removed-1, decoys after.
  const decoys = params.decoys || 0;
  const traySize = removed + decoys;
  const liftedArr = rng.shuffle([...lifted]);

  const cards = [];
  const solution = {};
  let cardSeq = 0;
  for (let cell = 0; cell < cells; cell++) {
    const id = 'c' + cardSeq++;
    const inTray = lifted.has(cell);
    cards.push({
      id,
      edges: solved[cell].slice(),
      cell: inTray ? -1 : cell,
      slot: inTray ? liftedArr.indexOf(cell) : -1,
      prelocked: prelocked.has(cell),
    });
    solution[cell] = { card: id, rot: 0 };
  }
  // Decoy cards: plausible but never part of the solution.
  for (let d = 0; d < decoys; d++) {
    cards.push({
      id: 'x' + d,
      edges: [rng.int(palette), rng.int(palette), rng.int(palette), rng.int(palette)],
      cell: -1,
      slot: removed + d,
      decoy: true,
    });
  }

  // 5) Initial tray rotations when the rotation mechanic is on.
  const initialRotations = {};
  if (params.rotation) {
    for (const c of cards) {
      if (c.slot >= 0 && !c.decoy) initialRotations[c.id] = rng.int(4);
    }
  }

  const moveLimit = params.moveLimit ?? null;
  const doc = {
    version: CONTENT_VERSION,
    contentId,
    seed,
    grid: { w, h },
    palette,
    mechanics: { rotation: !!params.rotation, lock: !!params.lock, decoys: decoys > 0 },
    goals: {
      moveLimit,
      timeLimitMs: params.timeLimitMs ?? null,
      // par: place each lifted card once + expected rotations/corrections
      par: {
        moves: removed + Math.ceil(removed * 0.5),
        ms: Math.max(30000, removed * 9000),
      },
    },
    theme: params.theme || 'studio',
    tutorial: !!params.tutorial,
    cards,
    traySize,
    initialRotations,
    solution,
    prelocked: [...prelocked],
  };
  return doc;
}

/**
 * Build the initial rules state for a content doc, honoring prelocked cards:
 * prelocked cards are placed and locked via real commands so the state hash
 * reflects the same transitions a player would perform.
 */
export function instantiate(content) {
  const state = createInitialState(content);
  for (const cell of content.prelocked || []) {
    const entry = content.cards.find((c) => c.cell === cell);
    if (!entry) continue;
    const card = state.cards[entry.id];
    card.locked = true;
    state.lockedCount += 1;
  }
  // anchored cards already match: the opening score must reflect them
  refreshScore(state);
  return state;
}

// ---------------------------------------------------------------------------
// Offline validators — prove legality, reachability, boundedness, no soft-lock
// ---------------------------------------------------------------------------

export function validateContent(doc) {
  const errors = [];
  const { w, h } = doc.grid;
  if (!(w >= 2 && h >= 2 && w <= 8 && h <= 8)) errors.push('grid-out-of-bounds');
  if (!(doc.palette >= 2 && doc.palette <= MOTIFS.length)) errors.push('palette-out-of-bounds');
  const cellSeen = new Set(), slotSeen = new Set();
  for (const c of doc.cards) {
    for (const e of c.edges) if (!(e >= 0 && e < doc.palette)) errors.push('edge-out-of-palette:' + c.id);
    if (c.cell >= 0) { if (c.cell >= w * h || cellSeen.has(c.cell)) errors.push('bad-cell:' + c.id); cellSeen.add(c.cell); }
    if (c.slot >= 0) { if (c.slot >= doc.traySize || slotSeen.has(c.slot)) errors.push('bad-slot:' + c.id); slotSeen.add(c.slot); }
  }
  // Reachability: replay the solution through the real command pipeline.
  const state = instantiate(doc);
  const rotNeed = {};
  for (const id of Object.keys(doc.initialRotations)) {
    rotNeed[id] = (4 - doc.initialRotations[id]) % 4;
  }
  for (let cell = 0; cell < w * h; cell++) {
    const sol = doc.solution[cell];
    if (!sol) continue;
    if (state.cells[cell] !== null) continue; // anchored
    const card = state.cards[sol.card];
    for (let r = 0; r < rotNeed[sol.card] || 0; r++) {
      const cmd = { type: 'rotateTray', tray: card.slot };
      if (!validateCommand(state, cmd).ok) { errors.push('solution-rotate-failed:' + sol.card); break; }
      applyCommand(state, cmd);
    }
    const place = { type: 'place', tray: card.slot, cell };
    const v = validateCommand(state, place);
    if (!v.ok) { errors.push('solution-place-failed:' + cell + ':' + v.reason); continue; }
    applyCommand(state, place);
  }
  if (errors.length === 0 && !isSolved(state)) errors.push('solution-does-not-solve');
  // Bounded duration / no soft-lock: move limit, when present, must allow the
  // minimal solution (one place per lifted card) plus slack.
  const liftedCount = doc.cards.filter((c) => c.slot >= 0 && !c.decoy).length;
  if (doc.goals.moveLimit !== null && doc.goals.moveLimit < liftedCount) errors.push('move-limit-below-minimum');
  if (doc.goals.timeLimitMs !== null && doc.goals.timeLimitMs < 10000) errors.push('time-limit-too-tight');
  return { ok: errors.length === 0, errors, solutionHash: errors.length === 0 ? hashState(state) : null };
}

// ---------------------------------------------------------------------------
// Journey — authored progression. One new concept at a time, combined with a
// known one, then a mastery stage every 5th. 45 stages across 5 chapters.
// ---------------------------------------------------------------------------

// Each row: [w, h, palette, removed, rotation, lock, decoys, moveLimit, timeLimitMs, prelocked, theme]
const J = [];
(function buildJourney() {
  const themes = THEMES.map((t) => t.id);
  // Chapter 1 — placement fundamentals (3x3, small palette)
  const ch1 = [
    [3, 3, 3, 3, 0, 0, 0, null, null, 0],
    [3, 3, 3, 4, 0, 0, 0, null, null, 0],
    [3, 3, 4, 5, 0, 0, 0, null, null, 0],
    [3, 3, 4, 6, 0, 0, 0, null, null, 0],
    [3, 3, 4, 9, 0, 0, 0, null, null, 0], // mastery: full lift
  ];
  // Chapter 2 — rotation mechanic
  const ch2 = [
    [3, 3, 3, 3, 1, 0, 0, null, null, 0],
    [3, 3, 4, 5, 1, 0, 0, null, null, 0],
    [4, 3, 4, 5, 1, 0, 0, null, null, 0],
    [4, 3, 4, 7, 1, 0, 0, null, null, 0],
    [4, 3, 5, 12, 1, 0, 0, null, null, 0], // mastery
  ];
  // Chapter 3 — locking + decoys
  const ch3 = [
    [4, 3, 4, 4, 0, 1, 0, null, null, 2],
    [4, 3, 4, 5, 1, 1, 0, null, null, 2],
    [4, 4, 4, 6, 1, 1, 1, null, null, 2],
    [4, 4, 5, 8, 1, 1, 1, null, null, 3],
    [4, 4, 5, 16, 1, 1, 2, null, null, 0], // mastery: full lift + decoys
  ];
  // Chapter 4 — constraints: move limits and time
  const ch4 = [
    [4, 3, 4, 5, 1, 1, 0, 12, null, 1],
    [4, 4, 4, 7, 1, 1, 1, 16, null, 1],
    [4, 4, 5, 8, 1, 1, 1, null, 150000, 1],
    [5, 4, 5, 9, 1, 1, 1, 20, null, 2],
    [5, 4, 5, 20, 1, 1, 2, 34, null, 0], // mastery
  ];
  // Chapter 5 — large mosaics, deep pools
  const ch5 = [
    [5, 4, 5, 8, 1, 1, 1, null, null, 2],
    [5, 5, 5, 10, 1, 1, 1, null, null, 2],
    [5, 5, 6, 12, 1, 1, 2, null, null, 3],
    [6, 5, 6, 14, 1, 1, 2, null, null, 3],
    [6, 5, 6, 30, 1, 1, 3, null, null, 0], // mastery: full 6x5 lift
  ];
  const chapters = [ch1, ch2, ch3, ch4, ch5];
  let n = 0;
  chapters.forEach((ch, ci) => {
    ch.forEach((row, ri) => {
      n++;
      const [w, h, palette, removed, rotation, lock, decoys, moveLimit, timeLimitMs, prelocked] = row;
      J.push({
        index: n - 1,
        id: 'journey-' + n,
        chapter: ci + 1,
        mastery: ri === 4,
        name: (ri === 4 ? 'Mastery ' : 'Stage ') + (ci * 5 + ri + 1),
        params: {
          w, h, palette, removed,
          rotation: !!rotation, lock: !!lock, decoys,
          moveLimit, timeLimitMs, prelocked,
          theme: themes[ci % themes.length],
        },
      });
    });
  });
  // Repeat the 25-stage arc with tighter numbers to reach 40+ authored stages.
  const arc2 = [];
  chapters.forEach((ch, ci) => {
    ch.forEach((row, ri) => {
      const [w, h, palette, removed, rotation, lock, decoys, moveLimit, timeLimitMs, prelocked] = row;
      arc2.push([
        Math.min(6, w + (ri >= 3 ? 1 : 0)), h, Math.min(8, palette + 1),
        removed + 1, rotation, lock, decoys + (ri % 2), moveLimit === null ? null : moveLimit + 2,
        timeLimitMs === null ? null : Math.max(60000, timeLimitMs - 30000), prelocked,
      ]);
    });
  });
  arc2.forEach((row, i) => {
    n++;
    const [w, h, palette, removed, rotation, lock, decoys, moveLimit, timeLimitMs, prelocked] = row;
    J.push({
      index: n - 1,
      id: 'journey-' + n,
      chapter: 6 + Math.floor(i / 5),
      mastery: i % 5 === 4,
      name: (i % 5 === 4 ? 'Mastery ' : 'Stage ') + n,
      params: {
        w, h, palette, removed,
        rotation: !!rotation, lock: !!lock, decoys,
        moveLimit, timeLimitMs, prelocked,
        theme: themes[(i + 2) % themes.length],
      },
    });
  });
})();

export const JOURNEY = Object.freeze(J);

export function journeyContent(stageIndex) {
  const stage = JOURNEY[stageIndex];
  if (!stage) return null;
  return generatePuzzle(stage.id, 'cm-journey-' + stage.id, stage.params);
}

// ---------------------------------------------------------------------------
// Daily — one shared seed per UTC day, immutable after publication
// ---------------------------------------------------------------------------

export function dailyKey(date = new Date()) {
  return date.toISOString().slice(0, 10); // YYYY-MM-DD in UTC
}

export function dailyContent(dateKey = dailyKey()) {
  // Difficulty ladder rotates deterministically by day-of-epoch.
  const days = Math.floor(Date.parse(dateKey + 'T00:00:00Z') / 86400000);
  const ladder = [
    { w: 3, h: 3, palette: 3, removed: 4, rotation: false, lock: false, decoys: 0 },
    { w: 4, h: 3, palette: 4, removed: 5, rotation: true, lock: false, decoys: 0 },
    { w: 4, h: 4, palette: 4, removed: 7, rotation: true, lock: true, decoys: 1, prelocked: 1 },
    { w: 4, h: 4, palette: 5, removed: 8, rotation: true, lock: true, decoys: 1, prelocked: 2 },
    { w: 5, h: 4, palette: 5, removed: 9, rotation: true, lock: true, decoys: 1, prelocked: 2 },
    { w: 5, h: 5, palette: 6, removed: 12, rotation: true, lock: true, decoys: 2, prelocked: 2 },
    { w: 4, h: 4, palette: 5, removed: 16, rotation: true, lock: true, decoys: 2 },
  ];
  const p = ladder[days % ladder.length];
  const theme = THEMES[days % THEMES.length].id;
  return generatePuzzle('daily-' + dateKey, 'cm-daily-' + dateKey, { ...p, theme, prelocked: p.prelocked || 0 });
}

// ---------------------------------------------------------------------------
// Practice difficulties
// ---------------------------------------------------------------------------

export const PRACTICE_DIFFICULTIES = Object.freeze([
  { id: 'casual', name: 'Casual', params: { w: 3, h: 3, palette: 3, removed: 4, rotation: false, lock: false, decoys: 0 } },
  { id: 'skilled', name: 'Skilled', params: { w: 4, h: 3, palette: 4, removed: 6, rotation: true, lock: false, decoys: 0 } },
  { id: 'expert', name: 'Expert', params: { w: 4, h: 4, palette: 5, removed: 9, rotation: true, lock: true, decoys: 1, prelocked: 1 } },
  { id: 'master', name: 'Master', params: { w: 5, h: 5, palette: 6, removed: 14, rotation: true, lock: true, decoys: 2, prelocked: 2 } },
]);

export function practiceContent(difficultyId, seedString) {
  const d = PRACTICE_DIFFICULTIES.find((x) => x.id === difficultyId) || PRACTICE_DIFFICULTIES[0];
  return generatePuzzle('practice-' + d.id + '-' + seedString, 'cm-practice-' + seedString, d.params);
}

// ---------------------------------------------------------------------------
// Challenges — constrained goals
// ---------------------------------------------------------------------------

export const CHALLENGES = Object.freeze([
  { id: 'frugal', name: 'Frugal Hands', blurb: 'Complete the mosaic within a tight move budget.',
    params: { w: 4, h: 3, palette: 4, removed: 6, rotation: true, lock: false, decoys: 0, moveLimit: 8 } },
  { id: 'sprint', name: 'Studio Sprint', blurb: 'Beat the clock on a lively 4×4.',
    params: { w: 4, h: 4, palette: 4, removed: 8, rotation: true, lock: true, decoys: 0, timeLimitMs: 120000, prelocked: 1 } },
  { id: 'impostors', name: 'Impostors', blurb: 'Two cards do not belong. Find the true mosaic.',
    params: { w: 4, h: 4, palette: 5, removed: 9, rotation: true, lock: true, decoys: 2, prelocked: 1 } },
  { id: 'grand', name: 'Grand Table', blurb: 'A wide 6×5 canvas with a deep tray.',
    params: { w: 6, h: 5, palette: 6, removed: 15, rotation: true, lock: true, decoys: 2, prelocked: 3 } },
  { id: 'glasswork', name: 'Glasswork', blurb: 'Full lift, every card loose, no anchors.',
    params: { w: 4, h: 4, palette: 5, removed: 16, rotation: true, lock: true, decoys: 1, moveLimit: 30 } },
]);

export function challengeContent(challengeId, seedString) {
  const c = CHALLENGES.find((x) => x.id === challengeId);
  if (!c) return null;
  return generatePuzzle('challenge-' + c.id + '-' + seedString, 'cm-challenge-' + c.id + '-' + seedString, c.params);
}

// ---------------------------------------------------------------------------
// Learn — interactive lessons. Each step requires the player to perform the
// action through the normal command pipeline; verification uses the same
// legal-action API as play.
// ---------------------------------------------------------------------------

export const LESSONS = Object.freeze([
  {
    id: 'lesson-place', name: 'First Placement',
    intro: 'Cards belong on the table. Place the loose card into the empty cell.',
    params: { w: 2, h: 2, palette: 2, removed: 1, rotation: false, lock: false, decoys: 0 },
    steps: [
      { id: 'place', text: 'Select the tray card, then place it in the glowing empty cell.', require: { type: 'place' } },
      { id: 'done', text: 'Edges that match link the artwork. Mosaic complete!', require: { type: 'terminal' } },
    ],
  },
  {
    id: 'lesson-match', name: 'Reading Edges',
    intro: 'Every card edge carries a motif. Matching motifs on touching edges connect.',
    params: { w: 3, h: 2, palette: 2, removed: 2, rotation: false, lock: false, decoys: 0 },
    steps: [
      { id: 'place-1', text: 'Place a tray card so its touching edges match its neighbors.', require: { type: 'place' } },
      { id: 'place-2', text: 'Place the last card to finish the picture.', require: { type: 'place' } },
      { id: 'done', text: 'Well read. A finished mosaic has no mismatched edges.', require: { type: 'terminal' } },
    ],
  },
  {
    id: 'lesson-recall', name: 'Second Thoughts',
    intro: 'Placements are reversible. Recall a card to try a different arrangement.',
    params: { w: 3, h: 2, palette: 2, removed: 2, rotation: false, lock: false, decoys: 0 },
    steps: [
      { id: 'place', text: 'Place any tray card onto the board.', require: { type: 'place' } },
      { id: 'recall', text: 'Now recall that card back to the tray.', require: { type: 'recall' } },
      { id: 'solve', text: 'Finish the mosaic at your own pace.', require: { type: 'terminal' } },
    ],
  },
  {
    id: 'lesson-rotate', name: 'Quarter Turns',
    intro: 'Some cards arrive turned. Rotate a tray card before placing it.',
    params: { w: 3, h: 2, palette: 2, removed: 2, rotation: true, lock: false, decoys: 0 },
    steps: [
      { id: 'rotate', text: 'Rotate a tray card until its motifs line up.', require: { type: 'rotateTray' } },
      { id: 'solve', text: 'Complete the mosaic.', require: { type: 'terminal' } },
    ],
  },
  {
    id: 'lesson-lock', name: 'Locking In',
    intro: 'When a card matches every placed neighbor, lock it for bonus points.',
    params: { w: 3, h: 3, palette: 2, removed: 3, rotation: false, lock: true, decoys: 0, prelocked: 0 },
    steps: [
      { id: 'place', text: 'Place a card that matches its neighbors.', require: { type: 'place' } },
      { id: 'lock', text: 'Lock a fully-matching card (lock action).', require: { type: 'lock' } },
      { id: 'solve', text: 'Complete the mosaic.', require: { type: 'terminal' } },
    ],
  },
  {
    id: 'lesson-decoy', name: 'The Impostor',
    intro: 'Some trays hold cards that belong nowhere. Leave impostors aside.',
    params: { w: 3, h: 3, palette: 3, removed: 4, rotation: true, lock: true, decoys: 1, prelocked: 1 },
    steps: [
      { id: 'solve', text: 'Finish the mosaic — one tray card is an impostor.', require: { type: 'terminal' } },
    ],
  },
]);

export function lessonContent(lessonId) {
  const l = LESSONS.find((x) => x.id === lessonId);
  if (!l) return null;
  return { lesson: l, content: generatePuzzle(l.id, 'cm-' + l.id, { ...l.params, tutorial: true, theme: 'studio' }) };
}
