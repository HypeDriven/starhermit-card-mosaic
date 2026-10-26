// The game's data and the StarHermit platform, on the runtime's modules:
// - progress (journey records and stars, lessons, dailies, challenges,
//   mastery XP, sessions), achievements and the local boards are the game's
//   save (starhermit:storage `saves`): { v: 1, progress, achievements,
//   boards } on the device and in the player's cloud slot, two devices'
//   copies merged on a conflict (js/migrate.js mergeDocs → js/storage.js
//   mergeProgress / mergeAchievements / mergeBoards). The slot the browser
//   build wrote (the JS SDK's zipped save.json: the same parts plus its
//   settings) shows as foreign and is merged in and replaced once;
// - the paused round's snapshot stays on the device (js/storage.js through
//   the localStorage shim, shim.ts), as the browser build kept it;
// - the game's own settings (table theme, colour-vision palette,
//   left-handed layout, hold to confirm, timing assist, haptics, captions,
//   the guest's display name) are `settings` (game.<key>, synced with the
//   account); the browser build's settings keys and save settings are
//   migrated, then removed;
// - the player's name, the invite link, the high-score board's rows and
//   posting a finished round's total through score-script.js (a practice
//   session whose socket carries { type: 'result', scores }, as the JS SDK's
//   submitScores did), and the platform's clock for the daily's date.
//
// The browser build's own-server routes (server.js: replay-validated score
// submission, its global boards, telemetry, achievements, activity and
// presence) were for local development hosting and are not called: the
// platform runs score-script.js, and the boards are its leaderboards.
import type { JsonValue } from "starhermit:engine";
import { connectGame, inviteLink as fetchInviteLink, leaderboards, onPlayerChange, player, profile, serverNow, serverTime, sessions } from "starhermit:platform";
import { saves, settings as store, storage } from "starhermit:storage";
import * as M from "../js/migrate.js";
import { tr } from "./i18n.ts";

export type Doc = ReturnType<typeof M.normalize>;

// --- the save ------------------------------------------------------------------------------
let doc: Doc = M.normalize({});
let lastSavedAt = 0;
const mergedListeners = new Set<() => void>();
/** fn() after progress from the account (another device, the browser build) was merged in. */
export function onProgressMerged(fn: () => void): void { mergedListeners.add(fn); }
function merged(): void { for (const fn of mergedListeners) fn(); }

export function getDoc(): Doc { return doc; }
/** Writes the save (device at once, the account debounced by the runtime). */
export function persist(): void {
  try { saves.save(doc as unknown as JsonValue, { schema: 1 }); }
  catch (e) { console.warn(`save: ${String(e)}`); }
}

/** Takes a document in (merged with what this device has); whether it changed. */
function adopt(other: Doc | null): boolean {
  if (!other) return false;
  const before = JSON.stringify(doc);
  const next = M.mergeDocs(other, doc);
  if (JSON.stringify(next) === before) return false;
  doc = next;
  return true;
}

saves.onConflict((local, remote) => ({
  merged: M.mergeDocs(M.docFromSave(remote.data), M.docFromSave(local?.data)) as unknown as JsonValue,
}));
saves.onStatus((_status, state) => {
  if (state === "foreign") { migrateForeign(); return; }
  // The account's save replaced the device's (another device saved last): merge it in.
  const cur = saves.load();
  if (cur && cur.savedAt !== lastSavedAt) {
    lastSavedAt = cur.savedAt;
    if (adopt(M.docFromSave(cur.data))) { persist(); merged(); }
  }
});

/** The browser build's cloud save: merged with this device's progress, saved over it once. */
function migrateForeign(): void {
  const old = saves.foreign();
  if (!old) return;
  const { doc: d, settings: s } = M.fromBrowserSave(old.text);
  const changed = adopt(d);
  if (s) for (const [k, v] of Object.entries(s)) adoptSetting(k, v);
  try { saves.save(doc as unknown as JsonValue, { schema: 1, replaceForeign: true }); }
  catch (e) { console.warn(`save migration: ${String(e)}`); }
  if (changed) merged();
}

/** For the profile's sync line: offline (a guest) | saving | synced | error. */
export function syncState(): "offline" | "saving" | "synced" | "error" {
  if (!player()) return "offline";
  const st = saves.state();
  if (st === "error" || st === "read-blocked") return "error";
  if (st === "loading" || st === "uploading" || st === "foreign" || saves.status() === "pending") return "saving";
  return "synced";
}
export function flush(): void { void saves.flush().catch(() => undefined); }

// --- the game's settings -------------------------------------------------------------------
export interface Settings {
  theme: string; cvd: boolean; leftHanded: boolean; holdToConfirm: boolean; timingAssist: boolean;
  haptics: boolean; captions: boolean; profileName: string; [key: string]: unknown;
}
export const settings: Settings = { ...M.DEFAULT_GAME_SETTINGS };
const settingsListeners = new Set<() => void>();
export function onSettingsChange(fn: () => void): void { settingsListeners.add(fn); }
function settingsChanged(): void { for (const fn of settingsListeners) fn(); }
function readSetting(key: string): void {
  let v: JsonValue | undefined;
  try { v = store.get(key); } catch { return; }
  const ok = M.checkSetting(key, v);
  if (ok !== undefined) settings[key] = ok;
}
/** A migrated value, kept unless this game set the key since. */
function adoptSetting(key: string, value: unknown): void {
  const v = M.checkSetting(key, value);
  if (v === undefined || store.get(key) !== undefined) return;
  try { store.set(key, v as JsonValue); settings[key] = v; settingsChanged(); } catch { /* keep the device's */ }
}
/** Changes one of the game's settings (device and account). */
export function setSetting(key: keyof Settings & string, value: boolean | string): void {
  settings[key] = value;
  try { store.set(key, value); } catch (e) { console.warn(`setting ${key}: ${String(e)}`); }
  settingsChanged();
}
// The browser build's per-player settings groups: the game's options in them
// carry over (unless this game set them since), then they are removed.
function importLegacy(): void {
  const keys = store.legacyKeys();
  if (!keys) return;
  for (const key of keys) {
    if (!M.BROWSER_SETTING_KEYS.includes(key)) continue;
    for (const [k, v] of Object.entries(M.gameSettingsFromLegacy(key, store.legacy(key)))) adoptSetting(k, v);
    store.removeLegacy(key);
  }
}

/** Reads the device's save and the game's settings (from onStart). */
export function initPlatform(): void {
  const cur = saves.load();
  lastSavedAt = cur?.savedAt ?? 0;
  const d = M.docFromSave(cur?.data);
  if (d) doc = d;
  else if (!cur) persist();
  for (const k of M.GAME_SETTING_KEYS) readSetting(k);
  store.onChange((key) => {
    if (!M.GAME_SETTING_KEYS.includes(key)) return;
    readSetting(key);
    settingsChanged();
  });
  store.onLegacy(importLegacy);
  importLegacy();
  if (saves.state() === "foreign") migrateForeign();
  settingsChanged();
  refreshPlayer();
  void serverTime().catch(() => undefined);
}

// --- the player ----------------------------------------------------------------------------
export function signedIn(): boolean { return !!player(); }
export function userId(): string | null { return player()?.userId ?? null; }
/** The account's name signed in, else the guest's own display name (may be ""). */
export function displayName(): string { return player()?.displayName ?? settings.profileName; }
let invite: string | null = null;
/** The invite link, fetched ahead so a button press can copy it at once. */
export function inviteLink(): string | null { return player() ? invite : null; }
function refreshPlayer(): void {
  invite = null;
  if (!player()) return;
  fetchInviteLink().then((u) => { invite = u; }, () => { invite = null; });
  void highScoreBoard().catch(() => null);
}
onPlayerChange(() => refreshPlayer());

/** Now in ms by the platform's clock when it has answered, else the device's. */
export function nowMs(): number { return serverNow() ?? Date.now(); }
/** Whether the clock is the platform's. */
export function serverClock(): boolean { return serverNow() !== null; }

// --- the StarHermit leaderboards -----------------------------------------------------------
const BOARD_KEY = "cardmosaic.board-id";
let boardId: string | null = null;
/** The high-score board's id: listed signed in, then kept on the device so a guest can read it. */
async function highScoreBoard(): Promise<string | null> {
  if (boardId) return boardId;
  if (player()) {
    try {
      const list = await leaderboards.list();
      const b = list.find((x) => x.key === "high-score") ?? list[0];
      if (b) { boardId = b.id; try { storage.set(BOARD_KEY, b.id); } catch { /* full */ } }
    } catch { /* offline */ }
  }
  if (!boardId) { try { boardId = storage.getText(BOARD_KEY); } catch { boardId = null; } }
  return boardId;
}
export interface BoardRow { rank: number | null; name: string; score: number; mine: boolean }
/** The high-score board's top 20 (friends only: the player's friends; names from the players' profiles); ok false when it cannot be read. */
export async function fetchLeaderboard(friendsOnly = false): Promise<{ ok: boolean; entries: BoardRow[] }> {
  const me = player();
  try {
    const id = await highScoreBoard();
    if (!id) return { ok: false, entries: [] };
    if (friendsOnly && !me) return { ok: false, entries: [] };
    const page = await leaderboards.entries(id, { pageSize: 20, ...(friendsOnly ? { friendsOnly: true } : {}) });
    const entries = await Promise.all(page.items.map(async (e) => {
      let name = e.username || tr("Player {id}", { id: e.userId.slice(0, 6) });
      if (me && e.userId === me.userId) name = me.displayName;
      else { try { name = (await profile(e.userId)).displayName; } catch { /* the username */ } }
      return { rank: e.rank ?? null, name, score: Math.floor(Number(e.score) || 0), mine: !!me && e.userId === me.userId };
    }));
    return { ok: true, entries };
  } catch { return { ok: false, entries: [] }; }
}

/** Signed in only: post a finished round's total through score-script.js; { posted, rank }. Never rejects. */
export async function postLeaderboard(total: number): Promise<{ posted: boolean; rank: number | null }> {
  const me = player();
  if (!me) return { posted: false, rank: null };
  const score = Math.max(0, Math.round(total));
  let accepted: string[] = [];
  try {
    const sessionId = await sessions.practice();
    accepted = await new Promise<string[]>((resolve) => {
      const socket = connectGame(sessionId);
      let done = false;
      const finish = (list: string[]): void => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        socket.close();
        resolve(list);
      };
      const timer = setTimeout(() => finish([]), 15000);
      socket.on("open", () => { socket.sendCommand({ type: "result", scores: { "high-score": score } }); });
      socket.on("game", (data) => {
        const d = data as { type?: string; accepted?: string[] } | null;
        if (d && d.type === "result-ack") finish(Array.isArray(d.accepted) ? d.accepted : []);
      });
      socket.on("error", () => finish([]));
      socket.on("stopped", () => finish([]));
      socket.on("abandoned", () => finish([]));
    });
  } catch { return { posted: false, rank: null }; }
  if (!accepted.includes("high-score")) return { posted: false, rank: null };
  try {
    const id = await highScoreBoard();
    if (!id) return { posted: true, rank: null };
    const r = await leaderboards.entries(id, { pageSize: 100 });
    const mine = r.items.find((e) => e.userId === me.userId);
    return { posted: true, rank: mine ? mine.rank : null };
  } catch { return { posted: true, rank: null }; }
}
