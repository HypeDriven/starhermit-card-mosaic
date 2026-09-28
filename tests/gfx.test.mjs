// gfx.test.mjs — graphics quality model (js/gfx.js) and its string tables.
import assert from 'node:assert/strict';
import { test } from './helpers.mjs';
import {
  PRESETS, CATEGORIES, detectPreset, resolve, presetTier, choosePreset, migrateQuality, describe,
} from '../js/gfx.js';
import { GFX_STRINGS, gfxStrings } from '../js/gfx-strings.js';

test('detectPreset: software renderers get low', () => {
  assert.equal(detectPreset('ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE)), SwiftShader driver)'), 'low');
  assert.equal(detectPreset('llvmpipe (LLVM 15.0.7, 256 bits)'), 'low');
  assert.equal(detectPreset('Microsoft Basic Render Driver'), 'low');
});

test('detectPreset: discrete GPUs and Apple M get high, integrated balanced', () => {
  assert.equal(detectPreset('ANGLE (NVIDIA, NVIDIA GeForce RTX 3070 Direct3D11 vs_5_0 ps_5_0, D3D11)'), 'high');
  assert.equal(detectPreset('ANGLE (AMD, AMD Radeon RX 6800 XT Direct3D11 vs_5_0 ps_5_0)'), 'high');
  assert.equal(detectPreset('Apple M2'), 'high');
  assert.equal(detectPreset('ANGLE (Intel, Intel(R) UHD Graphics 620 Direct3D11 vs_5_0 ps_5_0)'), 'balanced');
  assert.equal(detectPreset('Mali-G78'), 'balanced');
  assert.equal(detectPreset(''), 'balanced');
});

test('detectPreset: mobile caps auto at balanced', () => {
  assert.equal(detectPreset('Apple M1', { mobile: true }), 'balanced');
  assert.equal(detectPreset('SwiftShader', { mobile: true }), 'low');
});

test('resolve: auto follows detected, explicit preset wins', () => {
  const a = resolve({}, 'low');
  assert.equal(a.preset, 'low');
  assert.equal(a.auto, true);
  assert.equal(a.post, false, 'low preset renders without a post chain');
  const h = resolve({ preset: 'high' }, 'low');
  assert.equal(h.preset, 'high');
  assert.equal(h.auto, false);
  assert.equal(h.shadows, presetTier('high', 'shadows'));
  assert.equal(h.post, true);
});

test('resolve: per-category overrides and invalid values', () => {
  const r = resolve({ preset: 'low', bloom: 'on', shadows: 'bogus' }, 'high');
  assert.equal(r.bloom, 'on');
  assert.equal(r.shadows, 'off', 'invalid tier falls back to the preset');
  assert.equal(r.post, true, 'bloom override needs the post chain');
  for (const [cat, tiers] of Object.entries(CATEGORIES)) {
    for (const p of PRESETS) assert.ok(tiers.includes(presetTier(p, cat)), `${p}.${cat}`);
  }
});

test('resolve: render scale clamps to 50–200%', () => {
  assert.equal(resolve({ preset: 'high', render_scale: 5 }, 'low').renderScale, 2);
  assert.equal(resolve({ preset: 'high', render_scale: 0.1 }, 'low').renderScale, 0.5);
  assert.equal(resolve({ preset: 'ultra', render_scale: 1 }, 'low').scale, 1.25);
  assert.equal(resolve({ preset: 'high' }, 'low').adaptive, true);
  assert.equal(resolve({ preset: 'high', adaptive: false, show_fps: true }, 'low').showFps, true);
});

test('choosePreset clears overrides but keeps scale/adaptive/fps', () => {
  const next = choosePreset({ preset: 'low', bloom: 'on', ao: 'high', render_scale: 1.5, show_fps: true }, 'ultra');
  assert.deepEqual(next, { preset: 'ultra', render_scale: 1.5, show_fps: true });
  assert.equal(choosePreset({}, 'nonsense').preset, 'auto');
});

test('migrateQuality maps legacy tiers', () => {
  assert.deepEqual(migrateQuality('low'), { preset: 'low' });
  assert.deepEqual(migrateQuality('medium'), { preset: 'balanced' });
  assert.deepEqual(migrateQuality('high'), { preset: 'auto' });
  assert.deepEqual(migrateQuality(undefined), { preset: 'auto' });
});

test('describe summarises cost', () => {
  assert.match(describe(resolve({ preset: 'low' }), [800, 600]), /no shadows.*no anti-aliasing.*800×600 px/);
  assert.match(describe(resolve({ preset: 'ultra' })), /4096² shadows.*full ambient occlusion.*bloom.*MSAA/);
});

test('graphics strings exist for every required locale and key', () => {
  const need = ['en-US', 'en-GB', 'es-419', 'es-ES', 'de-DE', 'fr-FR', 'fr-CA', 'pt-BR', 'it-IT'];
  const en = GFX_STRINGS['en-US'];
  const tierNames = new Set(Object.values(CATEGORIES).flat());
  for (const loc of need) {
    const T = GFX_STRINGS[loc];
    assert.ok(T, loc);
    for (const k of Object.keys(en)) assert.ok(T[k] !== undefined, `${loc}.${k}`);
    for (const p of PRESETS) assert.ok(T.presets[p], `${loc}.presets.${p}`);
    for (const c of Object.keys(CATEGORIES)) assert.ok(T.categories[c], `${loc}.categories.${c}`);
    for (const t of tierNames) assert.ok(T.tiers[t], `${loc}.tiers.${t}`);
    for (const k of Object.keys(en.sum)) assert.ok(T.sum[k], `${loc}.sum.${k}`);
  }
  assert.equal(gfxStrings('en'), GFX_STRINGS['en-US']);
  assert.equal(gfxStrings('fr-CA'), GFX_STRINGS['fr-CA']);
  assert.equal(gfxStrings('es-MX'), GFX_STRINGS['es-419']);
  assert.equal(gfxStrings('xx'), GFX_STRINGS['en-US']);
});
