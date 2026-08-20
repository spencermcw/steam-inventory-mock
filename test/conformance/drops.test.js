'use strict';

/**
 * conformance/drops.test.js
 *
 * Playtime item drops, against the virtual clock.
 *
 * These are the tests that cannot exist without the mock. drop_interval and
 * drop_window run on real wall-clock playtime, so a daily cap or a monthly
 * interval is not testable against live Steam in any practical sense; here each
 * one is a millisecond unit test.
 */

const test = require('node:test');
const assert = require('node:assert');

const h = require('../harness');
const fixtures = require('../fixtures/synthetic');

const provider = (options = {}) => h.createProvider({ schema: fixtures, ...options });

/** Trigger a drop and report whether anything was actually granted. */
async function drop(p, defId) {
  const result = await h.call(p, 'triggerItemDrop', defId);
  assert.equal(result.status, h.RESULT.OK, `triggerItemDrop should not error: ${result.reason || ''}`);
  return result.items.length > 0;
}

test('drops: nothing is granted before drop_interval playtime has accrued', { skip: h.needs('customSchema', 'virtualClock') }, async () => {
  const p = provider(); // 9050: drop_interval 30
  assert.equal(await drop(p, 9050), false);

  p.advanceTime(29);
  assert.equal(await drop(p, 9050), false);

  p.advanceTime(1);
  assert.equal(await drop(p, 9050), true);
  assert.equal(await h.countOf(p, 9001), 1);
});

test('drops: an ineligible drop is a successful call with no items, not an error', { skip: h.needs('customSchema', 'virtualClock') }, async () => {
  const p = provider();
  const result = await h.call(p, 'triggerItemDrop', 9050);
  assert.equal(result.status, h.RESULT.OK);
  assert.equal(result.items.length, 0);
});

test('drops: the interval restarts after each grant', { skip: h.needs('customSchema', 'virtualClock') }, async () => {
  const p = provider();
  p.advanceTime(30);
  assert.equal(await drop(p, 9050), true);
  assert.equal(await drop(p, 9050), false, 'no free second drop');
  p.advanceTime(30);
  assert.equal(await drop(p, 9050), true);
});

test('drops: drop_max_per_window caps grants until the window elapses', { skip: h.needs('customSchema', 'virtualClock') }, async () => {
  // 9050: drop_interval 30, drop_window 1440, drop_max_per_window 3
  const p = provider();
  for (let i = 0; i < 3; i++) {
    p.advanceTime(30);
    assert.equal(await drop(p, 9050), true, `grant ${i + 1} of 3`);
  }
  p.advanceTime(30);
  assert.equal(await drop(p, 9050), false, 'window cap reached — cool-down');
  assert.equal(await h.countOf(p, 9001), 3);

  p.advanceTime(1440); // past the end of the window
  assert.equal(await drop(p, 9050), true, 'new window, drops resume');
});

test('drops: drop_max_per_window is capped at 10 however large the itemdef says', { skip: h.needs('customSchema', 'virtualClock') }, async () => {
  // 9052 asks for 25 per window; Valve limits it to 10.
  const p = provider();
  let granted = 0;
  for (let i = 0; i < 15; i++) {
    p.advanceTime(1);
    if (await drop(p, 9052)) granted++;
  }
  assert.equal(granted, 10);
});

test('drops: use_drop_limit stops drops permanently at drop_limit', { skip: h.needs('customSchema', 'virtualClock') }, async () => {
  const p = provider(); // 9051: drop_interval 1, drop_limit 2
  for (let i = 0; i < 5; i++) {
    p.advanceTime(1);
    await drop(p, 9051);
  }
  assert.equal(await h.countOf(p, 9002), 2);
});

test('drops: drop_limit 0 retires a generator entirely', { skip: h.needs('customSchema', 'virtualClock') }, async () => {
  // The documented mechanism for switching off a deprecated drop.
  const p = provider();
  p.advanceTime(10000);
  assert.equal(await drop(p, 9053), false);
});

test('drops: itemdefs with their own settings are tracked independently', { skip: h.needs('customSchema', 'virtualClock') }, async () => {
  const p = provider();
  p.advanceTime(30);
  assert.equal(await drop(p, 9050), true, 'itemdef with own settings');
  assert.equal(await drop(p, 9054), true, 'bare generator has its own (app) budget');
});

test('drops: bare playtimegenerators share one app-level budget', { skip: h.needs('customSchema', 'virtualClock') }, async () => {
  // 9054 and 9055 specify no drop settings at all, so per Valve they share a
  // budget with each other and with the app-level drop interval (default 30).
  const p = provider();
  p.advanceTime(30);
  assert.equal(await drop(p, 9054), true);
  assert.equal(await drop(p, 9055), false, 'the shared budget was just spent');

  p.advanceTime(30);
  assert.equal(await drop(p, 9055), true);
});

test('drops: triggering a non-playtimegenerator is rejected', { skip: h.needs('customSchema') }, async () => {
  const p = provider();
  const result = await h.call(p, 'triggerItemDrop', 9001);
  assert.equal(result.status, h.RESULT.INVALID_PARAM);
});

test('drops: wall-clock time alone does not accrue playtime', { skip: h.needs('customSchema', 'virtualClock') }, async () => {
  const p = provider();
  p.advanceTime(1000, { playing: false });
  assert.equal(await drop(p, 9050), false, 'the player was not playing');
  p.advanceTime(30);
  assert.equal(await drop(p, 9050), true);
});

// ─── bypassDropGating (test-mode) ──────────────────────────────────────────────

test('drops: bypassDropGating off leaves interval/limit gating unchanged', { skip: h.needs('customSchema', 'virtualClock', 'gatingBypass') }, async () => {
  const p = provider({ bypassDropGating: false }); // 9051: drop_interval 1, drop_limit 2
  assert.equal(await drop(p, 9051), false, 'no playtime accrued yet');
  p.advanceTime(1);
  assert.equal(await drop(p, 9051), true);
  p.advanceTime(1);
  assert.equal(await drop(p, 9051), true);
  p.advanceTime(1);
  assert.equal(await drop(p, 9051), false, 'drop_limit reached');
});

test('drops: bypassDropGating grants unlimited claims at t+0, past drop_interval/drop_limit/drop_max_per_window', { skip: h.needs('customSchema', 'virtualClock', 'gatingBypass') }, async () => {
  const p = provider({ bypassDropGating: true }); // 9051: drop_interval 1, drop_limit 2
  for (let i = 0; i < 5; i++) {
    assert.equal(await drop(p, 9051), true, `claim ${i + 1} of 5 at t+0, no wait`);
  }
  assert.equal(await h.countOf(p, 9002), 5, 'drop_limit of 2 did not cap the bypassed grants');
});

test('drops: bypassDropGating still rejects a non-playtimegenerator', { skip: h.needs('customSchema', 'virtualClock', 'gatingBypass') }, async () => {
  const p = provider({ bypassDropGating: true });
  const result = await h.call(p, 'triggerItemDrop', 9001); // a plain item
  assert.equal(result.status, h.RESULT.INVALID_PARAM, 'the type gate is not part of the bypass');
});

test('drops: bypassDropGating can be toggled live on provider.engine.options, without reconstructing the provider', { skip: h.needs('customSchema', 'virtualClock', 'gatingBypass') }, async () => {
  const p = provider(); // bypassDropGating defaults to false
  assert.equal(await drop(p, 9051), false, 'gated at t+0 with the flag off');

  p.engine.options.bypassDropGating = true;
  assert.equal(await drop(p, 9051), true, 'granted immediately once the live toggle flips on');
  assert.equal(await drop(p, 9051), true, 'and again, past drop_limit 2');

  p.engine.options.bypassDropGating = false;
  assert.equal(await drop(p, 9051), false, 'gating resumes immediately once toggled back off');
});
