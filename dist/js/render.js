// render.js — Three.js presentation layer for Card Mosaic.
// An illustrated card table in a quiet studio. This layer only mirrors logical
// truth from rules.js; all animation is cosmetic and settleable via
// skipAnimations(). Imports 'three' via the host page import map (r160).

import * as THREE from 'three';
import { getTheme, motifColors } from './themes.js';
import { paintCardFace } from './motifs.js';
import { analyzeBoard } from './rules.js';
import { createRng } from './rng.js';

// ---------------------------------------------------------------------------
// layers
// ---------------------------------------------------------------------------
const LAYER_ENV = 0;    // table, props, window light
const LAYER_PLAY = 1;   // cells, tray, cards  (raycast targets live here)
const LAYER_UI = 2;     // selection rings, glows, edge bars, ghost
const LAYER_FX = 3;     // particles, flashes (never raycastable)

// ---------------------------------------------------------------------------
// authored framing + board metrics (world units; no magic numbers inline)
// ---------------------------------------------------------------------------
const FRAMING = {
  fov: 38,            // authored perspective, low distortion
  elevationDeg: 55,   // look-down angle toward the tabletop
  fitMargin: 1.14,    // breathing room multiplier on fit distance
  fitBoost: 1.4,      // constant added to fit distance
  trayBias: 0.2,      // pull the look-at point toward the tray by this fraction
};
const PITCH = 1.14;          // cell center spacing
const CARD_SIZE = 0.98;      // card footprint
const CARD_H = 0.09;         // card thickness
const CARD_BEVEL = 0.02;
const CARD_RADIUS = 0.09;
const CELL_VISUAL = 1.07;    // cell inlay footprint
const FELT_Y = 0.012;        // felt surface height above table top
const FELT_PAD = 0.55;       // felt border around the board
const TRAY_GAP = 0.75;       // gap between board front edge and tray row
const TABLE_PAD = 1.7;       // table border around the play area
const TABLE_H = 0.34;
const TABLE_R = 0.55;
const TABLE_BEVEL = 0.05;
const SELECT_LIFT = 0.16;    // selected tray card lift
const GHOST_H = 0.42;        // drag ghost hover height
const FLY_ARC = 1.05;        // place/recall arc apex height
const TEX_SIZE = 256;        // card face texture px
const FOG_NEAR_K = 0.9;      // fog near = camera distance * k
const FOG_FAR_K = 3.2;

// input thresholds: movement beyond TAP_MAX_PX starts a drag, otherwise a tap
const TAP_MAX_PX = 6;
const TAP_MAX_MS = 250;

// vfx budgets
const PARTICLES_HIGH = 2000;
const PARTICLES_LOW = 500;
const EVENT_GAP = 0.12;      // seconds between queued event animations

const QUALITY = {
  low:    { pixelRatio: 1,   shadows: false, aa: false, particles: PARTICLES_LOW,  props: false },
  medium: { pixelRatio: 1.5, shadows: true,  aa: true,  particles: PARTICLES_HIGH, props: true  },
  high:   { pixelRatio: 2,   shadows: true,  aa: true,  particles: PARTICLES_HIGH, props: true  },
};

// ---------------------------------------------------------------------------
// small helpers
// ---------------------------------------------------------------------------
const clamp01 = (k) => (k < 0 ? 0 : k > 1 ? 1 : k);
const easeOutCubic = (k) => 1 - Math.pow(1 - k, 3);
const easeInOutCubic = (k) => (k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2);
const easeOutBack = (k) => { const c = 1.70158; return 1 + (c + 1) * Math.pow(k - 1, 3) + c * Math.pow(k - 1, 2); };

function roundedRectShape(w, h, r) {
  const s = new THREE.Shape();
  const x = -w / 2, y = -h / 2;
  s.moveTo(x + r, y);
  s.lineTo(x + w - r, y); s.absarc(x + w - r, y + r, r, -Math.PI / 2, 0, false);
  s.lineTo(x + w, y + h - r); s.absarc(x + w - r, y + h - r, r, 0, Math.PI / 2, false);
  s.lineTo(x + r, y + h); s.absarc(x + r, y + h - r, r, Math.PI / 2, Math.PI, false);
  s.lineTo(x, y + r); s.absarc(x + r, y + r, r, Math.PI, Math.PI * 1.5, false);
  return s;
}

function enableAllLayers(obj) {
  obj.layers.enable(LAYER_ENV);
  obj.layers.enable(LAYER_PLAY);
  obj.layers.enable(LAYER_UI);
  obj.layers.enable(LAYER_FX);
}

// ---------------------------------------------------------------------------
export class Renderer {
  /** true iff WebGL is available; never throws. */
  static isSupported() {
    try {
      const c = document.createElement('canvas');
      const gl = c.getContext('webgl2') || c.getContext('webgl') || c.getContext('experimental-webgl');
      return !!gl;
    } catch (_) {
      return false;
    }
  }

  constructor({ container, canvas, onIntent, settings = {} }) {
    if (!container || !canvas) throw new Error('Renderer: container and canvas are required');
    this._container = container;
    this._canvas = canvas;
    this._onIntent = typeof onIntent === 'function' ? onIntent : () => {};
    this._quality = QUALITY[settings.quality] ? settings.quality : 'medium';
    this._reducedMotion = !!settings.reducedMotion;
    this._cvd = !!settings.cvd;
    this._themeId = settings.theme || 'studio';
    this._theme = getTheme(this._themeId);

    let renderer;
    try {
      renderer = new THREE.WebGLRenderer({
        canvas,
        antialias: QUALITY[this._quality].aa,
        alpha: false,
        powerPreference: 'high-performance',
      });
    } catch (err) {
      throw new Error('Renderer: WebGL context creation failed: ' + ((err && err.message) || err));
    }
    this._renderer = renderer;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = this._theme.exposure;
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.shadowMap.enabled = QUALITY[this._quality].shadows;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;

    // scene + camera
    this._scene = new THREE.Scene();
    this._scene.background = new THREE.Color(this._theme.bg);
    this._scene.fog = new THREE.Fog(this._theme.fog, 8, 26);
    this._camera = new THREE.PerspectiveCamera(FRAMING.fov, 1, 0.1, 100);
    enableAllLayers(this._camera);
    this._camPos = new THREE.Vector3(0, 8, 8);       // authored base position
    this._camTarget = new THREE.Vector3(0, 0, 0);    // authored base target
    this._camTargetCur = new THREE.Vector3();
    this._camAnim = null;                            // {t,dur,fromPos,fromTar}
    this._shakeAmp = 0;
    this._shakeOff = new THREE.Vector3();

    // lights (per theme.light)
    const L = this._theme.light;
    this._keyLight = new THREE.DirectionalLight(L.key, L.keyIntensity);
    this._keyLight.position.set(4.5, 7.5, 3.5);
    this._keyLight.castShadow = QUALITY[this._quality].shadows;
    this._keyLight.shadow.mapSize.set(2048, 2048);
    this._keyLight.shadow.bias = -0.0004;
    enableAllLayers(this._keyLight);
    this._fillLight = new THREE.DirectionalLight(L.fill, L.fillIntensity);
    this._fillLight.position.set(-5, 4, -2.5);
    enableAllLayers(this._fillLight);
    this._hemi = new THREE.HemisphereLight(L.key, this._theme.table, L.ambient);
    enableAllLayers(this._hemi);
    this._scene.add(this._keyLight, this._fillLight, this._hemi);

    // persistent shared geometries (disposed only in dispose())
    this._geo = {
      glow: new THREE.PlaneGeometry(CELL_VISUAL + 0.1, CELL_VISUAL + 0.1),
      ring: new THREE.RingGeometry(0.55, 0.64, 40),
      bar: new THREE.PlaneGeometry(PITCH * 0.92, 0.13),
      seal: new THREE.CircleGeometry(0.17, 24),
      face: new THREE.PlaneGeometry(CARD_SIZE - 0.05, CARD_SIZE - 0.05),
      flash: new THREE.RingGeometry(0.32, 0.5, 40),
      ghost: new THREE.PlaneGeometry(CARD_SIZE, CARD_SIZE),
    };

    // per-load state
    this._world = null;
    this._built = false;
    this._disposed = false;
    this._loadResources = [];   // everything created by load(): {dispose()}
    this._cards = new Map();    // id -> cardObj
    this._cells = [];           // {mesh, glow, ring}
    this._traySlots = [];       // {mesh, glow, ring}
    this._bars = [];            // edge status bars
    this._pickList = [];
    this._m = null;             // named per-load materials
    this._content = null;
    this._state = null;
    this._meta = {};
    this._layout = null;
    this._syncMatched = 0;
    this._prevSyncMatched = 0;
    this._lastEventMatched = -1;

    // animation timeline
    this._anims = [];
    this._queueTime = 0;
    this._flashes = [];
    this._flashPool = [];

    // temps (no per-frame allocations)
    this._tv1 = new THREE.Vector3();
    this._tv2 = new THREE.Vector3();
    this._tv3 = new THREE.Vector3();
    this._tv4 = new THREE.Vector3();
    this._ndc = new THREE.Vector2();
    this._color = new THREE.Color();
    this._pose = { x: 0, y: 0, z: 0, yaw: 0, loc: 'none', index: -1 };
    this._raycaster = new THREE.Raycaster();
    this._raycaster.layers.set(LAYER_PLAY);
    this._dragPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -GHOST_H);

    // particles (persistent pool)
    this._pCap = QUALITY[this._quality].particles;
    this._buildParticles();

    // drag ghost (persistent; face texture assigned on drag)
    this._ghost = new THREE.Mesh(
      this._geo.ghost,
      new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.85, depthWrite: false })
    );
    this._ghost.rotation.x = -Math.PI / 2;
    this._ghost.visible = false;
    this._ghost.layers.set(LAYER_UI);
    this._scene.add(this._ghost);

    // terminal veil + invalid flash (persistent)
    this._veil = new THREE.Mesh(
      this._geo.glow,
      new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false })
    );
    this._veil.rotation.x = -Math.PI / 2;
    this._veil.visible = false;
    this._veil.layers.set(LAYER_UI);
    this._scene.add(this._veil);

    // pointer state
    this._ptr = null;

    // bound handlers
    this._onPointerDown = (e) => this._pointerDown(e);
    this._onPointerMove = (e) => this._pointerMove(e);
    this._onPointerUp = (e) => this._pointerUp(e);
    this._onPointerCancel = (e) => this._pointerCancel(e);
    this._onVisibility = () => {
      this._hidden = document.hidden;
      if (!this._hidden) this._lastT = performance.now(); // resume cleanly, no dt spike
    };
    this._onResize = () => this.resize();
    canvas.addEventListener('pointerdown', this._onPointerDown);
    canvas.addEventListener('pointermove', this._onPointerMove);
    canvas.addEventListener('pointerup', this._onPointerUp);
    canvas.addEventListener('pointercancel', this._onPointerCancel);
    canvas.addEventListener('lostpointercapture', this._onPointerCancel);
    document.addEventListener('visibilitychange', this._onVisibility);
    window.addEventListener('resize', this._onResize);
    if (typeof ResizeObserver !== 'undefined') {
      this._ro = new ResizeObserver(this._onResize);
      this._ro.observe(container);
    }

    // loop
    this._hidden = document.hidden;
    this._running = true;
    this._lastT = performance.now();
    this._time = 0;
    this._fps = 60;
    this._raf = requestAnimationFrame((t) => this._tick(t));

    this.resize();
  }

  // -------------------------------------------------------------------------
  // particles: one pooled Points system
  // -------------------------------------------------------------------------
  _buildParticles() {
    const max = PARTICLES_HIGH;
    this._pMax = max;
    this._pPos = new Float32Array(max * 3);
    this._pCol = new Float32Array(max * 3);
    this._pVel = new Float32Array(max * 3);
    this._pBase = new Float32Array(max * 3);
    this._pLife = new Float32Array(max);
    this._pMaxLife = new Float32Array(max);
    this._pGrav = new Float32Array(max);
    this._pCursor = 0;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(this._pPos, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('color', new THREE.BufferAttribute(this._pCol, 3).setUsage(THREE.DynamicDrawUsage));
    const m = new THREE.PointsMaterial({
      size: 0.07, vertexColors: true, transparent: true, depthWrite: false,
      blending: THREE.AdditiveBlending, sizeAttenuation: true,
    });
    this._points = new THREE.Points(g, m);
    this._points.frustumCulled = false;
    this._points.layers.set(LAYER_FX);
    this._scene.add(this._points);
    // park everything far below
    for (let i = 0; i < max; i++) this._pPos[i * 3 + 1] = -999;
  }

  _burst(x, y, z, colorHex, count, spread, up, grav) {
    if (this._reducedMotion) count = Math.max(1, Math.floor(count * 0.25));
    this._color.set(colorHex);
    const cap = Math.min(this._pCap, this._pMax);
    for (let n = 0; n < count; n++) {
      // find a dead slot (rotating cursor, bounded scan)
      let idx = -1;
      for (let s = 0; s < cap; s++) {
        const i = (this._pCursor + s) % cap;
        if (this._pLife[i] <= 0) { idx = i; break; }
      }
      if (idx < 0) return;
      this._pCursor = (idx + 1) % cap;
      const i3 = idx * 3;
      this._pPos[i3] = x; this._pPos[i3 + 1] = y; this._pPos[i3 + 2] = z;
      const a = Math.random() * Math.PI * 2;
      const r = Math.random() * spread;
      this._pVel[i3] = Math.cos(a) * r;
      this._pVel[i3 + 1] = up * (0.5 + Math.random());
      this._pVel[i3 + 2] = Math.sin(a) * r;
      const jitter = 0.75 + Math.random() * 0.35;
      this._pBase[i3] = this._color.r * jitter;
      this._pBase[i3 + 1] = this._color.g * jitter;
      this._pBase[i3 + 2] = this._color.b * jitter;
      this._pMaxLife[idx] = 0.6 + Math.random() * 0.7;
      this._pLife[idx] = this._pMaxLife[idx];
      this._pGrav[idx] = grav;
    }
  }

  _stepParticles(dt) {
    const cap = Math.min(this._pCap, this._pMax);
    let any = false;
    for (let i = 0; i < cap; i++) {
      if (this._pLife[i] <= 0) continue;
      any = true;
      this._pLife[i] -= dt;
      const i3 = i * 3;
      if (this._pLife[i] <= 0) {
        this._pCol[i3] = this._pCol[i3 + 1] = this._pCol[i3 + 2] = 0;
        continue;
      }
      this._pVel[i3 + 1] -= this._pGrav[i] * dt;
      this._pPos[i3] += this._pVel[i3] * dt;
      this._pPos[i3 + 1] += this._pVel[i3 + 1] * dt;
      this._pPos[i3 + 2] += this._pVel[i3 + 2] * dt;
      const f = this._pLife[i] / this._pMaxLife[i];
      this._pCol[i3] = this._pBase[i3] * f;
      this._pCol[i3 + 1] = this._pBase[i3 + 1] * f;
      this._pCol[i3 + 2] = this._pBase[i3 + 2] * f;
    }
    if (any) {
      this._points.geometry.attributes.position.needsUpdate = true;
      this._points.geometry.attributes.color.needsUpdate = true;
    }
  }

  _killParticles() {
    this._pLife.fill(0);
    this._pCol.fill(0);
    this._points.geometry.attributes.color.needsUpdate = true;
  }

  // -------------------------------------------------------------------------
  // load: full scene rebuild from a content doc
  // -------------------------------------------------------------------------
  load(content, themeId) {
    if (this._disposed) return;
    this._clearLoad();
    if (themeId) this._themeId = themeId;
    this._theme = getTheme(this._themeId);
    this._content = content;
    this._state = null;
    this._meta = {};
    this._syncMatched = 0;
    this._prevSyncMatched = 0;
    this._lastEventMatched = -1;

    const R = this._loadResources;
    const track = (res) => { R.push(res); return res; };
    const world = this._world = new THREE.Group();
    this._scene.add(world);

    const w = content.grid.w, h = content.grid.h;
    const boardW = (w - 1) * PITCH + 1;
    const boardD = (h - 1) * PITCH + 1;
    const trayZ = boardD / 2 + TRAY_GAP + 0.5;
    const trayN = content.traySize;
    const front = trayZ + 0.6;
    const tableW = Math.max(boardW, trayN * PITCH + 0.4) + TABLE_PAD * 2;
    const tz0 = -boardD / 2 - TABLE_PAD;
    const tz1 = front + TABLE_PAD;
    const tableD = tz1 - tz0;
    const tableCz = (tz0 + tz1) / 2;
    this._layout = { w, h, boardW, boardD, trayZ, trayN, tableW, tableD, tableCz };

    // -- table slab ----------------------------------------------------------
    const mTable = track(new THREE.MeshStandardMaterial({ color: this._theme.table, roughness: 0.85 }));
    const mTableSide = track(new THREE.MeshStandardMaterial({ color: this._theme.tableEdge, roughness: 0.9 }));
    const tableGeo = track(new THREE.ExtrudeGeometry(roundedRectShape(tableW, tableD, TABLE_R), {
      depth: TABLE_H - TABLE_BEVEL * 2, bevelEnabled: true,
      bevelThickness: TABLE_BEVEL, bevelSize: TABLE_BEVEL * 0.8, bevelSegments: 2, curveSegments: 8,
    }));
    const table = new THREE.Mesh(tableGeo, [mTable, mTableSide]);
    table.rotation.x = -Math.PI / 2;
    table.position.set(0, -(TABLE_H - TABLE_BEVEL * 2) - TABLE_BEVEL, tableCz);
    table.receiveShadow = true;
    table.layers.set(LAYER_ENV);
    world.add(table);

    // -- felt inlay ----------------------------------------------------------
    const mFeltLine = track(new THREE.MeshStandardMaterial({ color: this._theme.feltLine, roughness: 0.95 }));
    const feltLine = new THREE.Mesh(track(new THREE.PlaneGeometry(boardW + FELT_PAD * 2 + 0.12, boardD + FELT_PAD * 2 + 0.12)), mFeltLine);
    feltLine.rotation.x = -Math.PI / 2;
    feltLine.position.y = FELT_Y - 0.006;
    feltLine.layers.set(LAYER_ENV);
    world.add(feltLine);
    const mFelt = track(new THREE.MeshStandardMaterial({ color: this._theme.felt, roughness: 0.95 }));
    const felt = new THREE.Mesh(track(new THREE.PlaneGeometry(boardW + FELT_PAD * 2, boardD + FELT_PAD * 2)), mFelt);
    felt.rotation.x = -Math.PI / 2;
    felt.position.y = FELT_Y;
    felt.receiveShadow = true;
    felt.layers.set(LAYER_ENV);
    world.add(felt);

    // -- cell texture (shared by cells + tray slots) --------------------------
    this._cellTex = track(this._makeCellTexture());
    const mCell = track(new THREE.MeshStandardMaterial({ map: this._cellTex, roughness: 0.95 }));

    // -- board cells ----------------------------------------------------------
    const cellGeo = track(new THREE.PlaneGeometry(CELL_VISUAL, CELL_VISUAL));
    this._cells = [];
    for (let i = 0; i < w * h; i++) {
      const mesh = new THREE.Mesh(cellGeo, mCell);
      mesh.rotation.x = -Math.PI / 2;
      this._cellPos(i, mesh.position);
      mesh.position.y = FELT_Y + 0.003;
      mesh.receiveShadow = true;
      mesh.layers.set(LAYER_PLAY);
      mesh.userData.intent = { kind: 'cell', cell: i };
      world.add(mesh);

      const glow = new THREE.Mesh(this._geo.glow, track(new THREE.MeshBasicMaterial({
        transparent: true, opacity: 0, depthWrite: false,
      })));
      glow.rotation.x = -Math.PI / 2;
      glow.position.set(mesh.position.x, FELT_Y + 0.006, mesh.position.z);
      glow.visible = false;
      glow.layers.set(LAYER_UI);
      world.add(glow);

      const ring = new THREE.Mesh(this._geo.ring, track(new THREE.MeshBasicMaterial({
        transparent: true, opacity: 0.9, depthWrite: false, side: THREE.DoubleSide,
      })));
      ring.rotation.x = -Math.PI / 2;
      ring.position.set(mesh.position.x, FELT_Y + 0.008, mesh.position.z);
      ring.visible = false;
      ring.layers.set(LAYER_UI);
      world.add(ring);

      this._cells.push({ mesh, glow, ring });
      this._pickList.push(mesh);
    }

    // -- tray ----------------------------------------------------------------
    const mTray = track(new THREE.MeshStandardMaterial({ color: this._theme.cellInlay, roughness: 0.9 }));
    const trayMat = new THREE.Mesh(track(new THREE.PlaneGeometry(trayN * PITCH + 0.5, 1.45)), mTray);
    trayMat.rotation.x = -Math.PI / 2;
    trayMat.position.set(0, FELT_Y - 0.003, trayZ);
    trayMat.receiveShadow = true;
    trayMat.layers.set(LAYER_ENV);
    world.add(trayMat);

    this._traySlots = [];
    for (let i = 0; i < trayN; i++) {
      const mesh = new THREE.Mesh(cellGeo, mCell);
      mesh.rotation.x = -Math.PI / 2;
      this._trayPos(i, mesh.position);
      mesh.position.y = FELT_Y + 0.003;
      mesh.receiveShadow = true;
      mesh.layers.set(LAYER_PLAY);
      mesh.userData.intent = { kind: 'tray', tray: i };
      world.add(mesh);

      const glow = new THREE.Mesh(this._geo.glow, track(new THREE.MeshBasicMaterial({
        transparent: true, opacity: 0, depthWrite: false,
      })));
      glow.rotation.x = -Math.PI / 2;
      glow.position.set(mesh.position.x, FELT_Y + 0.006, mesh.position.z);
      glow.visible = false;
      glow.layers.set(LAYER_UI);
      world.add(glow);

      const ring = new THREE.Mesh(this._geo.ring, track(new THREE.MeshBasicMaterial({
        transparent: true, opacity: 0.9, depthWrite: false, side: THREE.DoubleSide,
      })));
      ring.rotation.x = -Math.PI / 2;
      ring.position.set(mesh.position.x, FELT_Y + 0.008, mesh.position.z);
      ring.visible = false;
      ring.layers.set(LAYER_UI);
      world.add(ring);

      this._traySlots.push({ mesh, glow, ring });
      this._pickList.push(mesh);
    }

    // -- edge status bars (pool sized to adjacency count) ---------------------
    const pairCount = (w - 1) * h + w * (h - 1);
    this._bars = [];
    for (let i = 0; i < pairCount; i++) {
      const bar = new THREE.Mesh(this._geo.bar, track(new THREE.MeshBasicMaterial({
        transparent: true, opacity: 0, depthWrite: false,
      })));
      bar.visible = false;
      bar.layers.set(LAYER_UI);
      world.add(bar);
      this._bars.push(bar);
    }

    // -- cards ----------------------------------------------------------------
    const cardGeo = track(new THREE.ExtrudeGeometry(roundedRectShape(CARD_SIZE, CARD_SIZE, CARD_RADIUS), {
      depth: CARD_H - CARD_BEVEL * 2, bevelEnabled: true,
      bevelThickness: CARD_BEVEL, bevelSize: CARD_BEVEL * 0.7, bevelSegments: 2, curveSegments: 6,
    }));
    cardGeo.translate(0, 0, -(CARD_H - CARD_BEVEL * 2) / 2);
    const mBody = track(new THREE.MeshStandardMaterial({ color: this._theme.cardEdge, roughness: 0.8 }));
    const mBack = track(new THREE.MeshStandardMaterial({ color: this._theme.cardBack, roughness: 0.85 }));
    const mSeal = track(new THREE.MeshBasicMaterial({ color: this._theme.accent, transparent: true, opacity: 0.95, depthWrite: false }));

    this._cards = new Map();
    const colors = motifColors(this._cvd);
    for (const c of content.cards) {
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = TEX_SIZE;
      paintCardFace(canvas, c.edges, colors, { face: this._theme.cardFace, frame: this._theme.cardEdge });
      const texture = track(new THREE.CanvasTexture(canvas));
      texture.colorSpace = THREE.SRGBColorSpace;
      texture.anisotropy = 4;
      const faceMat = track(new THREE.MeshStandardMaterial({ map: texture, roughness: 0.85 }));

      const group = new THREE.Group();
      const body = new THREE.Mesh(cardGeo, mBody);
      body.rotation.x = -Math.PI / 2;
      body.castShadow = true;
      body.receiveShadow = true;
      body.layers.set(LAYER_PLAY);
      body.userData.intent = { kind: 'none', cell: -1, tray: -1 };
      body.userData.cardId = c.id;

      const face = new THREE.Mesh(this._geo.face, faceMat);
      face.rotation.x = -Math.PI / 2;
      face.position.y = CARD_H / 2 + 0.002;
      face.layers.set(LAYER_PLAY);

      const back = new THREE.Mesh(this._geo.face, mBack);
      back.rotation.x = Math.PI / 2;
      back.position.y = -CARD_H / 2 - 0.002;
      back.layers.set(LAYER_PLAY);

      const seal = new THREE.Mesh(this._geo.seal, mSeal);
      seal.rotation.x = -Math.PI / 2;
      seal.position.set(CARD_SIZE * 0.29, CARD_H / 2 + 0.006, -CARD_SIZE * 0.29);
      seal.visible = false;
      seal.layers.set(LAYER_PLAY);

      group.add(body, face, back, seal);
      group.visible = false;
      world.add(group);
      this._cards.set(c.id, { id: c.id, edges: c.edges.slice(), canvas, texture, faceMat, group, body, face, back, seal });
      this._pickList.push(body);
    }

    // -- studio props (deterministic cosmetic stream) -------------------------
    this._props = new THREE.Group();
    this._props.visible = QUALITY[this._quality].props;
    world.add(this._props);
    this._buildProps(this._props, track);

    this._m = { table: mTable, tableSide: mTableSide, felt: mFelt, feltLine: mFeltLine, cell: mCell, tray: mTray, body: mBody, back: mBack, seal: mSeal };

    this._built = true;
    this.resize();
    this._resetCameraInstant();

    // prewarm shaders + one warm-up frame
    try {
      this._renderer.compile(this._scene, this._camera);
      this._renderer.render(this._scene, this._camera);
    } catch (_) { /* prewarm is best-effort */ }
  }

  _makeCellTexture() {
    const c = document.createElement('canvas');
    c.width = c.height = 128;
    const ctx = c.getContext('2d');
    ctx.fillStyle = this._theme.cellInlay;
    ctx.fillRect(0, 0, 128, 128);
    ctx.fillStyle = this._theme.cellEmpty;
    ctx.fillRect(9, 9, 110, 110);
    ctx.strokeStyle = this._theme.feltLine;
    ctx.lineWidth = 3;
    ctx.strokeRect(4.5, 4.5, 119, 119);
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    return tex;
  }

  _buildProps(group, track) {
    const rng = createRng(this._content ? this._content.seed : 'cm').fork('cosmetic');
    const t = this._theme;
    const lay = this._layout;
    const sideX = lay.tableW / 2 - TABLE_PAD * 0.55;
    const backZ = lay.tableCz - lay.tableD / 2 + TABLE_PAD * 0.5;

    const add = (mesh, x, z, ry) => {
      mesh.position.x = x; mesh.position.z = z;
      if (ry !== undefined) mesh.rotation.y = ry;
      mesh.traverse((o) => { o.layers.set(LAYER_ENV); });
      group.add(mesh);
    };
    const std = (color, rough = 0.85) => track(new THREE.MeshStandardMaterial({ color, roughness: rough }));

    // mug (left of the board)
    const mug = new THREE.Group();
    const mugMat = std(t.accentSoft, 0.6);
    const cup = new THREE.Mesh(track(new THREE.CylinderGeometry(0.26, 0.22, 0.5, 20)), mugMat);
    cup.position.y = 0.25;
    cup.castShadow = true;
    const handle = new THREE.Mesh(track(new THREE.TorusGeometry(0.15, 0.035, 8, 16, Math.PI)), mugMat);
    handle.position.set(0.27, 0.27, 0);
    handle.rotation.z = -Math.PI / 2;
    mug.add(cup, handle);
    add(mug, -sideX + rng.float() * 0.3 - 0.15, -lay.boardD / 2 + 0.4 + rng.float() * 1.2, rng.float() * Math.PI * 2);

    // pencil (right of the board, lying flat)
    const pencil = new THREE.Group();
    const shaft = new THREE.Mesh(track(new THREE.CylinderGeometry(0.035, 0.035, 1.5, 8)), std(t.accent, 0.7));
    shaft.rotation.z = Math.PI / 2;
    shaft.position.y = 0.035;
    shaft.castShadow = true;
    const tip = new THREE.Mesh(track(new THREE.ConeGeometry(0.035, 0.14, 8)), std(t.cardEdge, 0.7));
    tip.rotation.z = -Math.PI / 2;
    tip.position.set(0.82, 0.035, 0);
    pencil.add(shaft, tip);
    add(pencil, sideX - rng.float() * 0.3, lay.trayZ - 0.4 + rng.float() * 0.8, rng.float() * 0.9 - 0.45);

    // stacked spare cards (back right)
    const stack = new THREE.Group();
    const nStack = rng.intRange(2, 4);
    const stackMat = std(t.cardEdge, 0.9);
    const stackTop = std(t.cardBack, 0.85);
    for (let i = 0; i < nStack; i++) {
      const cardMesh = new THREE.Mesh(
        track(new THREE.BoxGeometry(CARD_SIZE, 0.045, CARD_SIZE)),
        i === nStack - 1 ? stackTop : stackMat
      );
      cardMesh.position.y = 0.024 + i * 0.048;
      cardMesh.rotation.y = (rng.float() - 0.5) * 0.22;
      cardMesh.castShadow = true;
      stack.add(cardMesh);
    }
    add(stack, sideX - 0.1 - rng.float() * 0.2, backZ + 0.5 + rng.float() * 0.4, rng.float() * 0.6 - 0.3);

    // window-light patch on the table (soft additive plane, back left)
    const lightPatch = new THREE.Mesh(
      track(new THREE.PlaneGeometry(2.6, 1.8)),
      track(new THREE.MeshBasicMaterial({
        color: t.light.key, transparent: true, opacity: 0.09,
        blending: THREE.AdditiveBlending, depthWrite: false,
      }))
    );
    lightPatch.rotation.x = -Math.PI / 2;
    lightPatch.rotation.z = 0.3 + rng.float() * 0.3;
    lightPatch.position.set(-sideX * 0.6, 0.004, backZ + 0.9);
    lightPatch.layers.set(LAYER_ENV);
    group.add(lightPatch);
  }

  // dispose everything built by load()
  _clearLoad() {
    this._anims.length = 0;
    this._queueTime = 0;
    for (const f of this._flashes) {
      f.mesh.visible = false;
      f.mesh.scale.setScalar(1);
      this._flashPool.push(f.mesh);
    }
    this._flashes.length = 0;
    this._killParticles();
    this._ghost.visible = false;
    if (this._veil) this._veil.visible = false;
    if (this._world) {
      this._scene.remove(this._world);
      this._world = null;
    }
    for (const r of this._loadResources) {
      try { r.dispose(); } catch (_) { /* already disposed */ }
    }
    this._loadResources = [];
    this._cards = new Map();
    this._cells = [];
    this._traySlots = [];
    this._bars = [];
    this._pickList = [];
    this._m = null;
    this._cellTex = null;
    this._built = false;
  }

  // -------------------------------------------------------------------------
  // layout helpers
  // -------------------------------------------------------------------------
  _cellPos(cell, out) {
    const lay = this._layout;
    const x = cell % lay.w, y = Math.floor(cell / lay.w);
    out.set((x - (lay.w - 1) / 2) * PITCH, FELT_Y + CARD_H / 2 + 0.004, (y - (lay.h - 1) / 2) * PITCH);
    return out;
  }

  _trayPos(slot, out) {
    const lay = this._layout;
    out.set((slot - (lay.trayN - 1) / 2) * PITCH, FELT_Y + CARD_H / 2 + 0.004, lay.trayZ);
    return out;
  }

  // logical pose of a card from current state + meta; result into this._pose
  _poseFor(id) {
    const st = this._state, p = this._pose, m = this._meta;
    const card = st.cards[id];
    p.yaw = -(((card.rot % 4) + 4) % 4) * (Math.PI / 2);
    const trayIdx = st.tray.indexOf(id);
    if (trayIdx >= 0) {
      this._trayPos(trayIdx, this._tv1);
      p.x = this._tv1.x; p.z = this._tv1.z;
      p.y = this._tv1.y + (m.selectedTray === trayIdx ? SELECT_LIFT : 0);
      p.loc = 'tray'; p.index = trayIdx;
      return p;
    }
    const cellIdx = st.cells.indexOf(id);
    if (cellIdx >= 0) {
      this._cellPos(cellIdx, this._tv1);
      p.x = this._tv1.x; p.y = this._tv1.y; p.z = this._tv1.z;
      p.loc = 'cell'; p.index = cellIdx;
      return p;
    }
    p.loc = 'none'; p.index = -1;
    return p;
  }

  _applyPose(c) {
    const p = this._pose;
    if (p.loc === 'none') { c.group.visible = false; return; }
    c.group.visible = true;
    c.group.position.set(p.x, p.y, p.z);
    c.group.rotation.y = p.yaw;
  }

  _isOwned(id) {
    for (const a of this._anims) {
      if (a.cards && a.cards.indexOf(id) >= 0) return true;
    }
    return false;
  }

  _snapAll() {
    for (const c of this._cards.values()) {
      this._poseFor(c.id);
      this._applyPose(c);
      const cardState = this._state && this._state.cards[c.id];
      if (c.seal.visible !== !!(cardState && cardState.locked)) c.seal.visible = !!(cardState && cardState.locked);
      c.seal.scale.setScalar(1);
    }
  }

  // -------------------------------------------------------------------------
  // syncState: reconcile meshes to an immutable rules snapshot + meta overlays
  // -------------------------------------------------------------------------
  syncState(state, meta = {}) {
    if (this._disposed) return;
    this._state = state;
    this._meta = meta || {};
    if (!this._built) return;
    const m = this._meta;
    const t = this._theme;

    // matched-edge bookkeeping for board-event sparkles
    const analysis = analyzeBoard(state);
    this._prevSyncMatched = this._syncMatched;
    this._syncMatched = analysis.matched;

    // cards
    for (const c of this._cards.values()) {
      this._poseFor(c.id);
      const p = this._pose;
      const it = c.body.userData.intent;
      if (p.loc === 'tray') { it.kind = 'tray'; it.tray = p.index; it.cell = -1; }
      else if (p.loc === 'cell') { it.kind = 'cell'; it.cell = p.index; it.tray = -1; }
      else { it.kind = 'none'; it.cell = -1; it.tray = -1; }
      c.seal.visible = !!state.cards[c.id].locked;
      if (!this._isOwned(c.id)) this._applyPose(c);
    }

    // cell overlays
    const legal = m.legalCells || [];
    const lockable = m.lockableCells || [];
    const focus = m.keyboardFocus || null;
    for (let i = 0; i < this._cells.length; i++) {
      const { glow, ring } = this._cells[i];
      const gm = glow.material, rm = ring.material;
      // glow: selected > hint > lockable > legal
      glow.visible = false;
      if (m.selectedCell === i) {
        glow.visible = true; gm.color.set(t.select); gm.opacity = 0.4;
      } else if (m.hintCell === i) {
        glow.visible = true; gm.color.set(t.select); gm.opacity = 0.35;
      } else if (lockable.indexOf(i) >= 0) {
        glow.visible = true; gm.color.set(t.accent); gm.opacity = 0.42;
      } else if (legal.indexOf(i) >= 0) {
        glow.visible = true; gm.color.set(t.accentSoft); gm.opacity = 0.3;
      }
      // ring: selected > hint > keyboard focus
      ring.visible = false;
      ring.userData.pulse = false;
      if (m.selectedCell === i) {
        ring.visible = true; rm.color.set(t.select); rm.opacity = 0.95;
      } else if (m.hintCell === i) {
        ring.visible = true; rm.color.set(t.select); ring.userData.pulse = true;
      } else if (focus && focus.kind === 'cell' && focus.index === i) {
        ring.visible = true; rm.color.set(t.accent); rm.opacity = 0.85;
      }
    }

    // tray overlays
    for (let i = 0; i < this._traySlots.length; i++) {
      const { glow, ring } = this._traySlots[i];
      const gm = glow.material, rm = ring.material;
      glow.visible = false;
      if (m.selectedTray === i) {
        glow.visible = true; gm.color.set(t.select); gm.opacity = 0.4;
      } else if (m.hintTray === i) {
        glow.visible = true; gm.color.set(t.select); gm.opacity = 0.35;
      }
      ring.visible = false;
      ring.userData.pulse = false;
      if (m.selectedTray === i) {
        ring.visible = true; rm.color.set(t.select); rm.opacity = 0.95;
      } else if (m.hintTray === i) {
        ring.visible = true; rm.color.set(t.select); ring.userData.pulse = true;
      } else if (focus && focus.kind === 'tray' && focus.index === i) {
        ring.visible = true; rm.color.set(t.accent); rm.opacity = 0.85;
      }
    }

    // edge status bars: matched glow subtly, mismatched restrained warning
    for (let i = 0; i < this._bars.length; i++) {
      const bar = this._bars[i];
      const pair = analysis.pairs[i];
      if (!pair || pair.open) { bar.visible = false; continue; }
      this._cellPos(pair.a, this._tv1);
      this._cellPos(pair.b, this._tv2);
      bar.position.set((this._tv1.x + this._tv2.x) / 2, FELT_Y + CARD_H + 0.012, (this._tv1.z + this._tv2.z) / 2);
      bar.rotation.set(-Math.PI / 2, 0, pair.dir === 1 ? Math.PI / 2 : 0);
      if (pair.matched) {
        bar.material.color.set(t.match);
        bar.material.opacity = 0.5;
      } else {
        bar.material.color.set(t.invalid);
        bar.material.opacity = 0.35;
      }
      bar.visible = true;
    }

    // terminal veil cleared on active play
    if (state.status === 'active' && this._veil.visible) this._veil.visible = false;
  }

  // -------------------------------------------------------------------------
  // animation timeline
  // -------------------------------------------------------------------------
  _addAnim(anim) {
    anim.t = 0;
    anim.wait = anim.wait || 0;
    this._anims.push(anim);
    return anim;
  }

  _stepAnims(dt) {
    const A = this._anims;
    for (let i = A.length - 1; i >= 0; i--) {
      const a = A[i];
      if (a.wait > 0) {
        a.wait -= dt;
        if (a.wait > 0) continue;
      }
      a.t += dt;
      const k = a.dur <= 0 ? 1 : clamp01(a.t / a.dur);
      try {
        if (a.update) a.update(a.ease ? a.ease(k) : k);
      } catch (_) { /* cosmetic anim must never break the loop */ }
      if (k >= 1) {
        A.splice(i, 1);
        try { if (a.done) a.done(); } catch (_) { /* ignore */ }
      }
    }
    this._queueTime = Math.max(0, this._queueTime - dt);

    // ring flashes
    const F = this._flashes;
    for (let i = F.length - 1; i >= 0; i--) {
      const f = F[i];
      f.t += dt;
      const k = clamp01(f.t / f.dur);
      f.mesh.material.opacity = (1 - k) * 0.85;
      const s = 0.6 + k * 1.6;
      f.mesh.scale.setScalar(s);
      if (k >= 1) {
        f.mesh.visible = false;
        f.mesh.scale.setScalar(1);
        F.splice(i, 1);
        this._flashPool.push(f.mesh);
      }
    }
  }

  /** Instantly settle every in-flight animation into the logical end state. */
  skipAnimations() {
    const A = this._anims;
    for (let i = 0; i < A.length; i++) {
      const a = A[i];
      try {
        if (a.update) a.update(1);
        if (a.done) a.done();
      } catch (_) { /* ignore */ }
    }
    A.length = 0;
    this._queueTime = 0;
    this._camAnim = null;
    this._shakeAmp = 0;
    this._shakeOff.set(0, 0, 0);
    this._killParticles();
    for (const f of this._flashes) {
      f.mesh.visible = false;
      f.mesh.scale.setScalar(1);
      this._flashPool.push(f.mesh);
    }
    this._flashes.length = 0;
    if (this._state && this._built) this._snapAll();
  }

  _ringFlash(x, y, z, colorHex) {
    if (!this._flashPool) this._flashPool = [];
    let mesh = this._flashPool.pop();
    if (!mesh) {
      mesh = new THREE.Mesh(this._geo.flash, new THREE.MeshBasicMaterial({
        transparent: true, opacity: 0, depthWrite: false, side: THREE.DoubleSide,
      }));
      mesh.rotation.x = -Math.PI / 2;
      mesh.layers.set(LAYER_FX);
      this._scene.add(mesh);
    }
    mesh.material.color.set(colorHex);
    mesh.position.set(x, y, z);
    mesh.visible = true;
    this._flashes.push({ mesh, t: 0, dur: this._reducedMotion ? 0.3 : 0.6 });
  }

  // fly a card along an arc; end pose comes from logical state on done
  _evFly(cardId, from, to, wait, arc) {
    const c = this._cards.get(cardId);
    if (!c) return 0;
    const rm = this._reducedMotion;
    const dur = rm ? 0.08 : 0.5;
    const fx = from.x, fy = from.y, fz = from.z;
    const tx = to.x, ty = to.y, tz = to.z;
    const y0 = c.group.rotation.y;
    this._poseFor(cardId);
    const y1 = this._pose.yaw;
    const h = rm ? 0 : arc;
    this._addAnim({
      wait, dur, ease: easeInOutCubic, cards: [cardId],
      update: (k) => {
        c.group.visible = true;
        c.group.position.set(
          fx + (tx - fx) * k,
          fy + (ty - fy) * k + Math.sin(k * Math.PI) * h,
          fz + (tz - fz) * k
        );
        c.group.rotation.y = y0 + (y1 - y0) * k;
      },
      done: () => {
        this._poseFor(cardId);
        this._applyPose(c);
      },
    });
    return dur;
  }

  playEvents(events, state) {
    if (this._disposed || !this._built || !events) return;
    const t = this._theme;
    for (const ev of events) {
      const wait = this._queueTime;
      let used = 0.05;
      switch (ev.type) {
        case 'place': {
          this._trayPos(ev.tray, this._tv1);
          this._cellPos(ev.cell, this._tv2);
          this._tv3.copy(this._tv1); this._tv4.copy(this._tv2);
          used = this._evFly(ev.card, this._tv3, this._tv4, wait, FLY_ARC) + 0.05;
          break;
        }
        case 'recall': {
          this._cellPos(ev.cell, this._tv1);
          this._trayPos(ev.tray, this._tv2);
          this._tv3.copy(this._tv1); this._tv4.copy(this._tv2);
          used = this._evFly(ev.card, this._tv3, this._tv4, wait, FLY_ARC * 0.8) + 0.05;
          break;
        }
        case 'swap': {
          this._cellPos(ev.a, this._tv1);
          this._cellPos(ev.b, this._tv2);
          this._tv3.copy(this._tv1); this._tv4.copy(this._tv2);
          const d1 = this._evFly(ev.cardA, this._tv3, this._tv4, wait, FLY_ARC * 0.6);
          const d2 = this._evFly(ev.cardB, this._tv4, this._tv3, wait, FLY_ARC * 0.6);
          used = Math.max(d1, d2) + 0.05;
          break;
        }
        case 'rotateTray': {
          const c = this._cards.get(ev.card);
          if (c) {
            const rm = this._reducedMotion;
            const dur = rm ? 0.1 : 0.35;
            const y0 = c.group.rotation.y;
            const baseY = c.group.position.y;
            this._addAnim({
              wait, dur, ease: easeInOutCubic, cards: [ev.card],
              update: (k) => {
                c.group.rotation.y = y0 - (Math.PI / 2) * k;
                if (!rm) c.group.position.y = baseY + Math.sin(k * Math.PI) * 0.22;
              },
              done: () => {
                this._poseFor(ev.card);
                this._applyPose(c);
              },
            });
            used = dur + 0.05;
          }
          break;
        }
        case 'lock': {
          const c = this._cards.get(ev.card);
          this._cellPos(ev.cell, this._tv1);
          const px = this._tv1.x, pz = this._tv1.z;
          if (c) {
            const dur = this._reducedMotion ? 0.05 : 0.4;
            this._addAnim({
              wait, dur, ease: easeOutBack, cards: [ev.card],
              update: (k) => {
                c.seal.visible = true;
                c.seal.scale.setScalar(Math.max(0.05, k));
              },
              done: () => {
                c.seal.visible = true;
                c.seal.scale.setScalar(1);
              },
            });
            used = dur + 0.05;
          }
          this._ringFlash(px, FELT_Y + CARD_H + 0.03, pz, t.select);
          this._burst(px, FELT_Y + CARD_H + 0.05, pz, t.match, 14, 0.9, 1.4, 3.2);
          break;
        }
        case 'invalid': {
          // rules' invalid event carries no cell; do a restrained board flash
          const lay = this._layout;
          this._veil.material.color.set(t.invalid);
          this._veil.scale.set(lay.boardW / (CELL_VISUAL + 0.1) + 1, lay.boardD / (CELL_VISUAL + 0.1) + 1.6, 1);
          this._veil.position.set(0, FELT_Y + CARD_H + 0.05, 0);
          this._veil.material.opacity = 0;
          this._veil.visible = true;
          const dur = this._reducedMotion ? 0.25 : 0.45;
          const peak = 0.22;
          this._addAnim({
            wait, dur,
            update: (k) => { this._veil.material.opacity = Math.sin(k * Math.PI) * peak; },
            done: () => { this._veil.visible = false; this._veil.material.opacity = 0; },
          });
          if (!this._reducedMotion) this._shakeAmp = Math.max(this._shakeAmp, 0.018);
          used = dur * 0.6;
          break;
        }
        case 'board': {
          // sparkle only when the matched count actually rose
          if (ev.matched > Math.max(this._prevSyncMatched, this._lastEventMatched) && state) {
            const analysis = analyzeBoard(state);
            let budget = this._reducedMotion ? 4 : 40;
            for (const pair of analysis.pairs) {
              if (!pair.matched || pair.open) continue;
              this._cellPos(pair.a, this._tv1);
              this._cellPos(pair.b, this._tv2);
              this._burst(
                (this._tv1.x + this._tv2.x) / 2, FELT_Y + CARD_H + 0.04, (this._tv1.z + this._tv2.z) / 2,
                t.match, Math.min(4, budget), 0.5, 1.0, 2.6
              );
              budget -= 4;
              if (budget <= 0) break;
            }
          }
          this._lastEventMatched = ev.matched;
          break;
        }
        case 'terminal': {
          if (ev.reason === 'complete') {
            // celebration: confetti + gentle camera nudge
            const lay = this._layout;
            const mc = motifColors(this._cvd);
            const bursts = this._reducedMotion ? 3 : 8;
            for (let b = 0; b < bursts; b++) {
              const bx = (Math.random() - 0.5) * lay.boardW;
              const bz = (Math.random() - 0.5) * lay.boardD;
              this._burst(bx, FELT_Y + 1.2 + Math.random(), bz, mc[b % mc.length],
                this._reducedMotion ? 8 : 22, 1.4, 0.6, 2.2);
            }
            this._ringFlash(0, FELT_Y + CARD_H + 0.04, 0, t.select);
            if (!this._reducedMotion) this._shakeAmp = Math.max(this._shakeAmp, 0.05);
            used = 0.8;
          } else {
            // subdued fade
            const lay = this._layout;
            this._veil.material.color.set(t.bg);
            this._veil.scale.set(lay.tableW / (CELL_VISUAL + 0.1), lay.tableD / (CELL_VISUAL + 0.1), 1);
            this._veil.position.set(0, FELT_Y + CARD_H + 0.06, lay.tableCz);
            this._veil.visible = true;
            const dur = this._reducedMotion ? 0.3 : 1.1;
            this._addAnim({
              wait, dur,
              update: (k) => { this._veil.material.opacity = k * 0.45; },
              done: () => { this._veil.material.opacity = 0.45; },
            });
            used = dur;
          }
          break;
        }
        default:
          // terminal-pending / duplicate / undo: no cosmetic animation
          break;
      }
      this._queueTime = wait + Math.max(used, EVENT_GAP);
    }
  }

  // -------------------------------------------------------------------------
  // settings
  // -------------------------------------------------------------------------
  setTheme(themeId) {
    if (this._disposed) return;
    this._themeId = themeId;
    this._theme = getTheme(themeId);
    const t = this._theme;
    this._renderer.toneMappingExposure = t.exposure;
    this._scene.background.set(t.bg);
    this._scene.fog.color.set(t.fog);
    this._keyLight.color.set(t.light.key);
    this._keyLight.intensity = t.light.keyIntensity;
    this._fillLight.color.set(t.light.fill);
    this._fillLight.intensity = t.light.fillIntensity;
    this._hemi.color.set(t.light.key);
    this._hemi.groundColor.set(t.table);
    this._hemi.intensity = t.light.ambient;
    if (this._built && this._m) {
      this._m.table.color.set(t.table);
      this._m.tableSide.color.set(t.tableEdge);
      this._m.felt.color.set(t.felt);
      this._m.feltLine.color.set(t.feltLine);
      this._m.tray.color.set(t.cellInlay);
      this._m.body.color.set(t.cardEdge);
      this._m.back.color.set(t.cardBack);
      this._m.seal.color.set(t.accent);
      // repaint the shared cell texture in place
      const c = this._cellTex.image;
      const ctx = c.getContext('2d');
      ctx.fillStyle = t.cellInlay; ctx.fillRect(0, 0, 128, 128);
      ctx.fillStyle = t.cellEmpty; ctx.fillRect(9, 9, 110, 110);
      ctx.strokeStyle = t.feltLine; ctx.lineWidth = 3; ctx.strokeRect(4.5, 4.5, 119, 119);
      this._cellTex.needsUpdate = true;
      this._repaintCards();
      if (this._state) this.syncState(this._state, this._meta);
    }
  }

  setCvd(b) {
    if (this._disposed) return;
    this._cvd = !!b;
    if (this._built) this._repaintCards();
  }

  _repaintCards() {
    const colors = motifColors(this._cvd);
    for (const c of this._cards.values()) {
      paintCardFace(c.canvas, c.edges, colors, { face: this._theme.cardFace, frame: this._theme.cardEdge });
      c.texture.needsUpdate = true;
    }
  }

  setQuality(tier) {
    if (this._disposed || !QUALITY[tier]) return;
    this._quality = tier;
    const q = QUALITY[tier];
    // antialiasing is fixed at construction (renderer recreation intentionally
    // avoided); everything else adjusts at runtime.
    this._renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, q.pixelRatio));
    this._renderer.shadowMap.enabled = q.shadows;
    this._keyLight.castShadow = q.shadows;
    this._keyLight.shadow.mapSize.set(tier === 'high' ? 2048 : 1024, tier === 'high' ? 2048 : 1024);
    if (this._keyLight.shadow.map) {
      this._keyLight.shadow.map.dispose();
      this._keyLight.shadow.map = null;
    }
    this._pCap = q.particles;
    if (this._props) this._props.visible = q.props;
    // material recompile for shadow toggle
    this._scene.traverse((o) => {
      if (o.material) {
        if (Array.isArray(o.material)) o.material.forEach((mm) => { mm.needsUpdate = true; });
        else o.material.needsUpdate = true;
      }
    });
    this.resize();
  }

  setReducedMotion(b) {
    this._reducedMotion = !!b;
    if (this._reducedMotion) {
      this._shakeAmp = 0;
      this._camAnim = null;
      this._resetCameraInstant();
    }
  }

  // -------------------------------------------------------------------------
  // camera
  // -------------------------------------------------------------------------
  _computeFraming() {
    const lay = this._layout;
    if (!lay) return;
    const aspect = this._camera.aspect || 1;
    const spanW = Math.max(lay.tableW * 0.82, lay.boardW + 1.2);
    const spanD = (lay.trayZ + 0.7) + lay.boardD / 2;
    const vfov = (FRAMING.fov * Math.PI) / 180;
    const hfov = 2 * Math.atan(Math.tan(vfov / 2) * aspect);
    const distH = (spanW / 2) / Math.tan(hfov / 2);
    const distV = ((spanD * 0.62) / 2) / Math.tan(vfov / 2);
    const dist = Math.max(distH, distV) * FRAMING.fitMargin + FRAMING.fitBoost;
    const el = (FRAMING.elevationDeg * Math.PI) / 180;
    const targetZ = (lay.trayZ - lay.boardD / 2) * FRAMING.trayBias * 0.5;
    this._camTarget.set(0, 0, targetZ);
    this._camPos.set(0, Math.sin(el) * dist, targetZ + Math.cos(el) * dist);
    this._camera.far = dist * 4 + 20;
    this._camera.updateProjectionMatrix();
    this._scene.fog.near = dist * FOG_NEAR_K;
    this._scene.fog.far = dist * FOG_FAR_K;
    // key light shadow frustum covers the table
    const s = Math.max(lay.tableW, lay.tableD) / 2 + 1;
    const sc = this._keyLight.shadow.camera;
    sc.left = -s; sc.right = s; sc.top = s; sc.bottom = -s;
    sc.near = 1; sc.far = 30;
    sc.updateProjectionMatrix();
  }

  _resetCameraInstant() {
    this._camAnim = null;
    this._camera.position.copy(this._camPos);
    this._camTargetCur.copy(this._camTarget);
    this._camera.lookAt(this._camTarget);
  }

  /** Return to authored framing with an interruptible eased transition. */
  resetCamera() {
    if (this._disposed) return;
    if (this._reducedMotion) { this._resetCameraInstant(); return; }
    this._camAnim = {
      t: 0, dur: 0.7,
      fromPos: this._camera.position.clone(),
      fromTar: this._camTargetCur.clone(),
    };
  }

  resize() {
    if (this._disposed) return;
    const w = this._container.clientWidth || 1;
    const h = this._container.clientHeight || 1;
    this._renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, QUALITY[this._quality].pixelRatio));
    this._renderer.setSize(w, h, false);
    this._camera.aspect = w / h;
    this._camera.updateProjectionMatrix();
    if (this._built) {
      this._computeFraming();
      if (!this._camAnim) this._resetCameraInstant();
    }
  }

  // -------------------------------------------------------------------------
  // pointer input
  // -------------------------------------------------------------------------
  _pick(e) {
    // raycast against an explicit gameplay list only; shake is removed first
    // so camera cosmetics never affect raycast truth
    const rect = this._canvas.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return null;
    this._ndc.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    this._ndc.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
    this._camera.position.sub(this._shakeOff);
    this._camera.lookAt(this._camTargetCur);
    this._camera.updateMatrixWorld();
    this._raycaster.setFromCamera(this._ndc, this._camera);
    this._camera.position.add(this._shakeOff);
    const hits = this._raycaster.intersectObjects(this._pickList, false);
    return hits.length > 0 ? hits[0] : null;
  }

  _emitHit(hit) {
    const it = hit && hit.object.userData.intent;
    if (!it || it.kind === 'none') { this._onIntent({ kind: 'background' }); return; }
    if (it.kind === 'cell') this._onIntent({ kind: 'cell', cell: it.cell });
    else if (it.kind === 'tray') this._onIntent({ kind: 'tray', tray: it.tray });
    else this._onIntent({ kind: 'background' });
  }

  _pointerDown(e) {
    if (this._disposed || this._ptr) return; // single pointer only, never multi-touch
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    try { this._canvas.setPointerCapture(e.pointerId); } catch (_) { /* ok */ }
    this._ptr = {
      id: e.pointerId, x0: e.clientX, y0: e.clientY, t0: performance.now(),
      dragging: false, hit: this._pick(e),
    };
  }

  _pointerMove(e) {
    const p = this._ptr;
    if (!p || e.pointerId !== p.id) return;
    if (!p.dragging) {
      const dx = e.clientX - p.x0, dy = e.clientY - p.y0;
      const dt = performance.now() - p.t0;
      if (Math.abs(dx) > TAP_MAX_PX || Math.abs(dy) > TAP_MAX_PX || (dt > TAP_MAX_MS && (dx !== 0 || dy !== 0))) {
        p.dragging = true;
        // start a drag ghost if the press landed on a card
        const it = p.hit && p.hit.object.userData.intent;
        const cardId = p.hit && p.hit.object.userData.cardId;
        if (cardId && it && it.kind !== 'none') {
          const c = this._cards.get(cardId);
          if (c) {
            this._ghost.material.map = c.texture;
            this._ghost.material.needsUpdate = true;
            this._ghost.visible = true;
          }
        }
      }
    }
    if (p.dragging && this._ghost.visible) {
      const rect = this._canvas.getBoundingClientRect();
      this._ndc.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
      this._ndc.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
      this._raycaster.setFromCamera(this._ndc, this._camera);
      if (this._raycaster.ray.intersectPlane(this._dragPlane, this._tv1)) {
        this._ghost.position.copy(this._tv1);
      }
    }
  }

  _pointerUp(e) {
    const p = this._ptr;
    if (!p || e.pointerId !== p.id) return;
    this._ptr = null;
    try { this._canvas.releasePointerCapture(e.pointerId); } catch (_) { /* ok */ }
    if (p.dragging) {
      this._ghost.visible = false;
      this._emitHit(this._pick(e)); // drop target, or background
    } else {
      this._emitHit(this._pick(e)); // tap
    }
  }

  _pointerCancel(e) {
    const p = this._ptr;
    if (!p || (e.pointerId !== undefined && e.pointerId !== p.id)) return;
    this._ptr = null;
    this._ghost.visible = false;
  }

  // -------------------------------------------------------------------------
  // main loop
  // -------------------------------------------------------------------------
  _tick(t) {
    if (this._disposed) return;
    this._raf = requestAnimationFrame((tt) => this._tick(tt));
    if (this._hidden) { this._lastT = t; return; } // render nothing while hidden
    let dt = (t - this._lastT) / 1000;
    this._lastT = t;
    if (dt <= 0) return;
    if (dt > 0.1) dt = 0.1;
    this._time += dt;
    this._fps += (1 / dt - this._fps) * 0.05;

    this._stepAnims(dt);
    this._stepParticles(dt);

    // hint pulse (time-based, no allocations)
    const pulse = 0.55 + 0.4 * Math.sin(this._time * 7);
    for (const { ring } of this._cells) {
      if (ring.visible && ring.userData.pulse) ring.material.opacity = pulse;
    }
    for (const { ring } of this._traySlots) {
      if (ring.visible && ring.userData.pulse) ring.material.opacity = pulse;
    }

    // camera: authored base or eased reset transition, plus decaying shake
    if (this._camAnim) {
      const a = this._camAnim;
      a.t += dt;
      const k = easeInOutCubic(clamp01(a.t / a.dur));
      this._camera.position.lerpVectors(a.fromPos, this._camPos, k);
      this._camTargetCur.lerpVectors(a.fromTar, this._camTarget, k);
      if (a.t >= a.dur) this._camAnim = null;
    } else {
      this._camera.position.copy(this._camPos);
      this._camTargetCur.copy(this._camTarget);
    }
    if (this._shakeAmp > 0.0005 && !this._reducedMotion) {
      this._shakeOff.set(
        Math.sin(this._time * 37) * this._shakeAmp,
        Math.sin(this._time * 53) * this._shakeAmp * 0.6,
        Math.sin(this._time * 43) * this._shakeAmp * 0.4
      );
      this._shakeAmp *= Math.exp(-3 * dt);
    } else {
      this._shakeOff.set(0, 0, 0);
      if (this._shakeAmp <= 0.0005) this._shakeAmp = 0;
    }
    this._camera.position.add(this._shakeOff);
    this._camera.lookAt(this._camTargetCur);

    this._renderer.render(this._scene, this._camera);
  }

  // -------------------------------------------------------------------------
  getStats() {
    const info = this._renderer.info;
    return {
      drawCalls: info.render.calls,
      triangles: info.render.triangles,
      fps: Math.round(this._fps),
    };
  }

  dispose() {
    if (this._disposed) return;
    this._disposed = true;
    cancelAnimationFrame(this._raf);
    this._canvas.removeEventListener('pointerdown', this._onPointerDown);
    this._canvas.removeEventListener('pointermove', this._onPointerMove);
    this._canvas.removeEventListener('pointerup', this._onPointerUp);
    this._canvas.removeEventListener('pointercancel', this._onPointerCancel);
    this._canvas.removeEventListener('lostpointercapture', this._onPointerCancel);
    document.removeEventListener('visibilitychange', this._onVisibility);
    window.removeEventListener('resize', this._onResize);
    if (this._ro) { this._ro.disconnect(); this._ro = null; }
    this._clearLoad();
    // persistent resources
    for (const g of Object.values(this._geo)) g.dispose();
    this._ghost.material.dispose();
    this._veil.material.dispose();
    if (this._flashPool) {
      for (const m of this._flashPool) m.material.dispose();
      this._flashPool = [];
    }
    for (const f of this._flashes) f.mesh.material.dispose();
    this._flashes = [];
    this._scene.remove(this._points);
    this._points.geometry.dispose();
    this._points.material.dispose();
    this._renderer.dispose();
  }
}
