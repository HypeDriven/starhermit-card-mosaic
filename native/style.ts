// The look of the menus, HUD and board: the browser build's style sheet,
// rewritten class-based in tools/ui-style.css and converted once with
// `starhermit css` into assets/ui-style.json (`npm run css`), registered at
// start. The browser build painted its colours from CSS custom properties
// the table theme set on <html> (themes.js themeCssVars) and mixed them with
// color-mix(); here the theme's colours and those mixes are tokens computed
// per theme and set with ui.setTokens, and the board (board.ts) reads the
// same palette. High contrast is the runtime's (it forces the UI's colours);
// the board draws its own high-contrast borders.
import { files } from "starhermit:engine";
import * as ui from "starhermit:ui";
import { getTheme, motifColors } from "../js/themes.js";

export type Theme = ReturnType<typeof getTheme>;

/** "#rrggbb" or "#rrggbbaa" → [r, g, b, a] 0–255. */
function rgba(hex: string): [number, number, number, number] {
  const h = hex.replace("#", "");
  const n = (i: number): number => parseInt(h.slice(i, i + 2), 16);
  return [n(0), n(2), n(4), h.length >= 8 ? n(6) : 255];
}
const hex2 = (v: number): string => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, "0");
/** CSS color-mix(in srgb, a k, b): `b` may be "transparent". */
export function mix(a: string, k: number, b: string): string {
  if (b === "transparent") {
    const [r, g, bl, al] = rgba(a);
    return `#${hex2(r)}${hex2(g)}${hex2(bl)}${hex2(al * k)}`;
  }
  const x = rgba(a), y = rgba(b);
  return `#${hex2(x[0] * k + y[0] * (1 - k))}${hex2(x[1] * k + y[1] * (1 - k))}${hex2(x[2] * k + y[2] * (1 - k))}`;
}

export interface Palette {
  theme: Theme;
  motifs: string[];
  feltPanel: string;
  feltBorder: string;
  feltRim: string;
  cellBorder: string;
  cell: string;
  cellLegal: string;
  cellMismatch: string;
  traySlotBorder: string;
  traySlotBg: string;
  hintGlow: string;
}

let palette: Palette = makePalette("studio", false);
export function currentPalette(): Palette { return palette; }

function makePalette(themeId: string, cvd: boolean): Palette {
  const t = getTheme(themeId);
  return {
    theme: t,
    motifs: motifColors(cvd),
    feltPanel: mix(t.felt, 0.92, "#000000"),
    feltBorder: mix(t.table, 0.8, "#000000"),
    feltRim: mix(t.felt, 0.6, "#ffffff"),
    cellBorder: mix(t.felt, 0.7, "#000000"),
    cell: mix(t.cellEmpty, 0.88, "transparent"),
    cellLegal: mix(t.cellEmpty, 0.7, t.select),
    cellMismatch: mix(t.cellEmpty, 0.6, t.invalid),
    traySlotBorder: mix(t.text, 0.3, "transparent"),
    traySlotBg: mix(t.cardFace, 0.45, "transparent"),
    hintGlow: mix(t.select, 0.65, "transparent"),
  };
}

function tokensFor(p: Palette): Record<string, string> {
  const t = p.theme;
  return {
    bg: t.bg, surface: t.surface, ink: t.ink, text: t.text, "text-soft": t.textSoft,
    accent: t.accent, "accent-dark": mix(t.accent, 0.7, "#000000"), select: t.select, invalid: t.invalid, match: t.match,
    card: t.cardFace, "card-edge": t.cardEdge, felt: t.felt, "felt-dark": p.feltPanel, "felt-border": p.feltBorder, "felt-rim": p.feltRim,
    topbar: mix(t.table, 0.88, "#000000"), "btn-border": mix(t.ink, 0.35, "transparent"), "soft-panel": mix(t.surface, 0.86, "transparent"),
    line: mix(t.text, 0.25, "transparent"), you: mix(t.select, 0.4, "transparent"), "topbar-ink": "#f4ead8",
  };
}

export function initStyles(): void {
  const css = files.readJson("assets/ui-style.json") as unknown as ui.CssStyles;
  ui.setTheme({
    fontSize: 16, smallSize: 13.6, headingSize: 24, padding: 8, spacing: 8, radius: 10,
    text: "#2c2620", muted: "#6b5f52", panel: "#e8ded0", control: "#f6efe3", hovered: "#efe4d2",
    pressed: "#e5d6c0", field: "#f6efe3", accent: "#c96f2e", focus: "#ffd166", outline: "#2c262059",
  });
  ui.setTokens(css.tokens);
  ui.setAnimations(css.animations);
  ui.setStyles({
    ...css.styles,
    label: { text: { color: "$text" } },
    paragraph: { text: { color: "$text" } },
    heading: { text: { color: "$text" } },
    widget: { focusRing: { color: "$select", width: 3, offset: 2 } },
    checkbox: {
      text: { color: "$text" }, minHeight: 44,
      parts: { box: { background: "$surface", border: { width: 2, color: "$btn-border" }, radius: 4 }, mark: { background: "$accent" } },
    },
    select: { text: { color: "$ink" }, background: "$surface", border: { width: 2, color: "$btn-border" }, radius: 10, minHeight: 44 },
    textField: { text: { color: "$ink" }, background: "$surface", border: { width: 2, color: "$btn-border" }, radius: 10, minHeight: 44, padding: { start: 10, end: 10 } },
    dialog: {
      background: "$bg", radius: 15, padding: 20, shadow: { y: 12, blur: 40, color: "#00000059" },
      parts: { backdrop: { background: "#00000073" } },
    },
    scrollArea: { parts: { bar: { background: "$text-soft", radius: 4 } } },
    tooltip: { background: "$text", text: { color: "$bg" }, radius: 6, padding: 6 },
  });
  applyTheme("studio", false);
}

let key = "";
/** The table theme's palette (colour-vision-safe motif colours with `cvd`). */
export function applyTheme(themeId: string, cvd: boolean): void {
  const k = `${themeId}:${cvd}`;
  if (k === key) return;
  key = k;
  palette = makePalette(themeId, cvd);
  ui.setTokens(tokensFor(palette));
}
