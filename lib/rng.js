'use strict';

/**
 * rng.js
 *
 * Seedable, serialisable PRNG. Reproducibility is a hard requirement: the same
 * engine powers the balance simulator, and a Monte Carlo run that cannot be
 * replayed cannot be debugged.
 *
 * mulberry32 — 32 bits of state, so save/restore is a single integer, which is
 * what makes transaction rollback able to un-roll a generator (see engine.js).
 */

// ─── Rng ──────────────────────────────────────────────────────────────────────

class Rng {
  /** @param {number|string} seed */
  constructor(seed = 0) {
    this.state = Rng.hashSeed(seed);
  }

  /** Accept string seeds so scenarios can be named ("harvest-run-3"). */
  static hashSeed(seed) {
    if (typeof seed === 'number') return seed >>> 0;
    let h = 2166136261 >>> 0;
    for (const ch of String(seed)) {
      h ^= ch.charCodeAt(0);
      h = Math.imul(h, 16777619);
    }
    return h >>> 0;
  }

  /** Float in [0, 1). */
  next() {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), 1 | t);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** Integer in [0, n). */
  int(n) {
    return Math.floor(this.next() * n);
  }

  /**
   * Weighted selection. Weights need not sum to 100 (or to anything).
   * Entries with weight <= 0 can never be selected.
   */
  pickWeighted(entries, weightOf = e => e.weight) {
    let total = 0;
    for (const entry of entries) {
      const w = weightOf(entry);
      if (w > 0) total += w;
    }
    if (total <= 0) return null;

    let roll = this.next() * total;
    for (const entry of entries) {
      const w = weightOf(entry);
      if (w <= 0) continue;
      roll -= w;
      if (roll < 0) return entry;
    }
    return entries[entries.length - 1]; // float slop guard
  }

  /** Opaque state snapshot, for transaction rollback and sim checkpoints. */
  save() {
    return this.state;
  }

  restore(state) {
    this.state = state >>> 0;
  }
}

module.exports = { Rng };
