'use strict';

/**
 * unit/rng-clock.test.js — determinism and time control.
 */

const test = require('node:test');
const assert = require('node:assert');

const { Rng } = require('../../lib/rng');
const { VirtualClock } = require('../../lib/clock');

// ─── Rng ──────────────────────────────────────────────────────────────────────

test('rng: the same seed produces the same stream', () => {
  const a = new Rng('seed-a');
  const b = new Rng('seed-a');
  const c = new Rng('seed-b');

  const draw = rng => Array.from({ length: 8 }, () => rng.next());
  assert.deepEqual(draw(a), draw(b));
  assert.notDeepEqual(draw(new Rng('seed-a')), draw(c));
});

test('rng: numeric and string seeds are both accepted', () => {
  assert.deepEqual(new Rng(7).next(), new Rng(7).next());
  assert.equal(typeof new Rng('name').next(), 'number');
});

test('rng: save/restore rewinds the stream exactly', () => {
  const rng = new Rng(42);
  rng.next();
  const state = rng.save();
  const expected = [rng.next(), rng.next()];
  rng.restore(state);
  assert.deepEqual([rng.next(), rng.next()], expected);
});

test('rng: values stay in [0,1)', () => {
  const rng = new Rng('range');
  for (let i = 0; i < 10000; i++) {
    const value = rng.next();
    assert.ok(value >= 0 && value < 1, `out of range: ${value}`);
  }
});

test('rng: weighted picks follow the weights and skip zero-weight entries', () => {
  const rng = new Rng('weights');
  const entries = [{ id: 'a', weight: 3 }, { id: 'b', weight: 1 }, { id: 'c', weight: 0 }];
  const counts = { a: 0, b: 0, c: 0 };
  for (let i = 0; i < 8000; i++) counts[rng.pickWeighted(entries).id]++;

  assert.equal(counts.c, 0, 'weight 0 is never selected');
  const ratio = counts.a / (counts.a + counts.b);
  assert.ok(Math.abs(ratio - 0.75) < 0.02, `ratio ${ratio}`);
});

test('rng: an all-zero weight set selects nothing', () => {
  assert.equal(new Rng(1).pickWeighted([{ weight: 0 }]), null);
});

// ─── VirtualClock ─────────────────────────────────────────────────────────────

test('clock: advancing moves wall time and playtime together', () => {
  const clock = new VirtualClock();
  const start = clock.now();
  clock.advance(90);
  assert.equal(clock.now(), start + 90 * 60000);
  assert.equal(clock.playtime(), 90);
});

test('clock: time away from the game does not accrue playtime', () => {
  const clock = new VirtualClock();
  clock.advance(600, { playing: false });
  assert.equal(clock.playtime(), 0);
  assert.ok(clock.now() > clock.startMs);
});

test('clock: it can start at a Steam timestamp and print one', () => {
  const clock = new VirtualClock({ start: '20260601T000000Z' });
  assert.equal(clock.toSteamTime(), '20260601T000000Z');
  clock.advance(60);
  assert.equal(clock.toSteamTime(), '20260601T010000Z');
});

test('clock: negative advances are rejected', () => {
  assert.throws(() => new VirtualClock().advance(-1), /non-negative/);
});
