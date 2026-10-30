// The studio card table on starhermit:scene, as the browser build's
// js/render.js drew it: the lacquered table slab (an extruded rounded
// rectangle, wood-grain canvas texture at detailed quality), the felt inlay
// and the tray mat, the studio props (glazed mug, pencil, spare-card stack,
// brass desk lamp with its warm bulb and point light, the window-light patch),
// dust motes drifting in the window light, the backdrop's wall gradient,
// fog, key / fill / hemisphere lights per theme (the page's r160 values), per-material RoomEnvironment reflections
// and the post effects per graphics level. The camera frames the table into
// the play area the HUD rails leave (setViewOffset), at the authored 38°
// field of view and 55° elevation; an invalid move gives it a small shake, a
// completed mosaic a larger one, and a round that ends otherwise dims the
// table under a veil.
//
// The browser build's play layer (card, cell and tray meshes, selection
// rings, edge bars, sparkle particles) sat under the DOM felt panel and was
// never drawn (its camera disabled that layer; the particles were hidden by
// the panel): here the board is the panel itself (board.ts) and those meshes
// are not built.
import {
  ACESFilmicToneMapping, AdditiveBlending, BackSide, BoxGeometry, BufferAttribute, BufferGeometry, CanvasTexture, Color,
  ConeGeometry, CylinderGeometry, DirectionalLight, DoubleSide, ExtrudeGeometry, Fog, Group, HemisphereLight, Material,
  Mesh, MeshBasicMaterial, MeshLambertMaterial, MeshPhysicalMaterial, MeshStandardMaterial, PMREMGenerator,
  PerspectiveCamera, PlaneGeometry, PointLight, Points, PointsMaterial, RepeatWrapping, RoomEnvironment, SRGBColorSpace, OrthographicCamera,
  Shape, SphereGeometry, TorusGeometry, Vector3, renderer, scene, type Texture,
} from "starhermit:scene";
import { OffscreenCanvas } from "starhermit:canvas";
import { getTheme } from "../js/themes.js";
import { createRng } from "../js/rng.js";
import type { Look } from "./quality.ts";

type Theme = ReturnType<typeof getTheme>;
const PI = Math.PI;
const FRAMING = { fov: 38, elevationDeg: 55, fitMargin: 1.14, fitBoost: 1.4, trayBias: 0.2 };
const PITCH = 1.14;
const FELT_Y = 0.012;
const FELT_PAD = 0.55;
const TRAY_GAP = 0.75;
const TABLE_PAD = 1.7;
const TABLE_H = 0.34;
const TABLE_R = 0.55;
const TABLE_BEVEL = 0.05;
const CARD_SIZE = 0.98;
const FOG_NEAR_K = 0.9;
const FOG_FAR_K = 3.2;
const DUST_COUNT = 90;
/** RoomEnvironment reflections on PBR materials (the page's per-material envMapIntensity, × each prop's boost). */
const ENV_INTENSITY = 0.45;

const camera = new PerspectiveCamera(FRAMING.fov, 16 / 9, 0.1, 100);
renderer.camera = camera;
renderer.toneMapping = ACESFilmicToneMapping;

let theme: Theme = getTheme("studio");
let themeId = "studio";
let look: Look | null = null;
let reducedMotion = false;
let time = 0;

// --- lights (the page's three r160 intensities and shadow values, engine.minor 28) ---
const keyLight = new DirectionalLight(0xffffff, 1);
keyLight.position.set(4.5, 7.5, 3.5);
keyLight.shadow.bias = -0.0004;
keyLight.shadow.normalBias = 0.02;
const fillLight = new DirectionalLight(0xffffff, 1);
fillLight.position.set(-5, 4, -2.5);
const hemi = new HemisphereLight(0xffffff, 0x000000, 1);
scene.add(keyLight, keyLight.target, fillLight, fillLight.target, hemi);
scene.fog = new Fog(0xe8ded0, 8, 26);

// --- backdrop: the wall gradient (detailed) on a dome behind everything ---
const backdropCanvas = new OffscreenCanvas(16, 256);
const backdropTex = new CanvasTexture(backdropCanvas);
backdropTex.colorSpace = SRGBColorSpace;
const backdrop = new Mesh(new SphereGeometry(80, 24, 16), new MeshBasicMaterial({ map: backdropTex, side: BackSide, fog: false, depthWrite: false }));
backdrop.visible = false;
scene.add(backdrop);
function hexMix(a: string, b: string, k: number): string {
  const c = new Color(a).lerp(new Color(b), k);
  return "#" + c.getHex().toString(16).padStart(6, "0");
}
function paintBackdrop(): void {
  const g = backdropCanvas.getContext("2d");
  const grad = g.createLinearGradient(0, 0, 0, 256);
  grad.addColorStop(0, hexMix(theme.bg, theme.light.key, 0.25));
  grad.addColorStop(0.55, theme.bg);
  grad.addColorStop(1, hexMix(theme.bg, theme.tableEdge, 0.28));
  g.fillStyle = grad;
  g.fillRect(0, 0, 16, 256);
  backdropTex.needsUpdate = true;
}

// --- dust motes in the window light ---
const dustBase = new Float32Array(DUST_COUNT * 4);
const dustPos = new Float32Array(DUST_COUNT * 3);
{
  const rng = createRng("cm-dust");
  for (let i = 0; i < DUST_COUNT; i++) {
    const x = (rng.float() - 0.5) * 3.4, y = 0.3 + rng.float() * 2.6, z = (rng.float() - 0.5) * 2.4;
    dustBase.set([x, y, z, rng.float() * PI * 2], i * 4);
    dustPos.set([x, y, z], i * 3);
  }
}
const dustGeo = new BufferGeometry();
const dustAttr = new BufferAttribute(dustPos, 3);
dustGeo.setAttribute("position", dustAttr);
function dustTexture(): Texture {
  const c = new OffscreenCanvas(32, 32);
  const g = c.getContext("2d");
  const grd = g.createRadialGradient(16, 16, 0, 16, 16, 16);
  grd.addColorStop(0, "rgba(255,255,255,1)");
  grd.addColorStop(0.4, "rgba(255,255,255,0.35)");
  grd.addColorStop(1, "rgba(255,255,255,0)");
  g.fillStyle = grd;
  g.fillRect(0, 0, 32, 32);
  const t = new CanvasTexture(c);
  t.colorSpace = SRGBColorSpace;
  return t;
}
const dustMat = new PointsMaterial({ size: 0.05, map: dustTexture(), color: 0xffffff, transparent: true, opacity: 0.55, depthWrite: false, blending: AdditiveBlending, sizeAttenuation: true, fog: false });
const dust = new Points(dustGeo, dustMat);
dust.frustumCulled = false;
dust.visible = false;
scene.add(dust);

// --- per-table state ---
interface Layout { w: number; h: number; boardW: number; boardD: number; trayZ: number; trayN: number; tableW: number; tableD: number; tableCz: number }
let world: Group | null = null;
let lay: Layout | null = null;
let seed = "cm";
let lightPatch: Mesh | null = null;
let lampGlow: PointLight | null = null;
let props: Group | null = null;
let veil: Mesh | null = null;
let veilAnim: { t: number; dur: number } | null = null;
let shakeAmp = 0;
const camPos = new Vector3(0, 8, 8);
const camTarget = new Vector3();
let built = "";

// --- procedural textures ---
let woodTex: Texture | null = null;
let feltTex: Texture | null = null;
/** Warm wood grain, near-white so the theme colour still drives the hue. */
function makeWoodTexture(): Texture {
  const W = 512, H = 256;
  const c = new OffscreenCanvas(W, H);
  const ctx = c.getContext("2d");
  const rng = createRng("cm-wood");
  ctx.fillStyle = "#f2ece4";
  ctx.fillRect(0, 0, W, H);
  for (let i = 0; i < 140; i++) {
    const y0 = rng.float() * H;
    const amp = 2 + rng.float() * 6;
    const freq = 0.004 + rng.float() * 0.01;
    const ph = rng.float() * 6.28;
    const shade = Math.floor(170 + rng.float() * 60);
    ctx.strokeStyle = `rgba(${shade - 30},${shade - 45},${shade - 60},${0.08 + rng.float() * 0.16})`;
    ctx.lineWidth = 0.6 + rng.float() * 2.2;
    ctx.beginPath();
    for (let x = 0; x <= W; x += 8) {
      const y = y0 + Math.sin(x * freq * 6.28 + ph) * amp + Math.sin(x * 0.031 + ph) * 0.8;
      if (x === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.stroke();
  }
  for (let k = 0; k < 2; k++) {
    const kx = rng.float() * W, ky = rng.float() * H;
    for (let r = 18; r > 2; r -= 3) {
      ctx.strokeStyle = `rgba(120,90,60,${0.05 + (18 - r) * 0.006})`;
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.ellipse(kx, ky, r * 1.9, r * 0.7, 0, 0, PI * 2);
      ctx.stroke();
    }
  }
  const tex = new CanvasTexture(c);
  tex.colorSpace = SRGBColorSpace;
  tex.wrapS = tex.wrapT = RepeatWrapping;
  tex.repeat.set(1 / 4.5, 1 / 2.2);
  tex.anisotropy = 4;
  return tex;
}
/** Fine felt fibre noise. */
function makeFeltTexture(): Texture {
  const N = 128;
  const c = new OffscreenCanvas(N, N);
  const ctx = c.getContext("2d");
  const img = ctx.createImageData(N, N);
  const rng = createRng("cm-felt");
  for (let i = 0; i < N * N; i++) {
    const v = 226 + Math.floor(rng.float() * 29);
    img.data[i * 4] = img.data[i * 4 + 1] = img.data[i * 4 + 2] = v;
    img.data[i * 4 + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  const tex = new CanvasTexture(c);
  tex.colorSpace = SRGBColorSpace;
  tex.wrapS = tex.wrapT = RepeatWrapping;
  tex.repeat.set(4, 4);
  return tex;
}

function roundedRectShape(w: number, h: number, r: number): Shape {
  const s = new Shape();
  const x = -w / 2, y = -h / 2;
  s.moveTo(x + r, y);
  s.lineTo(x + w - r, y); s.absarc(x + w - r, y + r, r, -PI / 2, 0, false);
  s.lineTo(x + w, y + h - r); s.absarc(x + w - r, y + h - r, r, 0, PI / 2, false);
  s.lineTo(x + r, y + h); s.absarc(x + r, y + h - r, r, PI / 2, PI, false);
  s.lineTo(x, y + r); s.absarc(x + r, y + r, r, PI, PI * 1.5, false);
  return s;
}

interface LitParams { color?: string | number; map?: Texture | null; roughness?: number; metalness?: number; clearcoat?: number; clearcoatRoughness?: number }
/** Lit material for the level's budget: Lambert on Low, Standard on Balanced, Physical (clearcoat) above. */
function lit(p: LitParams): Material {
  const kind = look?.budget.material ?? "standard";
  const base = { color: p.color ?? 0xffffff, map: p.map ?? null };
  if (kind === "lambert") return new MeshLambertMaterial(base);
  if (kind === "physical" && p.clearcoat) {
    return new MeshPhysicalMaterial({ ...base, roughness: p.roughness ?? 1, metalness: p.metalness ?? 0, clearcoat: p.clearcoat, clearcoatRoughness: p.clearcoatRoughness ?? 0 });
  }
  return new MeshStandardMaterial({ ...base, roughness: p.roughness ?? 1, metalness: p.metalness ?? 0 });
}

/** Builds the table for a round's board (grid size and tray length), seeded props. */
export function load(content: { grid: { w: number; h: number }; traySize: number; seed: string }, nextTheme: string): void {
  themeId = nextTheme;
  theme = getTheme(themeId);
  seed = String(content.seed);
  const w = content.grid.w, h = content.grid.h;
  const boardW = (w - 1) * PITCH + 1;
  const boardD = (h - 1) * PITCH + 1;
  const trayZ = boardD / 2 + TRAY_GAP + 0.5;
  const trayN = content.traySize;
  const front = trayZ + 0.6;
  const tableW = Math.max(boardW, trayN * PITCH + 0.4) + TABLE_PAD * 2;
  const tz0 = -boardD / 2 - TABLE_PAD;
  const tz1 = front + TABLE_PAD;
  lay = { w, h, boardW, boardD, trayZ, trayN, tableW, tableD: tz1 - tz0, tableCz: (tz0 + tz1) / 2 };
  build();
}
/** The idle table behind menus (a 4 × 4 board, as the title's attract view). */
export function loadIdle(nextTheme: string): void {
  load({ grid: { w: 4, h: 4 }, traySize: 4, seed: "cm-title" }, nextTheme);
}

function build(): void {
  if (!lay || !look) return;
  const key = `${JSON.stringify(lay)}|${seed}|${look.budget.material}|${look.budget.tableCurve}|${look.detailed}`;
  if (world) { scene.remove(world); world = null; }
  built = key;
  const L = lay;
  const g = new Group();
  world = g;
  scene.add(g);
  const detailed = look.detailed;
  if (detailed && !woodTex) { woodTex = makeWoodTexture(); feltTex = makeFeltTexture(); }

  const mTable = lit({ color: theme.table, roughness: 0.62, clearcoat: 0.35, clearcoatRoughness: 0.4, map: detailed ? woodTex : null });
  const mTableSide = lit({ color: theme.tableEdge, roughness: 0.7, clearcoat: 0.25, clearcoatRoughness: 0.5, map: detailed ? woodTex : null });
  const tableGeo = new ExtrudeGeometry(roundedRectShape(L.tableW, L.tableD, TABLE_R), {
    depth: TABLE_H - TABLE_BEVEL * 2, bevelEnabled: true,
    bevelThickness: TABLE_BEVEL, bevelSize: TABLE_BEVEL * 0.8, bevelSegments: 2, curveSegments: look.budget.tableCurve,
  });
  const table = new Mesh(tableGeo, [mTable, mTableSide]);
  table.rotation.x = -PI / 2;
  table.position.set(0, -(TABLE_H - TABLE_BEVEL * 2) - TABLE_BEVEL, L.tableCz);
  table.receiveShadow = true;
  g.add(table);

  const mFeltLine = lit({ color: theme.feltLine, roughness: 0.95 });
  const feltLine = new Mesh(new PlaneGeometry(L.boardW + FELT_PAD * 2 + 0.12, L.boardD + FELT_PAD * 2 + 0.12), mFeltLine);
  feltLine.rotation.x = -PI / 2;
  feltLine.position.y = FELT_Y - 0.006;
  g.add(feltLine);
  const mFelt = lit({ color: theme.felt, roughness: 0.95, map: detailed ? feltTex : null });
  const felt = new Mesh(new PlaneGeometry(L.boardW + FELT_PAD * 2, L.boardD + FELT_PAD * 2), mFelt);
  felt.rotation.x = -PI / 2;
  felt.position.y = FELT_Y;
  felt.receiveShadow = true;
  g.add(felt);
  const mTray = lit({ color: theme.cellInlay, roughness: 0.9, map: detailed ? feltTex : null });
  const trayMat = new Mesh(new PlaneGeometry(L.trayN * PITCH + 0.5, 1.45), mTray);
  trayMat.rotation.x = -PI / 2;
  trayMat.position.set(0, FELT_Y - 0.003, L.trayZ);
  trayMat.receiveShadow = true;
  g.add(trayMat);

  props = new Group();
  props.visible = detailed;
  g.add(props);
  buildProps(props);

  veil = new Mesh(new PlaneGeometry(L.tableW, L.tableD), new MeshBasicMaterial({ color: theme.bg, transparent: true, opacity: 0, depthWrite: false }));
  veil.rotation.x = -PI / 2;
  veil.position.set(0, FELT_Y + 0.15, L.tableCz);
  veil.visible = false;
  veilAnim = null;
  g.add(veil);

  dust.position.set(-(L.tableW / 2 - TABLE_PAD * 0.55) * 0.55, 0, L.tableCz - L.tableD / 2 + TABLE_PAD * 0.5 + 1.1);
  applyThemeLights();
  computeFraming();
  applyEnv();
}

function buildProps(group: Group): void {
  const L = lay!;
  const rng = createRng(seed).fork("cosmetic");
  const t = theme;
  const sideX = L.tableW / 2 - TABLE_PAD * 0.55;
  const backZ = L.tableCz - L.tableD / 2 + TABLE_PAD * 0.5;
  const add = (o: Group, x: number, z: number, ry?: number): void => {
    o.position.x = x; o.position.z = z;
    if (ry !== undefined) o.rotation.y = ry;
    group.add(o);
  };
  const std = (color: string | number, rough = 0.85): Material => new MeshStandardMaterial({ color, roughness: rough });

  // mug (left of the board), glazed ceramic catching the room reflections
  const mug = new Group();
  const mugMat = look!.budget.material === "lambert" ? new MeshLambertMaterial({ color: t.accentSoft })
    : new MeshPhysicalMaterial({ color: t.accentSoft, roughness: 0.45, clearcoat: 0.8, clearcoatRoughness: 0.15 });
  mugMat.userData.envBoost = 1.4;
  const cup = new Mesh(new CylinderGeometry(0.26, 0.22, 0.5, 20), mugMat);
  cup.position.y = 0.25;
  cup.castShadow = true;
  const handle = new Mesh(new TorusGeometry(0.15, 0.035, 8, 16, PI), mugMat);
  handle.position.set(0.27, 0.27, 0);
  handle.rotation.z = -PI / 2;
  mug.add(cup, handle);
  add(mug, -sideX + rng.float() * 0.3 - 0.15, -L.boardD / 2 + 0.4 + rng.float() * 1.2, rng.float() * PI * 2);

  // pencil (right of the board, lying flat)
  const pencil = new Group();
  const shaft = new Mesh(new CylinderGeometry(0.035, 0.035, 1.5, 8), std(t.accent, 0.7));
  shaft.rotation.z = PI / 2;
  shaft.position.y = 0.035;
  shaft.castShadow = true;
  const tip = new Mesh(new ConeGeometry(0.035, 0.14, 8), std(t.cardEdge, 0.7));
  tip.rotation.z = -PI / 2;
  tip.position.set(0.82, 0.035, 0);
  pencil.add(shaft, tip);
  add(pencil, sideX - rng.float() * 0.3, L.trayZ - 0.4 + rng.float() * 0.8, rng.float() * 0.9 - 0.45);

  // stacked spare cards (back right)
  const stack = new Group();
  const nStack = rng.intRange(2, 4);
  const stackMat = std(t.cardEdge, 0.9);
  const stackTop = std(t.cardBack, 0.85);
  for (let i = 0; i < nStack; i++) {
    const card = new Mesh(new BoxGeometry(CARD_SIZE, 0.045, CARD_SIZE), i === nStack - 1 ? stackTop : stackMat);
    card.position.y = 0.024 + i * 0.048;
    card.rotation.y = (rng.float() - 0.5) * 0.22;
    card.castShadow = true;
    stack.add(card);
  }
  add(stack, sideX - 0.1 - rng.float() * 0.2, backZ + 0.5 + rng.float() * 0.4, rng.float() * 0.6 - 0.3);

  // brass desk lamp (back left) with a warm emissive bulb that blooms
  const lamp = new Group();
  const brass = new MeshStandardMaterial({ color: "#b8893c", metalness: 0.85, roughness: 0.32 });
  brass.userData.envBoost = 2;
  const base = new Mesh(new CylinderGeometry(0.3, 0.34, 0.07, 28), brass);
  base.position.y = 0.035;
  base.castShadow = true;
  const arm1 = new Mesh(new CylinderGeometry(0.03, 0.03, 1.25, 10), brass);
  arm1.position.set(0.18, 0.62, 0);
  arm1.rotation.z = -0.3;
  arm1.castShadow = true;
  const arm2 = new Mesh(new CylinderGeometry(0.028, 0.028, 0.8, 10), brass);
  arm2.position.set(0.62, 1.28, 0);
  arm2.rotation.z = 1.05;
  arm2.castShadow = true;
  const shade = new Mesh(new ConeGeometry(0.26, 0.36, 28, 1, true), new MeshStandardMaterial({ color: "#b8893c", metalness: 0.85, roughness: 0.3, side: DoubleSide }));
  (shade.material as Material).userData.envBoost = 2;
  shade.position.set(0.98, 1.36, 0);
  shade.rotation.z = 0.55;
  shade.castShadow = true;
  const bulb = new Mesh(new SphereGeometry(0.1, 16, 12), new MeshStandardMaterial({ color: "#fff2d6", emissive: "#ffd89a", emissiveIntensity: 3.2, roughness: 0.4 }));
  bulb.position.set(1.05, 1.24, 0);
  lampGlow = new PointLight(t.light.key, 1.6, 4.5, 2);
  lampGlow.position.set(1.08, 1.1, 0);
  lamp.add(base, arm1, arm2, shade, bulb, lampGlow);
  add(lamp, -sideX + 0.05, backZ + 0.05, -0.55);

  // window-light patch on the table (soft additive plane, back left)
  lightPatch = new Mesh(new PlaneGeometry(2.6, 1.8), new MeshBasicMaterial({ color: t.light.key, transparent: true, opacity: 0.09, blending: AdditiveBlending, depthWrite: false }));
  lightPatch.rotation.x = -PI / 2;
  lightPatch.rotation.z = 0.3 + rng.float() * 0.3;
  lightPatch.position.set(-sideX * 0.6, 0.004, backZ + 0.9);
  group.add(lightPatch);
}

function applyThemeLights(): void {
  const t = theme;
  renderer.toneMappingExposure = t.exposure;
  scene.background = new Color(t.bg);
  (scene.fog as Fog).color.set(t.fog);
  keyLight.color.set(t.light.key);
  keyLight.intensity = t.light.keyIntensity;
  fillLight.color.set(t.light.fill);
  fillLight.intensity = t.light.fillIntensity;
  hemi.color.set(t.light.key);
  hemi.groundColor.set(t.table);
  hemi.intensity = t.light.ambient;
  dustMat.color.set(t.light.key);
  if (lampGlow) lampGlow.color.set(t.light.key);
  paintBackdrop();
}

/** Theme change: rebuild the table in the new colours. */
export function setTheme(next: string): void {
  if (next === themeId) return;
  themeId = next;
  theme = getTheme(next);
  if (lay) build(); else applyThemeLights();
}
export function currentTheme(): string { return themeId; }

let envTex: Texture | null = null;
/** r160 scaled scene.environment by each material's envMapIntensity; the engine (as r163+) does not, so
 * each standard material takes the room as its own envMap at the page's intensity (detailed only). */
function applyEnv(): void {
  scene.environment = null;
  world?.traverse((o) => {
    const mm = (o as Mesh).material as unknown;
    for (const m of Array.isArray(mm) ? mm : [mm]) if (m instanceof MeshStandardMaterial) {
      m.envMap = look?.detailed ? envTex : null;
      m.envMapIntensity = ENV_INTENSITY * (Number(m.userData.envBoost) || 1);
    }
  });
}
/** The look for the frame's graphics level; cheap when nothing changed. */
export function applyLook(next: Look): void {
  if (look && JSON.stringify(look) === JSON.stringify(next)) return;
  look = next;
  const shadows = next.shadows > 0;
  renderer.shadowMap.enabled = shadows;
  keyLight.castShadow = shadows;
  if (shadows) keyLight.shadow.mapSize = next.shadows;
  if (next.detailed) {
    if (!envTex) {
      try { const envRoom = new RoomEnvironment(renderer); envRoom.position.y = 0; /* the page's three (pre-r183) builds the room at the origin */ envTex = new PMREMGenerator(renderer).fromScene(envRoom, 0.04).texture; }
      catch (e) { console.warn("environment:", e instanceof Error ? e.message : String(e)); }
    }
  }
  applyEnv();
  backdrop.visible = next.detailed;
  dust.visible = next.ambient;
  dustGeo.setDrawRange(0, next.budget.dust);
  renderer.ao = next.ao === "off" ? null : {
    blendIntensity: 0.75, radius: 0.5, distanceExponent: 1.5, thickness: 1.0, scale: 1.0,
    samples: next.ao === "high" ? 16 : 8,
    denoise: { lumaPhi: 10, depthPhi: 2, normalPhi: 3, radius: next.ao === "high" ? 6 : 4, rings: 2, samples: next.ao === "high" ? 16 : 8, radiusExponent: 2 },
  };
  // High threshold: only the lamp bulb and bright highlights bloom.
  // The page's r160 UnrealBloomPass at its own strength (bloom model r160).
  renderer.bloom = next.bloom ? { model: "r160", strength: 0.5, radius: 0.5, threshold: 0.9, resolution: 0.5 } : null;
  // The browser build's grade pass: a gentle S-curve (0.18), saturation 1.07,
  // cool shadows / warm highlights, the 0.2 vignette.
  renderer.grade = next.grade ? {
    space: "display", contrastCurve: "s", contrast: 0.18, saturation: 1.07,
    shadows: [0.97, 0.985, 1.03], highlights: [1.035, 1.0, 0.965], split: [0.2, 0.8],
    vignette: { amount: 0.2, inner: 0.38, outer: 0.85 },
  } : null;
  renderer.antialias = next.antialias;
  if (lay) build(); else applyThemeLights();
}

export function setReducedMotion(on: boolean): void {
  reducedMotion = on;
  if (on) shakeAmp = 0;
}

// --- events ---
/** An invalid move: a restrained shake. */
export function invalid(): void { if (!reducedMotion) shakeAmp = Math.max(shakeAmp, 0.018); }
/** The round ended: a completed mosaic nudges the camera, any other end dims the table. */
export function terminal(complete: boolean): void {
  if (complete) { if (!reducedMotion) shakeAmp = Math.max(shakeAmp, 0.05); return; }
  if (!veil) return;
  (veil.material as MeshBasicMaterial).color.set(theme.bg);
  veil.visible = true;
  veilAnim = { t: 0, dur: reducedMotion ? 0.3 : 1.1 };
}
/** A new round: no veil. */
export function clearVeil(): void {
  veilAnim = null;
  if (veil) { veil.visible = false; (veil.material as MeshBasicMaterial).opacity = 0; }
}

// --- framing ---
let view = { x: 0, y: 0, w: 1, h: 1, W: 1, H: 1 };
/** The play area (window pixels) the table is framed into, within the W × H window. */
export function setPlayfield(x: number, y: number, w: number, h: number, W: number, H: number): void {
  const next = { x, y, w: Math.max(1, w), h: Math.max(1, h), W: Math.max(1, W), H: Math.max(1, H) };
  if (Object.entries(next).every(([k, v]) => Math.abs(v - (view as Record<string, number>)[k]!) < 0.5)) return;
  view = next;
  camera.aspect = view.w / view.h;
  camera.setViewOffset(view.w, view.h, -view.x, -view.y, view.W, view.H);
  camera.updateProjectionMatrix();
  computeFraming();
}
function computeFraming(): void {
  if (!lay) return;
  const L = lay;
  const aspect = view.w / view.h;
  const spanW = Math.max(L.tableW * 0.82, L.boardW + 1.2);
  const spanD = (L.trayZ + 0.7) + L.boardD / 2;
  const vfov = (FRAMING.fov * PI) / 180;
  const hfov = 2 * Math.atan(Math.tan(vfov / 2) * aspect);
  const distH = (spanW / 2) / Math.tan(hfov / 2);
  const distV = ((spanD * 0.62) / 2) / Math.tan(vfov / 2);
  const dist = Math.max(distH, distV) * FRAMING.fitMargin + FRAMING.fitBoost;
  const el = (FRAMING.elevationDeg * PI) / 180;
  const targetZ = (L.trayZ - L.boardD / 2) * FRAMING.trayBias * 0.5;
  camTarget.set(0, 0, targetZ);
  camPos.set(0, Math.sin(el) * dist, targetZ + Math.cos(el) * dist);
  camera.far = dist * 4 + 20;
  const fog = scene.fog as Fog;
  fog.near = dist * FOG_NEAR_K;
  fog.far = dist * FOG_FAR_K;
  // key light shadow frustum covers the table (the page's box)
  const s = Math.max(L.tableW, L.tableD) / 2 + 1;
  const sc = keyLight.shadow.camera as OrthographicCamera;
  sc.left = -s; sc.right = s; sc.top = s; sc.bottom = -s;
  sc.near = 1; sc.far = 30;
  sc.updateProjectionMatrix();
  keyLight.target.position.set(0, 0, L.tableCz);
  backdrop.position.copy(camTarget);
}

/** Each frame: dust, the light patch's shimmer, the veil, the camera with its decaying shake. */
export function update(dt: number): void {
  dt = Math.min(0.1, Math.max(0, dt));
  time += dt;
  if (dust.visible && !reducedMotion) {
    for (let i = 0; i < DUST_COUNT; i++) {
      const ph = dustBase[i * 4 + 3]!;
      dustPos[i * 3] = dustBase[i * 4]! + Math.sin(time * 0.13 + ph) * 0.25;
      dustPos[i * 3 + 1] = dustBase[i * 4 + 1]! + Math.sin(time * 0.09 + ph * 1.7) * 0.18;
      dustPos[i * 3 + 2] = dustBase[i * 4 + 2]! + Math.cos(time * 0.11 + ph) * 0.2;
    }
    dustAttr.needsUpdate = true;
    if (lightPatch) (lightPatch.material as MeshBasicMaterial).opacity = 0.085 + Math.sin(time * 0.4) * 0.012 + Math.sin(time * 1.3) * 0.006;
  }
  if (veilAnim && veil) {
    veilAnim.t += dt;
    const k = Math.min(1, veilAnim.t / veilAnim.dur);
    (veil.material as MeshBasicMaterial).opacity = k * 0.45;
    if (k >= 1) veilAnim = null;
  }
  camera.position.copy(camPos);
  if (shakeAmp > 0.0005 && !reducedMotion) {
    camera.position.x += Math.sin(time * 37) * shakeAmp;
    camera.position.y += Math.sin(time * 53) * shakeAmp * 0.6;
    camera.position.z += Math.sin(time * 43) * shakeAmp * 0.4;
    shakeAmp *= Math.exp(-3 * dt);
  } else shakeAmp = 0;
  camera.lookAt(camTarget);
}

/** For tests and checks: what is built. */
export function builtKey(): string { return built; }
