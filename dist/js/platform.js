// platform.js — StarHermit host adapter with graceful offline fallback.
// Hosted contract (wiki): the platform opens the game as
// index.html#game_token=<jwt> (optional &session_id=), stripped after the
// read. The JWT carries sub = user id and game_scope = this game's slug —
// never hard-coded. Same-origin /api calls send Authorization: Bearer; the
// token is re-minted every 45 min via POST /api/v1/games/{slug}/launch-token.
// The display name is the profile nickname from GET /api/v1/users/{sub}/profile
// — never /api/v1/me, never usernames. Cloud save is ONE zip+base64 slot at
// GET/PUT /api/v1/me/cloud-saves/{slug} (remote wins on boot; saves debounce
// ~2 s and flush on pagehide/hidden; localStorage stays the offline cache).
// Score/leaderboard/achievement/telemetry/activity/presence routes below are
// the game's OWN server script backend (declared server=server.js); they run
// on-platform and in local dev, and every method degrades to a structured
// {ok:false, error} / null result when offline. The launch token is kept in
// memory only — never written to localStorage.

const REFRESH_MS = 45 * 60 * 1000; // token lives 60 min; re-mint at 45
const RETRY_MS = 60 * 1000;
const SAVE_DEBOUNCE_MS = 2000;

// Minimal ZIP writer/reader (stored entries only, no compression).
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function zipStore(name, dataBytes) {
  const enc = new TextEncoder();
  const nameB = enc.encode(name);
  const crc = crc32(dataBytes);
  const out = [];
  const u16 = (v) => out.push(v & 0xff, (v >> 8) & 0xff);
  const u32 = (v) => out.push(v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >>> 24) & 0xff);
  u32(0x04034b50); u16(20); u16(0); u16(0); u16(0); u16(0);
  u32(crc); u32(dataBytes.length); u32(dataBytes.length);
  u16(nameB.length); u16(0);
  const head = new Uint8Array(out);
  const cd = [];
  const c16 = (v) => cd.push(v & 0xff, (v >> 8) & 0xff);
  const c32 = (v) => cd.push(v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >>> 24) & 0xff);
  c32(0x02014b50); c16(20); c16(20); c16(0); c16(0); c16(0); c16(0);
  c32(crc); c32(dataBytes.length); c32(dataBytes.length);
  c16(nameB.length); c16(0); c16(0); c16(0); c16(0); c32(0); c32(0);
  const cdHead = new Uint8Array(cd);
  const cdOff = head.length + nameB.length + dataBytes.length;
  const parts = [head, nameB, dataBytes, cdHead, nameB];
  const eocd = [];
  const e32 = (v) => eocd.push(v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >>> 24) & 0xff);
  const e16 = (v) => eocd.push(v & 0xff, (v >> 8) & 0xff);
  e32(0x06054b50); e16(0); e16(0); e16(1); e16(1);
  e32(cdHead.length + nameB.length); e32(cdOff); e16(0);
  parts.push(new Uint8Array(eocd));
  const total = parts.reduce((n, p) => n + p.length, 0);
  const buf = new Uint8Array(total);
  let o = 0;
  for (const p of parts) { buf.set(p, o); o += p.length; }
  return buf;
}
function unzipFirstEntry(zipBytes) {
  const dv = new DataView(zipBytes.buffer, zipBytes.byteOffset, zipBytes.byteLength);
  let off = 0;
  while (off + 30 <= zipBytes.length && dv.getUint32(off, true) === 0x04034b50) {
    const method = dv.getUint16(off + 8, true);
    const size = dv.getUint32(off + 18, true);
    const nameLen = dv.getUint16(off + 26, true);
    const extraLen = dv.getUint16(off + 28, true);
    const dataOff = off + 30 + nameLen + extraLen;
    if (method !== 0) throw new Error('unsupported zip entry');
    return zipBytes.slice(dataOff, dataOff + size);
  }
  throw new Error('bad zip');
}
function bytesToBase64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000)
    s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

export class Platform {
  constructor() {
    this.hosted = false;       // a launch token was read
    this.apiBase = '/api/v1';
    this.launchToken = null;   // memory only — never persisted
    this.userId = null;        // JWT sub
    this.scope = null;         // JWT game_scope — the cloud-save gameKey
    this.profile = { name: 'You', guest: true };
    this.sync = 'offline';     // offline | saving | synced (cloud mirror)
    this._syncListeners = [];
    this._profileNames = {};   // userId -> Promise<string>
    this._timeOffsetMs = 0;
    this._lastHeartbeat = 0;
    this._playing = false;
    this._refreshTimer = null;
    this._retryTimer = null;
    this._saveTimer = null;
    this._pendingSave = null;
    this._saveWaiters = [];
  }

  get tokenHosted() { return this.hosted; }

  /* --------------------------- bootstrap ---------------------------- */

  // Fragment first (platform contract); query forms are local-dev only.
  _readLaunchToken() {
    if (typeof window === 'undefined' || !window.location) return null;
    try {
      const h = new URLSearchParams(String(window.location.hash || '').replace(/^#/, ''));
      const t = h.get('game_token');
      if (t) {
        h.delete('game_token');
        h.delete('session_id');
        const rest = h.toString();
        window.history.replaceState(null, '',
          window.location.pathname + window.location.search + (rest ? '#' + rest : ''));
        return t;
      }
      const q = new URLSearchParams(window.location.search);
      return q.get('game_token') || q.get('launchToken') || q.get('token') || null;
    } catch {
      return null;
    }
  }

  _decodeJwt(t) {
    try {
      const seg = String(t).split('.')[1];
      if (!seg) return null;
      let b64 = seg.replace(/-/g, '+').replace(/_/g, '/');
      b64 += '='.repeat((4 - (b64.length % 4)) % 4);
      const bin = atob(b64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      return JSON.parse(new TextDecoder().decode(bytes));
    } catch {
      return null;
    }
  }

  /**
   * Read the launch token (fragment, stripped), decode sub/game_scope, start
   * the 45-min refresh, and probe the own-server time route. Hosted mode
   * activates iff a token was read.
   */
  async init() {
    this.launchToken = this._readLaunchToken();
    if (this.launchToken) {
      const claims = this._decodeJwt(this.launchToken);
      if (!claims) this.launchToken = null;
      else {
        if (typeof claims.sub === 'string' && claims.sub) this.userId = claims.sub;
        if (typeof claims.game_scope === 'string' && claims.game_scope) this.scope = claims.game_scope;
        if (!this.userId || !this.scope) this.launchToken = null;
      }
    }
    this.hosted = !!this.launchToken;
    if (this.hosted) {
      this._scheduleRefresh();
      try { window.addEventListener('pagehide', () => this._flushSave()); } catch { /* no window events */ }
      document.addEventListener('visibilitychange', () => { if (document.hidden) this._flushSave(); });
      this.fetchProfile(); // nickname lands async via the profile chip
    }
    const probe = await this._fetch(this.apiBase + '/time', { timeoutMs: 2000 });
    this._serverReachable = !!(probe && probe.ok && probe.body && typeof probe.body.now === 'number');
    return { hosted: this.hosted };
  }

  /* --------------------------- identity ----------------------------- */
  // Nickname via GET /api/v1/users/{id}/profile — the only profile read a
  // game-scoped token may make. Never /api/v1/me, never usernames.
  profileFor(userId) {
    if (!userId || typeof userId !== 'string') return Promise.resolve('Anonymous');
    if (this._profileNames[userId]) return this._profileNames[userId];
    const p = this._fetch(`/api/v1/users/${encodeURIComponent(userId)}/profile`)
      .then((r) => (r.ok && r.body && typeof r.body.nickname === 'string' && r.body.nickname ? r.body.nickname : null))
      .then((n) => n || ('Player ' + userId.slice(0, 8)))
      .catch(() => 'Player ' + userId.slice(0, 8));
    this._profileNames[userId] = p;
    return p;
  }

  async fetchProfile() {
    if (!this.userId) return null;
    const name = (await this.profileFor(this.userId)).slice(0, 40);
    this.profile = { name, guest: false };
    return this.profile;
  }

  /* --------------------------- token refresh ------------------------ */

  _scheduleRefresh() {
    if (this._refreshTimer) clearInterval(this._refreshTimer);
    this._refreshTimer = setInterval(() => this._refreshToken(), REFRESH_MS);
  }

  _refreshToken() {
    if (!this.launchToken || !this.scope) return Promise.resolve(false);
    return this._fetch(`/api/v1/games/${encodeURIComponent(this.scope)}/launch-token`, { method: 'POST', body: {} })
      .then((res) => {
        if (res.ok && res.body && typeof res.body.token === 'string' && res.body.token) {
          this.launchToken = res.body.token;
          const claims = this._decodeJwt(this.launchToken);
          if (claims && claims.sub) this.userId = claims.sub;
          if (claims && claims.game_scope) this.scope = claims.game_scope;
          return true;
        }
        this._retryRefresh();
        return false;
      })
      .catch(() => { this._retryRefresh(); return false; });
  }

  _retryRefresh() {
    if (this._retryTimer || !this.launchToken) return;
    this._retryTimer = setTimeout(() => {
      this._retryTimer = null;
      this._refreshToken();
    }, RETRY_MS);
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
  // cloud save — the real platform slot (zip+base64, one slot).
  // Remote wins on boot (the caller merges); saves debounce and flush on
  // pagehide/hidden; localStorage stays the offline cache.
  // -------------------------------------------------------------------------

  /** GET /api/v1/me/cloud-saves/{slug} → doc or null. */
  async loadCloud() {
    if (!this.hosted || !this.scope) return null;
    try {
      const res = await fetch(`${this.apiBase}/me/cloud-saves/${encodeURIComponent(this.scope)}`, {
        headers: this.launchToken ? { Authorization: `Bearer ${this.launchToken}` } : {},
      });
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`http-${res.status}`);
      const buf = new Uint8Array(await res.arrayBuffer());
      if (!buf.byteLength) return null;
      return JSON.parse(new TextDecoder().decode(unzipFirstEntry(buf)));
    } catch {
      return null;
    }
  }

  /** PUT the save doc to the cloud slot (debounced; resolves on flush). */
  saveCloud(doc) {
    if (!this.hosted || !this.scope) return Promise.resolve({ ok: false, error: 'offline' });
    this._pendingSave = doc;
    this._setSync('saving');
    if (this._saveTimer) clearTimeout(this._saveTimer);
    this._saveTimer = setTimeout(() => this._flushSave(), SAVE_DEBOUNCE_MS);
    return new Promise((resolve) => this._saveWaiters.push(resolve));
  }

  _flushSave() {
    if (this._saveTimer) { clearTimeout(this._saveTimer); this._saveTimer = null; }
    const waiters = this._saveWaiters;
    this._saveWaiters = [];
    const done = (result) => { for (const w of waiters) w(result); return result; };
    if (!this.hosted || !this.scope || this._pendingSave == null) {
      return Promise.resolve(done({ ok: false, error: 'nothing-pending' }));
    }
    const doc = this._pendingSave;
    this._pendingSave = null;
    let body;
    try {
      body = { dataBase64: bytesToBase64(zipStore('save.json', new TextEncoder().encode(JSON.stringify(doc)))) };
    } catch {
      return Promise.resolve(done({ ok: false, error: 'encode-failed' }));
    }
    return fetch(`${this.apiBase}/me/cloud-saves/${encodeURIComponent(this.scope)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.launchToken}` },
      body: JSON.stringify(body),
      keepalive: true,
    }).then((res) => {
      if (res.ok) { this._setSync('synced'); return done({ ok: true }); }
      this._pendingSave = this._pendingSave == null ? doc : this._pendingSave;
      this._setSync('offline');
      return done({ ok: false, error: `http-${res.status}` });
    }).catch(() => {
      this._pendingSave = this._pendingSave == null ? doc : this._pendingSave;
      this._setSync('offline');
      return done({ ok: false, error: 'network' });
    });
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
