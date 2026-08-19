// server.js — Card Mosaic StarHermit authoritative server.
// Node >=18, stdlib only. Serves the static distribution and a JSON API under
// /api/v1 (time, validated score submission, leaderboards, daily, cloud save,
// telemetry, achievements). Run: node server.js [port]   (default 8080)

import http from 'node:http';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { SCORE, compareResults } from './js/rules.js';
import { CONTENT_VERSION, dailyKey, dailyContent, journeyContent, challengeContent, practiceContent } from './js/content.js';
import { Session } from './js/session.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.argv[2]) || 8080;
const DATA_DIR = process.env.CARD_MOSAIC_DATA
  ? path.resolve(process.env.CARD_MOSAIC_DATA)
  : path.join(ROOT, '.data');

const BODY_LIMIT = 256 * 1024; // 256KB
const BOARD_CAP = 500;
const SCORE_RATE_LIMIT = 6;      // accepted+attempted submissions per minute per IP
const SCORE_RATE_WINDOW = 60000;

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function crc32(str) {
  let c = 0xffffffff;
  for (let i = 0; i < str.length; i++) {
    c ^= str.charCodeAt(i);
    for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1;
  }
  return (c ^ 0xffffffff) >>> 0;
}

function sendJson(res, status, obj, headers = {}) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', ...headers });
  res.end(body);
}

function sendError(res, status, error, headers = {}) {
  sendJson(res, status, { error }, headers);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > BODY_LIMIT) {
        reject(new Error('body-too-large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function readJsonBody(req) {
  const raw = await readBody(req);
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error('bad-json');
  }
}

function safeName(s) {
  return String(s).replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 120) || 'unknown';
}

function playerKey(req) {
  const auth = req.headers.authorization || '';
  const m = auth.match(/^Bearer\s+(.+)$/i);
  if (!m) return 'guest';
  return 'p-' + crypto.createHash('sha256').update(m[1]).digest('hex').slice(0, 24);
}

async function readJsonFile(file, fallback) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch {
    return fallback;
  }
}

async function writeJsonFile(file, obj) {
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  await writeFile(tmp, JSON.stringify(obj));
  await import('node:fs/promises').then((fs) => fs.rename(tmp, file));
}

// ---------------------------------------------------------------------------
// content regeneration from a contentId
// ---------------------------------------------------------------------------

function contentForId(contentId, seedHint) {
  const id = String(contentId || '');
  let m;
  if ((m = id.match(/^daily-(\d{4}-\d{2}-\d{2})$/))) return dailyContent(m[1]);
  if ((m = id.match(/^journey-(\d+)$/))) return journeyContent(Number(m[1]) - 1);
  if ((m = id.match(/^challenge-([a-z0-9]+)-(.+)$/))) return challengeContent(m[1], m[2]);
  if ((m = id.match(/^practice-([a-z0-9]+)-(.+)$/))) return practiceContent(m[1], m[2]);
  // fallback for odd practice ids: use the seed hint if present
  if (id.startsWith('practice-') && seedHint) return practiceContent('casual', seedHint);
  return null;
}

/** Theoretical maximum total score for a content doc. */
function maxPossibleScore(content) {
  const { w, h } = content.grid;
  const cells = w * h;
  const adjacencies = (w - 1) * h + w * (h - 1);
  const matched = adjacencies * SCORE.PER_MATCHED_EDGE;
  const locks = cells * SCORE.PER_LOCK;
  const completion = SCORE.COMPLETION_BASE + SCORE.COMPLETION_PER_CELL * cells;
  const timeBonus = content.goals.timeLimitMs ? Math.floor(content.goals.timeLimitMs / 1000) : 0;
  return matched + locks + completion + timeBonus;
}

// ---------------------------------------------------------------------------
// rate limiting (per-IP sliding window for score submissions)
// ---------------------------------------------------------------------------

const submitLog = new Map(); // ip -> [timestamps]

function rateLimited(ip) {
  const now = Date.now();
  const arr = (submitLog.get(ip) || []).filter((t) => now - t < SCORE_RATE_WINDOW);
  if (arr.length >= SCORE_RATE_LIMIT) {
    submitLog.set(ip, arr);
    return Math.ceil((arr[0] + SCORE_RATE_WINDOW - now) / 1000);
  }
  arr.push(now);
  submitLog.set(ip, arr);
  if (submitLog.size > 10000) {
    for (const [k, v] of submitLog) if (v.every((t) => now - t >= SCORE_RATE_WINDOW)) submitLog.delete(k);
  }
  return 0;
}

// ---------------------------------------------------------------------------
// telemetry — aggregate counters only, never raw payloads
// ---------------------------------------------------------------------------

let telemetryCounters = null; // lazily loaded {name: count}
let telemetryDirty = false;

async function recordTelemetry(events) {
  if (!telemetryCounters) telemetryCounters = await readJsonFile(path.join(DATA_DIR, 'telemetry.json'), {});
  for (const ev of events.slice(0, 100)) {
    const name = ev && typeof ev === 'object' ? (ev.name || ev.type) : null;
    if (typeof name !== 'string' || name.length > 60) continue;
    telemetryCounters[name] = (telemetryCounters[name] || 0) + 1;
  }
  telemetryDirty = true;
}

setInterval(() => {
  if (telemetryDirty && telemetryCounters) {
    telemetryDirty = false;
    writeJsonFile(path.join(DATA_DIR, 'telemetry.json'), telemetryCounters).catch(() => {});
  }
}, 30000).unref();

// ---------------------------------------------------------------------------
// API handlers
// ---------------------------------------------------------------------------

async function handleScores(req, res) {
  const ip = req.socket.remoteAddress || 'unknown';
  const retryAfter = rateLimited(ip);
  if (retryAfter > 0) {
    sendError(res, 429, 'rate-limited', { 'Retry-After': String(retryAfter) });
    return;
  }
  let body;
  try {
    body = await readJsonBody(req);
  } catch (e) {
    sendError(res, e.message === 'body-too-large' ? 413 : 400, e.message === 'body-too-large' ? 'body-too-large' : 'bad-json');
    return;
  }
  const board = typeof body.board === 'string' ? body.board : null;
  const entry = body.entry;
  if (!board || !entry || typeof entry !== 'object') return sendError(res, 400, 'missing-board-or-entry');
  const { result, replay } = entry;
  if (!result || typeof result !== 'object' || !replay || typeof replay !== 'object') {
    return sendError(res, 400, 'missing-result-or-replay');
  }

  // content version must match what this server serves
  if (result.contentVersion !== CONTENT_VERSION || replay.contentVersion !== CONTENT_VERSION) {
    return sendError(res, 400, 'content-version-mismatch');
  }

  // regenerate content from the claimed id — we never trust submitted content
  const content = contentForId(result.contentId, result.seed);
  if (!content) return sendError(res, 400, 'unknown-content-id');
  if (replay.contentId !== content.contentId || result.contentId !== content.contentId) {
    return sendError(res, 400, 'content-id-mismatch');
  }

  // replay the command log through the real session pipeline
  let recomputed;
  try {
    recomputed = Session.replay(content, replay);
  } catch {
    return sendError(res, 400, 'replay-failed');
  }
  if (!recomputed.ok || !recomputed.result) return sendError(res, 400, 'replay-mismatch');
  if (recomputed.result.score.total !== result.score.total) return sendError(res, 400, 'score-mismatch');
  if (recomputed.result.terminalReason !== result.terminalReason) return sendError(res, 400, 'result-mismatch');

  // plausibility
  const r = recomputed.result;
  if (!(r.elapsedMs >= 3000)) return sendError(res, 400, 'implausible-elapsed');
  if (!(r.movesUsed <= 10000)) return sendError(res, 400, 'implausible-moves');
  if (r.score.total > maxPossibleScore(content)) return sendError(res, 400, 'implausible-score');

  // accept: store, sort with the shared comparator, cap the board
  const file = path.join(DATA_DIR, 'boards', safeName(board) + '.json');
  const doc = await readJsonFile(file, { board, entries: [] });
  doc.entries.push({
    result: r,
    player: playerKey(req),
    submittedAt: new Date().toISOString(),
  });
  doc.entries.sort((a, b) => compareResults(a.result, b.result));
  doc.entries = doc.entries.slice(0, BOARD_CAP);
  try {
    await writeJsonFile(file, doc);
  } catch {
    return sendError(res, 500, 'store-failed');
  }
  const rank = doc.entries.findIndex((e) => e.result.sessionId === r.sessionId);
  sendJson(res, 200, { ok: true, rank: rank >= 0 ? rank + 1 : null, total: doc.entries.length });
}

async function handleLeaderboards(req, res, url) {
  const board = url.searchParams.get('board') || '';
  const scope = url.searchParams.get('scope') || 'global';
  const file = path.join(DATA_DIR, 'boards', safeName(board) + '.json');
  const doc = await readJsonFile(file, { board, entries: [] });
  sendJson(res, 200, {
    board,
    scope,
    entries: doc.entries,
    validated: true,
    friendsFiltered: false, // reference impl: friends scope == global
  });
}

function handleDaily(req, res) {
  const key = dailyKey();
  const content = dailyContent(key);
  sendJson(res, 200, { key, contentId: content.contentId, seed: content.seed });
}

async function handleCloudGet(req, res) {
  const file = path.join(DATA_DIR, 'cloud', playerKey(req) + '.json');
  const doc = await readJsonFile(file, null);
  sendJson(res, 200, { ok: true, doc });
}

async function handleCloudPut(req, res) {
  let body;
  try {
    body = await readJsonBody(req);
  } catch (e) {
    sendError(res, e.message === 'body-too-large' ? 413 : 400, e.message === 'body-too-large' ? 'body-too-large' : 'bad-json');
    return;
  }
  const doc = body && body.doc !== undefined ? body.doc : body;
  if (!doc || typeof doc !== 'object' || !Number.isInteger(doc.version) || doc.version < 0) {
    return sendError(res, 400, 'missing-version');
  }
  if (crc32(JSON.stringify(doc.data)) !== doc.crc) return sendError(res, 400, 'checksum-mismatch');
  const file = path.join(DATA_DIR, 'cloud', playerKey(req) + '.json');
  const stored = await readJsonFile(file, null);
  if (stored && stored.version !== doc.version) {
    // version conflict: hand both docs back so the client can merge
    sendJson(res, 409, { error: 'conflict', local: doc, remote: stored });
    return;
  }
  const next = { version: doc.version + 1, data: doc.data, crc: doc.crc, updatedAt: new Date().toISOString() };
  try {
    await writeJsonFile(file, next);
  } catch {
    return sendError(res, 500, 'store-failed');
  }
  sendJson(res, 200, { ok: true, version: next.version });
}

async function handleTelemetry(req, res) {
  try {
    const body = await readJsonBody(req);
    if (Array.isArray(body.events)) await recordTelemetry(body.events);
  } catch {
    /* telemetry is best-effort — still 204 */
  }
  res.writeHead(204);
  res.end();
}

async function handleAchievements(req, res) {
  let body;
  try {
    body = await readJsonBody(req);
  } catch (e) {
    sendError(res, e.message === 'body-too-large' ? 413 : 400, e.message === 'body-too-large' ? 'body-too-large' : 'bad-json');
    return;
  }
  const key = typeof body.key === 'string' ? body.key : null;
  if (!key || key.length > 60) return sendError(res, 400, 'missing-key');
  const file = path.join(DATA_DIR, 'achievements', playerKey(req) + '.json');
  const doc = await readJsonFile(file, { version: 1, unlocked: {} });
  const fresh = !doc.unlocked[key];
  if (fresh) {
    doc.unlocked[key] = new Date().toISOString();
    try {
      await writeJsonFile(file, doc);
    } catch {
      return sendError(res, 500, 'store-failed');
    }
  }
  sendJson(res, 200, { ok: true, unlocked: fresh });
}

// ---------------------------------------------------------------------------
// static files
// ---------------------------------------------------------------------------

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.webmanifest': 'application/manifest+json',
};

function serveStatic(req, res, url) {
  let pathname;
  try {
    pathname = decodeURIComponent(url.pathname);
  } catch {
    return sendError(res, 400, 'bad-path');
  }
  if (pathname.endsWith('/')) pathname += 'index.html';
  // path-traversal safe: resolve against ROOT and verify containment
  const filePath = path.normalize(path.join(ROOT, pathname));
  if (!filePath.startsWith(ROOT + path.sep) && filePath !== ROOT) {
    return sendError(res, 403, 'forbidden');
  }
  const ext = path.extname(filePath).toLowerCase();
  const mime = MIME[ext];
  if (!mime) return sendError(res, 404, 'not-found');
  const headers = { 'Content-Type': mime };
  if (filePath.startsWith(path.join(ROOT, 'vendor') + path.sep)) {
    headers['Cache-Control'] = 'public, max-age=31536000, immutable'; // hashed/vendored assets
  } else if (ext === '.html') {
    headers['Cache-Control'] = 'no-cache';
  } else {
    headers['Cache-Control'] = 'public, max-age=3600';
  }
  const stream = createReadStream(filePath);
  stream.on('error', () => {
    if (!res.headersSent) sendError(res, 404, 'not-found');
    else res.destroy();
  });
  stream.on('open', () => {
    res.writeHead(200, headers);
    stream.pipe(res);
  });
}

// ---------------------------------------------------------------------------
// router
// ---------------------------------------------------------------------------

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    const p = url.pathname;

    if (p === '/api/v1/time' && req.method === 'GET') {
      return sendJson(res, 200, { now: Date.now() });
    }
    if (p === '/api/v1/scores' && req.method === 'POST') return await handleScores(req, res);
    if (p === '/api/v1/leaderboards' && req.method === 'GET') return await handleLeaderboards(req, res, url);
    if (p === '/api/v1/daily' && req.method === 'GET') return handleDaily(req, res);
    if (p === '/api/v1/cloud' && req.method === 'GET') return await handleCloudGet(req, res);
    if (p === '/api/v1/cloud' && req.method === 'PUT') return await handleCloudPut(req, res);
    if (p === '/api/v1/telemetry' && req.method === 'POST') return await handleTelemetry(req, res);
    if (p === '/api/v1/achievements' && req.method === 'POST') return await handleAchievements(req, res);
    // best-effort presence/activity pings (fire-and-forget from the client)
    if ((p === '/api/v1/activity' || p === '/api/v1/presence') && req.method === 'POST') {
      res.writeHead(204);
      return res.end();
    }
    if (p.startsWith('/api/')) return sendError(res, 404, 'not-found');
    if (req.method !== 'GET' && req.method !== 'HEAD') return sendError(res, 405, 'method-not-allowed');
    serveStatic(req, res, url);
  } catch (e) {
    if (!res.headersSent) sendError(res, 500, 'internal-error');
    else res.destroy();
  }
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`Port ${PORT} is already in use. Choose another: node server.js <port>`);
    process.exit(1);
  }
  throw err;
});

server.listen(PORT, () => {
  console.log(`Card Mosaic server listening on http://localhost:${PORT} (data: ${DATA_DIR})`);
});
