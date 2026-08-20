'use strict';

/**
 * clock.js
 *
 * Virtual clock. Steam's playtimegenerator timers and manual-promo intervals
 * run on real wall-clock playtime, which makes a monthly faction token or a
 * six-week progression curve untestable against live Steam. Every time-dependent
 * decision in the engine reads this object instead of Date.now(), so those
 * become millisecond unit tests.
 *
 * Two distinct quantities are tracked, because Steam distinguishes them:
 *   • wall time    — advances always; gates drop_window and drop_start_time
 *   • playtime     — advances only while "playing"; gates drop_interval
 *
 * advanceTime(minutes) advances both by default (the player is playing). Pass
 * { playing: false } to model time passing between sessions.
 */

const { parseSteamTime, formatSteamTime } = require('./grammar');

const MS_PER_MINUTE = 60 * 1000;

// ─── VirtualClock ─────────────────────────────────────────────────────────────

class VirtualClock {
  /**
   * @param {object} [options]
   * @param {number|string} [options.start] epoch ms or Steam timestamp string
   */
  constructor(options = {}) {
    const start = options.start != null ? options.start : Date.UTC(2026, 0, 1, 0, 0, 0);
    this.startMs = typeof start === 'string' ? parseSteamTime(start) : start;
    this.nowMs = this.startMs;
    this.playtimeMinutes = 0;
  }

  /**
   * Advance the clock.
   * @param {number} minutes
   * @param {object} [options]
   * @param {boolean} [options.playing=true] whether playtime accrues too
   */
  advance(minutes, options = {}) {
    if (!(minutes >= 0)) throw new Error(`advance() needs a non-negative minute count, got ${minutes}`);
    const playing = options.playing !== false;
    this.nowMs += minutes * MS_PER_MINUTE;
    if (playing) this.playtimeMinutes += minutes;
    return this;
  }

  /** Advance playtime without advancing wall time (session compression). */
  advancePlaytimeOnly(minutes) {
    this.playtimeMinutes += minutes;
    return this;
  }

  now() {
    return this.nowMs;
  }

  playtime() {
    return this.playtimeMinutes;
  }

  /** "20260101T000000Z" — the format drop_start_time uses. */
  toSteamTime() {
    return formatSteamTime(this.nowMs);
  }

  snapshot() {
    return { nowMs: this.nowMs, playtimeMinutes: this.playtimeMinutes };
  }

  restore(snap) {
    this.nowMs = snap.nowMs;
    this.playtimeMinutes = snap.playtimeMinutes;
  }
}

/**
 * Adapter with the same surface, backed by real time, for the day a conformance
 * run needs to execute against a provider that cannot be time-travelled.
 * advance() is a no-op — tests that need time control must check
 * provider.capabilities.virtualClock first.
 */
class RealClock {
  constructor() {
    this.startMs = Date.now();
  }
  advance() {
    return this;
  }
  advancePlaytimeOnly() {
    return this;
  }
  now() {
    return Date.now();
  }
  playtime() {
    return (Date.now() - this.startMs) / MS_PER_MINUTE;
  }
  toSteamTime() {
    return formatSteamTime(Date.now());
  }
  snapshot() {
    return {};
  }
  restore() {}
}

module.exports = { VirtualClock, RealClock, MS_PER_MINUTE };
