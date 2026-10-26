// migrate.js — the engine client's save document and what the browser build
// left in the player's account (pure: no storage, importable in node).
//  - The engine save (starhermit:storage `saves`) is { v: 1, progress,
//    achievements, boards }: the browser build's cloud document without its
//    settings (those are the runtime's Options and the game's own settings
//    now). Two devices' copies merge with storage.js's mergeProgress,
//    mergeAchievements and mergeBoards (journey records, lessons, dailies and
//    challenges at their best, every achievement with its earliest unlock,
//    both local boards).
//  - The browser build's cloud save (slot game:card-mosaic, the JS SDK's
//    zipped save.json) is { v: 1, at, settings, progress, achievements,
//    boards }; the engine shows it as a foreign save whose text this reads.
//  - Settings: the browser build kept its whole settings object in the save
//    and the groups audio, graphics, access and privacy in the account's
//    per-player settings. The game's own options carry over (table theme,
//    colour-vision palette, left-handed layout, hold to confirm, timing
//    assist, haptics, captions); volumes, graphics quality, reduced motion,
//    high contrast, larger text and the language are the runtime's Options
//    now and are dropped, as is the telemetry consent (no telemetry).

import { mergeProgress, mergeAchievements, mergeBoards, DEFAULT_PROGRESS } from './storage.js';
import { THEMES } from './themes.js';

const obj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : null);
const clone = (v) => JSON.parse(JSON.stringify(v));

/** A document with every part present. */
export function normalize(doc) {
  const d = obj(doc) || {};
  const progress = { ...clone(DEFAULT_PROGRESS), ...(obj(d.progress) || {}) };
  for (const k of ['journey', 'lessons', 'dailies', 'challenges']) if (!obj(progress[k])) progress[k] = {};
  const ach = obj(d.achievements) || {};
  const boards = obj(d.boards) || {};
  return {
    v: 1,
    progress,
    achievements: { version: 1, unlocked: { ...(obj(ach.unlocked) || {}) } },
    boards: { version: 1, entries: { ...(obj(boards.entries) || {}) } },
  };
}

/** The progress document in an engine save, or null. */
export function docFromSave(data) {
  const d = obj(data);
  return d && d.v === 1 ? normalize(d) : null;
}

/** The browser build's cloud save text → { doc, settings } (either may be null). */
export function fromBrowserSave(text) {
  if (typeof text !== 'string') return { doc: null, settings: null };
  let d;
  try { d = JSON.parse(text); } catch { return { doc: null, settings: null }; }
  if (!obj(d)) return { doc: null, settings: null };
  const has = d.progress || d.achievements || d.boards;
  return { doc: has ? normalize(d) : null, settings: obj(d.settings) ? gameSettingsFrom(d.settings) : null };
}

/** Two documents merged (either may be null), keeping the better of every record. */
export function mergeDocs(a, b) {
  if (!a && !b) return normalize({});
  if (!a) return normalize(b);
  if (!b) return normalize(a);
  const x = normalize(a), y = normalize(b);
  return normalize({
    progress: mergeProgress(x.progress, y.progress),
    achievements: mergeAchievements(x.achievements, y.achievements),
    boards: mergeBoards(x.boards, y.boards),
  });
}

// ---------------------------------------------------------------- settings

const bool = (v) => typeof v === 'boolean';
const THEME_IDS = ['auto', ...Object.keys(THEMES)];
/** The game's own settings (game.<key> in the runtime's settings) with their checks. */
export const GAME_SETTINGS = {
  theme: (v) => THEME_IDS.includes(v),
  cvd: bool,
  leftHanded: bool,
  holdToConfirm: bool,
  timingAssist: bool,
  haptics: bool,
  captions: bool,
  profileName: (v) => typeof v === 'string' && v.length <= 24,
};
export const GAME_SETTING_KEYS = Object.keys(GAME_SETTINGS);
export const DEFAULT_GAME_SETTINGS = Object.freeze({
  theme: 'studio', cvd: false, leftHanded: false, holdToConfirm: false, timingAssist: false,
  haptics: true, captions: true, profileName: '',
});
/** The per-player settings keys the browser build wrote (its SYNCED_SETTINGS groups). */
export const BROWSER_SETTING_KEYS = ['audio', 'graphics', 'access', 'privacy'];

/** A value for one of the game's settings, or undefined when it is not one. */
export function checkSetting(key, value) {
  const check = GAME_SETTINGS[key];
  return check && check(value) ? value : undefined;
}

/** The game's settings found in a browser-build settings object (or one of its groups by key). */
export function gameSettingsFrom(settings) {
  const s = obj(settings) || {};
  const out = {};
  const g = obj(s.graphics) || {};
  const a = obj(s.access) || {};
  const put = (key, v) => { if (checkSetting(key, v) !== undefined) out[key] = v; };
  put('theme', g.theme);
  put('cvd', g.cvd);
  for (const k of ['leftHanded', 'holdToConfirm', 'timingAssist', 'haptics', 'captions']) put(k, a[k]);
  return out;
}

/** The game's settings in one of the browser build's per-player settings keys. */
export function gameSettingsFromLegacy(key, value) {
  if (key === 'graphics' || key === 'access') return gameSettingsFrom({ [key]: value });
  return {};
}
