// Card Mosaic on the StarHermit engine: the entry module (starhermit.txt
// engine.entry), played natively by the StarHermit client and in browsers by
// the engine's web runtime. The rules, content, session and the pure parts of
// the store are the browser build's js/*.js (ES modules) unchanged; this
// module is what js/main.js did around them — the state machine (title →
// modes → setup / journey / lessons → active ⇄ paused → resolving → results
// → progression), the selection model (tray card then cell, two placed cards
// to swap), the command pipeline with its sounds, captions and announcements,
// lessons checked through the same commands, undo and hints, the timed
// rounds' clock and ten-second warning, outcomes (journey stars and records,
// dailies, challenges, achievements, the local boards), the paused round's
// snapshot, posting a finished round to the high-score board, and the
// lifecycle. The screens, HUD and board are drawn by screens.ts and board.ts
// (starhermit:ui), the studio table by render.ts (starhermit:scene).
//
// The play clock is the runtime's fixed steps (60 a second), counted only
// while a round is active with nothing over it: pauses, a hidden window and
// slow frames never cost time, and play scripts replay exactly.
import "./shim.ts";
import { frame, onFixedUpdate, onQuit, onRender, onResume, onStart, onSuspend, onUpdate, onPreferencesChange, preferences, setFixedRate } from "starhermit:engine";
import { onAction, vibrate } from "starhermit:input";
import * as ui from "starhermit:ui";
import { onSessionEnded, onPlayerChange } from "starhermit:platform";
import { Session, MODES } from "../js/session.js";
import { JOURNEY, LESSONS, CHALLENGES, PRACTICE_DIFFICULTIES, journeyContent, lessonContent, dailyContent, dailyKey, practiceContent, challengeContent } from "../js/content.js";
import { listLegalCommands, TERMINAL, compareResults, quantizeElapsed } from "../js/rules.js";
import { journeyStars, unlockAchievement, ACHIEVEMENTS, saveSnapshot, loadSnapshot, clearSnapshot } from "../js/storage.js";
import * as audio from "./audio.ts";
import { tr, N, pt, onLocaleChange } from "./i18n.ts";
import * as platform from "./platform.ts";
import { lookFor } from "./quality.ts";
import * as render from "./render.ts";
import * as board from "./board.ts";
import { drawScreens } from "./screens.ts";
import { applyTheme, initStyles } from "./style.ts";

export type Content = ReturnType<typeof journeyContent> & object;
export type Lesson = (typeof LESSONS)[number];
export type Mode = keyof typeof MODES;
export type ScreenName = "title" | "modes" | "journey" | "lessons" | "setup" | "play" | "results" | "help" | "profile" | "boards";
export type OverlayName = "pause" | "settings" | "help" | "confirm" | "drawer-left" | "drawer-right";
export type Phase = "title" | "active" | "paused" | "resolving" | "results";
export interface SetupView { mode: Mode; title: () => string; rules: string; duration: string; ranked: boolean; assists: { undo: boolean; hints: boolean }; content: Content | null; list: "difficulties" | "challenges" | null }
export interface ResultsView {
  result: NonNullable<Session["result"]>; breakdown: { label: string; value: number; total?: boolean }[];
  par: { moves: number; ms: number }; stars: number; isNewBest: boolean; next: { label: string; action: "next" | "map" | "title" | "retry" };
  achievements: string[]; mode: Mode;
  lb: { pending?: boolean; posted?: boolean; rank?: number | null } | null;
}
export interface Toast { text: () => string; kind: "info" | "warn" | "success"; until: number; id: number }
export interface ConfirmView { title: string; message: string; confirm: string; action: "restart" | "concede" | "leave" }

const STEP_MS = 1000 / 60;
const RESULTS_DELAY_STEPS = 54;     // 900 ms of cosmetic settle before results
const RESULTS_DELAY_REDUCED = 4;    // 60 ms with reduced motion
const TIMED_DELAY_STEPS = 18;       // 300 ms after a clock runs out

export const app = {
  phase: "title" as Phase,
  screen: "title" as ScreenName,
  /** Frame the screen opened on (the action that opened it must not also act on it). */
  openedFrame: 0,
  focusNext: null as string | null,
  overlays: [] as OverlayName[],
  overlayOpenedFrame: 0,
  settingsTab: 0,
  confirm: null as ConfirmView | null,
  setup: null as SetupView | null,
  results: null as ResultsView | null,
  boards: { scope: "global" as "global" | "friends", loading: false, rows: null as platform.BoardRow[] | null, casual: false },
  toasts: [] as Toast[],
  caption: null as { text: string; until: number } | null,
  signedOut: false,
  flourishAt: -10,
  scorePulseAt: -10,
};
export let session: Session | null = null;
export const round = {
  mode: "practice" as Mode,
  lesson: null as Lesson | null,
  lessonStep: 0,
  stageIndex: null as number | null,
  challengeId: null as string | null,
  difficultyId: null as string | null,
  dailyDateKey: null as string | null,
  selectedTray: null as number | null,
  selectedCell: null as number | null,
  hint: null as { cell?: number | null; tray?: number | null; text?: string } | null,
  steps: 0,
  prevMatched: undefined as number | undefined,
  timeWarned: false,
  lastWasNewBest: false,
};
export const settings = platform.settings;
const now = (): number => frame().time;
let resolveLeft = -1;
let toastSeq = 0;
let suspendedAt = 0;
let autoPaused = false;

// ------------------------------------------------------------------ helpers
export function elapsedMs(): number { return quantizeElapsed(round.steps * STEP_MS); }
export function progress(): platform.Doc["progress"] { return platform.getDoc().progress; }
export function achievements(): platform.Doc["achievements"] { return platform.getDoc().achievements; }
export function localBoards(): platform.Doc["boards"] { return platform.getDoc().boards; }
export function utcToday(): string { return dailyKey(new Date(platform.nowMs())); }
export function themeFor(content: { theme?: string } | null | undefined): string {
  const s = settings.theme;
  return !s || s === "auto" ? (content?.theme || "studio") : s;
}
export function profileName(): string { return platform.displayName(); }
export function announce(msg: string, assertive = false): void {
  if (msg) ui.announce(msg.slice(0, 500), { politeness: assertive ? "assertive" : "polite" });
}
/** A transient toast; `text` re-reads in the current language. */
export function toast(text: () => string, kind: Toast["kind"] = "info"): void {
  while (app.toasts.length >= 4) app.toasts.shift();
  app.toasts.push({ text, kind, until: now() + 4.2, id: ++toastSeq });
}
export function dismissToast(id: number): void { app.toasts = app.toasts.filter((t) => t.id !== id); }
function caption(key: string): void {
  if (!settings.captions) return;
  app.caption = { text: key, until: now() + 2.2 };
}
function haptic(ms: number): void { if (settings.haptics) vibrate(ms); }

// ------------------------------------------------------------------ screens and overlays
export function showScreen(name: ScreenName, focus: string | null = null): void {
  app.overlays = [];
  app.confirm = null;
  app.screen = name;
  app.openedFrame = frame().frame;
  app.focusNext = focus;
  if (name !== "play") ui.setFocus(null);
  if (name === "boards") refreshBoards();
}
export function topOverlay(): OverlayName | null { return app.overlays[app.overlays.length - 1] ?? null; }
export function openOverlay(name: OverlayName): void {
  if (topOverlay() === name) return;
  app.overlays.push(name);
  app.overlayOpenedFrame = frame().frame;
  if (name !== "pause" && !name.startsWith("drawer")) audio.event("uiOpen");
}
export function closeOverlay(): void {
  const top = app.overlays.pop();
  if (!top) return;
  if (top === "confirm") app.confirm = null;
  if (top !== "pause" && !top.startsWith("drawer")) audio.event("uiClose");
  if (top === "pause") resume();
}
export function openSettings(tab = 0): void { app.settingsTab = tab; openOverlay("settings"); }
export function askConfirm(action: ConfirmView["action"]): void {
  const v: Record<ConfirmView["action"], ConfirmView> = {
    restart: { title: N("Restart round?"), message: N("The current arrangement will be discarded."), confirm: N("Restart"), action: "restart" },
    concede: { title: N("Concede round?"), message: N("The round ends now and is scored as conceded."), confirm: N("Concede"), action: "concede" },
    leave: { title: N("Leave round?"), message: N("You can resume later from the last saved position."), confirm: N("Leave"), action: "leave" },
  };
  app.confirm = v[action];
  openOverlay("confirm");
}
export function confirmYes(): void {
  const c = app.confirm;
  app.confirm = null;
  app.overlays = [];
  if (!c) return;
  if (c.action === "leave") leaveRound();
  else if (c.action === "concede") concede();
  else restartCurrent();
}

// ------------------------------------------------------------------ title and modes
export function hasSnapshot(): boolean { return !!(loadSnapshot() || {}).content; }
export function goTitle(): void {
  teardownRound();
  app.phase = "title";
  const homeTheme = settings.theme === "auto" ? "studio" : settings.theme;
  applyTheme(homeTheme, settings.cvd);
  render.setTheme(homeTheme);
  audio.setMusicIntensity(1);
  showScreen("title", "btn-play");
  announce(tr("Title screen"));
}
export function modeSetup(mode: Mode): void {
  switch (mode) {
    case "learn": showScreen("lessons", `lesson-${LESSONS[0]!.id}`); break;
    case "journey": showScreen("journey", "stage-0"); announce(tr("Journey map")); break;
    case "daily": {
      round.dailyDateKey = utcToday();
      const content = dailyContent(round.dailyDateKey) as Content;
      openSetup({ mode: "daily", title: ((date) => () => tr("Daily Mosaic — {date}", { date }))(round.dailyDateKey), rules: N("One shared seed for everyone today. Complete the mosaic; fewest invalid actions and fastest time break ties."), duration: N("5–10 min"), content, list: null });
      break;
    }
    case "practice":
      openSetup({ mode: "practice", title: () => tr("Practice"), rules: N("Unranked. Undo and hints allowed. Pick a difficulty."), duration: N("3–15 min"), content: null, list: "difficulties" });
      break;
    case "challenge":
      openSetup({ mode: "challenge", title: () => tr(MODES.challenge.label), rules: N("Constrained goals: move budgets, clocks, and impostor cards."), duration: N("5–10 min"), content: null, list: "challenges" });
      break;
    case "score": showScreen("boards"); break;
  }
}
function openSetup(v: Omit<SetupView, "ranked" | "assists">): void {
  const m = MODES[v.mode];
  app.setup = { ...v, ranked: m.ranked, assists: { undo: m.undoAllowed, hints: m.hintAllowed } };
  showScreen("setup", v.list === "difficulties" ? `diff-${PRACTICE_DIFFICULTIES[0]!.id}` : v.list === "challenges" ? `challenge-${CHALLENGES[0]!.id}` : "setup-start");
  announce(tr("Round setup"));
}

// ------------------------------------------------------------------ round lifecycle
interface Extras { lesson?: Lesson | null; stageIndex?: number | null; challengeId?: string | null; difficultyId?: string | null }
export function startRound(content: Content, mode: Mode, extras: Extras = {}): void {
  teardownRound();
  const s = new Session(content, { mode, lesson: extras.lesson || null });
  session = s;
  round.mode = mode;
  round.lesson = extras.lesson || null;
  round.lessonStep = 0;
  round.stageIndex = extras.stageIndex ?? null;
  round.challengeId = extras.challengeId ?? null;
  round.difficultyId = extras.difficultyId ?? null;
  round.selectedTray = null;
  round.selectedCell = null;
  round.hint = null;
  round.steps = 0;
  round.prevMatched = undefined;
  round.lastWasNewBest = false;
  round.timeWarned = false;
  enterRound(content);
  progress().sessionsPlayed++;
  platform.persist();
  activate();
}
function enterRound(content: Content): void {
  audio.setSeed(content.seed);
  const th = themeFor(content);
  applyTheme(th, settings.cvd);
  render.load(content, th);
  render.clearVeil();
  board.reset(session!.state);
  audio.startAmbience(th);
}
function activate(): void {
  app.phase = "active";
  app.results = null;
  resolveLeft = -1;
  showScreen("play", board.firstFocus());
  audio.setMusicIntensity(2);
  announce(tr("Round started"));
}
export function startJourney(i: number): void {
  const content = journeyContent(i) as Content | null;
  if (content) startRound(content, "journey", { stageIndex: i });
}
export function startLesson(id: string): void {
  const got = lessonContent(id);
  if (!got) return;
  startRound(got.content as Content, "learn", { lesson: got.lesson });
  announce(tr(got.lesson.intro), true);
}
export function startPractice(diffId: string): void {
  const seed = "p-" + Date.now().toString(36) + "-" + Math.floor(Math.random() * 1e6).toString(36);
  startRound(practiceContent(diffId || "casual", seed) as Content, "practice", { difficultyId: diffId });
}
export function startChallenge(id: string): void {
  if (!CHALLENGES.find((x) => x.id === id)) return;
  startRound(challengeContent(id, "fixed-" + id) as Content, "challenge", { challengeId: id });
}
export function startDaily(): void {
  const key = round.dailyDateKey || utcToday();
  round.dailyDateKey = key;
  startRound(dailyContent(key) as Content, "daily");
}
export function restartCurrent(): void {
  if (!session) return;
  startRound(session.content as Content, round.mode, { lesson: round.lesson, stageIndex: round.stageIndex, challengeId: round.challengeId, difficultyId: round.difficultyId });
}
function teardownRound(): void {
  audio.stopAmbience();
  audio.duck(false);
  session = null;
  round.lesson = null;
  round.selectedTray = null;
  round.selectedCell = null;
  resolveLeft = -1;
}
/** The live round's snapshot with the context the command log cannot say. */
function storeSnapshot(): void {
  if (!session || session.result) return;
  try {
    saveSnapshot({
      ...session.snapshot(),
      meta: {
        stageIndex: round.stageIndex, challengeId: round.challengeId, difficultyId: round.difficultyId,
        dailyDateKey: round.dailyDateKey, lessonId: round.lesson ? round.lesson.id : null,
        lessonStepIndex: round.lessonStep, elapsedMs: elapsedMs(),
      },
    });
  } catch (e) { console.warn(`snapshot: ${String(e)}`); }
}
export function resumeSnapshot(): void {
  const snap = loadSnapshot();
  if (!snap) { goTitle(); return; }
  const s = Session.restore(snap);
  if (!s) {
    clearSnapshot();
    toast(() => tr("Saved round was corrupted and has been cleared."), "warn");
    goTitle();
    return;
  }
  teardownRound();
  const meta = snap.meta || {};
  session = s;
  round.mode = s.mode as Mode;
  round.stageIndex = meta.stageIndex ?? null;
  round.challengeId = meta.challengeId ?? null;
  round.difficultyId = meta.difficultyId ?? null;
  round.dailyDateKey = meta.dailyDateKey ?? null;
  round.lesson = meta.lessonId ? (LESSONS.find((l) => l.id === meta.lessonId) || null) : null;
  s.lesson = round.lesson;
  round.lessonStep = meta.lessonStepIndex ?? snap.lessonStep ?? 0;
  round.steps = Math.round(Math.max(s.state.elapsedMs, meta.elapsedMs || 0) / STEP_MS);
  round.prevMatched = undefined;
  round.timeWarned = false;
  round.selectedTray = null;
  round.selectedCell = null;
  round.hint = null;
  enterRound(s.content as Content);
  if (s.result) showResults(); else activate();
}
export function discardSnapshot(): void { clearSnapshot(); goTitle(); }

export function pause(): void {
  if (app.phase !== "active") return;
  app.phase = "paused";
  storeSnapshot();
  audio.event("pause");
  audio.duck(true);
  app.overlays = ["pause"];
  app.overlayOpenedFrame = frame().frame;
  announce(tr("Paused"));
}
export function resume(): void {
  app.overlays = app.overlays.filter((o) => o !== "pause");
  if (app.phase !== "paused") return;
  app.phase = "active";
  audio.duck(false);
  app.overlays = [];
  app.focusNext = board.firstFocus();
}
/** "Leave" is an interruption, not a concession: the round is stored live. */
export function leaveRound(): void {
  storeSnapshot();
  goTitle();
}
export function concede(): void {
  if (!session || session.result) return;
  app.overlays = [];
  const r = session.concede(elapsedMs());
  handleEvents(r.events || [], true);
  showResults();
}

// ------------------------------------------------------------------ selection and commands
function canInteract(): boolean { return !!session && !session.result && app.phase === "active" && !app.overlays.length; }
export function onTray(tray: number): void {
  const s = session;
  if (!s || !canInteract()) return;
  if (round.selectedTray === tray) round.selectedTray = null;
  else if (s.state.tray[tray] !== null) {
    round.selectedTray = tray;
    round.selectedCell = null;
    audio.event("select");
  }
}
export function onCell(cell: number): void {
  const s = session;
  if (!s || !canInteract()) return;
  const occupied = s.state.cells[cell] !== null;
  // A tray card in hand and an occupied cell: explain, don't forward.
  if (occupied && round.selectedTray !== null) {
    announce(tr(REASON_TEXT["cell-occupied"]!), true);
    toast(() => tr(REASON_TEXT["cell-occupied"]!), "warn");
    return;
  }
  if (!occupied && round.selectedTray !== null) { dispatch({ type: "place", tray: round.selectedTray, cell }); return; }
  if (!occupied && round.selectedCell !== null) {
    toast(() => tr("Recall the card first, then place it here."), "warn");
    audio.event("invalid");
    return;
  }
  if (occupied) {
    if (round.selectedCell === null) {
      round.selectedCell = cell;
      round.selectedTray = null;
      audio.event("select");
    } else if (round.selectedCell === cell) round.selectedCell = null;
    else { dispatch({ type: "swap", a: round.selectedCell, b: cell }); return; }
  } else toast(() => tr("Select a tray card first."), "info");
}
/** Cancel: drop the selection, else pause. */
export function cancel(): void {
  if (round.selectedTray !== null) round.selectedTray = null;
  else if (round.selectedCell !== null) round.selectedCell = null;
  else pause();
}
export function rotate(): void { if (canInteract() && round.selectedTray !== null) dispatch({ type: "rotateTray", tray: round.selectedTray }); }
export function lock(): void { if (canInteract() && round.selectedCell !== null && view().canLock) dispatch({ type: "lock", cell: round.selectedCell }); }
export function recall(): void { if (canInteract() && round.selectedCell !== null && view().canRecall) dispatch({ type: "recall", cell: round.selectedCell }); }
export function undo(): void {
  if (!session || !canInteract()) return;
  if (!view().canUndo) { toast(() => tr("Undo is not available here."), "warn"); return; }
  const r = session.undo();
  if (r.ok) {
    audio.event("undo");
    storeSnapshot();
    round.selectedTray = null;
    round.selectedCell = null;
    board.playEvents([{ type: "undo" }], session.state);
    toast(() => tr("Undone"), "info");
    caption(N("undo"));
  } else toast(() => tr("Undo is not available here."), "warn");
}
export function hint(): void {
  if (!session || !canInteract() || !view().canHint) return;
  const h = session.hint();
  if (h) {
    round.hint = h;
    audio.event("hint");
    announce(tr(h.text));
  } else toast(() => tr("No hint available right now."), "info");
}

type Cmd = { type: string; tray?: number; cell?: number; a?: number; b?: number };
function dispatch(cmd: Cmd): void {
  const s = session;
  if (!s || s.result) return;
  const res = s.dispatch(cmd, elapsedMs());
  handleEvents(res.events || [], res.ok);
  if (res.ok) {
    round.selectedTray = null;
    round.selectedCell = null;
    round.hint = null;
    checkLessonProgress(cmd.type);
    storeSnapshot();
  }
  if (res.terminal) enterResolving(preferences().reducedMotion ? RESULTS_DELAY_REDUCED : RESULTS_DELAY_STEPS);
}

// Plain-language mapping for every validateCommand reason in rules.js.
export const REASON_TEXT: Record<string, string> = {
  "unknown-command": N("That action is not available."),
  "round-over": N("The round is already over."),
  "bad-tray-slot": N("That tray slot does not exist."),
  "bad-cell": N("That cell is not part of the board."),
  "tray-slot-empty": N("That tray slot is empty."),
  "cell-occupied": N("That cell already holds a card."),
  "cell-empty": N("That cell is empty."),
  "card-locked": N("That card is locked and cannot move."),
  "same-cell": N("Choose two different cells to swap."),
  "rotation-disabled": N("Rotating is not part of this puzzle."),
  "lock-disabled": N("Locking is not part of this puzzle."),
  "already-locked": N("That card is already locked."),
  "neighbors-mismatch": N("Locking needs every placed neighbor to match."),
  "no-tray-slot": N("That card is anchored to the table and cannot be recalled."),
  "not-terminal": N("The round cannot be settled yet."),
};

type Ev = { type: string; reason?: string; matched?: number };
function handleEvents(events: Ev[], ok: boolean): void {
  if (!ok) {
    if (events.some((e) => e.type === "invalid")) { audio.event("invalid"); haptic(40); render.invalid(); }
  } else {
    for (const e of events) {
      if (e.type === "place") audio.event("place");
      else if (e.type === "recall") audio.event("recall");
      else if (e.type === "swap") audio.event("swap");
      else if (e.type === "rotateTray") audio.event("rotate");
      else if (e.type === "lock") audio.event("lock");
      else if (e.type === "board" && round.prevMatched !== undefined && (e.matched ?? 0) > round.prevMatched) { audio.event("match"); flourish(); }
      if (e.type === "board") round.prevMatched = e.matched;
    }
  }
  for (const e of events) {
    switch (e.type) {
      case "invalid": {
        const key = REASON_TEXT[e.reason ?? ""] || N("That move is not allowed.");
        announce(tr(key), true);
        toast(() => tr(key), "warn");
        caption(N("not allowed"));
        break;
      }
      case "terminal": {
        const key = N("Round over — results are ready.");
        announce(tr(key), true);
        toast(() => tr(key), "info");
        caption(e.reason === "complete" ? N("mosaic complete") : N("round over"));
        render.terminal(e.reason === "complete");
        break;
      }
      case "lock": announce(tr("Card locked.")); caption(N("card locked")); break;
      case "place": caption(N("card placed")); break;
      case "recall": caption(N("card recalled")); break;
      case "swap": caption(N("cards swapped")); break;
      case "rotateTray": caption(N("card rotated")); break;
      default: break;
    }
  }
  if (session) board.playEvents(events, session.state);
}
/** A matched-edge gain: the board's glow and the score's pop (board.ts reads these). */
export function flourish(): void { app.flourishAt = now(); app.scorePulseAt = now(); }

function checkLessonProgress(cmdType: string): void {
  const l = round.lesson;
  if (!l) return;
  const step = l.steps[round.lessonStep];
  if (!step) return;
  if (step.require.type === cmdType) {
    round.lessonStep++;
    audio.event("hint");
    const next = l.steps[round.lessonStep];
    if (next) announce(tr(next.text));
  }
}

// ------------------------------------------------------------------ the view model
export interface View {
  legalCells: number[]; lockableCells: number[]; canUndo: boolean; canHint: boolean; canRotate: boolean; canLock: boolean; canRecall: boolean;
  movesLeft: number | null; timeLeftMs: number | null; analysis: { matched: number; mismatched: number; open: number };
}
let viewCache: { tick: number; sel: string; steps: number; v: View } | null = null;
/** What the HUD and board show for the live round (recomputed when the state or selection changes). */
export function view(): View {
  const s = session!;
  const st = s.state;
  const sel = `${round.selectedTray}:${round.selectedCell}:${s.snapshots.length}:${!!s.result}`;
  if (viewCache && viewCache.tick === st.tick && viewCache.sel === sel && viewCache.steps === round.steps) return viewCache.v;
  const all = listLegalCommands(st) as Cmd[];
  const legalCells = round.selectedTray !== null ? all.filter((c) => c.type === "place" && c.tray === round.selectedTray).map((c) => c.cell!) : [];
  const lockableCells = all.filter((c) => c.type === "lock").map((c) => c.cell!);
  const el = elapsedMs();
  const v: View = {
    legalCells, lockableCells,
    canUndo: s.undoAllowed && s.snapshots.length > 0 && !s.result,
    canHint: s.hintAllowed && !s.result,
    canRotate: st.mechanics.rotation && round.selectedTray !== null && st.tray[round.selectedTray] !== null,
    canLock: st.mechanics.lock && round.selectedCell !== null && lockableCells.includes(round.selectedCell),
    canRecall: round.selectedCell !== null && st.cells[round.selectedCell] !== null && !st.cards[st.cells[round.selectedCell]!]!.locked,
    movesLeft: st.moveLimit !== null ? Math.max(0, st.moveLimit - st.movesUsed) : null,
    timeLeftMs: st.timeLimitMs !== null ? Math.max(0, st.timeLimitMs - el) : null,
    analysis: s.analysis(),
  };
  viewCache = { tick: st.tick, sel, steps: round.steps, v };
  return v;
}

// ------------------------------------------------------------------ outcomes
function enterResolving(steps: number): void {
  if (app.phase === "resolving") return;
  app.phase = "resolving";
  resolveLeft = steps;
}
function scoreBreakdown(r: NonNullable<Session["result"]>): ResultsView["breakdown"] {
  const s = r.score;
  return [
    { label: N("Matched edges"), value: s.matched },
    { label: N("Locked cards"), value: s.locks },
    { label: N("Completion bonus"), value: s.completion },
    { label: N("Time bonus"), value: s.timeBonus },
    { label: N("Swap penalty"), value: -s.swapPenalty },
    { label: N("Invalid actions"), value: -s.invalidPenalty },
    { label: N("Total"), value: s.total, total: true },
  ];
}
function unlock(key: string): string[] {
  if (!unlockAchievement(achievements(), key)) return [];
  platform.persist();
  const meta = ACHIEVEMENTS.find((a) => a.key === key);
  announce(tr("Achievement unlocked: {name}", { name: tr(meta?.name || key) }));
  audio.event("achievement");
  return [key];
}
function applyOutcome(result: NonNullable<Session["result"]>): string[] {
  const newly: string[] = [];
  const p = progress();
  const s = session!;
  const done = result.terminalReason === TERMINAL.COMPLETE;
  round.lastWasNewBest = false;
  if (done) newly.push(...unlock("first_completion"));
  if (round.mode === "journey" && round.stageIndex !== null) {
    const stage = JOURNEY[round.stageIndex]!;
    const rec = p.journey[stage.id] || {};
    const stars = journeyStars(result, s.content.goals.par);
    round.lastWasNewBest = done && result.score.total > (rec.bestScore || 0);
    p.journey[stage.id] = {
      completed: rec.completed || done,
      bestScore: Math.max(rec.bestScore || 0, result.score.total),
      bestMoves: Math.min(rec.bestMoves ?? 1e9, result.movesUsed),
      stars: Math.max(rec.stars || 0, stars),
      completedAt: rec.completedAt || (done ? new Date(platform.nowMs()).toISOString() : null),
    };
    if (done) {
      p.masteryXp += stage.mastery ? 3 : 1;
      const mech = s.content.mechanics;
      if (mech.rotation && mech.lock && mech.decoys) newly.push(...unlock("mechanic_mastery"));
      const chapterStages = JOURNEY.filter((j) => j.chapter === stage.chapter);
      if (chapterStages.every((j) => (p.journey[j.id] || {}).completed)) newly.push(...unlock("chapter_clear"));
      const masteriesDone = JOURNEY.filter((j) => j.mastery && (p.journey[j.id] || {}).completed).length;
      if (masteriesDone >= 10) newly.push(...unlock("mastery_10"));
    }
  }
  if (round.mode === "learn" && round.lesson && done) p.lessons[round.lesson.id] = { completed: true };
  if (round.mode === "daily") {
    const key = round.dailyDateKey || utcToday();
    const prev = p.dailies[key];
    round.lastWasNewBest = !prev || result.score.total > prev.score;
    p.dailies[key] = {
      score: Math.max(prev?.score || 0, result.score.total),
      completed: prev?.completed || done,
      result: { total: result.score.total, reason: result.terminalReason },
    };
    if (done && Object.values(p.dailies).filter((d) => (d as { completed?: boolean }).completed).length >= 7) newly.push(...unlock("streak_7"));
  }
  if (round.mode === "challenge" && round.challengeId) {
    const prev = p.challenges[round.challengeId] || {};
    round.lastWasNewBest = done && result.score.total > (prev.bestScore || 0);
    p.challenges[round.challengeId] = { bestScore: Math.max(prev.bestScore || 0, result.score.total), completed: prev.completed || done };
  }
  if (p.sessionsPlayed >= 50) newly.push(...unlock("long_haul"));
  platform.persist();
  return newly;
}
/** The local board: every finished round, best first per content id (100 kept). */
function recordLocal(result: NonNullable<Session["result"]>): void {
  const b = localBoards();
  const list = b.entries[result.contentId] || [];
  list.push({ score: result.score.total, result, at: new Date(platform.nowMs()).toISOString(), assists: result.assists, sessionId: result.sessionId, name: profileName() || tr("Guest") });
  list.sort((x: { result: typeof result }, y: { result: typeof result }) => compareResults(x.result, y.result));
  b.entries[result.contentId] = list.slice(0, 100);
  platform.persist();
}
function nextAction(result: NonNullable<Session["result"]>): ResultsView["next"] {
  if (round.mode === "journey" && round.stageIndex !== null && result.terminalReason === TERMINAL.COMPLETE) {
    return round.stageIndex + 1 < JOURNEY.length ? { label: N("Next stage"), action: "next" } : { label: N("Journey complete — back to map"), action: "map" };
  }
  if (round.mode === "learn" && round.lesson) {
    const idx = LESSONS.findIndex((l) => l.id === round.lesson!.id);
    return idx >= 0 && idx + 1 < LESSONS.length ? { label: N("Next lesson"), action: "next" } : { label: N("Lessons done — to title"), action: "title" };
  }
  return { label: N("Play again"), action: "retry" };
}
function showResults(): void {
  const s = session;
  if (!s || !s.result) return;
  const result = s.result;
  app.phase = "results";
  resolveLeft = -1;
  audio.setMusicIntensity(1);
  audio.duck(false);
  const stars = round.mode === "journey" ? journeyStars(result, s.content.goals.par) : 0;
  const newly = applyOutcome(result);
  recordLocal(result);
  clearSnapshot();
  const view: ResultsView = {
    result, breakdown: scoreBreakdown(result), par: s.content.goals.par, stars, isNewBest: round.lastWasNewBest,
    next: nextAction(result), achievements: newly, mode: round.mode, lb: null,
  };
  app.results = view;
  app.toasts = [];
  showScreen("results", "results-next");
  announce(tr("Round results"));
  audio.event(result.terminalReason === TERMINAL.COMPLETE ? "complete" : "fail");
  if (round.lastWasNewBest) setTimeout(() => audio.event("newBest"), 700);
  if (result.terminalReason === TERMINAL.COMPLETE) haptic(60);
  // Signed in, every finished non-lesson round posts its total to the high-score board.
  if (platform.signedIn() && round.mode !== "learn") {
    view.lb = { pending: true };
    void platform.postLeaderboard(result.score.total).then((r) => { view.lb = r; });
  }
}
export function resultsAction(action: ResultsView["next"]["action"]): void {
  if (action === "retry") restartCurrent();
  else if (action === "next") {
    if (round.mode === "journey" && round.stageIndex !== null) startJourney(round.stageIndex + 1);
    else if (round.mode === "learn" && round.lesson) {
      const idx = LESSONS.findIndex((l) => l.id === round.lesson!.id);
      if (idx + 1 < LESSONS.length) startLesson(LESSONS[idx + 1]!.id);
      else goTitle();
    }
  } else if (action === "map") { teardownRound(); app.phase = "title"; audio.setMusicIntensity(1); showScreen("journey"); }
  else goTitle();
}

// ------------------------------------------------------------------ boards
export function refreshBoards(): void {
  app.boards.loading = true;
  app.boards.rows = null;
  void platform.fetchLeaderboard(app.boards.scope === "friends").then((r) => {
    app.boards.loading = false;
    if (r.ok) { app.boards.rows = r.entries; app.boards.casual = false; return; }
    // The local boards, flattened, best first.
    const rows: platform.BoardRow[] = [];
    for (const list of Object.values(localBoards().entries)) {
      for (const e of list as { name?: string; score?: number; result?: { score: { total: number } } }[]) {
        rows.push({ rank: null, name: e.name || tr("You"), score: e.score ?? e.result?.score.total ?? 0, mine: true });
      }
    }
    rows.sort((a, b) => b.score - a.score);
    app.boards.rows = rows.slice(0, 20).map((r, i) => ({ ...r, rank: i + 1 }));
    app.boards.casual = true;
  });
}
export function setBoardScope(scope: "global" | "friends"): void {
  if (app.boards.scope === scope) return;
  app.boards.scope = scope;
  refreshBoards();
}

// ------------------------------------------------------------------ settings hooks
export function replayTutorials(): void { app.overlays = []; showScreen("lessons"); toast(() => tr("Tutorials will play again"), "info"); }
export function practiceList(): typeof PRACTICE_DIFFICULTIES { return PRACTICE_DIFFICULTIES; }

// ------------------------------------------------------------------ input
onAction((e) => {
  if (!e.pressed) return;
  const fresh = frame().frame !== app.openedFrame && frame().frame !== app.overlayOpenedFrame;
  const top = topOverlay();
  if (top) {
    if ((e.action === "cancel" || (e.action === "pause" && top === "pause")) && fresh) {
      if (top === "pause") resume(); else closeOverlay();
    }
    return;
  }
  if (app.screen !== "play") {
    if (e.action === "cancel" && fresh && app.screen !== "title") {
      if (app.screen === "results") resultsAction("title");
      else if (app.screen === "journey" || app.screen === "lessons" || app.screen === "setup") showScreen("modes", "mode-learn");
      else goTitle();
    }
    return;
  }
  switch (e.action) {
    case "pause": if (app.phase === "active") pause(); break;
    case "cancel": if (fresh && app.phase === "active") cancel(); break;
    case "undo": undo(); break;
    case "hint": hint(); break;
    case "rotate": rotate(); break;
    case "lock": lock(); break;
    case "recall": recall(); break;
    case "up": case "down": case "left": case "right":
      // Nothing focused: the arrows start on the board.
      if (!ui.focused()) app.focusNext = board.firstFocus();
      break;
  }
});

// ------------------------------------------------------------------ boot and lifecycle
let lookKey = "";
function applyLook(): void {
  const f = frame();
  const key = `${f.quality}:${f.levelIndex}`;
  if (key === lookKey) return;
  lookKey = key;
  const look = lookFor(f.quality, f.levelIndex);
  render.applyLook(look);
  board.setDetailed(look.detailed);
}

onStart(() => {
  setFixedRate(60);
  initStyles();
  platform.initPlatform();
  audio.loadSfx();
  render.setReducedMotion(preferences().reducedMotion);
  applyLook();
  render.loadIdle("studio");
  goTitle();
  if (hasSnapshot()) toast(() => tr("An interrupted round was saved — Resume from the title screen."), "info");
});
onPreferencesChange((p) => render.setReducedMotion(p.reducedMotion));
platform.onSettingsChange(() => {
  const th = session ? themeFor(session.content) : (settings.theme === "auto" ? "studio" : settings.theme);
  applyTheme(th, settings.cvd);
  render.setTheme(th);
});
onLocaleChange(() => { viewCache = null; });
onSessionEnded(() => { app.signedOut = true; toast(() => pt("signedOut"), "info"); });
onPlayerChange((p) => { if (p) app.signedOut = false; });
onSuspend(() => {
  suspendedAt = Date.now();
  if (app.phase === "active") { pause(); autoPaused = true; }
  platform.flush();
});
onResume(() => {
  if (!autoPaused || !session) return;
  autoPaused = false;
  const awayMs = Date.now() - suspendedAt;
  const mins = Math.floor(awayMs / 60000);
  const away = mins > 0 ? tr("{n} min", { n: mins }) : tr("{n} s", { n: Math.round(awayMs / 1000) });
  toast(() => tr("Welcome back — paused for {time}. Your clock was stopped.", { time: away }), "info");
});
onQuit(() => { if (session && !session.result) storeSnapshot(); });

onFixedUpdate(() => {
  const s = session;
  if (!s) return;
  if (app.phase === "active" && !app.overlays.length) {
    round.steps++;
    if (round.steps % 6 === 0) hudTick(s);
  } else if (app.phase === "resolving" && resolveLeft >= 0) {
    if (--resolveLeft <= 0) showResults();
  }
});
/** 10 Hz: the timed rounds' settle and their ten-second warning. */
function hudTick(s: Session): void {
  const res = s.clockUpdate(elapsedMs()) as { terminalReason: string } | null;
  if (res) {
    render.terminal(res.terminalReason === TERMINAL.COMPLETE);
    enterResolving(TIMED_DELAY_STEPS);
    return;
  }
  const st = s.state;
  if (st.timeLimitMs !== null && !round.timeWarned) {
    const left = st.timeLimitMs - elapsedMs();
    if (left > 0 && left <= 10000) {
      round.timeWarned = true;
      audio.event("timeWarning");
      announce(tr("Ten seconds left."), true);
    }
  }
}

let frameDt = 0;
onUpdate((dt) => {
  frameDt = dt;
  applyLook();
  audio.update();
  const t0 = now();
  if (app.toasts.length && app.toasts[0]!.until < t0) app.toasts = app.toasts.filter((x) => x.until >= t0);
  if (app.caption && t0 > app.caption.until) app.caption = null;
});
onRender(() => {
  drawScreens();
  render.update(frameDt);
});
