// platform.test.mjs — js/platform.js on top of starhermit-sdk.js with a
// stubbed fetch and launch fragment: token read, profile nickname, cloud save
// round-trip on game:<slug>, settings KV patch, control bindings, and no
// network at all when standalone.

import { readFileSync } from 'node:fs';
import { test } from './helpers.mjs';
import { Platform } from '../js/platform.js';

const SLUG = 'card-mosaic';
const UID = 'u-1234567890';

function assert(c, m) { if (!c) throw new Error(m || 'assertion failed'); }

function loadSdkFactory() {
  const src = readFileSync(new URL('../starhermit-sdk.js', import.meta.url), 'utf8');
  const mod = { exports: {} };
  new Function('module', 'exports', src)(mod, mod.exports);
  return mod.exports;
}

function jwt(claims) {
  const enc = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return enc({ alg: 'none' }) + '.' + enc(claims) + '.sig';
}

function resp(status, body, bytes) {
  return {
    status, ok: status >= 200 && status < 300, statusText: String(status),
    headers: { get: () => null },
    text: async () => (body == null ? '' : JSON.stringify(body)),
    json: async () => body,
    arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
  };
}

function fakeWindow(hash) {
  return {
    location: { hash, search: '', pathname: '/', hostname: 'localhost', href: 'http://localhost/' + hash, origin: 'http://localhost' },
    history: { state: null, replaceState(_s, _t, url) { this.url = url; } },
    addEventListener() {},
  };
}

function hostedEnv() {
  const calls = [];
  let saved = null;
  let settings = { audio: { music: 0.25 } };
  const fetchStub = async (url, init = {}) => {
    const method = init.method || 'GET';
    calls.push({ url, method, init });
    const path = String(url);
    if (path === `/api/v1/users/${UID}/profile`) return resp(200, { nickname: 'Ada' });
    if (path === `/api/v1/me/cloud-saves/${encodeURIComponent('game:' + SLUG)}`) {
      if (method === 'PUT') { saved = Buffer.from(JSON.parse(init.body).dataBase64, 'base64'); return resp(200, { etag: '"v' + calls.length + '"' }); }
      return saved ? resp(200, null, new Uint8Array(saved)) : resp(404, null);
    }
    if (path === `/api/v1/games/${SLUG}/settings`) {
      if (method === 'PATCH') { settings = { ...settings, ...JSON.parse(init.body).settings }; return resp(200, { settings }); }
      return resp(200, { settings });
    }
    if (path === `/api/v1/games/${SLUG}/controls`) return resp(200, { actions: [{ action: 'undo', codes: ['KeyZ'] }] });
    return resp(404, null);
  };
  return { calls, fetchStub, get saved() { return saved; } };
}

function installGlobals(win) {
  globalThis.window = win;
  globalThis.document = { hidden: false, addEventListener() {}, documentElement: { lang: 'en-US' } };
}

test('hosted: token, profile, cloud save game:<slug>, settings, bindings', async () => {
  const env = hostedEnv();
  const win = fakeWindow('#game_token=' + jwt({ sub: UID, game_scope: SLUG, exp: Math.floor(Date.now() / 1000) + 3600 }) + '&session_id=s1');
  installGlobals(win);
  const sdk = loadSdkFactory().create({ window: win, fetch: env.fetchStub, setTimeout: () => 0, clearTimeout: () => {} });
  globalThis.StarHermit = sdk.init();
  assert(sdk.token && sdk.userId === UID && sdk.slug === SLUG, 'token claims read');
  assert(sdk.launchSessionId === 's1', 'session id read');
  assert(!/game_token/.test(win.history.url || ''), 'fragment stripped');

  const p = new Platform();
  await p.init();
  assert(p.hosted && p.userId === UID && p.scope === SLUG, 'adapter hosted');
  const prof = await p.fetchProfile();
  assert(prof.name === 'Ada', 'nickname from profile: ' + prof.name);

  assert((await p.loadCloud()) === null, 'empty slot');
  const pending = p.saveCloud({ v: 1, progress: { masteryXp: 7 } });
  await p._flushSave();
  assert((await pending).ok, 'save resolved ok');
  const put = env.calls.find((c) => c.method === 'PUT');
  assert(put && put.url.endsWith('/cloud-saves/game%3Acard-mosaic'), 'cloud path is game:<slug>');
  assert(put.init.headers.Authorization === 'Bearer ' + sdk.token, 'bearer sent');
  const back = await p.loadCloud();
  assert(back && back.progress.masteryXp === 7, 'cloud round-trip');

  const kv = await p.getSettings();
  assert(kv.audio.music === 0.25, 'settings read');
  await p.patchSettings({ access: { largeText: true } });
  const patch = env.calls.find((c) => c.method === 'PATCH');
  assert(patch && JSON.parse(patch.init.body).settings.access.largeText === true, 'settings patched');

  const b = await p.loadBindings();
  assert(b.undo[0] === 'KeyZ' && b.hint[0] === 'KeyH', 'platform binding overrides defaults');
  assert(p.actionFor({ code: 'KeyZ' }) === 'undo' && p.actionFor({ code: 'KeyU' }) === null, 'actionFor uses bindings');
  assert(p.actionFor({ key: 'p' }) === 'pause', 'synthetic key fallback');
  assert(p.inviteLink() === `https://dashboard.starhermit.com/game-invite/${UID}/${SLUG}`, 'invite link');
  assert(!p.canSignIn(), 'no sign-in button when signed in');
});

test('standalone: no token, no network, local defaults', async () => {
  const calls = [];
  const win = fakeWindow('');
  installGlobals(win);
  const sdk = loadSdkFactory().create({ window: win, fetch: async (u) => { calls.push(u); return resp(500, null); } });
  globalThis.StarHermit = sdk.init();
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (u) => { calls.push(u); throw new Error('network'); };
  try {
    const p = new Platform();
    await p.init();
    assert(!p.hosted, 'not hosted');
    assert((await p.loadCloud()) === null, 'no cloud');
    assert((await p.saveCloud({ v: 1 })).ok === false, 'save is local only');
    assert(Object.keys(await p.getSettings()).length === 0, 'no settings');
    await p.patchSettings({ audio: { music: 1 } });
    const b = await p.loadBindings();
    assert(b.undo[0] === 'KeyU', 'default bindings');
    await p.getServerTime();
    await p.submitScore({ board: 'x', entry: {} });
    p.activityStart({});
    assert(!p.canSignIn() && p.inviteLink() === null, 'no sign-in on localhost, no invite');
    assert(calls.length === 0, 'fetch calls standalone: ' + calls.join(', '));
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('save conflict: a write that loses to another device reloads the cloud copy for merging', async () => {
  const cloud = { bytes: null, etag: null };
  const fetchStub = async (url, init = {}) => {
    const method = init.method || 'GET';
    const path = String(url);
    const slot = `/api/v1/me/cloud-saves/${encodeURIComponent('game:' + SLUG)}`;
    if (path === slot + '/info') return resp(200, cloud.bytes ? { exists: true, etag: cloud.etag } : { exists: false });
    if (path === slot) {
      if (method === 'PUT') {
        const h = init.headers || {};
        if ((h['If-Match'] && h['If-Match'] !== cloud.etag) || (h['If-None-Match'] === '*' && cloud.bytes)) return resp(412, { etag: cloud.etag });
        cloud.bytes = Buffer.from(JSON.parse(init.body).dataBase64, 'base64');
        cloud.etag = '"v' + Date.now() + '"';
        return resp(200, { etag: cloud.etag });
      }
      return cloud.bytes ? resp(200, null, new Uint8Array(cloud.bytes)) : resp(404, null);
    }
    return resp(404, null);
  };
  const win = fakeWindow('#game_token=' + jwt({ sub: UID, game_scope: SLUG, exp: Math.floor(Date.now() / 1000) + 3600 }));
  installGlobals(win);
  const sdk = loadSdkFactory().create({ window: win, fetch: fetchStub, setTimeout: () => 0, clearTimeout: () => {} });
  globalThis.StarHermit = sdk.init();
  const p = new Platform();
  await p.init();
  assert((await p.loadCloud()) === null, 'empty slot');
  // Another device saves first.
  const other = { v: 1, progress: { masteryXp: 9 } };
  cloud.bytes = Buffer.from(sdk._zip('save.json', new TextEncoder().encode(JSON.stringify(other))));
  cloud.etag = '"other"';
  const merged = new Promise((resolve) => p.onConflict(resolve));
  const pending = p.saveCloud({ v: 1, progress: { masteryXp: 2 } });
  await p._flushSave();
  const r = await pending;
  assert(r.ok === false && r.error === 'conflict', 'conflict reported: ' + JSON.stringify(r));
  const remote = await merged;
  assert(remote && remote.progress.masteryXp === 9, 'the other device\'s save is handed over for merging');
  assert(!sdk.saveConflicted(), 'writes are allowed again after the reload');
  const again = p.saveCloud({ v: 1, progress: { masteryXp: 9 } });
  await p._flushSave();
  assert((await again).ok, 'merged save lands');
});

test('merge helpers keep the better of both devices', async () => {
  const { mergeProgress, mergeAchievements, mergeBoards } = await import('../js/storage.js');
  const m = mergeProgress(
    { journey: { a: { completed: true, bestScore: 50, bestMoves: 9, stars: 1, completedAt: '2026-02-01' } }, lessons: {}, dailies: { d: { score: 10, completed: true } }, challenges: {}, masteryXp: 3, sessionsPlayed: 4, streak: { count: 1 } },
    { journey: { a: { completed: false, bestScore: 80, bestMoves: 7, stars: 2, completedAt: null }, b: { completed: true, stars: 3 } }, lessons: { l: { completed: true } }, dailies: { d: { score: 30, completed: false } }, challenges: {}, masteryXp: 1, sessionsPlayed: 9, streak: { count: 4 } });
  assert(m.journey.a.completed && m.journey.a.bestScore === 80 && m.journey.a.bestMoves === 7 && m.journey.a.stars === 2 && m.journey.a.completedAt === '2026-02-01', 'journey record merged');
  assert(m.journey.b.completed && m.lessons.l.completed, 'remote-only records kept');
  assert(m.dailies.d.score === 30 && m.dailies.d.completed, 'daily merged');
  assert(m.masteryXp === 3 && m.sessionsPlayed === 9 && m.streak.count === 4, 'counters take the larger value');
  const a = mergeAchievements({ unlocked: { x: '2026-03-01' } }, { unlocked: { x: '2026-01-01', y: '2026-02-01' } });
  assert(a.unlocked.x === '2026-01-01' && a.unlocked.y, 'achievements union, earliest unlock');
  const b = mergeBoards({ entries: { k: [{ score: 5, sessionId: 's1' }] } }, { entries: { k: [{ score: 9, sessionId: 's2' }, { score: 5, sessionId: 's1' }] } });
  assert(b.entries.k.length === 2 && b.entries.k[0].score === 9, 'boards union without duplicates');
});
