// The look per graphics level: the browser build's four presets and budgets
// (js/gfx.js TABLE / BUDGETS, each tuned to hold 60 FPS on the weakest GPU
// Auto gave it) keyed by the runtime's quality tier (frame().quality), with
// the dust motes scaled within the tier by the level (frame().levelIndex), as
// the browser build scaled them by its hardware level. The runtime owns the
// rest of what the old Graphics panel did: Auto and the level choice, render
// scale and the pixel-ratio cap, adaptive resolution, the frame-rate limit
// and readout, and the shadow-map size and MSAA samples it holds to the
// level. The per-category overrides of the old panel are not offered (the
// runtime's Options choose a level).
import type { QualityTier } from "starhermit:engine";
import type { AntialiasMode } from "starhermit:scene";

export type Preset = QualityTier;
export interface Budget {
  /** Table, felt and props: Lambert, standard PBR, or physical (clearcoat lacquer). */
  material: "lambert" | "standard" | "physical";
  /** Table corner curve segments. */
  tableCurve: number;
  /** Dust motes drawn (ambient on). */
  dust: number;
}
export interface Look {
  preset: Preset;
  shadows: 0 | 1024 | 2048 | 4096;
  ao: "off" | "on" | "high";
  bloom: boolean;
  grade: boolean;
  antialias: AntialiasMode;
  /** Props, wood and felt textures, the wall backdrop, RoomEnvironment reflections, the felt panel's sheen. */
  detailed: boolean;
  /** Dust motes and the window light's shimmer. */
  ambient: boolean;
  budget: Budget;
}

const TABLE: Record<Preset, Omit<Look, "preset" | "budget">> = {
  low: { shadows: 0, ao: "off", bloom: false, grade: false, antialias: "off", detailed: false, ambient: false },
  balanced: { shadows: 1024, ao: "off", bloom: true, grade: true, antialias: "fxaa", detailed: true, ambient: true },
  high: { shadows: 2048, ao: "on", bloom: true, grade: true, antialias: "smaa", detailed: true, ambient: true },
  ultra: { shadows: 4096, ao: "high", bloom: true, grade: true, antialias: "msaa", detailed: true, ambient: true },
};
const BUDGETS: Record<Preset, Budget> = {
  low: { material: "lambert", tableCurve: 4, dust: 30 },
  balanced: { material: "standard", tableCurve: 8, dust: 45 },
  high: { material: "physical", tableCurve: 12, dust: 70 },
  ultra: { material: "physical", tableCurve: 16, dust: 90 },
};
export const MAX_DUST = 90;
/** The first level index of each tier (quantum, molecular, terrestrial, galactic). */
const TIER_FLOOR: Record<Preset, number> = { low: 0, balanced: 2, high: 4, ultra: 7 };

/** The look for a quality tier at a level index (0 quantum … 9 infinite). */
export function lookFor(preset: Preset, levelIndex: number): Look {
  const b = { ...BUDGETS[preset] };
  // Levels are about 1.64× apart in GPU throughput: the dust grows with the
  // level above the tier's first, at most twice the tier's budget.
  const k = Math.min(2, Math.pow(1.64, Math.max(0, levelIndex - TIER_FLOOR[preset])));
  b.dust = Math.min(MAX_DUST, Math.round(b.dust * k));
  return { preset, ...TABLE[preset], budget: b };
}
