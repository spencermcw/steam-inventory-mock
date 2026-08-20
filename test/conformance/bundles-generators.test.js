'use strict';

/**
 * conformance/bundles-generators.test.js
 *
 * Recursive bundle expansion and weighted generator rolls.
 *
 * The distribution test is the one that matters for the balance simulator: if
 * weighted selection is even slightly biased, every Monte Carlo yield curve
 * built on this engine is wrong in the same direction.
 */

const test = require('node:test');
const assert = require('node:assert');

const h = require('../harness');
const fixtures = require('../fixtures/synthetic');

const provider = (options = {}) => h.createProvider({ schema: fixtures, ...options });

// ─── Bundles ──────────────────────────────────────────────────────────────────

test('bundle: expansion is recursive and quantities multiply', { skip: h.needs('customSchema', 'sandboxGrants') }, async () => {
  // 9020 = "9021x2;9003x1", 9021 = "9001x3"  →  6 Alpha + 1 Gamma
  const p = provider();
  await h.call(p, 'generateItems', [9020], [1]);

  assert.equal(await h.countOf(p, 9001), 6);
  assert.equal(await h.countOf(p, 9003), 1);
  assert.equal(await h.countOf(p, 9020), 0, 'the bundle itself never lands in inventory');
  assert.equal(await h.countOf(p, 9021), 0);
});

test('bundle: a bundle target of an exchange expands on grant', { skip: h.needs('customSchema', 'sandboxGrants') }, async () => {
  const p = provider();
  await h.seed(p, { 9003: 1 });
  const result = await h.call(p, 'exchangeItems', 9022, await h.materials(p, { 9003: 1 }));

  assert.equal(result.status, h.RESULT.OK, result.reason || '');
  assert.equal(await h.countOf(p, 9001), 2);
  assert.equal(await h.countOf(p, 9002), 2);
});

// ─── Generators ───────────────────────────────────────────────────────────────

test('generator: exactly one entry is selected per grant', { skip: h.needs('customSchema', 'sandboxGrants') }, async () => {
  const p = provider();
  await h.call(p, 'generateItems', [9030], [1]);

  const items = await h.snapshot(p);
  const granted = items.reduce((sum, i) => sum + i.quantity, 0);
  assert.equal(granted, 1, 'one item, not one of each');
  assert.ok([9001, 9002, 9003].includes(items[0].itemdefid));
});

test('generator: a generator never lands in inventory itself', { skip: h.needs('customSchema', 'sandboxGrants') }, async () => {
  const p = provider();
  await h.call(p, 'generateItems', [9030], [1]);
  assert.equal(await h.countOf(p, 9030), 0);
});

test('generator: seeded rolls reproduce the same distribution', { skip: h.needs('customSchema', 'sandboxGrants', 'deterministicRng') }, async () => {
  // 9030 = "9001x70;9002x20;9003x10" — weights need not sum to 100, but here
  // they conveniently do, so the expected shares are 70/20/10 percent.
  const ROLLS = 6000;
  const roll = async seed => {
    const p = provider({ seed });
    for (let i = 0; i < ROLLS; i++) await h.call(p, 'generateItems', [9030], [1]);
    return h.totals(p);
  };

  const a = await roll('distribution-1');
  const b = await roll('distribution-1');
  assert.deepEqual([...a].sort(), [...b].sort(), 'same seed → identical outcome');

  const share = defId => (a.get(defId) || 0) / ROLLS;
  assert.ok(Math.abs(share(9001) - 0.7) < 0.02, `Alpha share ${share(9001)}`);
  assert.ok(Math.abs(share(9002) - 0.2) < 0.02, `Beta share ${share(9002)}`);
  assert.ok(Math.abs(share(9003) - 0.1) < 0.02, `Gamma share ${share(9003)}`);

  const c = await roll('distribution-2');
  assert.notDeepEqual([...a].sort(), [...c].sort(), 'a different seed → a different outcome');
});

test('generator: weights need not sum to 100', { skip: h.needs('customSchema', 'sandboxGrants', 'deterministicRng') }, async () => {
  // 9031 = "9001x3;9002x1" → 75/25.
  const ROLLS = 4000;
  const p = provider({ seed: 'uneven' });
  for (let i = 0; i < ROLLS; i++) await h.call(p, 'generateItems', [9031], [1]);

  const totals = await h.totals(p);
  const share = (totals.get(9001) || 0) / ROLLS;
  assert.ok(Math.abs(share - 0.75) < 0.02, `Alpha share ${share}`);
});

test('generator: a generator reached through an exchange still rolls', { skip: h.needs('customSchema', 'sandboxGrants') }, async () => {
  const p = provider();
  await h.seed(p, { 9003: 1 });
  const result = await h.call(p, 'exchangeItems', 9032, await h.materials(p, { 9003: 1 }));

  assert.equal(result.status, h.RESULT.OK, result.reason || '');
  assert.equal(await h.countOf(p, 9001), 1);
  assert.equal(await h.countOf(p, 9032), 0);
});
