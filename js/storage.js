// storage.js — versioned, checksummed local persistence.
// Key prefix cardmosaic.v1. Every record is an envelope {v, data, crc};
// corrupt or version-mismatched entries read as null (never throw).

// JSON round-trip clone (structuredClone is browser-only on the engine).
const clone = (v) => JSON.parse(JSON.stringify(v));

const PREFIX = 'cardmosaic.v1.';
const RECORD_VERSION = 1;

function crc32(str) {
  let c = 0xffffffff;
  for (let i = 0; i < str.length; i++) {
    c ^= str.charCodeAt(i);
    for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1;
  }
  return (c ^ 0xffffffff) >>> 0;
}

function store() {
  try {
    const t = '__cm_probe__';
    localStorage.setItem(t, '1');
    localStorage.removeItem(t);
    return localStorage;
  } catch {
    return null; // private mode etc. — memory fallback
  }
}

const memory = new Map();
let backing = typeof localStorage !== 'undefined' ? store() : null;

function rawGet(key) {
  if (backing) return backing.getItem(PREFIX + key);
  return memory.get(key) ?? null;
}
function rawSet(key, value) {
  if (backing) {
    try {
      backing.setItem(PREFIX + key, value);
      return;
    } catch {
      // localStorage became unusable mid-session (quota exceeded etc.): degrade
      // to the in-memory fallback so autosave never interrupts play.
      backing = null;
    }
  }
  memory.set(key, value);
}
function rawDel(key) {
  if (backing) backing.removeItem(PREFIX + key);
  else memory.delete(key);
}

function writeRecord(key, data) {
  const payload = JSON.stringify(data);
  rawSet(key, JSON.stringify({ v: RECORD_VERSION, data, crc: crc32(payload) }));
}

function readRecord(key) {
  const raw = rawGet(key);
  if (!raw) return null;
  try {
    const env = JSON.parse(raw);
    if (env.v !== RECORD_VERSION) return null;
    if (crc32(JSON.stringify(env.data)) !== env.crc) return null;
    return env.data;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

export const DEFAULT_SETTINGS = Object.freeze({
  version: 1,
  audio: { music: 0.7, effects: 0.9, ambience: 0.5, voice: 0.8, muted: false },
  // gfx: saved Graphics panel state ({preset:'auto'|low|balanced|high|ultra, render_scale,
  // adaptive, show_fps, <category>: tier}); `quality` is the legacy tier, migrated once.
  graphics: { quality: 'high', theme: 'studio', cvd: false, gfx: null },
  access: {
    reducedMotion: false, highContrast: false, largeText: false,
    leftHanded: false, holdToConfirm: false, timingAssist: false,
    haptics: true, captions: true,
  },
  controls: { bindings: null },       // player overrides for desktop bindings
  tutorial: { completed: [], replaySeen: false },
  privacy: { telemetryConsent: false },
});

export function loadSettings() {
  const s = readRecord('settings');
  if (!s) {
    const fresh = clone(DEFAULT_SETTINGS);
    fresh.graphics.gfx = { preset: 'auto' };
    return fresh;
  }
  // shallow-merge over defaults so new keys appear on old saves
  const merged = clone(DEFAULT_SETTINGS);
  for (const k of Object.keys(merged)) {
    if (s[k] && typeof s[k] === 'object' && !Array.isArray(s[k])) Object.assign(merged[k], s[k]);
    else if (s[k] !== undefined) merged[k] = s[k];
  }
  if (!merged.graphics.gfx || typeof merged.graphics.gfx !== 'object') {
    const q = s.graphics && s.graphics.quality;
    merged.graphics.gfx = { preset: q === 'low' ? 'low' : q === 'medium' ? 'balanced' : 'auto' };
  }
  return merged;
}
export function saveSettings(s) { writeRecord('settings', s); }

// ---------------------------------------------------------------------------
// Progression
// ---------------------------------------------------------------------------

export const DEFAULT_PROGRESS = Object.freeze({
  version: 1,
  journey: {},            // stageId -> {completed, bestScore, bestMoves, stars, completedAt}
  lessons: {},            // lessonId -> {completed}
  masteryXp: 0,
  dailies: {},            // dateKey -> {score, completed, result}
  challenges: {},         // challengeId -> {bestScore, completed}
  sessionsPlayed: 0,
  streak: { lastDailyKey: null, count: 0 },
});

export function loadProgress() {
  const p = readRecord('progress');
  if (!p) return clone(DEFAULT_PROGRESS);
  const merged = clone(DEFAULT_PROGRESS);
  Object.assign(merged, p);
  return merged;
}
export function saveProgress(p) { writeRecord('progress', p); }

// Journey stars: 1 complete, +1 at/below par moves, +1 at/below par time
export function journeyStars(result, par) {
  if (!result || result.terminalReason !== 'complete') return 0;
  let stars = 1;
  if (result.movesUsed <= par.moves) stars++;
  if (result.elapsedMs <= par.ms) stars++;
  return stars;
}

/**
 * Cloud-save conflict merge: the better of two progress records, so neither
 * device's progress is lost. Journey stages stay completed on either side
 * with the most stars, the higher best score, the fewer best moves and the
 * earliest completion; lessons, dailies and challenges keep completion and
 * the higher score; counters take the larger value.
 */
export function mergeProgress(local, remote) {
  const a = clone(local || DEFAULT_PROGRESS);
  const b = remote || {};
  const minDate = (x, y) => (!x ? y || null : !y ? x : (x < y ? x : y));
  for (const [id, r] of Object.entries(b.journey || {})) {
    const l = a.journey[id];
    if (!l) { a.journey[id] = r; continue; }
    a.journey[id] = {
      completed: !!(l.completed || r.completed),
      bestScore: Math.max(l.bestScore || 0, r.bestScore || 0),
      bestMoves: Math.min(l.bestMoves ?? 1e9, r.bestMoves ?? 1e9),
      stars: Math.max(l.stars || 0, r.stars || 0),
      completedAt: minDate(l.completedAt, r.completedAt),
    };
  }
  for (const [id, r] of Object.entries(b.lessons || {})) a.lessons[id] = { completed: !!((a.lessons[id] || {}).completed || r.completed) };
  for (const [key, r] of Object.entries(b.dailies || {})) {
    const l = a.dailies[key];
    a.dailies[key] = !l ? r : {
      score: Math.max(l.score || 0, r.score || 0),
      completed: !!(l.completed || r.completed),
      result: (r.score || 0) > (l.score || 0) ? r.result : l.result,
    };
  }
  for (const [id, r] of Object.entries(b.challenges || {})) {
    const l = a.challenges[id];
    a.challenges[id] = !l ? r : { bestScore: Math.max(l.bestScore || 0, r.bestScore || 0), completed: !!(l.completed || r.completed) };
  }
  a.masteryXp = Math.max(a.masteryXp || 0, b.masteryXp || 0);
  a.sessionsPlayed = Math.max(a.sessionsPlayed || 0, b.sessionsPlayed || 0);
  if (b.streak && (b.streak.count || 0) > ((a.streak && a.streak.count) || 0)) a.streak = { ...b.streak };
  return a;
}

/** Union of unlocked achievements, keeping the earliest unlock time. */
export function mergeAchievements(local, remote) {
  const out = { version: 1, unlocked: { ...((local && local.unlocked) || {}) } };
  for (const [k, at] of Object.entries((remote && remote.unlocked) || {})) {
    out.unlocked[k] = out.unlocked[k] && out.unlocked[k] < at ? out.unlocked[k] : at;
  }
  return out;
}

/** Union of the local boards (deduplicated by session id, best first per board). */
export function mergeBoards(local, remote) {
  const out = { version: 1, entries: {} };
  for (const src of [local, remote]) {
    for (const [key, list] of Object.entries((src && src.entries) || {})) {
      const into = out.entries[key] || (out.entries[key] = []);
      for (const e of list || []) if (!into.some((x) => x.sessionId && x.sessionId === e.sessionId)) into.push(e);
    }
  }
  for (const key of Object.keys(out.entries)) out.entries[key] = out.entries[key].sort((x, y) => (y.score || 0) - (x.score || 0)).slice(0, 100);
  return out;
}

// ---------------------------------------------------------------------------
// Achievements (stable lowercase keys, idempotent unlocks)
// ---------------------------------------------------------------------------

export const ACHIEVEMENTS = Object.freeze([
  { key: 'first_completion', name: 'First Mosaic', desc: 'Complete your first mosaic.' },
  { key: 'mechanic_mastery', name: 'Every Tool', desc: 'Complete a stage using rotation, locking, and decoy reading.' },
  { key: 'streak_7', name: 'Studio Regular', desc: 'Complete daily mosaics on 7 different days.' },
  { key: 'chapter_clear', name: 'Chapter Closed', desc: 'Complete every stage of a journey chapter.' },
  { key: 'mastery_10', name: 'Master of the Table', desc: 'Complete 10 mastery stages.' },
  { key: 'long_haul', name: 'Quiet Hours', desc: 'Play 50 sessions. Any mode, any pace — counts for everyone.' },
]);

export function loadAchievements() {
  return readRecord('achievements') || { version: 1, unlocked: {} }; // key -> iso timestamp
}
export function saveAchievements(a) { writeRecord('achievements', a); }
/** Idempotent unlock. Returns true if newly unlocked. */
export function unlockAchievement(a, key) {
  if (a.unlocked[key]) return false;
  a.unlocked[key] = new Date().toISOString();
  return true;
}

// ---------------------------------------------------------------------------
// Local leaderboards (score chase fallback; host boards live server-side)
// ---------------------------------------------------------------------------

export function loadBoards() {
  return readRecord('boards') || { version: 1, entries: {} }; // boardKey -> [entry]
}
export function saveBoards(b) { writeRecord('boards', b); }

// ---------------------------------------------------------------------------
// Last safe snapshot (resume interrupted round)
// ---------------------------------------------------------------------------

export function saveSnapshot(snapshot) { writeRecord('snapshot', snapshot); }
export function loadSnapshot() { return readRecord('snapshot'); }
export function clearSnapshot() { rawDel('snapshot'); }

// ---------------------------------------------------------------------------
// Anonymous analytics session id (random, rotatable, no personal data)
// ---------------------------------------------------------------------------

export function analyticsSessionId() {
  let id = readRecord('analytics-id');
  if (!id) {
    id = 'a-' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
    writeRecord('analytics-id', id);
  }
  return id;
}
