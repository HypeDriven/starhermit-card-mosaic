// migrate.test.mjs — the engine save document and what the browser build left
// in the account (js/migrate.js over js/storage.js's merges): the foreign
// cloud save (the JS SDK's save.json text) read into a document and the
// game's own settings, two devices' documents merged, the per-player
// settings groups, and the merge helpers themselves.
import assert from 'node:assert/strict';
import { test } from './helpers.mjs';
import { mergeProgress, mergeAchievements, mergeBoards } from '../js/storage.js';
import * as M from '../js/migrate.js';

const browserSave = JSON.stringify({
  v: 1, at: '2026-10-01T10:00:00.000Z',
  settings: {
    version: 1, audio: { music: 0.4, effects: 0.9, ambience: 0.5, voice: 0.8, muted: true },
    graphics: { quality: 'high', theme: 'ember', cvd: true, gfx: { preset: 'auto' } },
    access: { reducedMotion: true, highContrast: false, largeText: true, leftHanded: true, holdToConfirm: false, timingAssist: true, haptics: false, captions: true },
    controls: { bindings: null }, tutorial: { completed: ['lesson-place'], replaySeen: false }, privacy: { telemetryConsent: true },
  },
  progress: { version: 1, journey: { 'j-1': { completed: true, bestScore: 265, bestMoves: 3, stars: 3, completedAt: '2026-09-30T00:00:00.000Z' } }, lessons: { 'lesson-place': { completed: true } }, masteryXp: 1, dailies: {}, challenges: {}, sessionsPlayed: 7, streak: { lastDailyKey: null, count: 0 } },
  achievements: { version: 1, unlocked: { first_completion: '2026-09-30T00:00:00.000Z' } },
  boards: { version: 1, entries: { 'j-1': [{ score: 265, sessionId: 's-a', name: 'Ada' }] } },
});

test('the browser build\'s cloud save becomes the engine document and the game\'s settings', () => {
  const { doc, settings } = M.fromBrowserSave(browserSave);
  assert.equal(doc.v, 1);
  assert.equal(doc.progress.journey['j-1'].stars, 3);
  assert.equal(doc.progress.sessionsPlayed, 7);
  assert.ok(doc.achievements.unlocked.first_completion);
  assert.equal(doc.boards.entries['j-1'][0].score, 265);
  assert.equal('settings' in doc, false);
  // the game's own options carry over; volumes, motion, contrast, text size and telemetry are the runtime's
  assert.deepEqual(settings, { theme: 'ember', cvd: true, leftHanded: true, holdToConfirm: false, timingAssist: true, haptics: false, captions: true });
});

test('unreadable or empty saves give nothing; engine saves are recognised by v', () => {
  assert.deepEqual(M.fromBrowserSave('not json'), { doc: null, settings: null });
  assert.deepEqual(M.fromBrowserSave(null), { doc: null, settings: null });
  assert.equal(M.docFromSave({ v: 2 }), null);
  assert.equal(M.docFromSave(null), null);
  const d = M.docFromSave({ v: 1, progress: { masteryXp: 4 } });
  assert.equal(d.progress.masteryXp, 4);
  assert.deepEqual(d.progress.journey, {});
  assert.deepEqual(d.achievements, { version: 1, unlocked: {} });
});

test('two devices\' documents merge to the better of both', () => {
  const a = M.normalize({ progress: { journey: { s: { completed: true, bestScore: 10, bestMoves: 5, stars: 1 } }, sessionsPlayed: 3 }, achievements: { unlocked: { x: '2026-02-01' } } });
  const b = M.normalize({ progress: { journey: { s: { completed: false, bestScore: 40, bestMoves: 4, stars: 2 } }, sessionsPlayed: 9 }, boards: { entries: { k: [{ score: 3, sessionId: 'q' }] } } });
  const m = M.mergeDocs(a, b);
  assert.deepEqual(m.progress.journey.s, { completed: true, bestScore: 40, bestMoves: 4, stars: 2, completedAt: null });
  assert.equal(m.progress.sessionsPlayed, 9);
  assert.ok(m.achievements.unlocked.x);
  assert.equal(m.boards.entries.k.length, 1);
  assert.deepEqual(M.mergeDocs(null, null), M.normalize({}));
  assert.deepEqual(M.mergeDocs(a, null), a);
});

test('the per-player settings groups: graphics and access carry the game\'s options', () => {
  assert.deepEqual(M.gameSettingsFromLegacy('graphics', { theme: 'slate', cvd: false, quality: 'low' }), { theme: 'slate', cvd: false });
  assert.deepEqual(M.gameSettingsFromLegacy('access', { haptics: true, largeText: true }), { haptics: true });
  assert.deepEqual(M.gameSettingsFromLegacy('audio', { music: 1 }), {});
  assert.equal(M.checkSetting('theme', 'nope'), undefined);
  assert.equal(M.checkSetting('profileName', 'Ada'), 'Ada');
  assert.equal(M.checkSetting('profileName', 'x'.repeat(30)), undefined);
  assert.ok(M.BROWSER_SETTING_KEYS.includes('access'));
});

test('merge helpers keep the better of both devices', () => {
  const m = mergeProgress(
    { journey: { a: { completed: true, bestScore: 50, bestMoves: 9, stars: 1, completedAt: '2026-02-01' } }, lessons: {}, dailies: { d: { score: 10, completed: true } }, challenges: {}, masteryXp: 3, sessionsPlayed: 4, streak: { count: 1 } },
    { journey: { a: { completed: false, bestScore: 80, bestMoves: 7, stars: 2, completedAt: null }, b: { completed: true, stars: 3 } }, lessons: { l: { completed: true } }, dailies: { d: { score: 30, completed: false } }, challenges: {}, masteryXp: 1, sessionsPlayed: 9, streak: { count: 4 } });
  assert.ok(m.journey.a.completed && m.journey.a.bestScore === 80 && m.journey.a.bestMoves === 7 && m.journey.a.stars === 2 && m.journey.a.completedAt === '2026-02-01');
  assert.ok(m.journey.b.completed && m.lessons.l.completed);
  assert.ok(m.dailies.d.score === 30 && m.dailies.d.completed);
  assert.ok(m.masteryXp === 3 && m.sessionsPlayed === 9 && m.streak.count === 4);
  const a = mergeAchievements({ unlocked: { x: '2026-03-01' } }, { unlocked: { x: '2026-01-01', y: '2026-02-01' } });
  assert.ok(a.unlocked.x === '2026-01-01' && a.unlocked.y);
  const b = mergeBoards({ entries: { k: [{ score: 5, sessionId: 's1' }] } }, { entries: { k: [{ score: 9, sessionId: 's2' }, { score: 5, sessionId: 's1' }] } });
  assert.ok(b.entries.k.length === 2 && b.entries.k[0].score === 9);
});
