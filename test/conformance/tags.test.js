'use strict';

/**
 * conformance/tags.test.js
 *
 * Per-item tags and effective tag resolution.
 *
 * Settled, not open (Steam Constraints): an item's effective tag set is the
 * union of its itemdef's tags and its per-item tags, and recipe operands match
 * against that union. Checking itemdef tags alone would make instance-tagged
 * items silently fail recipes that work against real Steam — a divergence that
 * would only surface after launch.
 */

const test = require('node:test');
const assert = require('node:assert');

const h = require('../harness');
const fixtures = require('../../examples/economy');

const provider = (options = {}) => h.createProvider({ schema: fixtures, ...options });

const tagsOf = item => (item.tags || '').split(';').filter(Boolean);

test('tags: a generator copies its tags onto the items it creates', { skip: h.needs('customSchema', 'sandboxGrants') }, async () => {
  // 9041 has tags "color:red" and creates 9002 (itemdef tags: rarity:common).
  const p = provider();
  await h.call(p, 'generateItems', [9041], [1]);

  const [item] = await h.snapshot(p);
  assert.equal(item.itemdefid, 9002);
  assert.ok(tagsOf(item).includes('color:red'), `per-item tags were ${item.tags}`);
});

test('tags: a tag_generator applies one rolled value from its set', { skip: h.needs('customSchema', 'sandboxGrants') }, async () => {
  // 9040: "legendary:1;common:9" under the category token "quality".
  const p = provider({ seed: 'tag-roll' });
  for (let i = 0; i < 20; i++) await h.call(p, 'generateItems', [9041], [1]);

  const items = await h.snapshot(p);
  const values = new Set();
  for (const item of items) {
    const quality = tagsOf(item).filter(t => t.startsWith('quality:'));
    assert.equal(quality.length, 1, `exactly one quality tag, got ${item.tags}`);
    values.add(quality[0]);
  }
  for (const value of values) assert.ok(['quality:legendary', 'quality:common'].includes(value));
});

test('tags: differently tagged grants do not merge into one stack', { skip: h.needs('customSchema', 'sandboxGrants') }, async () => {
  const p = provider({ seed: 'stack-split' });
  for (let i = 0; i < 40; i++) await h.call(p, 'generateItems', [9041], [1]);

  const stacks = await h.snapshot(p);
  const signatures = new Set(stacks.map(s => s.tags));
  assert.ok(signatures.size > 1, 'legendary and common items are distinguishable, so they stack apart');
  assert.equal(stacks.length, signatures.size, 'one stack per distinct per-item tag set');
});

test('tags: a recipe operand matches per-item tags, not just itemdef tags', { skip: h.needs('customSchema', 'sandboxGrants') }, async () => {
  // 9014 requires "color:red*1". No itemdef in the fixture set carries
  // color:red — only instances produced by generator 9041 do.
  const p = provider({ seed: 'effective-tags' });
  await h.call(p, 'generateItems', [9041], [1]);

  const [redBeta] = await h.snapshot(p);
  assert.ok(tagsOf(redBeta).includes('color:red'));

  const result = await h.call(p, 'exchangeItems', 9014, [{ itemId: redBeta.itemId, quantity: 1 }]);
  assert.equal(result.status, h.RESULT.OK, result.reason || '');
  assert.equal(await h.countOf(p, 9014), 1);
});

test('tags: an item without the per-item tag does not satisfy the operand', { skip: h.needs('customSchema', 'sandboxGrants') }, async () => {
  const p = provider();
  await h.seed(p, { 9002: 1 }); // plain Beta, no color:red
  const result = await h.call(p, 'exchangeItems', 9014, await h.materials(p, { 9002: 1 }));
  assert.notEqual(result.status, h.RESULT.OK);
});

test('tags: per-item tags survive a stack merge of identical items', { skip: h.needs('customSchema', 'sandboxGrants') }, async () => {
  const p = provider({ seed: 'merge-tags' });
  await h.call(p, 'generateItems', [9021], [1]); // plain bundle → 3 Alpha
  await h.call(p, 'generateItems', [9021], [1]);

  const stacks = (await h.snapshot(p)).filter(s => s.itemdefid === 9001);
  assert.equal(stacks.length, 1, 'identical tag sets merge');
  assert.equal(stacks[0].quantity, 6);
});
