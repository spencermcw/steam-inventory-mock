'use strict';

/**
 * conformance/stacks.test.js
 *
 * TransferItemQuantity: splitting a quantity off a stack into a new instance,
 * and merging one stack into another.
 *
 * The load-bearing rule here is stack identity. Two instances are the same
 * stack only if they share an itemdef AND their per-item tags; a merge that
 * ignored that would fold two genuinely different items together and silently
 * drop one side's tags. Nothing would throw and the inventory would still look
 * plausible — the loss would surface much later as an item that has quietly
 * shed its cosmetics or its provenance. So the refusal is asserted here, along
 * with the inventory being byte-identical afterwards.
 */

const test = require('node:test');
const assert = require('node:assert');

const h = require('../harness');
const fixtures = require('../../examples/economy');
const { k_SteamItemInstanceIDInvalid } = require('../../index');

const provider = (options = {}) => h.createProvider({ schema: fixtures, ...options });

const stacksOf = async (p, itemdefid) => (await h.snapshot(p)).filter(i => i.itemdefid === itemdefid);

/**
 * Per-item tags are rolled, not authored: generator 9041 stamps "color:red" and
 * rolls one value off the "quality" tag_generator (legendary 1 : common 9).
 * Repeated rolls therefore give both several identically tagged items (which
 * auto_stack folds into one stack) and, eventually, a differently tagged one.
 * Looping until the shape we need appears keeps the test honest against a
 * provider whose rolls we cannot seed.
 */
async function stackOfAtLeast(p, quantity) {
  for (let i = 0; i < 120; i++) {
    await h.call(p, 'generateItems', [9041], [1]);
    const stack = (await stacksOf(p, 9002)).find(s => s.quantity >= quantity);
    if (stack) return stack;
  }
  throw new Error(`generator 9041 never produced ${quantity} identically tagged items`);
}

async function twoDistinctlyTaggedStacks(p) {
  for (let i = 0; i < 120; i++) {
    await h.call(p, 'generateItems', [9041], [1]);
    const stacks = await stacksOf(p, 9002);
    const other = stacks.find(s => s.tags !== stacks[0].tags);
    if (other) return [stacks[0], other];
  }
  throw new Error('generator 9041 never produced two differently tagged stacks');
}

// ─── Split ────────────────────────────────────────────────────────────────────

test('stacks: a split moves quantity into a brand-new instance', { skip: h.needs('customSchema', 'sandboxGrants') }, async () => {
  const p = provider();
  await h.seed(p, { 9001: 10 });
  const [before] = await stacksOf(p, 9001);

  const result = await h.call(p, 'transferItemQuantity', before.itemId, 4, k_SteamItemInstanceIDInvalid);
  assert.equal(result.status, h.RESULT.OK, result.reason || '');

  const after = await stacksOf(p, 9001);
  assert.equal(after.length, 2, 'the split produced a second stack');
  const source = after.find(s => s.itemId === before.itemId);
  const created = after.find(s => s.itemId !== before.itemId);
  assert.equal(source.quantity, 6);
  assert.equal(created.quantity, 4);
  assert.notEqual(created.itemId, before.itemId, 'the new instance got an id of its own');
  assert.equal(await h.countOf(p, 9001), 10, 'a transfer moves quantity, it does not mint or burn it');

  const reported = new Map(result.items.map(i => [i.itemId, i.quantity]));
  assert.equal(reported.get(before.itemId), 6, 'the source is reported');
  assert.equal(reported.get(created.itemId), 4, 'the new instance is reported');
});

test('stacks: omitting the destination splits, exactly as the invalid sentinel does', { skip: h.needs('customSchema', 'sandboxGrants') }, async () => {
  // Valve's k_SteamItemInstanceIDInvalid is ~0 on a uint64, which no JS number
  // holds exactly; callers must be able to say "no destination" the obvious way.
  const p = provider();
  await h.seed(p, { 9001: 5 });
  const [stack] = await stacksOf(p, 9001);

  const result = await h.call(p, 'transferItemQuantity', stack.itemId, 2);
  assert.equal(result.status, h.RESULT.OK, result.reason || '');
  assert.equal((await stacksOf(p, 9001)).length, 2);
});

test('stacks: a split copies the source per-item tags onto the new instance', { skip: h.needs('customSchema', 'sandboxGrants') }, async () => {
  const p = provider({ seed: 'split-tags' });
  const tagged = await stackOfAtLeast(p, 2);
  assert.ok(tagged.tags.includes('color:red'), `expected generator tags, got "${tagged.tags}"`);

  const result = await h.call(p, 'transferItemQuantity', tagged.itemId, 1, k_SteamItemInstanceIDInvalid);
  assert.equal(result.status, h.RESULT.OK, result.reason || '');

  const created = (await stacksOf(p, 9002)).find(s => s.itemId !== tagged.itemId && s.tags === tagged.tags);
  assert.ok(created, 'the split half carries the same tags — a split does not launder an item into a plain one');
  assert.equal(created.quantity, 1);
});

test('stacks: the split halves do not share one tag array', { skip: h.needs('customSchema', 'sandboxGrants', 'entitlements') }, async () => {
  // Reaching into provider state, which only a mock target can offer — hence
  // the same capability gate the harness puts on entitlements. Aliased tag
  // arrays are invisible through the result surface: they only bite later,
  // when editing one item's tags silently rewrites another's.
  const p = provider({ seed: 'split-alias' });
  const tagged = await stackOfAtLeast(p, 2);
  await h.call(p, 'transferItemQuantity', tagged.itemId, 1, k_SteamItemInstanceIDInvalid);

  const created = (await stacksOf(p, 9002)).find(s => s.itemId !== tagged.itemId && s.tags === tagged.tags);
  const sourceTags = p.account.get(tagged.itemId).tags;
  const createdTags = p.account.get(created.itemId).tags;

  assert.notEqual(createdTags, sourceTags, 'the tag array was copied');
  for (let i = 0; i < sourceTags.length; i++) {
    assert.notEqual(createdTags[i], sourceTags[i], 'each tag object was copied');
    assert.deepEqual(createdTags[i], sourceTags[i]);
  }
});

test('stacks: splitting the whole quantity empties the source under a new id', { skip: h.needs('customSchema', 'sandboxGrants') }, async () => {
  // Deliberate: the legal range is the same for a split as for a merge, so the
  // last unit needs no special case. The source is removed exactly as a stack
  // spent by consumeItem is, and the quantity reappears under a fresh id — so a
  // caller holding the old id must read the result rather than assume.
  const p = provider();
  await h.seed(p, { 9001: 3 });
  const [stack] = await stacksOf(p, 9001);

  const result = await h.call(p, 'transferItemQuantity', stack.itemId, 3, k_SteamItemInstanceIDInvalid);
  assert.equal(result.status, h.RESULT.OK, result.reason || '');

  const reported = new Map(result.items.map(i => [i.itemId, i.quantity]));
  assert.equal(reported.get(stack.itemId), 0, 'the emptied source is reported at quantity 0');

  const after = await stacksOf(p, 9001);
  assert.equal(after.length, 1, 'the emptied source is gone');
  assert.equal(after[0].quantity, 3);
  assert.notEqual(after[0].itemId, stack.itemId, 'the quantity lives under the new instance id');
});

// ─── Merge ────────────────────────────────────────────────────────────────────

test('stacks: a merge moves quantity between two stacks', { skip: h.needs('customSchema', 'sandboxGrants') }, async () => {
  const p = provider();
  await h.seed(p, { 9001: 8 });
  const [original] = await stacksOf(p, 9001);
  await h.call(p, 'transferItemQuantity', original.itemId, 5, k_SteamItemInstanceIDInvalid);
  const split = (await stacksOf(p, 9001)).find(s => s.itemId !== original.itemId);

  const result = await h.call(p, 'transferItemQuantity', split.itemId, 2, original.itemId);
  assert.equal(result.status, h.RESULT.OK, result.reason || '');

  const after = await stacksOf(p, 9001);
  assert.equal(after.length, 2, 'a partial merge leaves both stacks standing');
  assert.equal(after.find(s => s.itemId === original.itemId).quantity, 5);
  assert.equal(after.find(s => s.itemId === split.itemId).quantity, 3);
  assert.equal(await h.countOf(p, 9001), 8);
});

test('stacks: a merge that empties the source removes it', { skip: h.needs('customSchema', 'sandboxGrants') }, async () => {
  const p = provider();
  await h.seed(p, { 9001: 8 });
  const [original] = await stacksOf(p, 9001);
  await h.call(p, 'transferItemQuantity', original.itemId, 5, k_SteamItemInstanceIDInvalid);
  const split = (await stacksOf(p, 9001)).find(s => s.itemId !== original.itemId);

  const result = await h.call(p, 'transferItemQuantity', split.itemId, 5, original.itemId);
  assert.equal(result.status, h.RESULT.OK, result.reason || '');

  const reported = new Map(result.items.map(i => [i.itemId, i.quantity]));
  assert.equal(reported.get(split.itemId), 0, 'the emptied source is reported at quantity 0');
  assert.equal(reported.get(original.itemId), 8, 'the destination is reported at its new total');

  const after = await stacksOf(p, 9001);
  assert.deepEqual(
    after.map(s => [s.itemId, s.quantity]),
    [[original.itemId, 8]],
    'the inventory is back to the single stack it started as'
  );
});

test('stacks: two same-itemdef, same-tag stacks merge', { skip: h.needs('customSchema', 'sandboxGrants') }, async () => {
  const p = provider({ seed: 'merge-same-tags' });
  const tagged = await stackOfAtLeast(p, 3);
  await h.call(p, 'transferItemQuantity', tagged.itemId, 1, k_SteamItemInstanceIDInvalid);
  const split = (await stacksOf(p, 9002)).find(s => s.itemId !== tagged.itemId && s.tags === tagged.tags);

  const result = await h.call(p, 'transferItemQuantity', split.itemId, 1, tagged.itemId);
  assert.equal(result.status, h.RESULT.OK, result.reason || '');

  const survivor = (await stacksOf(p, 9002)).find(s => s.itemId === tagged.itemId);
  assert.equal(survivor.quantity, tagged.quantity, 'the quantity came home');
  assert.equal(survivor.tags, tagged.tags, 'and the tags are untouched');
});

test('stacks: merging differently tagged instances is refused and changes nothing', { skip: h.needs('customSchema', 'sandboxGrants') }, async () => {
  // The whole point. Both stacks are itemdef 9002; they differ only in the
  // "quality" value rolled onto them. One stack of 9002 could be produced from
  // them, but only by throwing away one side's tags — so the call must fail
  // rather than pick a winner.
  const p = provider({ seed: 'merge-different-tags' });
  const [left, right] = await twoDistinctlyTaggedStacks(p);
  const before = JSON.stringify(await h.snapshot(p));

  const result = await h.call(p, 'transferItemQuantity', left.itemId, 1, right.itemId);

  assert.equal(result.status, h.RESULT.INVALID_PARAM, 'a tag-destroying merge is a parameter error');
  assert.equal(JSON.stringify(await h.snapshot(p)), before, 'inventory unchanged after a refused merge');
});

test('stacks: the refusal names the tags it protected', { skip: h.needs('customSchema', 'sandboxGrants', 'failureReasons') }, async () => {
  const p = provider({ seed: 'merge-different-tags-reason' });
  const [left, right] = await twoDistinctlyTaggedStacks(p);

  const result = await h.call(p, 'transferItemQuantity', left.itemId, 1, right.itemId);
  assert.match(result.reason, /tags differ/i);
  assert.ok(result.reason.includes(left.tags) && result.reason.includes(right.tags), result.reason);
});

test('stacks: merging across itemdefs is refused', { skip: h.needs('customSchema', 'sandboxGrants') }, async () => {
  const p = provider();
  await h.seed(p, { 9001: 2, 9002: 2 });
  const [alpha] = await stacksOf(p, 9001);
  const [beta] = await stacksOf(p, 9002);
  const before = JSON.stringify(await h.snapshot(p));

  const result = await h.call(p, 'transferItemQuantity', alpha.itemId, 1, beta.itemId);
  assert.equal(result.status, h.RESULT.INVALID_PARAM);
  assert.equal(JSON.stringify(await h.snapshot(p)), before);
});

// ─── Rejections ───────────────────────────────────────────────────────────────

test('stacks: malformed transfers are rejected', { skip: h.needs('customSchema', 'sandboxGrants') }, async () => {
  const p = provider();
  await h.seed(p, { 9001: 4, 9002: 1 });
  const [alpha] = await stacksOf(p, 9001);
  const [beta] = await stacksOf(p, 9002);

  const cases = [
    ['unknown source', [987654, 1, k_SteamItemInstanceIDInvalid]],
    ['unknown destination', [alpha.itemId, 1, 987654]],
    ['zero quantity', [alpha.itemId, 0, k_SteamItemInstanceIDInvalid]],
    ['negative quantity', [alpha.itemId, -2, k_SteamItemInstanceIDInvalid]],
    ['non-finite quantity', [alpha.itemId, Number.NaN, k_SteamItemInstanceIDInvalid]],
    ['more than the source holds', [alpha.itemId, 5, k_SteamItemInstanceIDInvalid]],
    ['source is the destination', [alpha.itemId, 1, alpha.itemId]],
    ['destination is a different itemdef', [alpha.itemId, 1, beta.itemId]],
  ];

  for (const [label, args] of cases) {
    const result = await h.call(p, 'transferItemQuantity', ...args);
    assert.equal(result.status, h.RESULT.INVALID_PARAM, `${label}: expected INVALID_PARAM`);
  }
});

test('stacks: a failed transfer leaves inventory byte-identical', { skip: h.needs('customSchema', 'sandboxGrants') }, async () => {
  const p = provider();
  await h.seed(p, { 9001: 4, 9004: 2 });
  const [alpha] = await stacksOf(p, 9001);
  const before = JSON.stringify(await h.snapshot(p));

  const result = await h.call(p, 'transferItemQuantity', alpha.itemId, 99, k_SteamItemInstanceIDInvalid);
  assert.equal(result.status, h.RESULT.INVALID_PARAM);
  assert.equal(JSON.stringify(await h.snapshot(p)), before);
});
