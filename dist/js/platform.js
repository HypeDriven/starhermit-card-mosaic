// platform.js — StarHermit host adapter with graceful offline fallback.
// Platform plumbing (launch token from #game_token / #access_token, renewal,
// profile nickname, cloud-save slot game:<slug>, settings KV, controls,
// invite link, sign-in) goes through window.StarHermit (starhermit-sdk.js,
// loaded and init()ed from index.html before this module). Without a token
// the game is an offline guest and nothing here touches the network.
// Score/leaderboard/achievement/telemetry/activity/presence routes below are
// the game's OWN server backend (server.js, local dev); they are only probed
// when signed in and every method degrades to {ok:false} / null.

const SAVE_DEBOUNCE_MS = 2000;
const sdk = () => globalThis.StarHermit || null;

// Keyboard actions — declared as control.<action> in starhermit.txt.
export const DEFAULT_BINDINGS = {
  up: ['ArrowUp'], down: ['ArrowDown'], left: ['ArrowLeft'], right: ['ArrowRight'],
  select: ['Enter', 'Space'], cancel: ['Escape'],
  undo: ['KeyU'], hint: ['KeyH'], rotate: ['KeyR'], lock: ['KeyL'], pause: ['KeyP'],
};
// Synthetic events (gamepad) carry only `key`; map those onto actions too.
const KEY_FALLBACK = {
  ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right',
  Enter: 'select', ' ': 'select', Escape: 'cancel',
  u: 'undo', h: 'hint', r: 'rotate', l: 'lock', p: 'pause',
};

export class Platform {
  constructor() {
    this.apiBase = '/api/v1';
    this.profile = { name: 'You', guest: true };
    this.sync = 'offline';     // offline | saving | synced (cloud mirror)
    this.bindings = Object.fromEntries(Object.entries(DEFAULT_BINDINGS).map(([k, v]) => [k, v.slice()]));
    this._codeMap = null;
    this._syncListeners = [];
    this._authListeners = [];
    this._timeOffsetMs = 0;
    this._lastHeartbeat = 0;
    this._playing = false;
    this._saveWaiters = [];
    this._serverReachable = false;
  }

  get hosted() { const s = sdk(); return !!(s && s.signedIn); }
  get tokenHosted() { return this.hosted; }
  get launchToken() { const s = sdk(); return s ? s.token : null; }
  get userId() { const s = sdk(); return s ? s.userId : null; }
  get scope() { const s = sdk(); return s ? s.slug : null; }

  /* --------------------------- bootstrap ---------------------------- */

  /**
   * Hook the SDK's auth/saved events, resolve the nickname, and (signed in
   * only) probe the own-server time route. Standalone makes no requests.
   */
  async init() {
    const s = sdk();
    if (s) {
      s.on('saved', (ok) => {
        this._setSync(ok ? 'synced' : 'offline');
        const w = this._saveWaiters; this._saveWaiters = [];
        for (const fn of w) fn(ok ? { ok: true } : { ok: false, error: 'network' });
      });
      s.on('auth', (a) => {
        if (!a.signedIn) { this.profile = { name: 'You', guest: true }; this._setSync('offline'); }
        for (const fn of this._authListeners) { try { fn(a); } catch { /* listener errors never break the adapter */ } }
      });
    }
    if (this.hosted) {
      try { window.addEventListener('pagehide', () => this._flushSave()); } catch { /* no window events */ }
      document.addEventListener('visibilitychange', () => { if (document.hidden) this._flushSave(); });
      this.fetchProfile(); // nickname lands async via the profile chip
      const probe = await this._fetch(this.apiBase + '/time', { timeoutMs: 2000 });
      this._serverReachable = !!(probe && probe.ok && probe.body && typeof probe.body.now === 'number');
    }
    return { hosted: this.hosted };
  }

  onAuth(fn) { if (typeof fn === 'function') this._authListeners.push(fn); }
  canSignIn() { const s = sdk(); return !!(s && s.canSignIn()); }
  signIn() { const s = sdk(); return !!(s && s.signIn()); }
  inviteLink() { const s = sdk(); return s && s.signedIn ? s.inviteLink() : null; }

  /** Copy the invite link; resolves true when it reached the clipboard. */
  async copyInvite() {
    const link = this.inviteLink();
    if (!link) return false;
    try { await navigator.clipboard.writeText(link); return true; } catch { return false; }
  }

  /* --------------------------- identity ----------------------------- */
  // Nickname via the SDK (GET /api/v1/users/{id}/profile) — never /api/v1/me.
  profileFor(userId) {
    const s = sdk();
    if (!userId || typeof userId !== 'string') return Promise.resolve('Anonymous');
    if (!s || !s.signedIn) return Promise.resolve('Player ' + userId.slice(0, 6));
    return s.profile(userId).then((p) => (p && p.displayName) || 'Player ' + userId.slice(0, 6))
      .catch(() => 'Player ' + userId.slice(0, 6));
  }

  async fetchProfile() {
    if (!this.userId) return null;
    const name = (await this.profileFor(this.userId)).slice(0, 40);
    this.profile = { name, guest: false };
    return this.profile;
  }

  /* --------------------------- settings KV -------------------------- */

  /** Platform-stored preferences ({} when signed out). */
  async getSettings() {
    const s = sdk();
    if (!s || !s.signedIn) return {};
    try { return (await s.getSettings()) || {}; } catch { return {}; }
  }

  patchSettings(obj) {
    const s = sdk();
    if (!s || !s.signedIn) return Promise.resolve(null);
    return s.patchSettings(obj).catch(() => null);
  }

  /* --------------------------- controls ----------------------------- */

  /** Resolve bindings (platform overrides over defaults). */
  async loadBindings() {
    const s = sdk();
    if (s && s.signedIn) {
      try { this.bindings = await s.loadBindings(DEFAULT_BINDINGS); } catch { /* keep defaults */ }
    }
    this._codeMap = null;
    return this.bindings;
  }

  resetControls() {
    this.bindings = Object.fromEntries(Object.entries(DEFAULT_BINDINGS).map(([k, v]) => [k, v.slice()]));
    this._codeMap = null;
    const s = sdk();
    return s && s.signedIn ? s.resetControls().catch(() => null) : Promise.resolve(null);
  }

  /** Action name for a keydown event (event.code first, key for synthetic events). */
  actionFor(e) {
    if (!this._codeMap) {
      this._codeMap = {};
      for (const [a, codes] of Object.entries(this.bindings)) for (const c of codes) this._codeMap[c] = a;
    }
    if (e.code) return this._codeMap[e.code] || null;
    const k = e.key && e.key.length === 1 ? e.key.toLowerCase() : e.key;
    return KEY_FALLBACK[k] || null;
  }

  onSync(fn) {
    if (typeof fn === 'function') this._syncListeners.push(fn);
  }

  _setSync(state) {
    if (this.sync === state) return;
    this.sync = state;
    for (const fn of this._syncListeners) {
      try { fn(state); } catch { /* listener errors never break the adapter */ }
    }
  }

  // -------------------------------------------------------------------------
  // time
  // -------------------------------------------------------------------------

  /**
   * Server time with RTT adjustment: assume the server stamped `now` at the
   * midpoint of the round trip. Falls back to the local clock offline.
   */
  async getServerTime() {
    if (this._serverReachable) {
      const t0 = Date.now();
      const res = await this._fetch(this.apiBase + '/time');
      const t1 = Date.now();
      if (res.ok && res.body && typeof res.body.now === 'number') {
        const rtt = t1 - t0;
        const serverNow = res.body.now + Math.round(rtt / 2);
        this._timeOffsetMs = serverNow - t1;
        return { nowMs: serverNow, offsetMs: this._timeOffsetMs, source: 'server' };
      }
      this._serverReachable = false; // probe passed earlier but now failing — degrade
    }
    return { nowMs: Date.now(), offsetMs: 0, source: 'local' };
  }

  // -------------------------------------------------------------------------
  // scores / leaderboards (own-server backend routes)
  // -------------------------------------------------------------------------

  /**
   * POST {board, entry:{result, replay, name?, playerId?}} to /scores.
   * On {error} or 429 returns {ok:false, error, retryAfterMs?}.
   */
  async submitScore(entry) {
    if (!this._serverReachable) return { ok: false, error: 'offline' };
    const res = await this._fetch(this.apiBase + '/scores', {
      method: 'POST',
      body: entry,
      auth: true,
    });
    if (res.ok && res.body && res.body.ok !== false && !res.body.error) {
      return { ok: true, ...res.body };
    }
    if (res.status === 429) {
      return {
        ok: false,
        error: (res.body && res.body.error) || 'rate-limited',
        retryAfterMs: res.retryAfterMs ?? 60000,
      };
    }
    if (res.status === 0) return { ok: false, error: 'offline' };
    return { ok: false, error: (res.body && res.body.error) || 'submit-failed' };
  }

  /**
   * Post a finished round's total to the StarHermit `high-score` board
   * (score-script.js) via StarHermit.submitScores; resolves {posted, rank}
   * — the player's rank on that board, or null. Signed out: posts nothing.
   */
  async postHighScore(total) {
    const s = sdk();
    if (!s || !s.signedIn) return { posted: false, rank: null };
    try {
      const keys = await s.submitScores({ 'high-score': total });
      if (!keys || keys.indexOf('high-score') < 0) return { posted: false, rank: null };
      try {
        const r = await s.leaderboard('high-score', { pageSize: 100 });
        const me = ((r && r.items) || []).find((i) => i.userId === s.userId);
        return { posted: true, rank: me ? me.rank : null };
      } catch { return { posted: true, rank: null }; }
    } catch { return { posted: false, rank: null }; }
  }

  /** GET /leaderboards?board=&scope= → {ok, entries, validated} */
  async fetchLeaderboard({ board, scope = 'global' } = {}) {
    if (!this._serverReachable) return { ok: false };
    const q = new URLSearchParams();
    if (board) q.set('board', board);
    if (scope) q.set('scope', scope);
    const res = await this._fetch(this.apiBase + '/leaderboards?' + q.toString());
    if (res.ok && res.body && Array.isArray(res.body.entries)) {
      return { ok: true, entries: res.body.entries, validated: !!res.body.validated, friendsFiltered: !!res.body.friendsFiltered };
    }
    return { ok: false };
  }

  // -------------------------------------------------------------------------
  // cloud save — the platform slot game:<slug> via the SDK (zip+base64).
  // Remote wins on boot (the caller merges); saves debounce and flush on
  // pagehide/hidden; localStorage stays the offline cache.
  // -------------------------------------------------------------------------

  /** The cloud save doc, or null (none / signed out). */
  async loadCloud() {
    if (!this.hosted) return null;
    try { return await sdk().loadJSON(); } catch { return null; }
  }

  /** Mirror the save doc to the cloud slot (debounced; resolves on flush). */
  saveCloud(doc) {
    if (!this.hosted) return Promise.resolve({ ok: false, error: 'offline' });
    this._setSync('saving');
    sdk().saveJSON(doc, SAVE_DEBOUNCE_MS);
    return new Promise((resolve) => this._saveWaiters.push(resolve));
  }

  _flushSave() {
    const s = sdk();
    if (!s || !s.signedIn) return Promise.resolve({ ok: false, error: 'nothing-pending' });
    return s.flushSave(true).then((ok) => (ok ? { ok: true } : { ok: false, error: 'nothing-pending' }));
  }

  // -------------------------------------------------------------------------
  // telemetry / achievements / presence — own-server backend, best-effort
  // -------------------------------------------------------------------------

  /** Batch POST /telemetry. Caller is responsible for consent gating. */
  async postTelemetry(events) {
    if (!this._serverReachable || !Array.isArray(events) || events.length === 0) return { ok: false };
    const res = await this._fetch(this.apiBase + '/telemetry', {
      method: 'POST',
      body: { events: events.slice(0, 100) },
      auth: true,
    });
    return { ok: res.ok };
  }

  /** Record an achievement unlock server-side (idempotent). */
  async postAchievement(key) {
    if (!this._serverReachable) return { ok: false };
    const res = await this._fetch(this.apiBase + '/achievements', { method: 'POST', body: { key }, auth: true });
    return { ok: res.ok };
  }

  activityStart(meta = {}) {
    this._playing = true;
    this._post('/activity', { phase: 'start', ...meta });
  }

  activityEnd(summary = {}) {
    this._playing = false;
    this._post('/activity', { phase: 'end', ...summary });
  }

  /** Presence ping, throttled to once per 30s, only while hosted + playing. */
  presenceHeartbeat() {
    if (!this._serverReachable || !this._playing) return;
    const now = Date.now();
    if (now - this._lastHeartbeat < 30000) return;
    this._lastHeartbeat = now;
    this._post('/presence', { t: now });
  }

  _post(path, body) {
    // Fire and forget only when this game's API contract was positively
    // detected; the platform host has a different shared /api surface.
    if (!this._serverReachable) return;
    this._fetch(this.apiBase + path, { method: 'POST', body, auth: true }).catch(() => {});
  }

  // -------------------------------------------------------------------------
  // fetch plumbing — 5s AbortController timeout, never throws
  // -------------------------------------------------------------------------

  async _fetch(url, { method = 'GET', body = null, auth = false, timeoutMs = 5000 } = {}) {
    if (typeof fetch === 'undefined') return { ok: false, status: 0, body: null };
    const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timer = ctrl ? setTimeout(() => ctrl.abort(), timeoutMs) : null;
    try {
      const headers = {};
      if (body !== null) headers['Content-Type'] = 'application/json';
      if (auth && this.launchToken) headers['Authorization'] = 'Bearer ' + this.launchToken;
      if (!this.hosted) return { ok: false, status: 0, body: null };
      const resp = await fetch(url, {
        method,
        headers,
        body: body !== null ? JSON.stringify(body) : null,
        signal: ctrl ? ctrl.signal : undefined,
      });
      let parsed = null;
      const text = await resp.text();
      if (text) { try { parsed = JSON.parse(text); } catch { parsed = null; } }
      const out = { ok: resp.ok, status: resp.status, body: parsed };
      if (resp.status === 429) {
        const ra = resp.headers.get('Retry-After');
        const sec = ra ? Number(ra) : NaN;
        out.retryAfterMs = Number.isFinite(sec) ? sec * 1000 : 60000;
      }
      return out;
    } catch {
      return { ok: false, status: 0, body: null };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}
