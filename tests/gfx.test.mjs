// gfx.test.mjs — graphics quality model (js/gfx.js) and its string tables.
import '../js/gpu-level.js'; // window.StarHermitGpu (globalThis in Node)
import assert from 'node:assert/strict';
import { test } from './helpers.mjs';
import {
  PRESETS, CATEGORIES, detectPreset, detectLevel, presetForLevel, BUDGETS, resolve, presetTier, choosePreset, migrateQuality, describe,
} from '../js/gfx.js';
import { GFX_STRINGS, gfxStrings } from '../js/gfx-strings.js';

const desk = { webgl: true, webgl2: true, cores: 8, memoryGb: 8 };
const phone = { webgl: true, webgl2: true, mobile: true, cores: 8, memoryGb: 8 };

test('hardware level → preset: Low 0, Balanced 4, High 10, Ultra 17', () => {
  assert.equal(detectPreset('ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE)), SwiftShader driver)', desk), 'low');
  assert.equal(detectLevel('llvmpipe (LLVM 15.0.7, 256 bits)', desk), 0);
  assert.equal(detectPreset('ANGLE (AMD, AMD Radeon(TM) Graphics Direct3D11 vs_5_0 ps_5_0)', desk), 'low');
  assert.equal(detectPreset('ANGLE (Intel, Intel(R) UHD Graphics 620 Direct3D11)', desk), 'low');
  assert.equal(detectPreset('ANGLE (Intel, Intel(R) Iris(R) Xe Graphics Direct3D11)', desk), 'balanced');
  assert.equal(detectPreset('ANGLE (NVIDIA, NVIDIA GeForce GTX 1070 Direct3D11 vs_5_0 ps_5_0)', desk), 'high');
  assert.equal(detectPreset('ANGLE (NVIDIA, NVIDIA GeForce RTX 4080 Direct3D11 vs_5_0 ps_5_0)', desk), 'ultra');
  assert.equal(detectLevel('ANGLE (NVIDIA, NVIDIA GeForce RTX 5090 Direct3D11 vs_5_0 ps_5_0)', desk), 20);
  assert.equal(detectPreset('ANGLE (NVIDIA, NVIDIA GeForce RTX 5090 Direct3D11 vs_5_0 ps_5_0)', desk), 'ultra');
  assert.equal(detectPreset('', desk), 'balanced');
  assert.equal(presetForLevel(3), 'low');
  assert.equal(presetForLevel(16), 'high');
});

test('phones and tablets are capped at Balanced; software GPUs stay Low', () => {
  assert.equal(detectPreset('Adreno (TM) 740', phone), 'balanced');
  assert.ok(detectLevel('Adreno (TM) 740', phone) <= 9);
  assert.equal(detectPreset('NVIDIA GeForce RTX 5090', phone), 'balanced');
  assert.equal(detectPreset('Mali-G77', phone), 'low');
  assert.equal(detectPreset('SwiftShader', phone), 'low');
});

test('every preset has an explicit budget that grows from Low to Ultra and scales with the level', () => {
  const order = ['low', 'balanced', 'high', 'ultra'];
  const keys = ['material', 'cardTexture', 'cardCurve', 'cardBevel', 'tableCurve', 'particles', 'dust'];
  for (const p of order) for (const k of keys) assert.ok(BUDGETS[p][k] != null, `${p}.${k}`);
  for (let i = 1; i < order.length; i++) {
    for (const k of keys) if (typeof BUDGETS.low[k] === 'number') assert.ok(BUDGETS[order[i]][k] >= BUDGETS[order[i - 1]][k], `${order[i]}.${k}`);
  }
  const u17 = resolve({ preset: 'ultra' }, 'ultra', 17).budget;
  assert.deepEqual(resolve({ preset: 'ultra' }, 'low', 0).budget, u17, 'a manual Ultra on a weak GPU keeps the Ultra floor budget');
  const l0 = resolve({ preset: 'low' }, 'low', 0).budget, l3 = resolve({ preset: 'low' }, 'low', 3).budget;
  for (const k of keys) if (typeof l0[k] === 'number') assert.ok(l3[k] >= l0[k], `low.${k} scales up with the level`);
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
