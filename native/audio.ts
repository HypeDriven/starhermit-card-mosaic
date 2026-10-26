// Sound, as the browser build's js/audio.js: the authored one-shots
// (sfx/<name>.opus, sfx/manifest.json's event table) per logical event; the
// generative music in A-minor pentatonic (a three-voice sine pad on a new
// root every eight beats, triangle notes on the off-beats, and in play a
// bass pulse, at one beat a second on menus and two in play), seeded by the
// round; and the studio ambience (a low room tone with sparse high chimes
// whose density follows the table theme).
//
// The browser build's four buses become the runtime's (Options › Audio owns
// the volumes, the mute and the voice limit): music → "music", effects and
// ambience → "effects", the menu open/close cues → "interface". The old
// default bus levels (music 70 %, effects 90 %, ambience 50 %) are folded
// into each sound's gain; the pause duck (master to 25 %) holds the music
// and fades the ambience. The music and ambience voices, which the browser
// build made with oscillators and filtered noise, are rendered once into
// clips (createClip) with the same envelopes; the synthesized stand-ins it
// played while a sample loaded are not ported (the engine's web runtime drops
// clip loads while a synthesis graph changes: the arrow-exodus finding).
// Clips load once the mixer runs (natively at once, in a browser after the
// first press), one at a time.
import { context, createClip, loadClip, play as playClip, type AudioClip, type Bus, type Sound } from "starhermit:audio";
import { createRng } from "../js/rng.js";

const LEVEL = { music: 0.7, effects: 0.9, ambience: 0.5 };
const SCALE = [220.0, 261.63, 293.66, 329.63, 392.0, 440.0, 523.25, 587.33, 659.26, 783.99, 880.0];
/** Logical event → authored sample (sfx/manifest.json). */
const SAMPLES: Record<string, string> = {
  select: "card-select", place: "card-place", recall: "card-recall", swap: "card-swap", rotate: "card-rotate",
  lock: "card-lock", invalid: "invalid-move", match: "edge-match", complete: "mosaic-complete", fail: "round-fail",
  pause: "pause-toggle", hint: "hint-reveal", achievement: "achievement-unlock", uiOpen: "ui-open", uiClose: "ui-close",
  undo: "card-undo", timeWarning: "time-warning", newBest: "new-best",
};
const INTERFACE = new Set(["uiOpen", "uiClose"]);

const clips = new Map<string, AudioClip>();
const queue: string[] = [];
let loading = false;
let wantClips = false;
function load(name: string): void { if (!queue.includes(name) && !clips.has(name)) queue.push(name); }
function pump(): void {
  if (loading || !queue.length) return;
  const name = queue.shift()!;
  loading = true;
  loadClip(`sfx/${name}.opus`).then((c) => { clips.set(name, c); loading = false; }, (e: unknown) => { console.warn(`sfx ${name}: ${String(e)}`); loading = false; });
}
/** Asks for the clips; they load once the mixer runs (see update). */
export function loadSfx(): void { wantClips = true; }

/** Plays a logical event's sample. */
export function event(name: string): void {
  const file = SAMPLES[name];
  const clip = file ? clips.get(file) : undefined;
  if (!clip) return;
  const bus: Bus = INTERFACE.has(name) ? "interface" : "effects";
  try { playClip(clip, { bus, gain: LEVEL.effects }); }
  catch { clips.delete(file!); load(file!); } // a clip the mixer lost: load it again
}

// -- rendered voices ------------------------------------------------------------------------
const RATE = 11025;
/** js/audio.js _envGain: exponential from 0.0001 to `peak` over `attack`, back to 0.0001 over `decay`. */
function env(t: number, peak: number, attack: number, decay: number): number {
  if (t < 0) return 0;
  if (t < attack) return 0.0001 * Math.pow(peak / 0.0001, t / attack);
  const d = t - attack;
  if (d < decay) return peak * Math.pow(0.0001 / peak, d / decay);
  return 0;
}
/** A pad chord (root × 0.5, × 0.75, × 1 sines) rising over 1.2 s and gone by `len` (eight beats). */
function padClip(root: number, len: number): AudioClip {
  const n = Math.round((len + 0.1) * RATE);
  const out = new Float32Array(n);
  for (const mult of [1, 1.5, 2]) {
    const f = root * mult * 0.5, peak = 0.035 / mult;
    for (let i = 0; i < n; i++) {
      const t = i / RATE;
      const e = t < 1.2 ? 0.0001 * Math.pow(peak / 0.0001, t / 1.2) : t < len ? peak * Math.pow(0.0001 / peak, (t - 1.2) / (len - 1.2)) : 0;
      out[i]! += Math.sin(2 * Math.PI * f * t) * e;
    }
  }
  return createClip([out], RATE);
}
/** A triangle note: to 0.04 in 20 ms, gone by 0.6 s. */
function noteClip(f: number): AudioClip {
  const rate = RATE * 2;
  const n = Math.round(0.7 * rate);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / rate;
    const ph = (f * t) % 1;
    out[i] = (1 - 4 * Math.abs(ph - 0.5)) * env(t, 0.04, 0.02, 0.58);
  }
  return createClip([out], rate);
}
/** A bass pulse: a sine to `peak` in 10 ms, gone by 0.18 s. */
function bassClip(f: number, peak: number): AudioClip {
  const n = Math.round(0.25 * RATE);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) { const t = i / RATE; out[i] = Math.sin(2 * Math.PI * f * t) * env(t, peak, 0.01, 0.17); }
  return createClip([out], RATE);
}
/** An ambience chime (js/audio.js chime(): a sine and its octave at a quarter, 1.2 s). */
function chimeClip(f: number): AudioClip {
  const rate = RATE * 2;
  const n = Math.round(1.3 * rate);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / rate;
    out[i] = Math.sin(2 * Math.PI * f * t) * env(t, 0.05, 0.01, 1.2) + Math.sin(4 * Math.PI * f * t) * env(t, 0.0125, 0.01, 0.84);
  }
  return createClip([out], rate);
}
/** The room tone: noise lowpassed at 320 Hz, at 0.05, as a 6 s loop whose ends cross-fade. */
function roomToneClip(): AudioClip {
  const n = 6 * RATE, fade = RATE;
  const raw = new Float32Array(n + fade);
  const rng = createRng("cardmosaic:room");
  for (let i = 0; i < raw.length; i++) raw[i] = rng.float() * 2 - 1;
  // RBJ biquad lowpass, Q 1
  const w = (2 * Math.PI * 320) / RATE, alpha = Math.sin(w) / 2, c = Math.cos(w), a0 = 1 + alpha;
  const b0 = (1 - c) / 2 / a0, b1 = (1 - c) / a0, b2 = b0, a1 = (-2 * c) / a0, a2 = (1 - alpha) / a0;
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < raw.length; i++) {
    const x0 = raw[i]!;
    const y0 = b0 * x0 + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
    x2 = x1; x1 = x0; y2 = y1; y1 = y0;
    raw[i] = y0;
  }
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let v = raw[i]!;
    if (i < fade) { const k = i / fade; v = v * k + raw[n + i]! * (1 - k); }
    out[i] = v * 0.05;
  }
  return createClip([out], RATE);
}

const pads = new Map<string, AudioClip>();
const notes = new Map<number, AudioClip>();
const bass: AudioClip[] = [];
const chimes = new Map<number, AudioClip>();
let room: AudioClip | null = null;
/** One rendered voice a frame, once the samples are in; false when all are made. */
function renderNext(): boolean {
  for (const beat of [1, 0.5]) for (let r = 0; r <= 3; r++) {
    const k = `${r}:${beat}`;
    if (!pads.has(k)) { pads.set(k, padClip(SCALE[r]!, beat * 8)); return true; }
  }
  for (let i = 3; i <= 8; i++) if (!notes.has(i)) { notes.set(i, noteClip(SCALE[i]!)); return true; }
  if (bass.length < 2) { bass.push(bass.length === 0 ? bassClip(110, 0.05) : bassClip(82.4, 0.03)); return true; }
  for (let i = 5; i < SCALE.length; i++) if (!chimes.has(i)) { chimes.set(i, chimeClip(SCALE[i]!)); return true; }
  if (!room) { room = roomToneClip(); return true; }
  return false;
}

// -- music and ambience -------------------------------------------------------------------
let musicLevel = 0;
let seed = "cardmosaic-default";
let musicRng = createRng(seed + ":music");
let ambRng = createRng(seed).fork("audio");
let nextBeat = 0;
let step = 0;
let ducked = false;
let ambTheme: string | null = null;
let ambSound: Sound | null = null;
let nextChime = 0;
const DENSITY: Record<string, number> = { studio: 0.5, slate: 0.25, verdant: 0.7, ember: 0.4, porcelain: 0.3 };

/** Seeds the music and ambience for a round (the content's seed). */
export function setSeed(s: string): void {
  seed = String(s);
  musicRng = createRng(seed + ":music");
  ambRng = createRng(seed).fork("audio");
}
/** 0 off, 1 menus, 2 in play. */
export function setMusicIntensity(level: number): void {
  const lv = level === 2 ? 2 : level === 1 ? 1 : 0;
  if (lv === musicLevel) return;
  if (musicLevel === 0) { nextBeat = 0; step = 0; musicRng = createRng(seed + ":music"); }
  musicLevel = lv;
}
export function startAmbience(themeId: string): void {
  ambTheme = themeId;
  nextChime = context.currentTime + 2;
}
export function stopAmbience(): void {
  ambTheme = null;
  if (ambSound) { try { ambSound.fade(0.0001, 0.8); const s = ambSound; setTimeout(() => { try { s.stop(); } catch { /* gone */ } }, 1000); } catch { /* gone */ } }
  ambSound = null;
}
/** The pause duck: the ambience fades to a quarter and the music rests. */
export function duck(on: boolean): void {
  ducked = on;
  if (ambSound) { try { ambSound.fade((on ? 0.25 : 1) * LEVEL.ambience, 0.15); } catch { ambSound = null; } }
}

function playVoice(clip: AudioClip | undefined, bus: Bus, gain: number): void {
  if (!clip) return;
  try { playClip(clip, { bus, gain }); } catch { /* the mixer is full */ }
}

/** Each frame: the samples once the mixer runs, one rendered voice a frame,
 * then the music's beats and the ambience's chimes by mixer time. */
export function update(): void {
  if (context.state !== "running") return;
  if (wantClips) {
    wantClips = false;
    for (const name of new Set(Object.values(SAMPLES))) load(name);
  }
  pump();
  if (loading || queue.length) return;
  try { if (renderNext()) return; } catch (e) { console.warn(`audio: ${String(e)}`); return; }
  const now = context.currentTime;
  // ambience
  if (ambTheme && !ambSound && room) {
    try { ambSound = playClip(room, { bus: "effects", gain: 0.0001, loop: true }); ambSound.fade((ducked ? 0.25 : 1) * LEVEL.ambience, 2); }
    catch { ambSound = null; }
  }
  if (ambTheme && !ducked && now >= nextChime) {
    if (nextChime > 0 && ambRng.float() < (DENSITY[ambTheme] ?? 0.4)) {
      playVoice(chimes.get(ambRng.intRange(5, SCALE.length - 1)), "effects", LEVEL.ambience);
    }
    nextChime = now + 4 + ambRng.float() * 8;
  }
  // music
  if (!musicLevel || ducked) { if (nextBeat < now) nextBeat = now; return; }
  if (now < nextBeat) return;
  const beat = musicLevel === 2 ? 0.5 : 1.0;
  if (nextBeat === 0 || now - nextBeat > 1) nextBeat = now;
  const r = musicRng;
  if (step % 8 === 0) playVoice(pads.get(`${r.intRange(0, 3)}:${beat}`), "music", LEVEL.music);
  if (step % 2 === 1 && r.float() < 0.6) playVoice(notes.get(r.intRange(3, 8)), "music", LEVEL.music);
  if (musicLevel === 2 && step % 2 === 0) playVoice(bass[step % 4 === 0 ? 0 : 1], "music", LEVEL.music);
  nextBeat += beat;
  step++;
}
