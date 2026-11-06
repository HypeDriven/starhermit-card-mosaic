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
// and fades the ambience. The music and ambience voices, oscillators and
// filtered noise as the browser build made them, are offline graphs rendered
// once into clips with the same envelopes; the synthesized stand-ins it played
// while a sample loaded are not ported. The sample clips load and the voices
// render in onStart; the music and ambience start once the mixer runs (in a
// browser after the first press).
import { OfflineAudioContext, context, createClip, loadClip, play as playClip, type AudioClip, type Bus, type GainNode, type Sound } from "starhermit:audio";
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
/** Loads every clip at once (onStart); a cue whose clip is still loading is skipped. */
export function loadSfx(): void {
  for (const name of new Set(Object.values(SAMPLES))) {
    loadClip(`sfx/${name}.opus`).then((c) => { clips.set(name, c); }, (e: unknown) => console.warn(`sfx ${name}: ${String(e)}`));
  }
  void renderVoices().catch((e: unknown) => console.warn(`audio: ${String(e)}`));
}

/** Plays a logical event's sample. */
export function event(name: string): void {
  const file = SAMPLES[name];
  const clip = file ? clips.get(file) : undefined;
  if (!clip) return;
  const bus: Bus = INTERFACE.has(name) ? "interface" : "effects";
  try { playClip(clip, { bus, gain: LEVEL.effects }); }
  catch { /* the mixer is full this frame: skip it */ }
}

// -- rendered voices ------------------------------------------------------------------------
const RATE = 11025;
/** js/audio.js _envGain: exponential from 0.0001 to `peak` over `attack`, back to 0.0001 by `end`. */
function envelope(off: OfflineAudioContext, peak: number, attack: number, end: number): GainNode {
  const g = off.createGain();
  g.gain.setValueAtTime(0.0001, 0);
  g.gain.exponentialRampToValueAtTime(peak, attack);
  g.gain.exponentialRampToValueAtTime(0.0001, end);
  return g;
}
function voice(off: OfflineAudioContext, type: "sine" | "triangle", f: number, g: GainNode, end: number): void {
  const osc = off.createOscillator();
  osc.type = type; osc.frequency.value = f;
  osc.connect(g).connect(off.destination);
  osc.start(); osc.stop(end);
}
/** A pad chord (root × 0.5, × 0.75, × 1 sines) rising over 1.2 s and gone by `len` (eight beats). */
async function renderPad(root: number, len: number): Promise<AudioClip> {
  const off = new OfflineAudioContext(1, Math.round((len + 0.1) * RATE), RATE);
  for (const mult of [1, 1.5, 2]) voice(off, "sine", root * mult * 0.5, envelope(off, 0.035 / mult, 1.2, len), len);
  return createClip(await off.startRendering());
}
/** A triangle note: to 0.04 in 20 ms, gone by 0.6 s. */
async function renderNote(f: number): Promise<AudioClip> {
  const off = new OfflineAudioContext(1, Math.round(0.7 * RATE * 2), RATE * 2);
  voice(off, "triangle", f, envelope(off, 0.04, 0.02, 0.6), 0.6);
  return createClip(await off.startRendering());
}
/** A bass pulse: a sine to `peak` in 10 ms, gone by 0.18 s. */
async function renderBass(f: number, peak: number): Promise<AudioClip> {
  const off = new OfflineAudioContext(1, Math.round(0.25 * RATE), RATE);
  voice(off, "sine", f, envelope(off, peak, 0.01, 0.18), 0.18);
  return createClip(await off.startRendering());
}
/** An ambience chime (js/audio.js chime(): a sine and its octave at a quarter, 1.2 s). */
async function renderChime(f: number): Promise<AudioClip> {
  const off = new OfflineAudioContext(1, Math.round(1.3 * RATE * 2), RATE * 2);
  voice(off, "sine", f, envelope(off, 0.05, 0.01, 1.21), 1.21);
  voice(off, "sine", f * 2, envelope(off, 0.0125, 0.01, 0.85), 0.85);
  return createClip(await off.startRendering());
}
const ROOM_GAIN = 0.05;
/** The room tone: white noise looping every 6 s, lowpassed at 320 Hz: periodic once settled, so no seam. */
async function renderRoom(): Promise<AudioClip> {
  const n = 6 * RATE, settle = Math.round(0.25 * RATE);
  const off = new OfflineAudioContext(1, settle + n, RATE);
  const noise = off.createNoise({ seed: 0xc47d, seconds: 6 });
  const lp = off.createBiquadFilter();
  lp.type = "lowpass"; lp.frequency.value = 320; lp.Q.value = 0; // dB: linear Q 1
  const g = off.createGain();
  g.gain.value = ROOM_GAIN;
  noise.connect(lp).connect(g).connect(off.destination);
  noise.start();
  const r = await off.startRendering();
  return createClip([r.getChannelData(0).slice(settle)], RATE);
}

const pads = new Map<string, AudioClip>();
const notes = new Map<number, AudioClip>();
const bass: AudioClip[] = [];
const chimes = new Map<number, AudioClip>();
let room: AudioClip | null = null;
/** Every voice, one graph at a time (at most 16 may render at once); `room` last, as update()'s go. */
async function renderVoices(): Promise<void> {
  for (const beat of [1, 0.5]) for (let r = 0; r <= 3; r++) pads.set(`${r}:${beat}`, await renderPad(SCALE[r]!, beat * 8));
  for (let i = 3; i <= 8; i++) notes.set(i, await renderNote(SCALE[i]!));
  bass.push(await renderBass(110, 0.05), await renderBass(82.4, 0.03));
  for (let i = 5; i < SCALE.length; i++) chimes.set(i, await renderChime(SCALE[i]!));
  room = await renderRoom();
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

/** Each frame once the mixer runs and the voices are rendered: the music's beats and the ambience's chimes by mixer time. */
export function update(): void {
  if (context.state !== "running") return;
  if (!room) return;
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
