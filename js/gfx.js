// gfx.js — graphics quality model: presets, per-category overrides, GPU
// detection and a cost summary. Pure (no three.js, no DOM), so the settings
// panel, the renderer and the node tests agree on what a setting means.

export const PRESETS = ['low', 'balanced', 'high', 'ultra'];

// Category → allowed tiers, cheapest first.
export const CATEGORIES = {
  shadows: ['off', 'low', 'medium', 'high'],
  ao: ['off', 'on', 'high'],
  bloom: ['off', 'on'],
  grade: ['off', 'on'],
  antialias: ['off', 'fxaa', 'smaa', 'msaa'],
  particles: ['low', 'high'],
  detail: ['plain', 'detailed'],
  ambient: ['off', 'on'],
};

// Each preset is a row of tiers, a device-pixel-ratio cap and a render scale
// (the scale multiplies the capped device pixel ratio).
const TABLE = {
  low: { cap: 1, scale: 1, shadows: 'off', ao: 'off', bloom: 'off', grade: 'off', antialias: 'off', particles: 'low', detail: 'plain', ambient: 'off' },
  balanced: { cap: 1.5, scale: 1, shadows: 'low', ao: 'off', bloom: 'on', grade: 'on', antialias: 'fxaa', particles: 'high', detail: 'detailed', ambient: 'on' },
  high: { cap: 2, scale: 1, shadows: 'medium', ao: 'on', bloom: 'on', grade: 'on', antialias: 'smaa', particles: 'high', detail: 'detailed', ambient: 'on' },
  ultra: { cap: 2, scale: 1.25, shadows: 'high', ao: 'high', bloom: 'on', grade: 'on', antialias: 'msaa', particles: 'high', detail: 'detailed', ambient: 'on' },
};

export const SHADOW_MAP = { off: 0, low: 1024, medium: 2048, high: 4096 };
export const PARTICLE_CAP = { low: 500, high: 2000 };

// Auto picks the preset from the StarHermit hardware level (0 = Galaxy S20 / Intel UHD, 20 = RTX 5090;
// gpu-level.js → window.StarHermitGpu): Low from 0, Balanced from 4, High from 10, Ultra from 17.
// Phones, tablets and ≤ 4 GB machines are capped at level 9 (Balanced); software renderers are level 0.
export const PRESET_LEVELS = { low: 0, balanced: 4, high: 10, ultra: 17 };

function gpuApi() { return globalThis.StarHermitGpu; }

/** Hardware level (0–20) for an unmasked renderer string plus StarHermitGpu.detectSystem() facts. */
export function detectLevel(gpu, system) {
  const G = gpuApi();
  if (!G) return PRESET_LEVELS.balanced;
  return G.detectLevel({ ...(system || {}), gpu: String(gpu || '') });
}

/** The preset Auto starts from for a hardware level. */
export function presetForLevel(level) {
  const G = gpuApi();
  if (G) return G.presetForLevel(level, PRESET_LEVELS);
  return level >= 17 ? 'ultra' : level >= 10 ? 'high' : level >= 4 ? 'balanced' : 'low';
}

/** Best preset for this GPU (the level already caps phones/tablets at Balanced). */
export function detectPreset(gpu, system) {
  return presetForLevel(detectLevel(gpu, system));
}

/** Scale a count tuned at the preset's floor level up for faster GPUs (≤ 4×, never below the floor budget). */
export function scaleCount(n, preset, level) {
  const G = gpuApi();
  const floor = PRESET_LEVELS[preset] || 0;
  return Math.round(G ? G.scaleBudget(n, Math.max(Number(level) || 0, floor), floor) : n);
}

/**
 * Per-preset asset and effect budget. Each preset is tuned to hold 60 FPS on the weakest GPU Auto gives
 * it (Low → hardware level 0, Balanced → 4, High → 10, Ultra → 17; measured with tests/gfx-bench.mjs).
 *   material     'lambert' (table, felt, cards) | 'standard' | 'physical' (clearcoat lacquered table);
 *   cardTexture  card-face canvas edge in px (motif art is painted at this size);
 *   cardCurve / cardBevel  card corner curve and bevel segments; tableCurve = table corner segments;
 *   particles    sparkle budget at the floor level (the Particles tier still caps it);
 *   dust         ambient dust motes drawn (Ambient on).
 * Counts scale up within the preset on faster GPUs (StarHermitGpu.scaleBudget, ≤ 4×, never below the floor).
 */
export const BUDGETS = {
  low: { material: 'lambert', cardTexture: 128, cardCurve: 3, cardBevel: 1, tableCurve: 4, particles: 250, dust: 30 },
  balanced: { material: 'standard', cardTexture: 256, cardCurve: 6, cardBevel: 2, tableCurve: 8, particles: 500, dust: 45 },
  high: { material: 'physical', cardTexture: 512, cardCurve: 8, cardBevel: 3, tableCurve: 12, particles: 1000, dust: 70 },
  ultra: { material: 'physical', cardTexture: 512, cardCurve: 12, cardBevel: 4, tableCurve: 16, particles: 1500, dust: 90 },
};
export const MAX_DUST = 90;

/** A preset's concrete budget for a hardware level. */
export function budgetFor(preset, level) {
  const b = { ...(BUDGETS[preset] || BUDGETS.balanced) };
  b.particles = Math.min(PARTICLE_CAP.high, scaleCount(b.particles, preset, level));
  b.dust = Math.min(MAX_DUST, scaleCount(b.dust, preset, level));
  return b;
}

/** Legacy `settings.graphics.quality` (low/medium/high) → saved gfx object. */
export function migrateQuality(quality) {
  if (quality === 'low') return { preset: 'low' };
  if (quality === 'medium') return { preset: 'balanced' };
  return { preset: 'auto' };
}

/**
 * Resolve saved settings into concrete tiers.
 * `saved`: { preset: 'auto'|preset, render_scale, adaptive, show_fps, <category>: 'preset'|tier }.
 */
export function resolve(saved, detected, level) {
  const s = saved || {};
  const auto = !PRESETS.includes(s.preset);
  const preset = auto ? (PRESETS.includes(detected) ? detected : 'balanced') : s.preset;
  const row = TABLE[preset];
  const renderScale = clamp(Number(s.render_scale) || 1, 0.5, 2);
  const out = { preset, auto, cap: row.cap, renderScale, scale: row.scale * renderScale };
  for (const [cat, tiers] of Object.entries(CATEGORIES)) {
    out[cat] = tiers.includes(s[cat]) ? s[cat] : row[cat];
  }
  out.budget = budgetFor(preset, level);
  out.adaptive = s.adaptive !== false;
  out.showFps = !!s.show_fps;
  // Post-processing runs only when something needs it; MSAA alone uses the canvas.
  out.post = out.ao !== 'off' || out.bloom === 'on' || out.grade === 'on' || out.antialias === 'fxaa' || out.antialias === 'smaa';
  return out;
}

/** Saved object after the player picks a preset: overrides are cleared. */
export function choosePreset(saved, preset) {
  const s = saved || {};
  const out = { preset: PRESETS.includes(preset) ? preset : 'auto' };
  if (s.render_scale !== undefined) out.render_scale = s.render_scale;
  if (s.adaptive !== undefined) out.adaptive = s.adaptive;
  if (s.show_fps !== undefined) out.show_fps = s.show_fps;
  return out;
}

/** The preset's own tier for a category (for "From preset (…)" labels). */
export function presetTier(preset, cat) {
  return TABLE[preset]?.[cat];
}

/** Short English cost summary; the UI swaps in localized words where it can. */
export function describe(r, pixels) {
  const parts = [
    r.shadows === 'off' ? 'no shadows' : `${SHADOW_MAP[r.shadows]}² shadows`,
    r.ao === 'off' ? null : r.ao === 'high' ? 'full ambient occlusion' : 'ambient occlusion',
    r.bloom === 'on' ? 'bloom' : null,
    r.grade === 'on' ? 'colour grade' : null,
    r.antialias === 'off' ? 'no anti-aliasing' : r.antialias.toUpperCase(),
    pixels ? `${pixels[0]}×${pixels[1]} px` : null,
  ];
  return parts.filter(Boolean).join(' · ');
}

function clamp(v, a, b) {
  return Math.min(b, Math.max(a, v));
}
