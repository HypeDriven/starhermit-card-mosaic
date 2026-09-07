// audio.js — procedural WebAudio for Card Mosaic.
// Everything is synthesized at runtime (oscillator envelopes + filtered noise
// bursts); no audio assets, no external libs. Musical pitch set is a warm
// A-minor pentatonic (A3–A5). Importing this module in a non-browser context
// must not throw: no AudioContext is created until resume() is called, and all
// browser API access is guarded.

import { createRng } from './rng.js';

// A minor pentatonic: A C D E G, around A3 (220 Hz) up to A5.
const SCALE = [220.0, 261.63, 293.66, 329.63, 392.0, 440.0, 523.25, 587.33, 659.26, 783.99, 880.0];

const BUSES = ['music', 'effects', 'ambience', 'voice'];

// Authored one-shot clips (sfx/<name>.opus, see sfx/manifest.json) mapped onto
// the same event names as the synth recipes below. Clips are fetched lazily —
// only after the user-gesture unlock created the AudioContext — and decoded
// once into a cache. While a clip is still loading (or if it failed to load)
// the existing synth recipe for that event plays instead.
const SFX_BY_EVENT = {
  select: 'card-select',
  place: 'card-place',
  recall: 'card-recall',
  swap: 'card-swap',
  rotate: 'card-rotate',
  lock: 'card-lock',
  invalid: 'invalid-move',
  match: 'edge-match',
  complete: 'mosaic-complete',
  fail: 'round-fail',
  pause: 'pause-toggle',
  hint: 'hint-reveal',
  achievement: 'achievement-unlock',
  uiOpen: 'ui-open',
  uiClose: 'ui-close',
};

// Per-event synth recipes. Each is a function of (engine, when, variant) that
// schedules its nodes on the effects bus. Variants come from the seeded RNG so
// a given session always sounds the same (replay-deterministic timbre).
function makeRecipes() {
  return {
    select(e, t, v) { e.blip(t, v.pitch(6, 8), 0.09, 'sine', 0.10); },
    place(e, t, v) { e.thump(t, 120 + v.detune(20), 0.14, 0.5); e.paperTap(t + 0.012, 0.05, 0.16); },
    recall(e, t, v) { e.paperTap(t, 0.07, 0.14); e.blip(t + 0.02, v.pitch(4, 6), 0.1, 'triangle', 0.08); },
    swap(e, t, v) { e.blip(t, v.pitch(3, 5), 0.08, 'triangle', 0.09); e.blip(t + 0.07, v.pitch(6, 8), 0.1, 'triangle', 0.09); },
    rotate(e, t, v) { e.blip(t, v.pitch(5, 7), 0.06, 'square', 0.05); e.blip(t + 0.05, v.pitch(5, 7), 0.07, 'triangle', 0.07); },
    lock(e, t, v) { e.chime(t, [v.pitch(5, 6), v.pitch(8, 9)], 0.12, 0.5, 0.12); },
    invalid(e, t, v) { e.thump(t, 90 + v.detune(10), 0.12, 0.35); e.blip(t, 110, 0.1, 'sine', 0.12); },
    match(e, t, v) { e.chime(t, [v.pitch(4, 5)], 0.18, 0.4, 0.08); },
    complete(e, t, v) { e.chime(t, [3, 5, 7, 9].map((i) => SCALE[i]), 0.5, 0.7, 0.14); },
    fail(e, t, v) { e.chime(t, [SCALE[3], SCALE[1], SCALE[0]], 0.4, 0.45, 0.12); },
    tick(e, t, v) { e.blip(t, SCALE[6], 0.03, 'sine', 0.05); },
    uiOpen(e, t, v) { e.blip(t, v.pitch(6, 8), 0.08, 'sine', 0.07); },
    uiClose(e, t, v) { e.blip(t, v.pitch(3, 5), 0.08, 'sine', 0.06); },
    pause(e, t, v) { e.blip(t, SCALE[5], 0.12, 'sine', 0.07); e.blip(t + 0.1, SCALE[2], 0.14, 'sine', 0.06); },
    hint(e, t, v) { e.chime(t, [v.pitch(6, 7), v.pitch(9, 10)], 0.3, 0.35, 0.08); },
    achievement(e, t, v) { e.chime(t, [SCALE[5], SCALE[7], SCALE[8], SCALE[10]], 0.6, 0.6, 0.1); },
  };
}

export class AudioEngine {
  /**
   * @param settings { audio: {music, effects, ambience, voice, muted} }
   */
  constructor(settings = {}) {
    const a = settings.audio || {};
    this._busVolumes = {
      music: a.music ?? 0.7,
      effects: a.effects ?? 0.9,
      ambience: a.ambience ?? 0.5,
      voice: a.voice ?? 0.8,
    };
    this._muted = !!a.muted;
    this._ctx = null;
    this._master = null;
    this._buses = {};
    this._noiseBuffer = null;
    this._recipes = makeRecipes();
    this._seedString = 'cardmosaic-default';
    this._rng = createRng(this._seedString).fork('audio');
    // ambience / music scheduler state
    this._ambTheme = null;
    this._ambTimer = null;
    this._ambChimeAt = 0;
    this._musicLevel = 0;
    this._musicTimer = null;
    this._musicNextAt = 0;
    this._musicStep = 0;
    this._ducked = false;
    this._disposed = false;
    // sfx clip cache: name -> AudioBuffer | null (null = load failed, don't retry)
    this._sfxBuffers = new Map();
    this._sfxLoading = new Map();
  }

  // -------------------------------------------------------------------------
  // context lifecycle
  // -------------------------------------------------------------------------

  /** Create/unlock the AudioContext. Safe to call repeatedly (gesture unlock). */
  resume() {
    if (this._disposed) return;
    if (typeof window === 'undefined') return;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    if (!this._ctx) {
      this._ctx = new AC();
      this._master = this._ctx.createGain();
      this._master.gain.value = this._muted ? 0 : 1;
      this._master.connect(this._ctx.destination);
      for (const bus of BUSES) {
        const g = this._ctx.createGain();
        g.gain.value = this._busVolumes[bus];
        g.connect(this._master);
        this._buses[bus] = g;
      }
      this._makeNoiseBuffer();
      if (this._ambTheme) this._startAmbienceScheduler();
      if (this._musicLevel > 0) this._startMusicScheduler();
    }
    if (this._ctx.state === 'suspended') {
      this._ctx.resume().catch(() => {});
    }
  }

  /** Suspend the context (page hidden, pause menu). */
  suspend() {
    if (this._ctx && this._ctx.state === 'running') {
      this._ctx.suspend().catch(() => {});
    }
  }

  // -------------------------------------------------------------------------
  // seeded variants — call when a round starts so replays sound identical
  // -------------------------------------------------------------------------

  setSeed(seedString) {
    this._seedString = String(seedString);
    this._rng = createRng(this._seedString).fork('audio');
  }

  _variant() {
    const rng = this._rng;
    return {
      pitch: (lo, hi) => SCALE[rng.intRange(lo, Math.min(hi, SCALE.length - 1))],
      detune: (cents) => rng.intRange(-cents, cents),
    };
  }

  // -------------------------------------------------------------------------
  // buses
  // -------------------------------------------------------------------------

  setBusVolume(bus, v) {
    if (!BUSES.includes(bus)) return;
    const clamped = Math.max(0, Math.min(1, v));
    this._busVolumes[bus] = clamped;
    const g = this._buses[bus];
    if (g && this._ctx) this._ramp(g.gain, clamped, 0.05);
  }

  getBusVolume(bus) {
    return this._busVolumes[bus] ?? 0;
  }

  setMuted(b) {
    this._muted = !!b;
    if (this._master && this._ctx) this._ramp(this._master.gain, this._muted ? 0 : 1, 0.05);
  }

  isMuted() { return this._muted; }

  /** Duck the master bus while an overlay is open. */
  duck() {
    this._ducked = true;
    if (this._master && this._ctx) this._ramp(this._master.gain, this._muted ? 0 : 0.25, 0.15);
  }

  unduck() {
    this._ducked = false;
    if (this._master && this._ctx) this._ramp(this._master.gain, this._muted ? 0 : 1, 0.15);
  }

  // -------------------------------------------------------------------------
  // event sounds
  // -------------------------------------------------------------------------

  playEvent(name, opts = {}) {
    if (!this._ctx || this._ctx.state !== 'running' || this._muted) return;
    if (this._playSampleFor(name)) return;
    const recipe = this._recipes[name];
    if (!recipe) return;
    const t = this._ctx.currentTime + 0.01;
    try {
      recipe(this, t, this._variant(), opts);
    } catch {
      /* never let audio break gameplay */
    }
  }

  /**
   * Try the authored sample for an event. Returns true when a decoded clip
   * was scheduled on the effects bus (synth recipe must then be skipped).
   * Returns false while the clip is loading or after a load failure, so the
   * caller falls back to synthesis; a fetch is kicked off in the background.
   */
  _playSampleFor(name) {
    const clip = SFX_BY_EVENT[name];
    if (!clip || !this._ctx || typeof fetch !== 'function') return false;
    if (this._sfxBuffers.has(clip)) {
      const buffer = this._sfxBuffers.get(clip);
      if (!buffer) return false;
      try {
        const src = this._ctx.createBufferSource();
        src.buffer = buffer;
        src.connect(this._buses.effects || this._master);
        src.start();
      } catch {
        /* never let audio break gameplay */
      }
      return true;
    }
    this._loadClip(clip);
    return false;
  }

  /** Fire-and-forget fetch + decode of one clip; caches result or failure. */
  _loadClip(clip) {
    if (this._sfxLoading.has(clip)) return;
    const pending = fetch(`sfx/${clip}.opus`)
      .then((res) => {
        if (!res.ok) throw new Error(`http ${res.status}`);
        return res.arrayBuffer();
      })
      .then((bytes) => (this._ctx ? this._ctx.decodeAudioData(bytes) : null))
      .then((buffer) => {
        this._sfxBuffers.set(clip, buffer || null);
      })
      .catch(() => {
        this._sfxBuffers.set(clip, null);
      })
      .finally(() => {
        this._sfxLoading.delete(clip);
      });
    this._sfxLoading.set(clip, pending);
  }

  // -------------------------------------------------------------------------
  // primitive voices (all scheduled on the effects bus)
  // -------------------------------------------------------------------------

  _ramp(param, target, seconds) {
    // exponential ramps only — never a nonzero->nonzero set, so no clicks
    const now = this._ctx.currentTime;
    const from = Math.max(0.0001, param.value);
    param.setValueAtTime(from, now);
    param.exponentialRampToValueAtTime(Math.max(0.0001, target), now + Math.max(0.01, seconds));
  }

  _envGain(bus, peak, attack, decay, when) {
    const g = this._ctx.createGain();
    g.gain.setValueAtTime(0.0001, when);
    g.gain.exponentialRampToValueAtTime(Math.max(0.0001, peak), when + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, when + attack + decay);
    g.connect(this._buses[bus] || this._master);
    return g;
  }

  /** Short pitched blip. */
  blip(when, freq, dur, type = 'sine', peak = 0.1, bus = 'effects') {
    if (!this._ctx) return;
    const osc = this._ctx.createOscillator();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, when);
    const g = this._envGain(bus, peak, 0.008, dur, when);
    osc.connect(g);
    osc.start(when);
    osc.stop(when + dur + 0.05);
  }

  /** Two-or-more-note chime; freqs spaced by `gap` seconds. */
  chime(when, freqs, dur, peak = 0.4, gap = 0.1, bus = 'effects') {
    if (!this._ctx) return;
    const per = peak / Math.max(1, freqs.length);
    freqs.forEach((f, i) => {
      const t = when + i * gap;
      const osc = this._ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(f, t);
      // gentle shimmer partial
      const osc2 = this._ctx.createOscillator();
      osc2.type = 'sine';
      osc2.frequency.setValueAtTime(f * 2, t);
      const g = this._envGain(bus, per, 0.01, dur, t);
      const g2 = this._envGain(bus, per * 0.25, 0.01, dur * 0.7, t);
      osc.connect(g);
      osc2.connect(g2);
      osc.start(t); osc.stop(t + dur + 0.1);
      osc2.start(t); osc2.stop(t + dur + 0.1);
    });
  }

  /** Soft felt thump: low sine with fast pitch drop. */
  thump(when, freq, dur, peak = 0.5, bus = 'effects') {
    if (!this._ctx) return;
    const osc = this._ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(freq, when);
    osc.frequency.exponentialRampToValueAtTime(Math.max(20, freq * 0.5), when + dur);
    const g = this._envGain(bus, peak, 0.004, dur, when);
    osc.connect(g);
    osc.start(when);
    osc.stop(when + dur + 0.05);
  }

  /** Paper tap: short band-passed noise burst. */
  paperTap(when, dur, peak = 0.15, bus = 'effects', center = 2400) {
    if (!this._ctx || !this._noiseBuffer) return;
    const src = this._ctx.createBufferSource();
    src.buffer = this._noiseBuffer;
    const filt = this._ctx.createBiquadFilter();
    filt.type = 'bandpass';
    filt.frequency.setValueAtTime(center, when);
    filt.Q.value = 1.2;
    const g = this._envGain(bus, peak, 0.003, dur, when);
    src.connect(filt).connect(g);
    src.start(when);
    src.stop(when + dur + 0.05);
  }

  _makeNoiseBuffer() {
    const len = Math.floor(this._ctx.sampleRate * 1.0);
    const buf = this._ctx.createBuffer(1, len, this._ctx.sampleRate);
    const data = buf.getChannelData(0);
    // deterministic-ish noise from the session rng is fine for a buffer we reuse
    const rng = createRng(this._seedString + ':noise');
    for (let i = 0; i < len; i++) data[i] = rng.float() * 2 - 1;
    this._noiseBuffer = buf;
  }

  // -------------------------------------------------------------------------
  // ambience — quiet room tone + sparse chimes, density varies by theme
  // -------------------------------------------------------------------------

  startAmbience(themeId = 'studio') {
    this._ambTheme = themeId;
    if (!this._ctx) return;
    this._startAmbienceScheduler();
  }

  _startAmbienceScheduler() {
    if (this._ambTimer || !this._ctx) return;
    // room tone: looped filtered noise, very quiet
    if (this._noiseBuffer && !this._roomTone) {
      const src = this._ctx.createBufferSource();
      src.buffer = this._noiseBuffer;
      src.loop = true;
      const filt = this._ctx.createBiquadFilter();
      filt.type = 'lowpass';
      filt.frequency.value = 320;
      const g = this._ctx.createGain();
      g.gain.value = 0.0001;
      src.connect(filt).connect(g).connect(this._buses.ambience);
      src.start();
      // fade in
      g.gain.setValueAtTime(0.0001, this._ctx.currentTime);
      g.gain.exponentialRampToValueAtTime(0.05, this._ctx.currentTime + 2);
      this._roomTone = { src, g };
    }
    const density = { studio: 0.5, slate: 0.25, verdant: 0.7, ember: 0.4, porcelain: 0.3 };
    const d = density[this._ambTheme] ?? 0.4;
    this._ambChimeAt = this._ctx.currentTime + 2;
    this._ambTimer = setInterval(() => {
      if (!this._ctx || this._ctx.state !== 'running' || this._muted) return;
      const horizon = this._ctx.currentTime + 3;
      while (this._ambChimeAt < horizon) {
        if (this._rng.float() < d) {
          const f = SCALE[this._rng.intRange(5, SCALE.length - 1)];
          this.chime(this._ambChimeAt, [f], 1.2, 0.05, 0, 'ambience');
        }
        this._ambChimeAt += 4 + this._rng.float() * 8;
      }
    }, 1500);
  }

  stopAmbience() {
    this._ambTheme = null;
    if (this._ambTimer) { clearInterval(this._ambTimer); this._ambTimer = null; }
    if (this._roomTone && this._ctx) {
      const { src, g } = this._roomTone;
      const now = this._ctx.currentTime;
      g.gain.setValueAtTime(Math.max(0.0001, g.gain.value), now);
      g.gain.exponentialRampToValueAtTime(0.0001, now + 0.8);
      setTimeout(() => { try { src.stop(); } catch {} }, 1000);
      this._roomTone = null;
    }
  }

  // -------------------------------------------------------------------------
  // adaptive music — small lookahead scheduler; intensity 0|1|2
  // -------------------------------------------------------------------------

  setMusicIntensity(level) {
    const lv = level === 2 ? 2 : level === 1 ? 1 : 0;
    if (lv === this._musicLevel) return;
    this._musicLevel = lv;
    if (!this._ctx) return;
    if (lv === 0) {
      this.stopMusic();
    } else {
      this._startMusicScheduler();
    }
  }

  _startMusicScheduler() {
    if (this._musicTimer || !this._ctx) return;
    this._musicNextAt = this._ctx.currentTime + 0.1;
    this._musicStep = 0;
    const rng = createRng(this._seedString + ':music');
    this._musicTimer = setInterval(() => {
      if (!this._ctx || this._ctx.state !== 'running' || this._muted) return;
      const horizon = this._ctx.currentTime + 0.6;
      const beat = this._musicLevel === 2 ? 0.5 : 1.0;
      while (this._musicNextAt < horizon) {
        const t = this._musicNextAt;
        const step = this._musicStep;
        // sparse pad every 8 steps (both intensities)
        if (step % 8 === 0) {
          const root = SCALE[rng.intRange(0, 3)];
          for (const mult of [1, 1.5, 2]) {
            const osc = this._ctx.createOscillator();
            osc.type = 'sine';
            osc.frequency.setValueAtTime(root * mult * 0.5, t);
            const g = this._ctx.createGain();
            g.gain.setValueAtTime(0.0001, t);
            g.gain.exponentialRampToValueAtTime(0.035 / mult, t + 1.2);
            g.gain.exponentialRampToValueAtTime(0.0001, t + beat * 8);
            osc.connect(g).connect(this._buses.music);
            osc.start(t);
            osc.stop(t + beat * 8 + 0.1);
          }
        }
        // slow arpeggio on odd steps
        if (step % 2 === 1 && rng.float() < 0.6) {
          const f = SCALE[rng.intRange(3, 8)];
          const osc = this._ctx.createOscillator();
          osc.type = 'triangle';
          osc.frequency.setValueAtTime(f, t);
          const g = this._ctx.createGain();
          g.gain.setValueAtTime(0.0001, t);
          g.gain.exponentialRampToValueAtTime(0.04, t + 0.02);
          g.gain.exponentialRampToValueAtTime(0.0001, t + 0.6);
          osc.connect(g).connect(this._buses.music);
          osc.start(t);
          osc.stop(t + 0.7);
        }
        // gentle pulse at intensity 2
        if (this._musicLevel === 2 && step % 2 === 0) {
          const osc = this._ctx.createOscillator();
          osc.type = 'sine';
          osc.frequency.setValueAtTime(step % 4 === 0 ? 110 : 82.4, t);
          const g = this._ctx.createGain();
          g.gain.setValueAtTime(0.0001, t);
          g.gain.exponentialRampToValueAtTime(step % 4 === 0 ? 0.05 : 0.03, t + 0.01);
          g.gain.exponentialRampToValueAtTime(0.0001, t + 0.18);
          osc.connect(g).connect(this._buses.music);
          osc.start(t);
          osc.stop(t + 0.25);
        }
        this._musicNextAt += beat;
        this._musicStep++;
      }
    }, 250);
  }

  stopMusic() {
    this._musicLevel = 0;
    if (this._musicTimer) { clearInterval(this._musicTimer); this._musicTimer = null; }
  }

  // -------------------------------------------------------------------------

  dispose() {
    this._disposed = true;
    this.stopMusic();
    this.stopAmbience();
    if (this._ctx) {
      this._ctx.close().catch(() => {});
      this._ctx = null;
      this._master = null;
      this._buses = {};
    }
  }
}
