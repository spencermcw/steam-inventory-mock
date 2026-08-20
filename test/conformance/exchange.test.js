'use strict';

/**
 * conformance/exchange.test.js
 *
 * The exchange grammar, recipe selection, and material handling.
 */

const test = require('node:test');
const assert = require('node:assert');

const h = require('../harness');
const fixtures = require('../../examples/economy');

const provider = (options = {}) => h.createProvider({ schema: fixtures, ...options });

test('exchange: an exact material set produces the target', { skip: h.needs('customSchema', 'sandboxGrants') }, async () => {
  const p = provider();
  await h.seed(p, { 9001: 2 });

  const result = await h.call(p, 'exchangeItems', 9010, await h.materials(p, { 9001: 2 }));

  assert.equal(result.status, h.RESULT.OK, result.reason || '');
  assert.equal(await h.countOf(p, 9010), 1, 'target granted');
  assert.equal(await h.countOf(p, 9001), 0, 'materials consumed');
});

test('exchange: exactly one target item is produced per call', { skip: h.needs('customSchema', 'sandboxGrants') }, async () => {
  // Steam: the generate array must be size 1 and the quantity must be 1. Even
  // when the player offers enough for several crafts, one call makes one item.
  const p = provider();
  await h.seed(p, { 9001: 4 });

  await h.call(p, 'exchangeItems', 9010, await h.materials(p, { 9001: 2 }));
  assert.equal(await h.countOf(p, 9010), 1);
});

test('exchange: insufficient materials fail', { skip: h.needs('customSchema', 'sandboxGrants') }, async () => {
  const p = provider();
  await h.seed(p, { 9001: 1 });

  const result = await h.call(p, 'exchangeItems', 9010, await h.materials(p, { 9001: 1 }));

  assert.notEqual(result.status, h.RESULT.OK);
  assert.equal(await h.countOf(p, 9010), 0);
  assert.equal(await h.countOf(p, 9001), 1, 'materials untouched');
});

test('exchange: unknown target itemdef is rejected', { skip: h.needs('customSchema', 'sandboxGrants') }, async () => {
  const p = provider();
  await h.seed(p, { 9001: 2 });
  const result = await h.call(p, 'exchangeItems', 123456, await h.materials(p, { 9001: 2 }));
  assert.equal(result.status, h.RESULT.INVALID_PARAM);
});

test('exchange: a target with no exchange formula is rejected', { skip: h.needs('customSchema', 'sandboxGrants') }, async () => {
  const p = provider();
  await h.seed(p, { 9001: 2 });
  const result = await h.call(p, 'exchangeItems', 9015, await h.materials(p, { 9001: 2 }));
  assert.equal(result.status, h.RESULT.INVALID_PARAM);
});

test('exchange: materials not in inventory are rejected', { skip: h.needs('customSchema', 'sandboxGrants') }, async () => {
  const p = provider();
  await h.seed(p, { 9001: 2 });
  const result = await h.call(p, 'exchangeItems', 9010, [{ itemId: 999999, quantity: 2 }]);
  assert.equal(result.status, h.RESULT.INVALID_PARAM);
});

// ─── First-match recipe selection ─────────────────────────────────────────────

test(
  'exchange: the FIRST satisfied recipe wins, not the cheapest',
  { skip: h.needs('customSchema', 'sandboxGrants', 'configurableSurplus') },
  async () => {
    // 9010 = "9001x2;9002x5", 9012 = "9002x5;9001x2" — same two recipes, opposite
    // order. Offer the union of both material sets to each. Whichever recipe is
    // listed first is the one that gets consumed.
    //
    // Run with surplusPolicy 'ignore' so the winning recipe is observable in
    // what is left behind; under 'consume' everything offered is spent and the
    // choice is invisible from the outside.
    const both = { 9001: 2, 9002: 5 };

    const first = provider({ surplusPolicy: 'ignore' });
    await h.seed(first, both);
    const a = await h.call(first, 'exchangeItems', 9010, await h.materials(first, both));
    assert.equal(a.status, h.RESULT.OK, a.reason || '');
    assert.equal(await h.countOf(first, 9001), 0, '9010 consumed its first recipe (2x Alpha)');
    assert.equal(await h.countOf(first, 9002), 5, 'Beta untouched');

    const second = provider({ surplusPolicy: 'ignore' });
    await h.seed(second, both);
    const b = await h.call(second, 'exchangeItems', 9012, await h.materials(second, both));
    assert.equal(b.status, h.RESULT.OK, b.reason || '');
    assert.equal(await h.countOf(second, 9002), 0, '9012 consumed its first recipe (5x Beta)');
    assert.equal(await h.countOf(second, 9001), 2, 'Alpha untouched');
  }
);

test('exchange: a later recipe is used when the earlier one is unsatisfiable', { skip: h.needs('customSchema', 'sandboxGrants') }, async () => {
  const p = provider();
  await h.seed(p, { 9002: 5 });
  const result = await h.call(p, 'exchangeItems', 9010, await h.materials(p, { 9002: 5 }));
  assert.equal(result.status, h.RESULT.OK, result.reason || '');
  assert.equal(await h.countOf(p, 9010), 1);
});

test('exchange: the order the client passes materials in does not matter', { skip: h.needs('customSchema', 'sandboxGrants') }, async () => {
  // One of the open questions in Provider Architecture: does recipe selection
  // depend on client material ordering? It must not.
  const spec = { 9001: 2, 9002: 5 };

  const forward = provider();
  await h.seed(forward, spec);
  const a = await h.call(forward, 'exchangeItems', 9010, await h.materials(forward, spec));

  const reversed = provider();
  await h.seed(reversed, spec);
  const b = await h.call(reversed, 'exchangeItems', 9010, (await h.materials(reversed, spec)).reverse());

  assert.equal(a.status, b.status);
  assert.deepEqual(await h.totals(forward), await h.totals(reversed));
});

// ─── Tag operands ─────────────────────────────────────────────────────────────

test('exchange: a tag operand matches any itemdef carrying the tag', { skip: h.needs('customSchema', 'sandboxGrants') }, async () => {
  // 9011 = "rarity:common*3"; Alpha and Beta are both rarity:common.
  const p = provider();
  await h.seed(p, { 9001: 2, 9002: 1 });

  const result = await h.call(p, 'exchangeItems', 9011, await h.materials(p, { 9001: 2, 9002: 1 }));

  assert.equal(result.status, h.RESULT.OK, result.reason || '');
  assert.equal(await h.countOf(p, 9011), 1);
});

test('exchange: a tag operand is not satisfied by untagged items', { skip: h.needs('customSchema', 'sandboxGrants') }, async () => {
  const p = provider();
  await h.seed(p, { 9003: 3 }); // rarity:rare
  const result = await h.call(p, 'exchangeItems', 9011, await h.materials(p, { 9003: 3 }));
  assert.notEqual(result.status, h.RESULT.OK);
});

test('exchange: overlapping tag operands are assigned, not greedily grabbed', { skip: h.needs('customSchema', 'sandboxGrants') }, async () => {
  // 9013 = "rarity:common*1,band:1*1". Alpha satisfies both operands; Beta only
  // `rarity:common`. A greedy matcher that hands Alpha to the first operand
  // leaves the second unsatisfiable and wrongly rejects a valid recipe.
  const p = provider();
  await h.seed(p, { 9001: 1, 9002: 1 });

  const result = await h.call(p, 'exchangeItems', 9013, await h.materials(p, { 9001: 1, 9002: 1 }));

  assert.equal(result.status, h.RESULT.OK, result.reason || '');
});

// ─── Surplus materials ────────────────────────────────────────────────────────

test('exchange: surplus material handling follows the configured policy', { skip: h.needs('customSchema', 'sandboxGrants', 'configurableSurplus') }, async () => {
  // UNVERIFIED against real Steam — this test documents the three readings and
  // pins the mock to whichever one is configured. See README.md.
  const spec = { 9001: 5 }; // recipe needs 2

  const consuming = provider({ surplusPolicy: 'consume' });
  await h.seed(consuming, spec);
  await h.call(consuming, 'exchangeItems', 9010, await h.materials(consuming, spec));
  assert.equal(await h.countOf(consuming, 9001), 0, "'consume' spends everything offered");

  const ignoring = provider({ surplusPolicy: 'ignore' });
  await h.seed(ignoring, spec);
  await h.call(ignoring, 'exchangeItems', 9010, await h.materials(ignoring, spec));
  assert.equal(await h.countOf(ignoring, 9001), 3, "'ignore' spends only what the recipe needs");

  const strict = provider({ surplusPolicy: 'strict' });
  await h.seed(strict, spec);
  const rejected = await h.call(strict, 'exchangeItems', 9010, await h.materials(strict, spec));
  assert.equal(rejected.status, h.RESULT.INVALID_PARAM, "'strict' rejects an inexact material list");
  assert.equal(await h.countOf(strict, 9001), 5);
});
