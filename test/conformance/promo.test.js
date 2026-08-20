'use strict';

/**
 * conformance/promo.test.js
 *
 * Promo grants: once-per-account by default, plus the `manual` + `drop_interval`
 * recurrence that is the native mechanism behind the monthly faction-change
 * token (Steam Constraints → Promo items).
 */

const test = require('node:test');
const assert = require('node:assert');

const h = require('../harness');
const fixtures = require('../../examples/economy');

const provider = (options = {}) => h.createProvider({ schema: fixtures, ...options });

async function promo(p, defId) {
  const result = await h.call(p, 'addPromoItem', defId);
  assert.equal(result.status, h.RESULT.OK, `addPromoItem should not error: ${result.reason || ''}`);
  return result.items.length > 0;
}

test('promo: a manual promo grants once per account', { skip: h.needs('customSchema') }, async () => {
  const p = provider();
  assert.equal(await promo(p, 9060), true);
  assert.equal(await h.countOf(p, 9001), 5);
  assert.equal(await h.countOf(p, 9002), 2);

  assert.equal(await promo(p, 9060), false, 'second call grants nothing');
  assert.equal(await h.countOf(p, 9001), 5, 'inventory unchanged');
});

test('promo: a promo bundle expands on grant', { skip: h.needs('customSchema') }, async () => {
  const p = provider();
  await promo(p, 9060);
  assert.equal(await h.countOf(p, 9060), 0, 'the bundle itself is never held');
});

test('promo: manual + drop_interval recurs on schedule', { skip: h.needs('customSchema', 'virtualClock') }, async () => {
  const p = provider(); // 9061: drop_interval 10080 (one week)
  assert.equal(await promo(p, 9061), true);
  assert.equal(await promo(p, 9061), false);

  p.advanceTime(10079);
  assert.equal(await promo(p, 9061), false, 'a minute short');

  p.advanceTime(1);
  assert.equal(await promo(p, 9061), true);
  assert.equal(await h.countOf(p, 9061), 2);
});

test('promo: drop_start_time gates the earliest grant', { skip: h.needs('customSchema', 'virtualClock') }, async () => {
  // The clock starts 2026-01-01; 9065 opens 2026-06-01.
  const p = provider();
  assert.equal(await promo(p, 9065), false);

  p.advanceTime(152 * 24 * 60); // ~5 months
  assert.equal(await promo(p, 9065), true);
});

test('promo: owns: rules read app ownership', { skip: h.needs('customSchema', 'entitlements') }, async () => {
  const without = provider();
  assert.equal(await promo(without, 9062), false);

  const withApp = provider();
  h.setEntitlements(withApp, { ownsApps: [440] });
  assert.equal(await promo(withApp, 9062), true);
});

test('promo: ach: rules read achievements', { skip: h.needs('customSchema', 'entitlements') }, async () => {
  const p = provider();
  assert.equal(await promo(p, 9063), false);
  h.setEntitlements(p, { achievements: ['first_landing'] });
  assert.equal(await promo(p, 9063), true);
});

test('promo: played: rules read per-app playtime, including the minutes threshold', { skip: h.needs('customSchema', 'entitlements') }, async () => {
  const short = provider();
  h.setEntitlements(short, { playtime: { 570: 14 } });
  assert.equal(await promo(short, 9064), false);

  const long = provider();
  h.setEntitlements(long, { playtime: { 570: 15 } });
  assert.equal(await promo(long, 9064), true);
});

test('promo: a non-promo itemdef is rejected', { skip: h.needs('customSchema') }, async () => {
  const p = provider();
  const result = await h.call(p, 'addPromoItem', 9001);
  assert.equal(result.status, h.RESULT.INVALID_PARAM);
});

test('promo: an unknown itemdef is rejected', { skip: h.needs('customSchema') }, async () => {
  const p = provider();
  const result = await h.call(p, 'addPromoItem', 424242);
  assert.equal(result.status, h.RESULT.INVALID_PARAM);
});

// ─── bypassPromoGating (test-mode) ─────────────────────────────────────────────

test('promo: bypassPromoGating off leaves once-per-account gating unchanged', { skip: h.needs('customSchema', 'gatingBypass') }, async () => {
  const p = provider({ bypassPromoGating: false });
  assert.equal(await promo(p, 9060), true);
  assert.equal(await promo(p, 9060), false, 'second call grants nothing');
});

test('promo: bypassPromoGating allows re-claiming a once-per-account promo repeatedly', { skip: h.needs('customSchema', 'gatingBypass') }, async () => {
  const p = provider({ bypassPromoGating: true });
  assert.equal(await promo(p, 9060), true);
  assert.equal(await promo(p, 9060), true, 'once-per-account bypassed');
  assert.equal(await promo(p, 9060), true, 'again, still no wait');
  assert.equal(await h.countOf(p, 9001), 15, '3 grants x 5 Alpha each');
});

test('promo: bypassPromoGating does not bypass entitlement rules (owns:/ach:/played:)', { skip: h.needs('customSchema', 'entitlements', 'gatingBypass') }, async () => {
  const p = provider({ bypassPromoGating: true });
  assert.equal(await promo(p, 9062), false, 'owns:440 still required even under bypass');
  h.setEntitlements(p, { ownsApps: [440] });
  assert.equal(await promo(p, 9062), true, 'granted once the entitlement is actually satisfied');
});

test('promo: bypassPromoGating does not bypass drop_start_time', { skip: h.needs('customSchema', 'virtualClock', 'gatingBypass') }, async () => {
  const p = provider({ bypassPromoGating: true });
  assert.equal(await promo(p, 9065), false, 'before drop_start_time, even under bypass');
});

test('promo: bypassPromoGating can be toggled live on provider.engine.options, without reconstructing the provider', { skip: h.needs('customSchema', 'gatingBypass') }, async () => {
  const p = provider();
  assert.equal(await promo(p, 9060), true);
  assert.equal(await promo(p, 9060), false, 'gated with the flag off');

  p.engine.options.bypassPromoGating = true;
  assert.equal(await promo(p, 9060), true, 'granted once toggled on live');
});
