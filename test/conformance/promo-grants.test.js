'use strict';

/**
 * conformance/promo-grants.test.js
 *
 * The bulk promo surface: AddPromoItems, GrantPromoItems, and the
 * RequestEligiblePromoItemDefinitionsIDs / GetEligiblePromoItemDefinitionIDs
 * pair — plus the `granted_manually` itemdef flag that only the bulk
 * GrantPromoItems sweep respects (docs/schema.html).
 *
 * Fixtures used, beyond the ones test/conformance/promo.test.js already
 * covers (9060-9065): 9130 "Manual-Only Badge" (`promo: 'manual'`,
 * `granted_manually: true`) and 9131 "Bulk-Eligible Reward"
 * (`promo: 'owns:440'`, no `granted_manually`). 9060 and 9061 are also
 * `promo: 'manual'` but, like 9131, do NOT set `granted_manually` — so they
 * are bulk-grantable too. That pairing with 9130 is deliberate: it isolates
 * the flag from the rule type, holding the rule constant and varying only
 * the flag.
 */

const test = require('node:test');
const assert = require('node:assert');

const h = require('../harness');
const fixtures = require('../../examples/economy');

const provider = (options = {}) => h.createProvider({ schema: fixtures, ...options });

async function addOne(p, defId) {
  const result = await h.call(p, 'addPromoItem', defId);
  assert.equal(result.status, h.RESULT.OK, `addPromoItem should not error: ${result.reason || ''}`);
  return result.items.length > 0;
}

/** Wait for one 'eligiblePromoItemDefIDs' event, issuing the request that fires it. */
function requestEligibleIds(p) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('eligiblePromoItemDefIDs did not fire')), 1000);
    p.once('eligiblePromoItemDefIDs', payload => {
      clearTimeout(timer);
      resolve(payload);
    });
    p.requestEligiblePromoItemDefinitionsIDs();
  });
}

// ─── AddPromoItems ──────────────────────────────────────────────────────────

test('addPromoItems: grants several at once, in one result', { skip: h.needs('customSchema', 'entitlements') }, async () => {
  const p = provider();
  h.setEntitlements(p, { ownsApps: [440], achievements: ['first_landing'] });

  const result = await h.call(p, 'addPromoItems', [9060, 9062, 9063]);
  assert.equal(result.status, h.RESULT.OK, result.reason || '');

  const grantedDefs = new Set(result.items.map(i => i.itemdefid));
  assert.ok(grantedDefs.has(9001) && grantedDefs.has(9002), '9060 expanded its bundle into the result');
  assert.ok(grantedDefs.has(9062), 'owns:440 promo granted');
  assert.ok(grantedDefs.has(9063), 'ach:first_landing promo granted');

  assert.equal(await h.countOf(p, 9001), 5);
  assert.equal(await h.countOf(p, 9002), 2);
  assert.equal(await h.countOf(p, 9062), 1);
  assert.equal(await h.countOf(p, 9063), 1);
});

test('addPromoItems: DOES grant a granted_manually item when named explicitly', { skip: h.needs('customSchema') }, async () => {
  const p = provider();
  const result = await h.call(p, 'addPromoItems', [9130]);
  assert.equal(result.status, h.RESULT.OK, result.reason || '');
  assert.equal(await h.countOf(p, 9130), 1, 'granted_manually never gates an explicit id');
});

test('addPromoItems: skips an already-granted id and still grants the rest', { skip: h.needs('customSchema') }, async () => {
  const p = provider();
  assert.equal(await addOne(p, 9060), true, 'first claim, via the singular call');

  const result = await h.call(p, 'addPromoItems', [9060, 9061]);
  assert.equal(result.status, h.RESULT.OK, result.reason || '');

  const grantedDefs = new Set(result.items.map(i => i.itemdefid));
  assert.ok(grantedDefs.has(9061), '9061 was granted');
  assert.equal(await h.countOf(p, 9001), 5, '9060 not double-granted (its bundle count is unchanged)');
  assert.equal(await h.countOf(p, 9002), 2, '9060 not double-granted (its bundle count is unchanged)');
  assert.equal(await h.countOf(p, 9061), 1, '9061 granted despite 9060 in the same batch being ineligible');
});

test('addPromoItems: an unknown itemdefid is a parameter error granting nothing', { skip: h.needs('customSchema') }, async () => {
  const p = provider();
  const before = JSON.stringify(await h.snapshot(p));

  const result = await h.call(p, 'addPromoItems', [9060, 424242]);
  assert.equal(result.status, h.RESULT.INVALID_PARAM);

  assert.equal(JSON.stringify(await h.snapshot(p)), before, 'a bad id fails the whole call before anything is touched');
});

// ─── GrantPromoItems ────────────────────────────────────────────────────────

test('grantPromoItems: grants the bulk-eligible item and does not grant the granted_manually one', { skip: h.needs('promoGrantAll', 'customSchema', 'entitlements') }, async () => {
  const p = provider();
  h.setEntitlements(p, { ownsApps: [440] });

  const result = await h.call(p, 'grantPromoItems');
  assert.equal(result.status, h.RESULT.OK, result.reason || '');

  const grantedDefs = new Set(result.items.map(i => i.itemdefid));
  assert.ok(grantedDefs.has(9131), '9131 (owns:440, no granted_manually) swept up');
  assert.ok(!grantedDefs.has(9130), '9130 (granted_manually: true) excluded from the sweep');
  assert.equal(await h.countOf(p, 9131), 1);
  assert.equal(await h.countOf(p, 9130), 0);
});

test('grantPromoItems: owed nothing succeeds with an empty list, not an error', { skip: h.needs('promoGrantAll', 'customSchema') }, async () => {
  const p = provider();
  // Claim every promo this fresh account is ever going to qualify for without
  // entitlements or time passing, via the singular call — establishing a
  // state where the bulk sweep genuinely has nothing left to do.
  assert.equal(await addOne(p, 9060), true);
  assert.equal(await addOne(p, 9061), true);

  const result = await h.call(p, 'grantPromoItems');
  assert.equal(result.status, h.RESULT.OK, result.reason || '');
  assert.deepEqual(result.items, [], 'nothing owed is success, not failure');
  assert.equal(result.granted, false);
});

test('grantPromoItems: idempotent — a second run grants nothing further', { skip: h.needs('promoGrantAll', 'customSchema', 'entitlements') }, async () => {
  const p = provider();
  h.setEntitlements(p, { ownsApps: [440] });

  const first = await h.call(p, 'grantPromoItems');
  assert.equal(first.status, h.RESULT.OK, first.reason || '');
  assert.equal(first.granted, true, 'first run has something to sweep');
  const totalsAfterFirst = await h.totals(p);

  const second = await h.call(p, 'grantPromoItems');
  assert.equal(second.status, h.RESULT.OK, second.reason || '');
  assert.deepEqual(second.items, [], 'once per account: the second sweep finds nothing new');
  assert.equal(second.granted, false);

  const totalsAfterSecond = await h.totals(p);
  assert.deepEqual([...totalsAfterSecond.entries()], [...totalsAfterFirst.entries()], 'no double grant');
});

// ─── Eligible promo item definition ids ────────────────────────────────────

test('eligible promo ids: empty before request, populated after, includes granted_manually items', { skip: h.needs('promoGrantAll', 'customSchema') }, async () => {
  const p = provider();
  assert.deepEqual(p.getEligiblePromoItemDefinitionIDs(), [], 'reading before requesting returns empty, not a fresh computation');

  const payload = await requestEligibleIds(p);
  assert.equal(payload.result, h.RESULT.OK);
  assert.equal(payload.count, payload.cachedData.length);

  const ids = p.getEligiblePromoItemDefinitionIDs();
  assert.ok(ids.includes(9060), '9060 (manual) eligible on a fresh account');
  assert.ok(ids.includes(9061), '9061 (manual) eligible on a fresh account');
  assert.ok(ids.includes(9130), 'granted_manually items are eligible even though they will not come through a bulk grant');
  assert.ok(!ids.includes(9062), 'owns:440 not satisfied without the entitlement');
  assert.ok(!ids.includes(9065), 'drop_start_time not yet reached');

  const sorted = [...ids].sort((a, b) => a - b);
  assert.deepEqual(ids, sorted, 'ids are returned in stable, sorted order');
});
