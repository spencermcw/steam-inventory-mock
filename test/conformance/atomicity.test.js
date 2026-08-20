'use strict';

/**
 * conformance/atomicity.test.js
 *
 * ExchangeItems is atomic on real Steam — materials are consumed and the target
 * granted as a single transaction. Every `requires:` ownership check in the game
 * rests on that: the required item is consumed by the recipe and re-issued by
 * the bundle, and a non-atomic implementation would eat facilities.
 */

const test = require('node:test');
const assert = require('node:assert');

const h = require('../harness');
const fixtures = require('../../examples/economy');

const provider = (options = {}) => h.createProvider({ schema: fixtures, ...options });

test('atomicity: a failed exchange leaves inventory byte-identical', { skip: h.needs('customSchema', 'sandboxGrants') }, async () => {
  const p = provider();
  await h.seed(p, { 9001: 1, 9002: 4, 9003: 2 });

  const before = JSON.stringify(await h.snapshot(p));

  // Short by one Alpha and one Beta: neither recipe of 9010 is satisfiable.
  const result = await h.call(p, 'exchangeItems', 9010, await h.materials(p, { 9001: 1, 9002: 4 }));
  assert.notEqual(result.status, h.RESULT.OK);

  assert.equal(JSON.stringify(await h.snapshot(p)), before, 'inventory unchanged after a failed exchange');
});

test('atomicity: a throw mid-expansion rolls the whole grant back', { skip: h.needs('customSchema', 'sandboxGrants') }, async () => {
  // 9099 is a bundle that contains itself. Expansion blows the depth guard part
  // way through, after inner grants have already been written.
  const p = provider();
  await h.seed(p, { 9001: 3 });
  const before = JSON.stringify(await h.snapshot(p));

  const result = await h.call(p, 'generateItems', [9099], [1]);
  assert.notEqual(result.status, h.RESULT.OK);

  assert.equal(JSON.stringify(await h.snapshot(p)), before);
});

test('atomicity: requires round-trip consumes and re-issues the required item', { skip: h.needs('customSchema', 'sandboxGrants') }, async () => {
  // 9090: exchange "9091x1,9002x2", bundle "9003x1;9091x1".
  // The facility (9091) is spent by the recipe and handed straight back by the
  // bundle — Steam validates ownership atomically, with no net consumption.
  const p = provider();
  await h.seed(p, { 9091: 1, 9002: 2 });

  const result = await h.call(p, 'exchangeItems', 9090, await h.materials(p, { 9091: 1, 9002: 2 }));

  assert.equal(result.status, h.RESULT.OK, result.reason || '');
  assert.equal(await h.countOf(p, 9091), 1, 'facility returned');
  assert.equal(await h.countOf(p, 9002), 0, 'consumables spent');
  assert.equal(await h.countOf(p, 9003), 1, 'output granted');
});

test('atomicity: without the required item the craft fails and nothing moves', { skip: h.needs('customSchema', 'sandboxGrants') }, async () => {
  const p = provider();
  await h.seed(p, { 9002: 2 });
  const before = JSON.stringify(await h.snapshot(p));

  const result = await h.call(p, 'exchangeItems', 9090, await h.materials(p, { 9002: 2 }));

  assert.notEqual(result.status, h.RESULT.OK);
  assert.equal(JSON.stringify(await h.snapshot(p)), before);
});

test('atomicity: a failed exchange does not consume randomness', { skip: h.needs('customSchema', 'sandboxGrants', 'deterministicRng') }, async () => {
  // A rolled-back generator must roll back the RNG too, or a failed call
  // silently desynchronises a seeded replay.
  const rollFive = async p => {
    const out = [];
    for (let i = 0; i < 5; i++) {
      const result = await h.call(p, 'generateItems', [9030], [1]);
      out.push(result.items.map(i2 => i2.itemdefid).join(','));
    }
    return out.join('|');
  };

  const clean = provider({ seed: 'rng-rollback' });
  const baseline = await rollFive(clean);

  const dirty = provider({ seed: 'rng-rollback' });
  await h.seed(dirty, { 9001: 1 });
  const failed = await h.call(dirty, 'exchangeItems', 9010, await h.materials(dirty, { 9001: 1 }));
  assert.notEqual(failed.status, h.RESULT.OK);
  // Clear the seeded item so the roll sequence is compared on equal footing.
  const [alpha] = (await h.snapshot(dirty)).filter(i => i.itemdefid === 9001);
  await h.call(dirty, 'consumeItem', alpha.itemId, alpha.quantity);

  assert.equal(await rollFive(dirty), baseline);
});
