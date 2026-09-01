// platform.js — StarHermit host adapter with graceful offline fallback.
// Detects whether the game is served by the StarHermit host (same-origin
// /api/v1) and talks to it; every method degrades to a structured
// {ok:false, error} / null result when offline. The launch token is read from
// the URL and kept in memory only — never written to localStorage.

export class Platform {
  constructor() {
    this.hosted = false;
    this.apiBase = '/api/v1';
    this.launchToken = null;   // memory only — never persisted
    this._timeOffsetMs = 0;
    this._lastHeartbeat = 0;
    this._playing = false;
  }

  /**
   * Detect hosting: launch token from the URL query, then probe
   * GET /api/v1/time with a 2s timeout.
   */
  async init() {
    if (typeof window !== 'undefined' && window.location) {
      try {
        const q = new URLSearchParams(window.location.search);
        this.launchToken = q.get('launchToken') || q.get('token') || null;
      } catch {
        this.launchToken = null;
      }
    }
    const probe = await this._fetch(this.apiBase + '/time', { timeoutMs: 2000 });
    this.hosted = !!(probe && probe.ok && probe.body && typeof probe.body.now === 'number');
    return { hosted: this.hosted };
  }

  // -------------------------------------------------------------------------
  // time
  // -------------------------------------------------------------------------

  /**
   * Server time with RTT adjustment: assume the server stamped `now` at the
   * midpoint of the round trip. Falls back to the local clock offline.
   */
  async getServerTime() {
    if (this.hosted) {
      const t0 = Date.now();
      const res = await this._fetch(this.apiBase + '/time');
      const t1 = Date.now();
      if (res.ok && res.body && typeof res.body.now === 'number') {
        const rtt = t1 - t0;
        const serverNow = res.body.now + Math.round(rtt / 2);
        this._timeOffsetMs = serverNow - t1;
        return { nowMs: serverNow, offsetMs: this._timeOffsetMs, source: 'server' };
      }
      this.hosted = false; // probe passed earlier but now failing — degrade
    }
    return { nowMs: Date.now(), offsetMs: 0, source: 'local' };
  }

  // -------------------------------------------------------------------------
  // scores / leaderboards
  // -------------------------------------------------------------------------

  /**
   * POST {board, entry:{result, replay}} to /scores.
   * On {error} or 429 returns {ok:false, error, retryAfterMs?}.
   */
  async submitScore(entry) {
    if (!this.hosted) return { ok: false, error: 'offline' };
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
    if (!this.hosted) return { ok: false };
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
  // cloud save (versioned, checksummed doc; conflicts surface as 409)
  // -------------------------------------------------------------------------

  /** PUT /cloud — returns {ok:true, version} or {ok:false, error, conflict?}. */
  async saveCloud(doc) {
    if (!this.hosted) return { ok: false, error: 'offline' };
    const res = await this._fetch(this.apiBase + '/cloud', { method: 'PUT', body: doc, auth: true });
    if (res.ok && res.body && res.body.ok) return { ok: true, version: res.body.version };
    if (res.status === 409 && res.body) {
      return { ok: false, error: 'conflict', local: res.body.local, remote: res.body.remote };
    }
    return { ok: false, error: (res.body && res.body.error) || 'save-failed' };
  }

  /** GET /cloud → doc or null. */
  async loadCloud() {
    if (!this.hosted) return null;
    const res = await this._fetch(this.apiBase + '/cloud', { auth: true });
    if (res.ok && res.body && res.body.ok) return res.body.doc;
    return null;
  }

  // -------------------------------------------------------------------------
  // telemetry / achievements / presence — all best-effort
  // -------------------------------------------------------------------------

  /** Batch POST /telemetry. Caller is responsible for consent gating. */
  async postTelemetry(events) {
    if (!this.hosted || !Array.isArray(events) || events.length === 0) return { ok: false };
    const res = await this._fetch(this.apiBase + '/telemetry', {
      method: 'POST',
      body: { events: events.slice(0, 100) },
      auth: true,
    });
    return { ok: res.ok };
  }

  /** Record an achievement unlock server-side (idempotent). */
  async postAchievement(key) {
    if (!this.hosted) return { ok: false };
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
    if (!this.hosted || !this._playing) return;
    const now = Date.now();
    if (now - this._lastHeartbeat < 30000) return;
    this._lastHeartbeat = now;
    this._post('/presence', { t: now });
  }

  _post(path, body) {
    // Fire and forget only when this game's API contract was positively
    // detected; the UUID static host has a different shared /api surface.
    if (!this.hosted) return;
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
