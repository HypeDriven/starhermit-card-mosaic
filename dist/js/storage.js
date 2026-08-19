// storage.js — versioned, checksummed local persistence.
// Key prefix cardmosaic.v1. Every record is an envelope {v, data, crc};
// corrupt or version-mismatched entries read as null (never throw).

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
const backing = typeof localStorage !== 'undefined' ? store() : null;

function rawGet(key) {
  if (backing) return backing.getItem(PREFIX + key);
  return memory.get(key) ?? null;
}
function rawSet(key, value) {
  if (backing) backing.setItem(PREFIX + key, value);
  else memory.set(key, value);
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
  graphics: { quality: 'high', theme: 'studio', cvd: false },
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
  if (!s) return structuredClone(DEFAULT_SETTINGS);
  // shallow-merge over defaults so new keys appear on old saves
  const merged = structuredClone(DEFAULT_SETTINGS);
  for (const k of Object.keys(merged)) {
    if (s[k] && typeof s[k] === 'object' && !Array.isArray(s[k])) Object.assign(merged[k], s[k]);
    else if (s[k] !== undefined) merged[k] = s[k];
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
  if (!p) return structuredClone(DEFAULT_PROGRESS);
  const merged = structuredClone(DEFAULT_PROGRESS);
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
