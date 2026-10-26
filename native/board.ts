// The mosaic board as the browser build's DOM felt panel drew it (index.html
// #board-container, js/ui.js, css/style.css): the felt panel (with the
// detailed table's sheen and inner shadow), the grid of cells and the tray
// below it (beside it on short landscape screens). Every cell and tray slot
// is a ui.widget button with the old button's accessible name ("Row 1 column
// 2, card with Wave north, …"), so Tab, the arrows, Enter/Space and a pad's
// D-pad and South move over and press them as they did the DOM buttons, and
// a tap or click on one does what it did. The look per cell: legal placement
// tint and border, the selection outline, the lockable double border, the
// mismatch tint, the green match bars on matched sides, the pulsing hint
// ring, the locked border and the lock seal; the cards with their four edge
// motifs and the centre medallion (motifs.ts), turned by a quarter turn with
// the old 0.18 s transition; the selected tray card lifting 6 px; the glow
// over the panel when a move matched more edges. Everything is drawn with
// starhermit:draw inside the widgets (no images), in logical pixels times
// the UI's scale.
import { frame } from "starhermit:engine";
import * as draw from "starhermit:draw";
import * as ui from "starhermit:ui";
import { analyzeBoard, effectiveEdges, cellXY } from "../js/rules.js";
import { MOTIFS } from "../js/content.js";
import { tr, N } from "./i18n.ts";
import { drawMotif } from "./motifs.ts";
import { app, onCell, onTray, round, session, view } from "./main.ts";
import { currentPalette, mix, type Palette } from "./style.ts";

type State = NonNullable<typeof session>["state"];
type Card = State["cards"][string];

const GAP = 8;
const PAD = 12;
const BORDER = 3;
const TRAY_GAP = 12;
let detailed = true;
export function setDetailed(on: boolean): void { detailed = on; }

// --- per-card and per-slot animation -----------------------------------------------------
const turn = new Map<string, number>(); // displayed quarter turns (fractional while animating)
const lift = new Map<number, number>();  // tray slot lift 0–1
let analysis: { tick: number; links: Set<number>[]; mismatch: Set<number> } | null = null;

/** A new round's board: cards at their turns, no lift. */
export function reset(state: State): void {
  turn.clear();
  lift.clear();
  analysis = null;
  for (const id of Object.keys(state.cards)) turn.set(id, state.cards[id]!.rot);
}
/** Session events (the DOM build animated only through its classes). */
export function playEvents(_events: { type: string }[], _state: State): void { analysis = null; }

/** The widget to focus when the round starts or the arrows wake the board. */
export function firstFocus(): string { return "cell-0"; }

function syncAnalysis(state: State): NonNullable<typeof analysis> {
  if (analysis && analysis.tick === state.tick) return analysis;
  const a = analyzeBoard(state);
  const links = state.cells.map(() => new Set<number>());
  const mismatch = new Set<number>();
  for (const p of a.pairs) {
    if (p.open) continue;
    if (p.matched) { links[p.a]!.add(p.dir); links[p.b]!.add((p.dir + 2) % 4); }
    else { mismatch.add(p.a); mismatch.add(p.b); }
  }
  analysis = { tick: state.tick, links, mismatch };
  return analysis;
}

// --- layout ------------------------------------------------------------------------------
export interface BoardLayout { panelW: number; panelH: number; cell: number; slotW: number; slotH: number; trayCols: number; trayRows: number; side: boolean }
/**
 * The panel's size in `availW` × `availH` logical pixels, as the CSS sized it:
 * a definite width (at most 600 and 92 % of the shorter window side), the
 * grid filling it, the tray slots 52–84 px wide (12 % of the shorter side)
 * wrapping under it, everything shrunk to fit a short window; `side` puts the
 * tray in a column beside the grid (the landscape phone layout).
 */
export function layoutBoard(state: State, availW: number, availH: number, vmin: number, side: boolean): BoardLayout {
  const { w, h } = state.grid;
  const n = state.tray.length;
  const inset = (PAD + BORDER) * 2;
  let slotW = Math.max(44, Math.min(84, Math.max(52, vmin * 0.12)));
  if (side) slotW = Math.max(40, Math.min(64, availH * 0.11));
  let panelW = Math.min(availW, vmin * 0.92, 600);
  for (let iter = 0; iter < 3; iter++) {
    if (side) {
      const trayCols = Math.max(1, Math.min(2, n));
      const trayW = trayCols * slotW + (trayCols - 1) * GAP;
      const gridAvailW = Math.min(availW - inset - TRAY_GAP - trayW, 600);
      const cellW = (gridAvailW - GAP * (w - 1)) / w;
      const cellH = (availH - inset - GAP * (h - 1)) / h;
      const cell = Math.max(24, Math.floor(Math.min(cellW, cellH)));
      const gridW = cell * w + GAP * (w - 1), gridH = cell * h + GAP * (h - 1);
      const trayRows = Math.ceil(n / trayCols);
      const slotH = slotW / 0.86;
      const trayH = trayRows * slotH + (trayRows - 1) * GAP;
      if (trayH > availH - inset && iter < 2) { slotW *= (availH - inset) / trayH; continue; }
      return { panelW: gridW + TRAY_GAP + trayW + inset, panelH: Math.max(gridH, trayH) + inset, cell, slotW, slotH, trayCols, trayRows, side };
    }
    const gridW0 = panelW - inset;
    const trayCols = Math.max(1, Math.min(n, Math.floor((gridW0 + GAP) / (slotW + GAP))));
    const trayRows = Math.ceil(n / trayCols);
    const slotH = slotW / 0.86;
    const trayH = trayRows * slotH + (trayRows - 1) * GAP + 6;
    const cellW = (gridW0 - GAP * (w - 1)) / w;
    const cellH = (availH - inset - TRAY_GAP - trayH - GAP * (h - 1)) / h;
    let cell = Math.floor(Math.min(cellW, cellH));
    if (cell < 30 && iter < 2) { slotW = Math.max(36, slotW * 0.75); continue; }
    cell = Math.max(24, cell);
    const gridW = cell * w + GAP * (w - 1), gridH = cell * h + GAP * (h - 1);
    if (gridW < gridW0) panelW = Math.max(gridW, Math.min(trayCols * (slotW + GAP), gridW0)) + inset;
    return { panelW, panelH: gridH + TRAY_GAP + trayH + inset, cell, slotW, slotH, trayCols, trayRows, side };
  }
  return { panelW, panelH: availH, cell: 24, slotW, slotH: slotW / 0.86, trayCols: 1, trayRows: n, side };
}

// --- descriptions --------------------------------------------------------------------------
function cardDescription(card: Card): string {
  const eff = effectiveEdges(card) as number[];
  const dirs = [N("{motif} north"), N("{motif} east"), N("{motif} south"), N("{motif} west")];
  return tr("card with {edges}", { edges: eff.map((m, d) => tr(dirs[d]!, { motif: tr(MOTIFS[m]!.name) })).join(", ") });
}

// --- drawing helpers ---------------------------------------------------------------------
const HC = (): boolean => ui.preferences().highContrast;
function seal(cx: number, cy: number, k: number, color: string): void {
  const r = 9 * k;
  const ring: [number, number][] = [];
  for (let i = 0; i < 18; i++) { const a = (i / 18) * Math.PI * 2; ring.push([cx + Math.cos(a) * r, cy + Math.sin(a) * r]); }
  draw.polygon(ring, color);
  const s = (14 / 16) * k;
  const pts: [number, number][] = [[-3, -1], [-3, -3]];
  for (let i = 1; i < 8; i++) { const a = Math.PI + (i / 8) * Math.PI; pts.push([Math.cos(a) * 3, -3 + Math.sin(a) * 3]); }
  pts.push([3, -3], [3, -1], [4, -1], [4, 5], [-4, 5], [-4, -1]);
  draw.polygon(pts.map(([x, y]) => [cx + x * s, cy + y * s] as [number, number]), "#ffffff");
}

/** A card filling (x, y, w, h) window pixels: face, border, edge motifs and the centre medallion, turned `q` quarter turns. */
function drawCard(x: number, y: number, w: number, h: number, card: Card, q: number, k: number, pal: Palette): void {
  const t = pal.theme;
  const hc = HC();
  const bw = (hc ? 3 : 2);
  const bg: ui.Fill[] = detailed && !hc
    ? [{ type: "linear", angle: 145, stops: [{ color: "#ffffff8c", at: 0 }, { color: "#ffffff00", at: 0.38 }, { color: "#00000000", at: 0.7 }, { color: "#0000000d", at: 1 }] }, t.cardFace]
    : [t.cardFace];
  draw.box(x, y, w, h, {
    background: bg,
    border: { width: bw, color: hc ? t.text : t.cardEdge },
    radius: 7,
    shadow: detailed ? [{ y: 1, blur: 1, color: "#0000002e" }, { y: 4, blur: 9, color: "#00000047" }, { y: 1, inset: true, color: "#ffffff99" }] : { y: 2, blur: 5, color: "#00000040" },
  });
  const f = Math.min(w, h) - bw * 2 * k;
  const cx = x + w / 2, cy = y + h / 2;
  const angle = (q * Math.PI) / 2;
  const m = Math.max(10 * k, Math.min(20 * k, f * 0.2));
  const edgeR = f / 2 - 1 * k - m / 2;
  const colors = pal.motifs;
  for (let d = 0; d < 4; d++) {
    const a = -Math.PI / 2 + d * (Math.PI / 2) + angle;
    const id = card.edges[d]!;
    drawMotif(id, cx + Math.cos(a) * edgeR, cy + Math.sin(a) * edgeR, m, angle, colors[id]!, t.cardFace);
  }
  const ringD = f * 0.44;
  if (ringD > 14 * k) {
    draw.box(cx - ringD / 2, cy - ringD / 2, ringD, ringD, { border: { width: 1.5, color: t.cardEdge }, radius: ringD / k });
    const mini = Math.min(8 * k, ringD * 0.22);
    const mr = ringD / 2 - 4.5 * k * (mini / (8 * k));
    for (let d = 0; d < 4; d++) {
      const a = -Math.PI / 2 + d * (Math.PI / 2) + angle;
      const id = card.edges[d]!;
      drawMotif(id, cx + Math.cos(a) * mr, cy + Math.sin(a) * mr, mini, angle, colors[id]!, t.cardFace);
    }
  }
  if (card.locked) seal(x + w - 3 * k, y + 3 * k, k, t.match);
}

function pulse(): number { return 0.5 - 0.5 * Math.cos(frame().time * Math.PI * 2); }

// --- the panel ---------------------------------------------------------------------------
/** Builds the panel at the current place in the UI (`L` from layoutBoard). */
export function buildBoard(L: BoardLayout): void {
  const s = session;
  if (!s) return;
  const state = s.state;
  const v = view();
  const pal = currentPalette();
  const t = pal.theme;
  const an = syncAnalysis(state);
  const busy = app.phase !== "active" || app.overlays.length > 0;
  const legal = new Set(v.legalCells);
  const lockable = new Set(v.lockableCells);
  const dt = Math.min(0.1, frame().delta);
  const rm = ui.preferences().reducedMotion;
  // the quarter turns ease toward the state's (0.18 s ease-out)
  for (const id of Object.keys(state.cards)) {
    const target = state.cards[id]!.rot;
    let cur: number = turn.get(id) ?? target;
    if (rm) cur = target;
    // turn forward the short way (rotations only add quarter turns)
    if (cur > target) cur = target;
    cur += (target - cur) * Math.min(1, dt * 18);
    if (Math.abs(target - cur) < 0.01) cur = target;
    turn.set(id, cur);
  }
  const flourish = Math.max(0, 1 - (frame().time - app.flourishAt) / 0.7);
  const glow = flourish > 0 && !rm ? Math.sin(Math.min(1, (1 - flourish) / 0.4) * Math.PI / 2) * (flourish < 0.6 ? flourish / 0.6 : 1) : 0;
  const panelStyle: ui.Style = {
    width: L.panelW, height: L.panelH,
    ...(detailed ? {
      background: [{ type: "radial", center: { x: 0.5, y: 0.35 }, stops: ["#ffffff12", "#ffffff00"] }, pal.feltPanel],
      shadow: [
        { y: 14, blur: 34, color: "#00000080" }, { y: 3, blur: 8, color: "#00000040" },
        { spread: 2, inset: true, color: pal.feltRim }, { blur: 40, inset: true, color: "#00000047" },
        ...(glow > 0 ? [{ blur: 20, spread: 2, color: mix(t.match, glow, "transparent") }] : []),
      ],
    } : glow > 0 ? { shadow: [{ y: 10, blur: 30, color: "#00000073" }, { spread: 2, inset: true, color: pal.feltRim }, { blur: 20, spread: 2, color: mix(t.match, glow, "transparent") }] } : {}),
  };
  const { w } = state.grid;
  const gridBlock = (): void => {
    ui.grid("board-grid", () => {
      for (let i = 0; i < state.cells.length; i++) cellWidget(i, state, L.cell, legal, lockable, an, busy, pal);
    }, { columns: Array.from({ length: w }, () => L.cell), gap: GAP });
  };
  const trayBlock = (): void => {
    ui.column("tray", () => {
      for (let r = 0; r < L.trayRows; r++) {
        ui.row(`tray-r${r}`, () => {
          for (let c = 0; c < L.trayCols; c++) {
            const i = r * L.trayCols + c;
            if (i < state.tray.length) trayWidget(i, state, L, busy, pal);
          }
        }, { spacing: GAP });
      }
    }, { spacing: GAP, align: "center", padding: { top: 6 } });
  };
  ui.style("felt-panel", panelStyle).id("board").column("board", () => {
    if (L.side) ui.row("board-row", () => { gridBlock(); trayBlock(); }, { spacing: TRAY_GAP, align: "center" });
    else { gridBlock(); trayBlock(); }
  }, { spacing: TRAY_GAP, align: "center", justify: "center" });
}

function cellWidget(i: number, state: State, size: number, legal: Set<number>, lockable: Set<number>, an: NonNullable<typeof analysis>, busy: boolean, pal: Palette): void {
  const cardId = state.cells[i];
  const card = cardId !== null && cardId !== undefined ? state.cards[cardId]! : null;
  const { x, y } = cellXY(state, i);
  let label = tr("Row {r} column {c}", { r: y + 1, c: x + 1 }) + ", ";
  if (!card) label += legal.has(i) ? tr("empty, legal placement") : tr("empty");
  else {
    label += cardDescription(card);
    if (card.locked) label += tr(", locked");
    else if (an.mismatch.has(i)) label += tr(", has mismatched edges");
  }
  const selected = round.selectedCell === i;
  const isHint = round.hint?.cell === i;
  const res = ui.id(`cell-${i}`).widget(label, {
    role: "button", size: { width: size, height: size }, disabled: busy,
    draw: (r, st) => {
      const k = st.scale;
      const t = pal.theme;
      const hc = st.highContrast;
      const rad = 10;
      const isLegal = !card && legal.has(i);
      if (isHint && !st.reducedMotion) draw.box(r.x, r.y, r.width, r.height, { radius: rad, shadow: { spread: 6 * pulse(), color: pal.hintGlow } });
      const fill = an.mismatch.has(i) ? pal.cellMismatch : isLegal ? pal.cellLegal : pal.cell;
      const borderColor = hc ? (isLegal ? t.select : t.text) : isLegal ? t.select : (card?.locked || lockable.has(i)) ? t.match : pal.cellBorder;
      draw.box(r.x, r.y, r.width, r.height, {
        background: fill, radius: rad,
        border: { width: hc ? 3 : 2, color: borderColor, ...(lockable.has(i) && !hc ? { style: "double" as const } : {}) },
        ...(detailed ? { shadow: { y: 2, blur: 6, inset: true, color: "#00000038" } } : {}),
      });
      // matched sides: 5 px bars inside the edge
      const links = an.links[i]!;
      const b = 5 * k;
      const clip = { clip: { x: r.x, y: r.y, width: r.width, height: r.height } };
      if (links.has(0)) draw.roundRect(r.x + 2 * k, r.y + 2 * k, r.width - 4 * k, b, 2 * k, t.match, clip);
      if (links.has(1)) draw.roundRect(r.x + r.width - 2 * k - b, r.y + 2 * k, b, r.height - 4 * k, 2 * k, t.match, clip);
      if (links.has(2)) draw.roundRect(r.x + 2 * k, r.y + r.height - 2 * k - b, r.width - 4 * k, b, 2 * k, t.match, clip);
      if (links.has(3)) draw.roundRect(r.x + 2 * k, r.y + 2 * k, b, r.height - 4 * k, 2 * k, t.match, clip);
      if (card) drawCard(r.x + 3 * k, r.y + 3 * k, r.width - 6 * k, r.height - 6 * k, card, turn.get(card.id) ?? card.rot, k, pal);
      if (selected) draw.strokeRoundRect(r.x - 4 * k, r.y - 4 * k, r.width + 8 * k, r.height + 8 * k, (rad + 4) * k, t.select, 3 * k);
      if (isHint && st.reducedMotion) draw.strokeRoundRect(r.x - 4 * k, r.y - 4 * k, r.width + 8 * k, r.height + 8 * k, (rad + 4) * k, t.select, 3 * k);
    },
  });
  if (res.activated && !busy) onCell(i);
}

function trayWidget(i: number, state: State, L: BoardLayout, busy: boolean, pal: Palette): void {
  const cardId = state.tray[i];
  const card = cardId !== null && cardId !== undefined ? state.cards[cardId]! : null;
  const selected = round.selectedTray === i;
  const isHint = round.hint?.tray === i;
  const rm = ui.preferences().reducedMotion;
  let l = lift.get(i) ?? 0;
  const want = selected ? 1 : 0;
  l = rm ? want : l + (want - l) * Math.min(1, Math.min(0.1, frame().delta) * 22);
  lift.set(i, l);
  const label = tr("Tray slot {n}", { n: i + 1 }) + ", " + (card ? cardDescription(card) : tr("empty"));
  const res = ui.id(`tray-${i}`).widget(label, {
    role: "button", size: { width: L.slotW, height: L.slotH }, disabled: busy || !card,
    draw: (r, st) => {
      const k = st.scale;
      const t = pal.theme;
      const dy = -6 * k * l;
      const x = r.x, y = r.y + dy, w = r.width, h = r.height;
      if (isHint && !st.reducedMotion) draw.box(x, y, w, h, { radius: 10, shadow: { spread: 6 * pulse(), color: pal.hintGlow } });
      draw.box(x, y, w, h, {
        background: card ? pal.traySlotBg : mix(pal.traySlotBg, 0.4, "transparent"), radius: 10,
        border: { width: st.highContrast ? 3 : 2, color: selected ? t.select : card ? pal.traySlotBorder : mix(pal.traySlotBorder, 0.4, "transparent") },
        ...(selected ? { shadow: { y: 4, blur: 10, color: "#0000004d" } } : {}),
      });
      if (card) drawCard(x + 3 * k, y + 3 * k, w - 6 * k, h - 6 * k, card, turn.get(card.id) ?? card.rot, k, pal);
      if (isHint && st.reducedMotion) draw.strokeRoundRect(x - 4 * k, y - 4 * k, w + 8 * k, h + 8 * k, 14 * k, t.select, 3 * k);
    },
  });
  if (res.activated && !busy && card) onTray(i);
}
