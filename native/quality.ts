// The look per graphics level. The engine-owned effects (shadows and their
// map size, ambient occlusion, bloom, the grade, anti-aliasing) are the
// level's own (levelSettings(): the same table every StarHermit game reads).
// The game's art (materials, the table's curve, props and textures, the dust
// and the window shimmer) is the browser build's four presets (js/gfx.js
// TABLE / BUDGETS) keyed by the level's quality tier, with the dust motes
// scaled within the tier by the level's particle budget against the tier's
// anchor level (quantum, molecular, terrestrial, galactic), at most twice.
// The runtime owns what the old Graphics panel did besides: Auto and the
// level choice, render scale and the pixel-ratio cap, adaptive resolution and
// the frame-rate limit and readout. The per-category overrides of the old
// panel are not offered (the runtime's Options choose a level).
import { levelSettings, type GraphicsLevel, type LevelSettings, type QualityTier } from "starhermit:engine";
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
  /** The level's key-light shadow map size, 0 when the level draws no shadows. */
  shadows: number;
  /** The level's ambient occlusion (null: off). */
  ao: { resolution: number; samples: number; denoiseSamples: number } | null;
  /** The level's bloom resolution as a fraction of the frame (null: off). */
  bloom: number | null;
  grade: boolean;
  antialias: AntialiasMode;
  /** Props, wood and felt textures, the wall backdrop, RoomEnvironment reflections, the felt panel's sheen. */
  detailed: boolean;
  /** Dust motes and the window light's shimmer. */
  ambient: boolean;
  budget: Budget;
}

type Art = Pick<Look, "detailed" | "ambient">;
const ART: Record<Preset, Art> = {
  low: { detailed: false, ambient: false },
  balanced: { detailed: true, ambient: true },
  high: { detailed: true, ambient: true },
  ultra: { detailed: true, ambient: true },
};
const BUDGETS: Record<Preset, Budget> = {
  low: { material: "lambert", tableCurve: 4, dust: 30 },
  balanced: { material: "standard", tableCurve: 8, dust: 45 },
  high: { material: "physical", tableCurve: 12, dust: 70 },
  ultra: { material: "physical", tableCurve: 16, dust: 90 },
};
export const MAX_DUST = 90;
/** Each tier's reference level: its budgets are tuned there. */
const ANCHOR: Record<Preset, GraphicsLevel> = { low: "quantum", balanced: "molecular", high: "terrestrial", ultra: "galactic" };

/** The look for a graphics level (the frame's by default). */
export function lookFor(s: LevelSettings = levelSettings()): Look {
  const preset = s.quality;
  // The dust grows with the level's particle budget above the tier's anchor,
  // at most twice the tier's budget.
  const k = Math.min(2, s.particles / levelSettings(ANCHOR[preset]).particles);
  const b = BUDGETS[preset];
  return {
    preset, ...ART[preset],
    shadows: s.shadows ? s.shadowMapSize : 0,
    ao: s.ao && { resolution: s.ao.resolution, samples: s.ao.samples, denoiseSamples: s.ao.denoiseSamples },
    bloom: s.bloom ? s.bloom.resolution : null,
    grade: s.grade,
    antialias: s.antialias,
    budget: { ...b, dust: Math.min(MAX_DUST, Math.round(b.dust * k)) },
  };
}
