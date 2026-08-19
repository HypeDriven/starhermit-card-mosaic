// rng.js — deterministic seeded random streams.
// Pure ES module, no dependencies. Used by rules, content and cosmetic layers
// with separate streams so cosmetic randomness can never influence rules.

/** FNV-1a 32-bit hash of a string, returned as unsigned int. */
export function hashString(str) {
  let h = 0x811c9dc5 >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** mulberry32 PRNG core. */
function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * A named deterministic random stream.
 * Streams are forked by name so `rules`, `content` and `cosmetic` randomness
 * never share a sequence.
 */
export class RngStream {
  constructor(seedInt, name = 'root') {
    this.name = name;
    this._next = mulberry32(seedInt >>> 0);
  }
  /** float in [0, 1) */
  float() { return this._next(); }
  /** integer in [0, n) */
  int(n) { return Math.floor(this._next() * n); }
  /** integer in [min, max] inclusive */
  intRange(min, max) { return min + Math.floor(this._next() * (max - min + 1)); }
  /** random element */
  pick(arr) { return arr[this.int(arr.length)]; }
  /** in-place deterministic Fisher–Yates shuffle; returns the array */
  shuffle(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = this.int(i + 1);
      const t = arr[i]; arr[i] = arr[j]; arr[j] = t;
    }
    return arr;
  }
  /** fork an independent named sub-stream */
  fork(name) {
    return new RngStream((hashString(this.name + ':' + name) ^ Math.floor(this._next() * 0xffffffff)) >>> 0, this.name + ':' + name);
  }
}

/** Create the root stream for a string seed (e.g. "cm-daily-2026-08-18"). */
export function createRng(seedString) {
  return new RngStream(hashString(String(seedString)), String(seedString));
}
