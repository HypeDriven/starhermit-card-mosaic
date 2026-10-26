// The browser build's DOM shell (index.html + js/ui.js + css/style.css) as
// starhermit:ui, built every frame: the top bar (the Goal and Actions drawer
// toggles, the status line), the play layout (the objective / progress /
// score rail, the felt board, the action rail with Moves, Time and Ranked),
// the toasts and the caption strip, and the screens (title with its key art,
// modes, journey map, lessons, setup, results, how to play, profile, score
// chase) and overlays (pause, settings, the compact help, confirm). The
// browser's media queries are layouts picked by the window's logical size:
// wide (≥ 1024 px: both rails docked), compact (700–1023: the rails are
// drawers behind the top bar's toggles), phone (< 700: the objective a
// drawer, the actions a row along the bottom) and short landscape (≤ 540 px
// tall: the actions a column beside the board, the tray beside the grid);
// the left-handed setting mirrors the rails. The table (render.ts) is framed
// into the play area the rails leave.
import { frame, openMenu, clipboard } from "starhermit:engine";
import { bindings } from "starhermit:input";
import * as draw from "starhermit:draw";
import * as ui from "starhermit:ui";
import { requestSignIn } from "starhermit:platform";
import { TextureLoader, type Texture } from "starhermit:scene";
import { JOURNEY, LESSONS, CHALLENGES, PRACTICE_DIFFICULTIES } from "../js/content.js";
import { MODES } from "../js/session.js";
import { ACHIEVEMENTS } from "../js/storage.js";
import { THEMES, getTheme } from "../js/themes.js";
import { tr, N, pt } from "./i18n.ts";
import * as platform from "./platform.ts";
import * as render from "./render.ts";
import { buildBoard, layoutBoard } from "./board.ts";
import {
  app, askConfirm, closeOverlay, confirmYes, discardSnapshot, dismissToast, goTitle, hasSnapshot, hint, lock, modeSetup,
  openOverlay, openSettings, pause, progress, achievements, recall, replayTutorials, resultsAction, resume, resumeSnapshot,
  rotate, round, session, setBoardScope, settings, showScreen, startChallenge, startDaily, startJourney, startLesson,
  startPractice, topOverlay, toast, undo, utcToday, view, type Mode, type ScreenName,
} from "./main.ts";
import { currentPalette } from "./style.ts";

// ------------------------------------------------------------------ layout
interface Layout { lw: number; lh: number; sc: number; ox: number; oy: number; W: number; H: number; wide: boolean; compact: boolean; phone: boolean; shortLand: boolean; vmin: number }
function layoutNow(): Layout {
  const f = frame();
  const sc = ui.preferences().scale;
  const sa = f.safeArea;
  const lw = Math.max(1, (f.width - sa.left - sa.right) / sc), lh = Math.max(1, (f.height - sa.top - sa.bottom) / sc);
  const shortLand = lw > lh && lh <= 540;
  const wide = !shortLand && lw >= 1024;
  const phone = !shortLand && lw < 700;
  return { lw, lh, sc, ox: sa.left / sc, oy: sa.top / sc, W: f.width / sc, H: f.height / sc, wide, compact: !wide && !phone && !shortLand, phone, shortLand, vmin: Math.min(lw, lh) };
}
const lastHeight = new Map<string, number>();

function textWidth(text: string, style: string | readonly string[], kind?: "button"): number {
  return ui.measureText(text, { ...(kind ? { kind } : {}), style: typeof style === "string" ? style : [...style] }).width / ui.preferences().scale;
}
const buttonWidth = (text: string, style: readonly string[]): number => textWidth(text, style, "button") + 2;

interface Btn { id: string; text: string; style?: string[]; disabled?: boolean; selected?: boolean; act: () => void; content?: () => void }
const PLAIN = ["btn"];
/** A button `width` wide (null: its text's); a label too long for it wraps inside. */
function button(b: Btn, width: number | null = null): void {
  const style = b.style ?? PLAIN;
  const opts: ui.ButtonOptions = {};
  if (b.disabled) opts.disabled = true;
  if (b.selected !== undefined) opts.selected = b.selected;
  const s: ui.Style = width != null ? { width } : {};
  if (b.content) opts.content = b.content;
  else if (width != null && buttonWidth(b.text, style) > width) {
    const inner = width - 36;
    const bold = style.includes("btn-primary");
    opts.content = () => { ui.style({ text: { align: "center" } }).paragraph(b.text, inner, bold ? { weight: "600" } : {}); };
  }
  if (ui.style(...style, s).id(b.id).button(b.text, opts)) b.act();
}
/** Buttons at their own widths in rows that wrap at `width` (CSS flex-wrap). */
function flow(label: string, list: Btn[], width: number, align: "start" | "center" | "end" = "start", gap = 8): void {
  const rows: Btn[][] = [[]];
  let used = 0;
  for (const b of list) {
    const bw = Math.min(width, buttonWidth(b.text, b.style ?? PLAIN));
    if (rows[rows.length - 1]!.length && used + gap + bw > width) { rows.push([]); used = 0; }
    used += (rows[rows.length - 1]!.length ? gap : 0) + bw;
    rows[rows.length - 1]!.push(b);
  }
  ui.column(label, () => {
    rows.forEach((row, ri) => ui.row(`${label}-r${ri}`, () => {
      for (const b of row) button(b, buttonWidth(b.text, b.style ?? PLAIN) > width ? width : null);
    }, { spacing: gap, align: "center" }));
  }, { spacing: gap, align, width });
}
/** Text up to `width` wide: one label when it fits, else a paragraph. */
function para(text: string, width: number, cls?: string | null, id?: string, center = false): void {
  if (!text) return;
  const styles: (string | ui.Style)[] = cls ? [cls] : ["body"];
  if (center) styles.push({ text: { align: "center" } });
  let u = ui.style(...styles);
  if (id) u = u.id(id);
  if (ui.measureText(text, { style: styles }).width / ui.preferences().scale <= width) u.label(text);
  else u.paragraph(text, width);
}
function heading(cls: "h1" | "h2" | "h3", text: string, width: number, id?: string): void {
  if (ui.measureText(text, { kind: "heading", style: cls }).width / ui.preferences().scale <= width) (id ? ui.id(id) : ui).style(cls).heading(text);
  else ui.style(cls).paragraph(text, width);
}
/** A definition list (CSS grid auto / 1fr). */
function dl(label: string, rows: [string, string][], w: number, dtCls = "dt", ddCls = "dd", numeric = false): void {
  const dtW = Math.min(w * 0.6, Math.max(40, ...rows.map(([k]) => textWidth(k, dtCls))));
  const ddW = w - dtW - 16;
  ui.grid(label, () => {
    for (const [k, v] of rows) {
      para(k, dtW, dtCls);
      if (numeric) ui.style(ddCls).label(v); else para(v, ddW, ddCls);
    }
  }, { columns: [{ width: dtW }, numeric ? { fr: 1, align: "end" } : { fr: 1 }], gap: { row: 2, column: 16 }, width: w });
}

// ------------------------------------------------------------------ glyphs (no emoji or symbol fonts)
type Glyph = "star" | "starOutline" | "menu" | "rotate" | "lock" | "recall" | "undo" | "pause" | "check" | "dot";
function starPts(cx: number, cy: number, r: number): [number, number][] {
  const pts: [number, number][] = [];
  for (let i = 0; i < 10; i++) { const a = -Math.PI / 2 + (i * Math.PI) / 5; const rr = i % 2 ? r * 0.42 : r; pts.push([cx + Math.cos(a) * rr, cy + Math.sin(a) * rr]); }
  return pts;
}
function arcLine(cx: number, cy: number, r: number, a0: number, a1: number, color: string, w: number): [number, number] {
  let px = cx + Math.cos(a0) * r, py = cy + Math.sin(a0) * r;
  for (let i = 1; i <= 12; i++) {
    const a = a0 + ((a1 - a0) * i) / 12;
    const x = cx + Math.cos(a) * r, y = cy + Math.sin(a) * r;
    draw.line(px, py, x, y, color, w);
    px = x; py = y;
  }
  return [px, py];
}
function drawGlyph(kind: Glyph, r: ui.Rect, color: string): void {
  const cx = r.x + r.width / 2, cy = r.y + r.height / 2, s = Math.min(r.width, r.height) / 2;
  const w = Math.max(1.5, s * 0.22);
  switch (kind) {
    case "star": draw.polygon(starPts(cx, cy, s), color); break;
    case "starOutline": {
      const p = starPts(cx, cy, s);
      for (let i = 0; i < p.length; i++) { const a = p[i]!, b = p[(i + 1) % p.length]!; draw.line(a[0], a[1], b[0], b[1], color, Math.max(1, s * 0.14)); }
      break;
    }
    case "dot": draw.polygon(starPts(cx, cy, s * 0.25).map((_, i) => [cx + Math.cos(i * 0.63) * s * 0.18, cy + Math.sin(i * 0.63) * s * 0.18]), color); break;
    case "menu": for (const dy of [-0.6, 0, 0.6]) draw.line(cx - s * 0.8, cy + dy * s, cx + s * 0.8, cy + dy * s, color, w); break;
    case "rotate": {
      const [ex, ey] = arcLine(cx, cy, s * 0.7, -Math.PI * 0.4, Math.PI * 1.3, color, w);
      draw.polygon([[ex - s * 0.35, ey - s * 0.05], [ex + s * 0.2, ey - s * 0.3], [ex + s * 0.15, ey + s * 0.3]], color);
      break;
    }
    case "lock": {
      draw.roundRect(cx - s * 0.65, cy - s * 0.1, s * 1.3, s * 0.95, s * 0.15, color);
      arcLine(cx, cy - s * 0.15, s * 0.42, Math.PI, Math.PI * 2, color, w);
      break;
    }
    case "recall": {
      // ↩: a hook on the right, the shaft running left to the head
      arcLine(cx + s * 0.3, cy - s * 0.2, s * 0.4, -Math.PI / 2, Math.PI / 2, color, w);
      draw.line(cx + s * 0.3, cy - s * 0.6, cx + s * 0.1, cy - s * 0.6, color, w);
      draw.line(cx + s * 0.3, cy + s * 0.2, cx - s * 0.4, cy + s * 0.2, color, w);
      draw.polygon([[cx - s * 0.85, cy + s * 0.2], [cx - s * 0.35, cy - s * 0.15], [cx - s * 0.35, cy + s * 0.55]], color);
      break;
    }
    case "undo": {
      // a counter-clockwise turn (the rotate arrow mirrored)
      const [ex, ey] = arcLine(cx, cy, s * 0.7, Math.PI * 1.4, -Math.PI * 0.3, color, w);
      draw.polygon([[ex + s * 0.35, ey - s * 0.05], [ex - s * 0.2, ey - s * 0.3], [ex - s * 0.15, ey + s * 0.3]], color);
      break;
    }
    case "pause": draw.rect(cx - s * 0.55, cy - s * 0.7, s * 0.38, s * 1.4, color); draw.rect(cx + s * 0.17, cy - s * 0.7, s * 0.38, s * 1.4, color); break;
    case "check": draw.line(cx - s * 0.7, cy, cx - s * 0.2, cy + s * 0.55, color, w); draw.line(cx - s * 0.2, cy + s * 0.55, cx + s * 0.75, cy - s * 0.6, color, w); break;
  }
}
function glyph(kind: Glyph, size: number, color: string, label = ""): void {
  ui.widget(label, { role: label ? "image" : "none", size: { width: size, height: size }, draw: (r) => drawGlyph(kind, r, color) });
}
function stars(n: number, size: number, color: string, label: string): void {
  ui.row(`stars-${label}`, () => {
    for (let i = 0; i < 3; i++) glyph(i < n ? "star" : "starOutline", size, color, i === 0 ? label : "");
  }, { spacing: size * 0.15, align: "center" });
}

// ------------------------------------------------------------------ art
const art: Record<string, Texture | null> = { key: null, complete: null, over: null };
let artAsked = false;
function loadArt(): void {
  if (artAsked) return;
  artAsked = true;
  const loader = new TextureLoader();
  // Decorative: a missing file just leaves the art out.
  loader.loadAsync("assets/key-art.webp").then((t) => { art.key = t; }, () => undefined);
  loader.loadAsync("assets/results-complete.webp").then((t) => { art.complete = t; }, () => undefined);
  loader.loadAsync("assets/results-over.webp").then((t) => { art.over = t; }, () => undefined);
}

/** A 16:9 picture in its framed box (the CSS .title-art / .results-art: rounded, bordered, shadowed). */
function artImage(tex: Texture, w: number, cls: string): void {
  const b = cls === "title-art" ? 3 : 2;
  ui.style(cls).column(`${cls}-box`, () => {
    ui.image("", tex, { width: w - b * 2, height: (w - b * 2) * 9 / 16 });
  }, { clip: true });
}

// ------------------------------------------------------------------ the frame
let topH = 52;
export function drawScreens(): void {
  loadArt();
  const L = layoutNow();
  const f = frame();
  const playing = app.screen === "play" && !!session;
  if (!playing) {
    // Screens sit on the page background; the table shows only in play.
    draw.rect(0, 0, f.width, f.height, currentPalette().theme.bg);
  }
  topbar(L, playing);
  if (playing) playScreen(L);
  else {
    switch (app.screen) {
      case "title": titleScreen(L); break;
      case "modes": modesScreen(L); break;
      case "journey": journeyScreen(L); break;
      case "lessons": lessonsScreen(L); break;
      case "setup": setupScreen(L); break;
      case "results": resultsScreen(L); break;
      case "help": helpScreen(L); break;
      case "profile": profileScreen(L); break;
      case "boards": boardsScreen(L); break;
      default: break;
    }
  }
  overlays(L);
  toasts(L, playing);
  if (app.caption && settings.captions) {
    const text = "♪ " + tr(app.caption.text);
    const w = Math.min(L.lw * 0.9, 560);
    ui.place("captions", { anchor: "bottom", y: 24 }, () => { para(text, w - 28, "captions", "caption-text"); }, { style: "captions" });
  }
  // a screen that just opened focuses its first control once laid out
  // (asked again for a few frames: a tall screen moves into its scroll area on its second frame)
  if (app.focusNext) {
    const age = f.frame - app.openedFrame;
    if (age >= 1) ui.setFocus(app.focusNext);
    if (age >= 4) app.focusNext = null;
  }
}

// ------------------------------------------------------------------ top bar
function statusText(): string {
  const s = session;
  if (!s || app.screen !== "play") return "Card Mosaic";
  const v = view();
  const st = s.state;
  const parts: string[] = [];
  parts.push(tr(MODES[round.mode].label));
  if (s.ranked) parts.push(tr("ranked"));
  const filled = st.cells.filter((c: string | null) => c !== null).length;
  parts.push(tr("{n}/{total} placed", { n: filled, total: st.cells.length }));
  if (v.movesLeft != null) parts.push(tr("{n} moves left", { n: v.movesLeft }));
  if (v.timeLeftMs != null) parts.push(fmtMs(v.timeLeftMs));
  parts.push(tr("score {n}", { n: st.score.total }));
  return parts.join(" · ");
}
function topbar(L: Layout, playing: boolean): void {
  const left = playing && !L.wide;
  const right = playing && L.compact;
  const toggle = (id: string, label: string, overlay: "drawer-left" | "drawer-right", glyphFirst: boolean): void => {
    if (ui.style("icon-btn").id(id).button(label, {
      content: () => ui.row(`${id}-face`, () => {
        if (glyphFirst) glyph("menu", 16, "#f4ead8");
        ui.style({ text: { size: 13, color: "#f4ead8" } }).label(label);
        if (!glyphFirst) glyph("menu", 16, "#f4ead8");
      }, { spacing: 4, align: "center" }),
    })) openOverlay(overlay);
  };
  const inner = L.lw - 16;
  const r = ui.place("topbar", "top-start", () => {
    ui.row("topbar-row", () => {
      if (left) toggle("btn-drawer-left", tr("Goal"), "drawer-left", true);
      ui.column("status", () => {
        ui.style("status-line", { text: { overflow: "ellipsis" } }).id("status-line").label(statusText());
      }, { grow: 1, align: "center" });
      if (right) toggle("btn-drawer-right", tr("Actions"), "drawer-right", false);
    }, { width: inner, height: 44, spacing: 8, align: "center" });
  }, { style: "topbar", width: L.lw });
  topH = r.height / L.sc;
}

// ------------------------------------------------------------------ play
function fmtMs(ms: number | null): string {
  if (ms == null) return "";
  const s = Math.max(0, Math.ceil(ms / 1000));
  return Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0");
}
function objectiveText(): string {
  const s = session!;
  if (round.mode === "learn" && round.lesson) return tr("Lesson: {name}", { name: tr(round.lesson.name) });
  const st = s.state;
  const empty = st.cells.filter((c: string | null) => c === null).length;
  if (empty > 0) return tr("Complete the mosaic — fill {n} of {total} cells.", { n: empty, total: st.cells.length });
  return tr("Resolve the remaining mismatched edges.");
}
function lessonText(): string {
  const l = round.lesson;
  if (!l) return "";
  const step = l.steps[Math.min(round.lessonStep, l.steps.length - 1)];
  return step ? tr(step.text) : "";
}
/** The left rail's content: objective, lesson step, progress, score breakdown. */
function railLeft(w: number): void {
  const s = session!;
  const st = s.state;
  const v = view();
  ui.style("rail-h").label(tr("Objective").toUpperCase());
  para(objectiveText(), w, "rail-p", "hud-objective");
  const lesson = lessonText();
  if (lesson) para(lesson, w, "hud-lesson", "hud-lesson");
  ui.style("rail-h").label(tr("Progress").toUpperCase());
  const filled = st.cells.filter((c: string | null) => c !== null).length;
  para(tr("{n} of {total} cells filled", { n: filled, total: st.cells.length }), w, "rail-p", "hud-progress");
  para(tr("{matched} matched · {mismatched} mismatched · {open} open", v.analysis), w, "rail-p", "hud-analysis");
  ui.style("rail-h").label(tr("Score").toUpperCase());
  const sc = st.score;
  const pulse = Math.max(0, 1 - (frame().time - app.scorePulseAt) / 0.4);
  const neg = (n: number): string => (n > 0 ? "−" + n : String(n));
  const rows: [string, string][] = [
    [tr("Matched edges"), String(sc.matched)], [tr("Locks"), String(sc.locks)], [tr("Completion"), String(sc.completion)],
    [tr("Time bonus"), String(sc.timeBonus)], [tr("Swap penalty"), neg(sc.swapPenalty)], [tr("Invalid penalty"), neg(sc.invalidPenalty)],
  ];
  const dtW = w - 48;
  ui.grid("hud-score", () => {
    for (const [k, val] of rows) { para(k, dtW, "score-dt"); ui.style("score-dd").label(val); }
    ui.style("score-total").label(tr("Total"));
    ui.style("score-total", pulse > 0 && !ui.preferences().reducedMotion ? { scale: 1 + 0.08 * Math.sin(pulse * Math.PI) } : null).id("hud-total").label(String(sc.total));
  }, { columns: [{ fr: 1 }, { width: "auto", align: "end" }], gap: { row: 1, column: 12 }, width: w });
}
interface Action { id: string; text: string; key: string | null; glyph: Glyph | null; enabled: boolean; act: () => void }
function keyLabel(action: string): string | null {
  const b = bindings(action).find((x) => x.device === "keyboard");
  return b ? b.label : null;
}
function actions(): Action[] {
  const v = view();
  const busy = app.phase !== "active";
  return [
    { id: "btn-rotate", text: tr("Rotate"), key: keyLabel("rotate"), glyph: "rotate", enabled: v.canRotate && !busy, act: rotate },
    { id: "btn-lock", text: tr("Lock"), key: keyLabel("lock"), glyph: "lock", enabled: v.canLock && !busy, act: lock },
    { id: "btn-recall", text: tr("Recall"), key: null, glyph: "recall", enabled: v.canRecall && !busy, act: recall },
    { id: "btn-undo", text: tr("Undo"), key: keyLabel("undo"), glyph: "undo", enabled: v.canUndo && !busy, act: undo },
    { id: "btn-hint", text: tr("Hint"), key: keyLabel("hint"), glyph: null, enabled: v.canHint && !busy, act: hint },
    { id: "btn-pause", text: tr("Pause"), key: keyLabel("pause"), glyph: "pause", enabled: !busy, act: pause },
  ];
}
function actionButton(a: Action, width: number | null, showKey: boolean): void {
  const ink = currentPalette().theme.ink;
  const opts: ui.ButtonOptions = {
    disabled: !a.enabled,
    content: () => ui.row(`${a.id}-face`, () => {
      if (a.glyph) glyph(a.glyph, 14, ink); else ui.style({ text: { weight: "700" } }).label("?");
      ui.label(a.text);
      if (showKey && a.key) ui.style("bindings-key").label(a.key);
    }, { spacing: 6, align: "center" }),
  };
  if (ui.style("btn", "action-btn", width != null ? { width } : null).id(a.id).button(a.text, opts)) a.act();
}
function statusBits(w: number): void {
  const s = session!;
  const v = view();
  if (v.movesLeft != null) para(tr("Moves left: {n}", { n: v.movesLeft }), w, "hud-stat", "hud-moves");
  if (v.timeLeftMs != null) para(tr("Time: {time}", { time: fmtMs(v.timeLeftMs) }), w, "hud-stat", "hud-time");
  if (s.ranked) ui.style("ranked-badge").id("hud-ranked").label(tr("Ranked"));
}

function playScreen(L: Layout): void {
  const leftHanded = !!settings.leftHanded;
  const playY = topH;
  const playH = L.lh - playY;
  const pad = 8;
  let leftW = 0, rightW = 0, bottomH = 0;
  if (L.wide) {
    leftW = Math.min(272, Math.max(220, L.lw * 0.17));
    rightW = Math.min(304, Math.max(230, L.lw * 0.19));
    const railL = (): void => {
      ui.place("rail-left", { anchor: leftHanded ? "top-end" : "top-start", x: pad, y: playY + pad }, () => railLeft(leftW - 24), { style: "rail-left", width: leftW, spacing: 2 });
    };
    const railR = (): void => {
      ui.place("rail-right", { anchor: leftHanded ? "top-start" : "top-end", x: pad, y: playY + pad }, () => {
        ui.column("action-bar", () => { for (const a of actions()) actionButton(a, rightW, true); }, { spacing: 8, width: rightW });
        ui.column("rail-status", () => statusBits(rightW), { spacing: 4, padding: { top: 8 } });
      }, { width: rightW, spacing: 8 });
    };
    railL(); railR();
    leftW += pad; rightW += pad;
  } else if (L.shortLand) {
    // the actions a column beside the board
    const acts = actions();
    const colW = Math.max(...acts.map((a) => buttonWidth(a.text, ["btn", "action-btn"]) + 26));
    rightW = colW + pad * 2;
    const r = ui.place("rail-right", { anchor: leftHanded ? "top-start" : "top-end", x: pad, y: playY + 4 }, () => {
      ui.column("action-bar", () => { for (const a of acts) actionButton(a, colW, false); }, { spacing: 4, width: colW });
      ui.column("rail-status", () => statusBits(colW), { spacing: 2 });
    }, { width: colW, spacing: 4 });
    void r;
  } else if (L.phone) {
    // the actions along the bottom, scrolling sideways when they do not fit
    const acts = actions();
    const total = acts.reduce((n, a) => n + buttonWidth(a.text, ["btn", "action-btn"]) + 22, 0) + 8 * (acts.length - 1);
    const statusH = 26;
    const rowH = 52;
    bottomH = rowH + statusH + 8;
    ui.place("rail-right", { anchor: "bottom-start", x: 0, y: 4 }, () => {
      ui.column("rail-status", () => ui.row("rail-status-row", () => statusBits(L.lw), { spacing: 16, align: "center" }), { width: L.lw, align: "center", height: statusH });
      ui.scrollArea("action-scroll", { width: L.lw, height: rowH }, () => {
        ui.row("action-bar", () => { for (const a of acts) actionButton(a, null, false); }, { spacing: 8, padding: { start: 8, end: 8 }, width: Math.max(L.lw, total + 16), justify: total + 16 < L.lw ? "center" : "start" });
      });
    }, { width: L.lw });
  } else {
    // compact: the rails are drawers; the moves / time line under the board
    bottomH = 30;
    ui.place("rail-status", { anchor: "bottom", y: 6 }, () => ui.row("rail-status-row", () => statusBits(L.lw), { spacing: 16, align: "center" }));
  }
  // the board, centred in what the rails leave
  const cx0 = leftHanded && (L.wide || L.shortLand) ? rightW : leftW;
  const centerW = L.lw - leftW - rightW;
  let centerH = playH - bottomH;
  let bannerH = 0;
  const lesson = lessonText();
  if (lesson && !L.wide) {
    // The lesson's step (the docked rail's line) over the board while the rail is a drawer.
    const bw = Math.min(centerW - 16, 560);
    const r = ui.place("lesson-banner", { anchor: "top-start", x: cx0 + (centerW - bw) / 2, y: playY + 6 }, () => {
      para(lesson, bw - 24, "hud-lesson", "lesson-banner-text", true);
    }, { style: "lesson-banner", width: bw, align: "center" });
    bannerH = r.height / L.sc + 8;
    centerH -= bannerH;
  }
  const s = session!;
  const BL = layoutBoard(s.state, centerW - 16, centerH - 16, L.vmin, L.shortLand);
  const bx = cx0 + (centerW - BL.panelW) / 2;
  const by = playY + bannerH + Math.max(4, (centerH - BL.panelH) / 2);
  ui.place("board-place", { anchor: "top-start", x: bx, y: by }, () => buildBoard(BL));
  render.setPlayfield((L.ox + cx0) * L.sc, (L.oy + playY) * L.sc, centerW * L.sc, centerH * L.sc, frame().width, frame().height);
}

// ------------------------------------------------------------------ screens
/** A screen: its panel centred under the top bar, scrolling when taller than the room. */
function screen(key: string, L: Layout, maxW: number, build: (inner: number) => void, center = false): void {
  const padX = L.phone ? 16 : 16;
  const avail = Math.max(80, L.lh - topH);
  const width = Math.max(200, Math.min(maxW, L.lw - padX * 2));
  const inner = width;
  const h = lastHeight.get(key) ?? 0;
  ui.place(`scr-${key}`, { anchor: "top-start", x: 0, y: topH }, () => {
    const body = (): void => {
      const r = ui.column(`${key}-panel`, () => {
        build(inner);
        ui.style("small-soft", { text: { align: "center" } }).paragraph(tr("Card Mosaic — a quiet studio puzzle. Progress is stored locally on this device."), inner);
      }, { width, spacing: 12, align: center ? "center" : "start", padding: { top: 24, bottom: 16 } });
      lastHeight.set(key, r.height / L.sc);
    };
    if (h > avail) {
      ui.scrollArea(`${key}-scroll`, { width: L.lw, height: avail }, () => {
        ui.column(`${key}-scroll-col`, body, { width: L.lw - 12, align: "center" });
      });
    } else ui.column(`${key}-center`, body, { height: avail, width: L.lw, justify: "center", align: "center" });
  }, { width: L.lw, height: avail });
}
function backButton(id: string, to: ScreenName, text = tr("Back to title")): Btn {
  return { id, text, style: ["btn", "btn-quiet"], act: () => (to === "title" ? goTitle() : showScreen(to, to === "modes" ? "mode-learn" : null)) };
}

function dailyCountdown(): string {
  const nowMs = platform.nowMs();
  const next = Date.parse(utcToday() + "T00:00:00Z") + 86400000;
  const ms = Math.max(0, next - nowMs);
  const h = Math.floor(ms / 3600000), m = Math.floor((ms % 3600000) / 60000), s = Math.floor((ms % 60000) / 1000);
  return `${h}h ${String(m).padStart(2, "0")}m ${String(s).padStart(2, "0")}s`;
}

function titleScreen(L: Layout): void {
  const side = L.shortLand && !!art.key;
  screen("title", L, side ? 900 : 640, (w) => {
    const menu = (mw: number): void => {
      heading("h1", "Card Mosaic", mw, "title-h");
      if (!L.shortLand) para(tr("Place edge-coded cards so the artwork connects — a quiet puzzle on a studio card table."), mw, "tagline", "tagline", true);
      if (hasSnapshot()) {
        flow("title-resume", [
          { id: "btn-title-resume", text: tr("Resume saved round"), style: ["btn", "btn-primary"], act: resumeSnapshot },
          { id: "btn-title-discard", text: tr("Discard"), style: ["btn", "btn-quiet"], act: discardSnapshot },
        ], mw, "center");
      }
      button({ id: "btn-play", text: tr("Play"), style: ["btn", "btn-primary", "btn-xl"], act: () => { showScreen("modes", "mode-learn"); } });
      const daily: Btn = {
        id: "btn-title-daily", text: tr("Daily challenge"), act: () => modeSetup("daily"),
        content: () => ui.column("daily-face", () => {
          ui.label(tr("Daily challenge"));
          ui.style("daily-countdown").id("daily-countdown").label(dailyCountdown());
        }, { align: "center", spacing: 0 }),
      };
      flow("title-secondary", [daily,
        { id: "btn-title-journey", text: tr("Journey"), act: () => modeSetup("journey") },
        { id: "btn-title-profile", text: tr("Profile"), act: () => showScreen("profile") },
      ], mw, "center");
      const tert: Btn[] = [
        { id: "btn-title-settings", text: tr("Settings"), style: ["btn", "btn-quiet"], act: () => openSettings(0) },
        { id: "btn-title-help", text: tr("How to play"), style: ["btn", "btn-quiet"], act: () => showScreen("help") },
      ];
      const link = platform.inviteLink();
      if (link) tert.push({ id: "btn-title-invite", text: pt("invite"), style: ["btn", "btn-quiet"], act: () => {
        try { clipboard.writeText(link); toast(() => pt("inviteCopied"), "success"); } catch { toast(() => pt("inviteFailed"), "warn"); }
      } });
      if (!platform.signedIn()) tert.push({ id: "btn-title-signin", text: pt("signIn"), act: () => { void requestSignIn().catch(() => undefined); } });
      flow("title-tertiary", tert, mw, "center", 16);
      const p = progress();
      const bits = [
        tr("Journey: {n} of {total} stages complete", { n: Object.keys(p.journey).length, total: JOURNEY.length }),
        (p.dailies[utcToday()] ? tr("Today’s daily: done") : tr("Today’s daily: open")),
      ];
      para(bits.join(" · "), mw, "title-summary", "title-summary", true);
      if (platform.signedIn()) para(pt("signedInAs", { name: platform.displayName() }), mw, "title-summary", "title-signed-in", true);
      else if (app.signedOut) para(pt("signedOut"), mw, "title-summary", "title-signed-out", true);
    };
    if (side) {
      const artW = Math.min(w * 0.38, 360);
      ui.row("title-side", () => {
        artImage(art.key!, artW, "title-art");
        ui.column("title-menu", () => menu(w - artW - 24), { width: w - artW - 24, spacing: 10, align: "center" });
      }, { spacing: 24, align: "center", width: w });
    } else {
      if (art.key) {
        const aw = Math.min(w, L.lh < 820 && !L.phone ? 440 : L.lh < 960 && !L.phone ? 560 : 640);
        artImage(art.key, aw, "title-art");
      }
      ui.column("title-menu", () => menu(w), { width: w, spacing: 12, align: "center" });
    }
  }, true);
}

function modesScreen(L: Layout): void {
  screen("modes", L, 960, (w) => {
    heading("h2", tr("Choose a mode"), w, "modes-h");
    const gap = 12;
    const min = Math.min(260, w);
    const cols = Math.max(1, Math.floor((w + gap) / (min + gap)));
    const cw = (w - gap * (cols - 1)) / cols;
    const modes = Object.keys(MODES) as Mode[];
    const BLURB: Record<Mode, [string, string]> = {
      learn: [N("Interactive lessons introduce one rule at a time."), N("2–5 min")],
      journey: [N("Authored stages that combine mechanics and end in mastery tests."), N("3–8 min")],
      daily: [N("One shared mosaic per UTC day, same seed for everyone."), N("≈5 min")],
      practice: [N("Relaxed play at your chosen difficulty. No rating effects."), N("3–10 min")],
      challenge: [N("Constrained goals: move budgets, clocks, and impostor cards."), N("5–10 min")],
      score: [N("Chase global and friends leaderboards on validated seeds."), N("5–10 min")],
    };
    ui.column("mode-list", () => {
      for (let i = 0; i < modes.length; i += cols) {
        ui.row(`mode-r${i}`, () => {
          for (const mode of modes.slice(i, i + cols)) {
            const m = MODES[mode];
            const assists = [m.undoAllowed && tr("Undo"), m.hintAllowed && tr("Hint")].filter(Boolean).join(", ") || tr("None");
            const ci = cw - 36;
            const face = (): void => {
              ui.column(`mode-${mode}-face`, () => {
                ui.style("mode-name").label(tr(m.label));
                ui.style("mode-blurb").paragraph(tr(BLURB[mode][0]), ci);
                ui.style("mode-meta").paragraph(tr("{duration} · 1 player · Assists: {assists}", { duration: tr(BLURB[mode][1]), assists }), ci);
                ui.style(m.ranked ? "badge-ranked" : "badge-casual").label(tr(m.ranked ? "Ranked" : "Casual"));
              }, { spacing: 6, width: ci });
            };
            if (ui.style("btn", "mode-card", { width: cw }).id(`mode-${mode}`).button(tr(m.label), { content: face })) modeSetup(mode);
          }
        }, { spacing: gap, align: "stretch" });
      }
    }, { spacing: gap, width: w });
    button(backButton("btn-modes-back", "title"));
  });
}

function journeyScreen(L: Layout): void {
  const p = progress();
  screen("journey", L, 960, (w) => {
    heading("h2", tr("Journey"), w, "journey-h");
    para(tr("Authored stages, one new idea at a time. Earn up to three stars per stage."), w, "blurb");
    const chapters = new Map<number, (typeof JOURNEY)[number][]>();
    for (const st of JOURNEY) { if (!chapters.has(st.chapter)) chapters.set(st.chapter, []); chapters.get(st.chapter)!.push(st); }
    const accent = currentPalette().theme.accent;
    for (const [num, list] of chapters) {
      ui.style("h3").heading(tr("Chapter {n}", { n: num }));
      const btns: { w: number; build: () => void }[] = [];
      list.forEach((st, i) => {
        const rec = p.journey[st.id] || {};
        const completed = !!rec.completed;
        const nStars = rec.stars || 0;
        const prev = i > 0 ? list[i - 1] : null;
        const prevChapter = chapters.get(num - 1);
        const gate = prev || (prevChapter && prevChapter[prevChapter.length - 1]);
        const unlocked = !gate || !!(p.journey[gate.id] && p.journey[gate.id].completed);
        const name = stageName(st.name);
        const aria = name + (completed ? tr(", complete, {n} of 3 stars", { n: nStars }) : unlocked ? tr(", available") : tr(", locked"));
        const bw = Math.max(72, textWidth(name, "stage-name") + 24, unlocked ? 0 : textWidth(tr("Locked"), "stage-lock") + 24);
        btns.push({ w: bw, build: () => {
          if (ui.style("btn", "stage-btn", { width: bw }).id(`stage-${st.index}`).button(aria, {
            disabled: !unlocked,
            content: () => ui.column(`stage-${st.index}-face`, () => {
              ui.style("stage-name").label(name);
              if (completed) stars(nStars, 12, accent, "");
              else ui.style({ text: { color: accent } }).label("·");
              if (!unlocked) ui.style("stage-lock").label(tr("Locked"));
            }, { align: "center", spacing: 2 }),
          }) && unlocked) startJourney(st.index);
        } });
      });
      // flex-wrap rows
      const rows: (typeof btns)[] = [[]];
      let used = 0;
      for (const b of btns) { if (rows[rows.length - 1]!.length && used + 8 + b.w > w) { rows.push([]); used = 0; } used += (rows[rows.length - 1]!.length ? 8 : 0) + b.w; rows[rows.length - 1]!.push(b); }
      ui.column(`chapter-${num}`, () => rows.forEach((row, ri) => ui.row(`chapter-${num}-r${ri}`, () => { for (const b of row) b.build(); }, { spacing: 8, align: "stretch" })), { spacing: 8 });
    }
    button(backButton("btn-journey-back", "modes", tr("Back")));
  });
}
/** Journey stage names are authored as "Stage n" / "Mastery n". */
function stageName(name: string): string {
  const m = /^(Stage|Mastery) (\d+)$/.exec(name || "");
  if (!m) return tr(name);
  return m[1] === "Stage" ? tr("Stage {n}", { n: m[2]! }) : tr("Mastery {n}", { n: m[2]! });
}

function lessonsScreen(L: Layout): void {
  const p = progress();
  screen("lessons", L, 960, (w) => {
    heading("h2", tr("Lessons"), w, "lessons-h");
    para(tr("Short interactive lessons. Each asks you to perform the move yourself."), w, "blurb");
    const match = currentPalette().theme.match;
    ui.column("lesson-list", () => {
      for (const l of LESSONS) {
        const done = !!(p.lessons[l.id] && p.lessons[l.id].completed);
        if (ui.style("btn", "lesson-btn", { width: w }).id(`lesson-${l.id}`).button(tr(l.name), {
          content: () => ui.column(`lesson-${l.id}-face`, () => {
            ui.row(`lesson-${l.id}-name`, () => { ui.style("lesson-name").label(tr(l.name)); if (done) glyph("check", 14, match, "✓"); }, { spacing: 6, align: "center" });
            ui.style("lesson-intro").paragraph(tr(l.intro), w - 40);
          }, { spacing: 2, width: w - 36 }),
        })) startLesson(l.id);
      }
    }, { spacing: 8, width: w });
    button(backButton("btn-lessons-back", "modes", tr("Back")));
  });
}

function setupScreen(L: Layout): void {
  const v = app.setup;
  if (!v) { showScreen("modes"); return; }
  screen("setup", L, 560, (w) => {
    heading("h2", v.title(), w, "setup-title");
    para(tr(v.rules), w, "blurb", "setup-blurb");
    const assists = [v.assists.undo && tr("Undo"), v.assists.hints && tr("Hint")].filter(Boolean).join(", ") || tr("None");
    dl("setup-meta", [[tr("Expected duration"), tr(v.duration)], [tr("Players"), "1"], [tr("Assists"), assists]], w);
    para(v.ranked ? tr("Ranked — the result counts toward leaderboards.") : tr("Unranked — casual play, no rating effects."), w, "ranked-note", "setup-ranked");
    const opt = (id: string, name: string, blurb: string, act: () => void): void => {
      if (ui.style("btn", "opt-btn", { width: w }).id(id).button(name, {
        content: () => ui.column(`${id}-face`, () => { ui.label(name); ui.style("opt-blurb").paragraph(blurb, w - 40); }, { spacing: 2, width: w - 36 }),
      })) act();
    };
    if (v.list === "difficulties") {
      ui.column("setup-options", () => {
        for (const d of PRACTICE_DIFFICULTIES) opt(`diff-${d.id}`, tr(d.name), tr("{w}×{h} board, {n} cards in tray", { w: d.params.w, h: d.params.h, n: d.params.removed }), () => startPractice(d.id));
      }, { spacing: 8, width: w });
    } else if (v.list === "challenges") {
      ui.column("setup-options", () => {
        for (const c of CHALLENGES) opt(`challenge-${c.id}`, tr(c.name), tr(c.blurb), () => startChallenge(c.id));
      }, { spacing: 8, width: w });
    }
    const btns: Btn[] = [];
    if (!v.list) btns.push({ id: "setup-start", text: tr("Start"), style: ["btn", "btn-primary"], act: startDaily });
    btns.push(backButton("btn-setup-back", "modes", tr("Back")));
    flow("setup-buttons", btns, w);
  });
}

function resultsScreen(L: Layout): void {
  const res = app.results;
  if (!res) { goTitle(); return; }
  const r = res.result;
  const pal = currentPalette();
  screen("results", L, 560, (w) => {
    const headlines: Record<string, string> = { complete: N("Mosaic complete!"), "moves-exhausted": N("Out of moves"), "time-up": N("Time is up"), conceded: N("Round conceded") };
    heading("h2", tr(headlines[r.terminalReason] || N("Round over")), w, "results-headline");
    para([tr("Time {time}", { time: fmtMs(r.elapsedMs) }), tr("{n} moves", { n: r.movesUsed })].join(" · "), w, "blurb", "results-sub");
    const pic = r.terminalReason === "complete" ? art.complete : art.over;
    if (pic) {
      const aw = Math.min(w, L.lh <= 540 ? 320 : w);
      artImage(pic, aw, "results-art");
    }
    if (res.stars > 0) stars(res.stars, 26, pal.theme.accent, tr("{n} of 3 stars", { n: res.stars }));
    if (res.isNewBest) ui.style("newbest").id("results-newbest").label(tr("New personal best!"));
    ui.style("h3").heading(tr("Score breakdown"));
    ui.grid("results-breakdown", () => {
      for (const row of res.breakdown) {
        para(tr(row.label), w - 80, row.total ? "score-total" : "score-dt");
        ui.style(row.total ? "score-total" : "score-dd").label(String(row.value));
      }
    }, { columns: [{ fr: 1 }, { width: "auto", align: "end" }], gap: { row: 1, column: 12 }, width: w });
    para(tr("Par: {par}", { par: [tr("{n} moves", { n: res.par.moves }), fmtMs(res.par.ms)].join(" · ") }), w, "blurb", "results-par");
    for (const k of res.achievements) {
      const a = ACHIEVEMENTS.find((x) => x.key === k);
      ui.column(`unlock-${k}`, () => para(tr("Achievement unlocked: {name}", { name: tr(a?.name || k) }), w - 14, "body"), { style: "unlock" });
    }
    if (res.lb) {
      const lb = res.lb;
      para(lb.pending ? pt("lbPosting") : !lb.posted ? pt("lbNotPosted") : lb.rank ? pt("lbRank", { rank: lb.rank }) : pt("lbPosted"), w, "blurb", "results-lb");
    }
    flow("results-buttons", [
      { id: "btn-results-retry", text: tr("Retry"), act: () => resultsAction("retry") },
      { id: "results-next", text: tr(res.next.label), style: ["btn", "btn-primary"], act: () => resultsAction(res.next.action) },
      { id: "btn-results-map", text: tr("Map"), act: () => resultsAction("map") },
      { id: "btn-results-title", text: tr("Title"), style: ["btn", "btn-quiet"], act: () => resultsAction("title") },
    ], w);
  });
}

const RULES: [string, string][] = [
  [N("The goal"), N("Fill every cell of the mosaic. Wherever two cards touch, the motifs on the touching edges must match.")],
  [N("Placing cards"), N("Select a card in the tray, then choose an empty cell. Keyboard: arrows move, Enter confirms.")],
  [N("Matching edges"), N("Each matched edge glows and scores 10 points. Mismatched edges are tinted — they never block you, but they score nothing.")],
  [N("Rotating"), N("Some cards arrive turned. Select a tray card and Rotate (R) to quarter-turn it before placing.")],
  [N("Locking"), N("A card that matches every placed neighbor can be locked (L) for 15 points. Locked cards cannot move.")],
  [N("Swapping & recall"), N("Tap two placed cards to swap them (−5 points). Recall returns a placed card to its tray slot.")],
  [N("Invalid moves"), N("Illegal tries are always reversible and cost 2 points — the game explains why each one failed.")],
  [N("Impostors"), N("Some trays hold decoy cards that belong nowhere. Leave them aside to finish the true mosaic.")],
];
function ruleCards(label: string, cards: [string, string][], w: number): void {
  const gap = 12;
  const min = Math.min(240, w);
  const cols = Math.max(1, Math.floor((w + gap) / (min + gap)));
  const cw = (w - gap * (cols - 1)) / cols;
  ui.column(label, () => {
    for (let i = 0; i < cards.length; i += cols) {
      ui.row(`${label}-r${i}`, () => {
        for (const [h, body] of cards.slice(i, i + cols)) {
          ui.column(`${label}-${h}`, () => { ui.style("h3").heading(tr(h)); ui.style("body").paragraph(tr(body), cw - 34); }, { style: "rule-card", width: cw, spacing: 6 });
        }
      }, { spacing: gap, align: "stretch" });
    }
  }, { spacing: gap, width: w });
}
function helpScreen(L: Layout): void {
  screen("help", L, 960, (w) => {
    heading("h2", tr("How to play"), w, "help-h");
    ruleCards("rule-cards", RULES, w);
    button(backButton("btn-help-back", "title"));
  });
}

let nameDraft: string | null = null;
function profileScreen(L: Layout): void {
  const p = progress();
  const acc = achievements();
  screen("profile", L, 960, (w) => {
    heading("h2", tr("Profile"), w, "profile-h");
    if (platform.signedIn()) {
      para(tr("Display name (platform account)"), w, "dt");
      para(platform.displayName(), w, "body", "profile-name");
    } else {
      para(tr("Display name (stored on this device)"), w, "dt");
      if (nameDraft === null) nameDraft = settings.profileName;
      ui.row("profile-form", () => {
        nameDraft = ui.textField("profile-name", nameDraft ?? "", { maxChars: 24, width: Math.min(320, w - 100) });
        const save = (): void => { platform.setSetting("profileName", (nameDraft ?? "").trim().slice(0, 24)); toast(() => tr("Display name saved"), "success"); };
        if (ui.submitted("profile-name")) save();
        if (ui.style("btn", "btn-primary").id("btn-profile-save").button(tr("Save"))) save();
      }, { spacing: 8, align: "center" });
    }
    const sync = platform.syncState();
    para(sync === "offline" ? tr("Offline — progress saves on this device.") : sync === "synced" ? tr("Cloud save synced.") : sync === "saving" ? tr("Saving to cloud…") : tr("Cloud sync unavailable — local copy is current."), w, "soft", "profile-sync");
    ui.style("h3").heading(tr("Statistics"));
    const journeyDone = Object.values(p.journey).filter((s) => (s as { completed?: boolean }).completed).length;
    const rows: [string, string][] = [
      [tr("Sessions played"), String(p.sessionsPlayed || 0)],
      [tr("Journey stages complete"), tr("{n} of {total}", { n: journeyDone, total: JOURNEY.length })],
      [tr("Mastery XP"), String(p.masteryXp || 0)],
    ];
    if (p.streak && p.streak.count) rows.push([tr("Daily streak"), tr("{n} days", { n: p.streak.count })]);
    dl("profile-stats", rows, w, "score-dt", "score-dd", true);
    ui.style("h3").heading(tr("Achievements"));
    const gap = 8;
    const cols = Math.max(1, Math.floor((w + gap) / (Math.min(220, w) + gap)));
    const cw = (w - gap * (cols - 1)) / cols;
    ui.column("profile-achievements", () => {
      for (let i = 0; i < ACHIEVEMENTS.length; i += cols) {
        ui.row(`ach-r${i}`, () => {
          for (const a of ACHIEVEMENTS.slice(i, i + cols)) {
            const got = acc.unlocked[a.key];
            ui.column(`ach-${a.key}`, () => {
              ui.style("ach-name").label(tr(a.name));
              ui.style("ach-desc").paragraph(tr(a.desc), cw - 30);
              ui.style("ach-date").label(got ? tr("Unlocked {date}", { date: String(got).slice(0, 10) }) : tr("Not yet unlocked"));
            }, { style: got ? "ach-card" : ["ach-card", "ach-locked"], width: cw, spacing: 2 });
          }
        }, { spacing: gap, align: "stretch" });
      }
    }, { spacing: gap, width: w });
    button(backButton("btn-profile-back", "title"));
  });
}

function boardsScreen(L: Layout): void {
  const b = app.boards;
  screen("boards", L, 560, (w) => {
    heading("h2", tr("Score chase"), w, "boards-h");
    ui.row("scope-toggle", () => {
      button({ id: "btn-boards-global", text: tr("Global"), style: ["btn", ...(b.scope === "global" ? ["btn-pressed"] : [])], selected: b.scope === "global", act: () => setBoardScope("global") });
      button({ id: "btn-boards-friends", text: tr("Friends"), style: ["btn", ...(b.scope === "friends" ? ["btn-pressed"] : [])], selected: b.scope === "friends", act: () => setBoardScope("friends") });
    }, { spacing: 8 });
    para(b.casual ? tr("Casual board — these scores are not validated.") : (b.scope === "global" ? tr("Global board — validated scores.") : tr("Friends board — validated scores.")), w, "ranked-note", "boards-note");
    if (b.rows && !b.rows.length) para(tr("No scores yet — be the first."), w, "body", "boards-empty");
    if (b.rows && b.rows.length) {
      ui.column("boards-list", () => {
        b.rows!.forEach((e, i) => {
          const name = (e.name || tr("Anonymous")) + (b.casual ? " " + tr("(casual)") : "");
          ui.id(`lb-${i}`).row(tr("Rank {n}, {name}, {score} points", { n: e.rank ?? i + 1, name: e.name || tr("Anonymous"), score: e.score }) + (b.casual ? tr(", casual") : ""), () => {
            ui.label(`${e.rank ?? i + 1}.`);
            ui.style({ text: { overflow: "ellipsis" } }).label(name);
            ui.spacer();
            ui.label(String(e.score));
          }, { style: e.mine && !b.casual ? "lb-you" : "lb-row", width: w, spacing: 8, align: "center" });
        });
      }, { spacing: 4, width: w });
    }
    button(backButton("btn-boards-back", "title"));
  });
}

// ------------------------------------------------------------------ overlays
function dialogFrame(label: string, title: string, L: Layout, maxW: number, build: (w: number) => void): void {
  const w = Math.min(maxW, L.lw - (L.phone ? 40 : 56));
  const avail = L.lh - (L.phone ? 56 : 64);
  const h = lastHeight.get(`dlg-${label}`) ?? 0;
  const body = (): void => {
    const r = ui.column(`${label}-body`, () => {
      heading("h2", title, w, `${label}-h`);
      build(w);
    }, { spacing: 12, width: w });
    lastHeight.set(`dlg-${label}`, r.height / L.sc);
  };
  const open = ui.dialog(label, "", true, () => {
    if (h > avail) ui.scrollArea(`${label}-scroll`, { width: w + 14, height: avail }, body);
    else body();
  });
  // The Escape (or East) that opened it must not close it the same frame.
  if (!open && frame().frame !== app.overlayOpenedFrame) closeOverlay();
}
function overlays(L: Layout): void {
  const top = topOverlay();
  if (!top) return;
  switch (top) {
    case "pause": pauseOverlay(L); break;
    case "settings": settingsOverlay(L); break;
    case "help": helpOverlay(L); break;
    case "confirm": confirmOverlay(L); break;
    case "drawer-left": drawerOverlay(L, "left"); break;
    case "drawer-right": drawerOverlay(L, "right"); break;
  }
}
function pauseOverlay(L: Layout): void {
  dialogFrame("pause", tr("Paused"), L, 480, (w) => {
    button({ id: "btn-resume", text: tr("Resume"), style: ["btn", "btn-primary"], act: resume }, w);
    const section = (id: string, title: string, btns: Btn[]): void => {
      ui.column(id, () => { ui.style("section-h").label(title.toUpperCase()); flow(`${id}-btns`, btns, w); }, { style: "pause-section", spacing: 6, width: w });
    };
    section("pause-settings", tr("Settings"), [
      { id: "btn-pause-audio", text: tr("Audio"), act: () => openSettings(0) },
      { id: "btn-pause-graphics", text: tr("Graphics"), act: () => openSettings(1) },
      { id: "btn-pause-controls", text: tr("Controls"), act: () => openSettings(2) },
      { id: "btn-pause-accessibility", text: tr("Accessibility"), act: () => openSettings(3) },
    ]);
    section("pause-help", tr("Help"), [{ id: "btn-pause-help", text: tr("How to play"), act: () => openOverlay("help") }]);
    section("pause-round", tr("Round"), [
      { id: "btn-pause-restart", text: tr("Restart round"), act: () => askConfirm("restart") },
      { id: "btn-pause-concede", text: tr("Concede round"), act: () => askConfirm("concede") },
      { id: "btn-pause-leave", text: tr("Leave round"), style: ["btn", "btn-danger"], act: () => askConfirm("leave") },
    ]);
  });
}
function confirmOverlay(L: Layout): void {
  const c = app.confirm;
  if (!c) { closeOverlay(); return; }
  dialogFrame("confirm", tr(c.title), L, 400, (w) => {
    para(tr(c.message), w, "blurb", "confirm-message");
    flow("confirm-buttons", [
      { id: "btn-confirm-yes", text: tr(c.confirm), style: ["btn", "btn-danger"], act: confirmYes },
      { id: "btn-confirm-no", text: tr("Cancel"), act: closeOverlay },
    ], w);
  });
}
function helpOverlay(L: Layout): void {
  dialogFrame("help-overlay", tr("How to play"), L, 480, (w) => {
    ruleCards("help-compact", [
      [N("Goal"), N("Fill the mosaic so touching edges share the same motif.")],
      [N("Moves"), N("Select a tray card, then an empty cell. Rotate turned cards (R). Lock fully-matching cards (L) for bonus points.")],
      [N("Fixing mistakes"), N("Recall a card, swap two placed cards, or Undo (U). Invalid tries are explained and cost 2 points.")],
    ], w);
    button({ id: "btn-help-close", text: tr("Close help"), act: closeOverlay });
  });
}
const SETTINGS_TABS = [N("Audio"), N("Graphics"), N("Controls"), N("Accessibility")];
function settingsOverlay(L: Layout): void {
  dialogFrame("settings", tr("Settings"), L, 640, (w) => {
    const labels = SETTINGS_TABS.map((t) => tr(t));
    ui.row("settings-tabs", () => {
      labels.forEach((t, i) => {
        if (ui.style("tab").id(`tab-${i}`).button(t, { selected: i === app.settingsTab })) app.settingsTab = i;
      });
    }, { style: "tab-strip", width: w, spacing: 4 });
    const check = (key: "cvd" | "leftHanded" | "holdToConfirm" | "timingAssist" | "haptics" | "captions", label: string): void => {
      const cur = !!settings[key];
      const next = ui.id(`set-${key}`).checkbox(label, cur);
      if (next !== cur) platform.setSetting(key, next);
    };
    const options = (note: string): void => {
      para(tr(note), w, "soft");
      button({ id: "btn-open-options", text: tr("Open Options"), act: () => openMenu() });
    };
    switch (app.settingsTab) {
      case 0: options(N("Music, effects and voice volumes and mute are set in the StarHermit Options (F1).")); break;
      case 1: {
        ui.style("dt").label(tr("Table theme"));
        const btns: Btn[] = Object.values(THEMES).map((t) => ({
          id: `theme-${t.id}`, text: tr(t.name), style: ["btn", "theme-swatch", ...(settings.theme === t.id ? ["btn-pressed"] : [])], selected: settings.theme === t.id,
          act: () => platform.setSetting("theme", t.id),
          content: () => ui.column(`theme-${t.id}-face`, () => {
            const th = getTheme(t.id);
            ui.widget("", { role: "none", size: { width: 40, height: 28 }, draw: (r) => draw.box(r.x, r.y, r.width, r.height, { background: { type: "linear", angle: 135, stops: [{ color: th.bg, at: 0 }, { color: th.felt, at: 0.55 }, { color: th.accent, at: 1 }] }, radius: 6, border: { width: 2, color: th.cardEdge } }) });
            ui.label(tr(t.name));
          }, { align: "center", spacing: 4 }),
        }));
        flow("theme-list", btns, w);
        check("cvd", tr("Color-vision-safe motif palette"));
        options(N("Graphics quality, render scale and the frame rate are set in the StarHermit Options (F1)."));
        break;
      }
      case 2: {
        const rows: [string[], string][] = [
          [["left", "up", "down", "right"], N("Move focus among cells and tray cards")], [["select"], N("Select or confirm")],
          [["cancel"], N("Cancel selection, close dialog, or pause")], [["undo"], N("Undo")], [["hint"], N("Hint")],
          [["rotate"], N("Rotate selected tray card")], [["lock"], N("Lock selected cell")], [["recall"], N("Recall selected card")], [["pause"], N("Pause")],
        ];
        ui.style("dt").label(tr("Keyboard bindings"));
        const keyW = Math.min(w * 0.45, 220);
        ui.grid("bindings", () => {
          rows.forEach(([acts, text], i) => {
            const keys = acts.flatMap((a) => bindings(a).filter((b) => b.device === "keyboard").map((b) => b.label));
            const lines: string[][] = [[]];
            let used = 0;
            for (const k of keys) {
              const kw = textWidth(k, "bindings-key") + 4;
              if (lines[lines.length - 1]!.length && used + kw > keyW) { lines.push([]); used = 0; }
              used += kw;
              lines[lines.length - 1]!.push(k);
            }
            ui.column(`bind-${i}`, () => lines.forEach((ln, li) => ui.row(`bind-${i}-${li}`, () => { for (const k of ln) ui.style("bindings-key").label(k); }, { spacing: 4 })), { spacing: 2, width: keyW });
            para(tr(text), w - keyW - 16, "body");
          });
        }, { columns: [{ width: keyW }, { fr: 1 }], gap: { row: 6, column: 16 }, width: w });
        options(N("Change keys and gamepad buttons in the StarHermit Options (F1)."));
        break;
      }
      default: {
        check("leftHanded", tr("Left-handed layout"));
        check("holdToConfirm", tr("Hold to confirm instead of toggle"));
        check("timingAssist", tr("Timing assist (relaxed clocks where rules allow)"));
        check("haptics", tr("Haptic feedback"));
        check("captions", tr("Captions for meaningful sounds"));
        button({ id: "btn-tutorial-replay", text: tr("Replay tutorials"), act: replayTutorials });
        options(N("Reduced motion, high contrast and text size are set in the StarHermit Options (F1)."));
      }
    }
    button({ id: "btn-settings-close", text: tr("Close settings"), act: closeOverlay });
  });
}
function drawerOverlay(L: Layout, side: "left" | "right"): void {
  if (!session || app.screen !== "play") { closeOverlay(); return; }
  dialogFrame(`drawer-${side}`, side === "left" ? tr("Goal") : tr("Actions"), L, 320, (w) => {
    if (side === "left") railLeft(w);
    else {
      ui.column("drawer-actions", () => {
        for (const a of actions()) actionButton({ ...a, act: () => { closeOverlay(); a.act(); } }, w, true);
      }, { spacing: 8, width: w });
      statusBits(w);
    }
    button({ id: `btn-drawer-${side}-close`, text: tr("Close"), act: closeOverlay });
  });
}

// ------------------------------------------------------------------ toasts
function toasts(L: Layout, playing: boolean): void {
  if (!app.toasts.length) return;
  const w = Math.min(L.lw - 32, 560);
  const atTop = app.screen === "results";
  ui.place("toasts", atTop ? { anchor: "top", y: 4 } : { anchor: "bottom", y: playing && L.phone ? 96 : 72 }, () => {
    for (const t of app.toasts) {
      const text = t.text();
      const cls = ["toast", ...(t.kind === "warn" ? ["toast-warn"] : t.kind === "success" ? ["toast-success"] : [])];
      const fits = textWidth(text, cls) + 40 <= w;
      if (ui.style(...cls).id(`toast-${t.id}`).button(text, fits ? {} : { content: () => ui.style({ text: { align: "center" } }).paragraph(text, w - 40) })) dismissToast(t.id);
    }
  }, { spacing: 6, align: "center", width: w });
}
