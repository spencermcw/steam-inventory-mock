'use strict';

/**
 * conformance/dynamic-props.test.js
 *
 * Dynamic item properties: the StartUpdateProperties / SetProperty /
 * RemoveProperty / SubmitUpdateProperties batch, and reading the result back
 * through GetResultItemProperty(handle, index, "dynamic_props").
 *
 * Settled, not open (Valve documents all of it): properties are mutable,
 * arbitrary string/int/bool/float values on an item *instance*; the read-back
 * form is "the string representation of the JSON for all the dynamic
 * properties for the item"; a call may touch at most 100 items and may leave
 * at most 1024 bytes of JSON on any one of them; and a client-side set can be
 * restricted to white-listed names, optionally further restricted to items
 * carrying a tag "either on the item or its associated item definition".
 *
 * Open, and deliberately unmodelled: Valve's per-user rate limit (time-based
 * partner-side policy, no published window), %token% substitution into item
 * descriptions (web-view rendering, not inventory state), and properties being
 * cleared on trade (this library has no trading).
 */

const test = require('node:test');
const assert = require('node:assert');

const h = require('../harness');
const fixtures = require('../../examples/economy');
const { properties, MAX_PROPERTY_BYTES, MAX_ITEMS_PER_UPDATE } = require('../../index');

const provider = (options = {}) => h.createProvider({ schema: fixtures, ...options });

/**
 * These consume a fixture schema and sandbox grants and nothing else. The
 * provider-level `dynamicProperties` capability (see provider-interface.js) is
 * what a partial binding declines; when a real target registers in the harness
 * and declares it, it belongs in this list too.
 */
const needsProps = (...extra) => h.needs('customSchema', 'sandboxGrants', ...extra);

/** The dynamic_props JSON for one item, read back the way Valve says to read it. */
async function readProps(p, itemId) {
  const handle = p.getItemsByID([itemId]);
  await h.call(p, 'getAllItems'); // let the queue drain in issue order
  const items = p.getResultItems(handle) || [];
  const index = items.findIndex(i => i.itemId === itemId);
  assert.notEqual(index, -1, `item ${itemId} should be in the result`);
  const json = p.getResultItemProperty(handle, index, 'dynamic_props');
  p.destroyResult(handle);
  return JSON.parse(json);
}

/** One item of itemdef `defId`, freshly seeded. */
async function seedOne(p, defId, quantity = 1) {
  await h.seed(p, { [defId]: quantity });
  const [item] = (await h.snapshot(p)).filter(i => i.itemdefid === defId);
  return item;
}

/** Whole inventory including properties — the comparison an atomicity test needs. */
async function propSnapshot(p) {
  const result = await h.call(p, 'getAllItems');
  return JSON.stringify(
    result.items
      .map(i => ({
        itemId: i.itemId,
        itemdefid: i.itemdefid,
        quantity: i.quantity,
        tags: i.tags,
        dynamic_props: i.dynamic_props,
      }))
      .sort((a, b) => a.itemId - b.itemId)
  );
}

// ─── Round trip ───────────────────────────────────────────────────────────────

test('dynamic props: an item with no properties reads back as {}', { skip: needsProps() }, async () => {
  const p = provider();
  const item = await seedOne(p, 9001);
  assert.deepEqual(await readProps(p, item.itemId), {});
});

test('dynamic props: a set survives a submit and reads back through GetResultItemProperty', { skip: needsProps() }, async () => {
  const p = provider();
  const item = await seedOne(p, 9120); // Rocket Launcher

  const update = p.startUpdateProperties();
  assert.equal(typeof update, 'number', 'StartUpdateProperties hands back a handle immediately');
  assert.equal(p.setProperty(update, item.itemId, 'num_times_fired', 100), true);

  const result = await h.call(p, 'submitUpdateProperties', update);
  assert.equal(result.status, h.RESULT.OK, result.reason || '');
  assert.deepEqual(result.items.map(i => i.itemId), [item.itemId], 'the submit reports the items it touched');
  assert.equal(result.items[0].dynamic_props, '{"num_times_fired":100}');

  assert.deepEqual(await readProps(p, item.itemId), { num_times_fired: 100 });
});

test('dynamic props: staging touches nothing until submit', { skip: needsProps() }, async () => {
  const p = provider();
  const item = await seedOne(p, 9120);

  const update = p.startUpdateProperties();
  p.setProperty(update, item.itemId, 'kills', 7);
  assert.deepEqual(await readProps(p, item.itemId), {}, 'a staged edit is invisible to the account');

  await h.call(p, 'submitUpdateProperties', update);
  assert.deepEqual(await readProps(p, item.itemId), { kills: 7 });
});

test('dynamic props: all four types round-trip', { skip: needsProps() }, async () => {
  const p = provider();
  const item = await seedOne(p, 9120);

  const update = p.startUpdateProperties();
  assert.equal(p.setPropertyString(update, item.itemId, 'nickname', 'Betsy'), true);
  assert.equal(p.setPropertyInt(update, item.itemId, 'kills', 42), true);
  assert.equal(p.setPropertyBool(update, item.itemId, 'favourite', true), true);
  assert.equal(p.setPropertyFloat(update, item.itemId, 'accuracy', 0.75), true);

  const result = await h.call(p, 'submitUpdateProperties', update);
  assert.equal(result.status, h.RESULT.OK, result.reason || '');

  assert.deepEqual(await readProps(p, item.itemId), {
    nickname: 'Betsy',
    kills: 42,
    favourite: true,
    accuracy: 0.75,
  });
});

test('dynamic props: setting the same name again overwrites, including across types', { skip: needsProps() }, async () => {
  const p = provider();
  const item = await seedOne(p, 9120);

  const first = p.startUpdateProperties();
  p.setPropertyInt(first, item.itemId, 'kills', 1);
  await h.call(p, 'submitUpdateProperties', first);

  const second = p.startUpdateProperties();
  p.setPropertyString(second, item.itemId, 'kills', 'many');
  await h.call(p, 'submitUpdateProperties', second);

  assert.deepEqual(await readProps(p, item.itemId), { kills: 'many' });
});

test('dynamic props: RemoveProperty drops one name and leaves the rest', { skip: needsProps() }, async () => {
  const p = provider();
  const item = await seedOne(p, 9120);

  const first = p.startUpdateProperties();
  p.setPropertyInt(first, item.itemId, 'kills', 3);
  p.setPropertyInt(first, item.itemId, 'deaths', 4);
  await h.call(p, 'submitUpdateProperties', first);

  const second = p.startUpdateProperties();
  assert.equal(p.removeProperty(second, item.itemId, 'kills'), true);
  const result = await h.call(p, 'submitUpdateProperties', second);
  assert.equal(result.status, h.RESULT.OK, result.reason || '');

  assert.deepEqual(await readProps(p, item.itemId), { deaths: 4 });
});

test('dynamic props: removing a name the item never had is a no-op, not a failure', { skip: needsProps() }, async () => {
  const p = provider();
  const item = await seedOne(p, 9120);

  const update = p.startUpdateProperties();
  p.removeProperty(update, item.itemId, 'never_set');
  const result = await h.call(p, 'submitUpdateProperties', update);

  assert.equal(result.status, h.RESULT.OK, result.reason || '');
  assert.deepEqual(await readProps(p, item.itemId), {});
});

test('dynamic props: one batch spans several items', { skip: needsProps() }, async () => {
  const p = provider();
  await h.seed(p, { 9004: 3 }); // Unstacked Widget: three distinct instances
  const items = (await h.snapshot(p)).filter(i => i.itemdefid === 9004);
  assert.equal(items.length, 3);

  const update = p.startUpdateProperties();
  items.forEach((item, n) => p.setPropertyInt(update, item.itemId, 'slot', n));

  const result = await h.call(p, 'submitUpdateProperties', update);
  assert.equal(result.status, h.RESULT.OK, result.reason || '');
  assert.equal(result.items.length, 3, 'every touched item comes back in the result');

  for (let n = 0; n < items.length; n++) {
    assert.deepEqual(await readProps(p, items[n].itemId), { slot: n });
  }
});

// ─── Atomicity ────────────────────────────────────────────────────────────────

test('dynamic props: a failed batch leaves every item byte-identical', { skip: needsProps() }, async () => {
  const p = provider();
  await h.seed(p, { 9004: 3 });
  const items = (await h.snapshot(p)).filter(i => i.itemdefid === 9004);

  // Give the first two items properties, so the rollback has something real to
  // restore rather than an empty set that looks the same either way.
  const setup = p.startUpdateProperties();
  p.setPropertyInt(setup, items[0].itemId, 'kills', 1);
  p.setPropertyString(setup, items[1].itemId, 'nickname', 'Betsy');
  await h.call(p, 'submitUpdateProperties', setup);

  const before = await propSnapshot(p);

  // A batch that writes to all three real items and then to one that does not
  // exist. The failure is discovered at submit, after earlier edits in the
  // same batch have already been applied to the transaction.
  const doomed = p.startUpdateProperties();
  for (const item of items) p.setPropertyInt(doomed, item.itemId, 'kills', 99);
  p.setPropertyInt(doomed, 999999, 'kills', 99);

  const result = await h.call(p, 'submitUpdateProperties', doomed);
  assert.notEqual(result.status, h.RESULT.OK, 'an item the account does not hold fails the batch');
  assert.deepEqual(result.items, [], 'a failed submit reports no items');

  assert.equal(await propSnapshot(p), before, 'every item is exactly as it was');
});

test('dynamic props: an unknown item is caught at submit, not at stage', { skip: needsProps() }, async () => {
  // Steam validates the batch when it receives it. Rejecting at stage time
  // would promise a guarantee the client will not get — the item can be
  // consumed between the SetProperty and the Submit.
  const p = provider();
  const update = p.startUpdateProperties();
  assert.equal(p.setProperty(update, 999999, 'kills', 1), true, 'staging accepts it');

  const result = await h.call(p, 'submitUpdateProperties', update);
  assert.equal(result.status, h.RESULT.INVALID_PARAM);
});

test('dynamic props: an unrepresentable value is refused at stage time', { skip: needsProps() }, async () => {
  // Unlike an unknown item, no server state could make NaN valid — and Valve's
  // SetProperty returns bool right here, so there is nowhere to report it later.
  const p = provider();
  const item = await seedOne(p, 9120);
  const update = p.startUpdateProperties();

  assert.equal(p.setPropertyFloat(update, item.itemId, 'accuracy', NaN), false);
  assert.equal(p.setPropertyInt(update, item.itemId, 'kills', 1.5), false);
  assert.equal(p.setProperty(update, item.itemId, 'has space', 1), false, 'and so is a malformed name');

  const result = await h.call(p, 'submitUpdateProperties', update);
  assert.equal(result.status, h.RESULT.OK, 'nothing was staged, so the empty batch succeeds');
  assert.deepEqual(await readProps(p, item.itemId), {});
});

// ─── Documented limits ────────────────────────────────────────────────────────

test('dynamic props: more than 100 items in one call is refused', { skip: needsProps() }, async () => {
  const p = provider();
  await h.seed(p, { 9004: MAX_ITEMS_PER_UPDATE + 1 });
  const items = (await h.snapshot(p)).filter(i => i.itemdefid === 9004);
  assert.equal(items.length, MAX_ITEMS_PER_UPDATE + 1, 'the fixture item does not auto_stack');

  const before = await propSnapshot(p);
  const update = p.startUpdateProperties();
  for (const item of items) p.setPropertyInt(update, item.itemId, 'slot', 1);

  const result = await h.call(p, 'submitUpdateProperties', update);
  assert.equal(result.status, h.RESULT.LIMIT_EXCEEDED, result.reason || '');
  assert.equal(await propSnapshot(p), before);
});

test('dynamic props: exactly 100 items in one call is allowed', { skip: needsProps() }, async () => {
  const p = provider();
  await h.seed(p, { 9004: MAX_ITEMS_PER_UPDATE });
  const items = (await h.snapshot(p)).filter(i => i.itemdefid === 9004);

  const update = p.startUpdateProperties();
  for (const item of items) p.setPropertyInt(update, item.itemId, 'slot', 1);

  const result = await h.call(p, 'submitUpdateProperties', update);
  assert.equal(result.status, h.RESULT.OK, result.reason || '');
  assert.equal(result.items.length, MAX_ITEMS_PER_UPDATE);
});

test('dynamic props: many edits to one item is one item against the cap', { skip: needsProps() }, async () => {
  // Valve's limit is on items modified per call, not on edits. Names and
  // values are kept short so this tests the item cap and not the byte cap.
  const p = provider();
  const item = await seedOne(p, 9120);

  const update = p.startUpdateProperties();
  for (let n = 0; n <= MAX_ITEMS_PER_UPDATE; n++) p.setPropertyInt(update, item.itemId, `p${n}`, n);

  const result = await h.call(p, 'submitUpdateProperties', update);
  assert.equal(result.status, h.RESULT.OK, result.reason || '');
  assert.equal(Object.keys(await readProps(p, item.itemId)).length, MAX_ITEMS_PER_UPDATE + 1);
});

test('dynamic props: an item over 1024 bytes of JSON is refused', { skip: needsProps() }, async () => {
  const p = provider();
  const item = await seedOne(p, 9120);
  const before = await propSnapshot(p);

  const update = p.startUpdateProperties();
  p.setPropertyString(update, item.itemId, 'blob', 'x'.repeat(MAX_PROPERTY_BYTES));

  const result = await h.call(p, 'submitUpdateProperties', update);
  assert.equal(result.status, h.RESULT.LIMIT_EXCEEDED, result.reason || '');
  assert.equal(await propSnapshot(p), before);
});

test('dynamic props: the cap is measured on the merged result, not on the edit', { skip: needsProps() }, async () => {
  // A one-byte edit that pushes an already-large set over the line is exactly
  // the case a delta measurement would miss.
  const p = provider();
  const item = await seedOne(p, 9120);

  const fill = p.startUpdateProperties();
  p.setPropertyString(fill, item.itemId, 'blob', 'x'.repeat(MAX_PROPERTY_BYTES - 100));
  const filled = await h.call(p, 'submitUpdateProperties', fill);
  assert.equal(filled.status, h.RESULT.OK, filled.reason || '');

  const overflow = p.startUpdateProperties();
  p.setPropertyString(overflow, item.itemId, 'straw', 'y'.repeat(200));
  const result = await h.call(p, 'submitUpdateProperties', overflow);

  assert.equal(result.status, h.RESULT.LIMIT_EXCEEDED, result.reason || '');
  assert.deepEqual(Object.keys(await readProps(p, item.itemId)), ['blob'], 'the first set is untouched');
});

test('dynamic props: the cap counts UTF-8 bytes, not characters', { skip: needsProps() }, async () => {
  const p = provider();
  const item = await seedOne(p, 9120);

  // 400 characters, 1200 bytes: under the cap by length, over it by bytes.
  const value = '☠'.repeat(400);
  assert.ok(value.length < MAX_PROPERTY_BYTES);

  const update = p.startUpdateProperties();
  p.setPropertyString(update, item.itemId, 'blob', value);
  const result = await h.call(p, 'submitUpdateProperties', update);

  assert.equal(result.status, h.RESULT.LIMIT_EXCEEDED, result.reason || '');
});

// ─── Handle lifetime ──────────────────────────────────────────────────────────

test('dynamic props: an update handle cannot be submitted twice', { skip: needsProps() }, async () => {
  const p = provider();
  const item = await seedOne(p, 9120);

  const update = p.startUpdateProperties();
  p.setPropertyInt(update, item.itemId, 'kills', 1);

  const first = await h.call(p, 'submitUpdateProperties', update);
  assert.equal(first.status, h.RESULT.OK, first.reason || '');

  const second = await h.call(p, 'submitUpdateProperties', update);
  assert.equal(second.status, h.RESULT.INVALID_STATE, 'the handle was spent by the first submit');
  assert.deepEqual(await readProps(p, item.itemId), { kills: 1 }, 'and nothing was applied twice');
});

test('dynamic props: a failed submit spends the handle too', { skip: needsProps() }, async () => {
  // The batch was sent. Re-submitting it would replay edits against state that
  // has since moved.
  const p = provider();
  const update = p.startUpdateProperties();
  p.setProperty(update, 999999, 'kills', 1);

  const first = await h.call(p, 'submitUpdateProperties', update);
  assert.equal(first.status, h.RESULT.INVALID_PARAM);

  const second = await h.call(p, 'submitUpdateProperties', update);
  assert.equal(second.status, h.RESULT.INVALID_STATE);
});

test('dynamic props: staging against a spent handle fails rather than silently accumulating', { skip: needsProps() }, async () => {
  const p = provider();
  const item = await seedOne(p, 9120);
  const update = p.startUpdateProperties();
  await h.call(p, 'submitUpdateProperties', update);

  assert.equal(p.setProperty(update, item.itemId, 'kills', 1), false);
  assert.equal(p.removeProperty(update, item.itemId, 'kills'), false);
});

// ─── White-list ───────────────────────────────────────────────────────────────

test('dynamic props: with no white-list configured, any property may be set', { skip: needsProps() }, async () => {
  // The permissive default models a partner site with nothing configured —
  // this library cannot know the real list. On Steam an un-white-listed
  // client-side set is refused outright, so a client that relies on this
  // default breaks on contact; see the engine's propertyWhitelist option.
  const p = provider();
  const item = await seedOne(p, 9120);

  const update = p.startUpdateProperties();
  p.setProperty(update, item.itemId, 'anything_at_all', 1);
  const result = await h.call(p, 'submitUpdateProperties', update);

  assert.equal(result.status, h.RESULT.OK, result.reason || '');
});

test('dynamic props: with a white-list, an unlisted name is refused', { skip: needsProps() }, async () => {
  const p = provider({ propertyWhitelist: [{ name: 'kills', type: 'int' }] });
  const item = await seedOne(p, 9120);

  const allowed = p.startUpdateProperties();
  p.setPropertyInt(allowed, item.itemId, 'kills', 5);
  assert.equal((await h.call(p, 'submitUpdateProperties', allowed)).status, h.RESULT.OK);

  const refused = p.startUpdateProperties();
  p.setPropertyInt(refused, item.itemId, 'gold', 999);
  const result = await h.call(p, 'submitUpdateProperties', refused);

  assert.equal(result.status, h.RESULT.INVALID_PARAM, result.reason || '');
  assert.deepEqual(await readProps(p, item.itemId), { kills: 5 }, 'the allowed property is untouched');
});

test('dynamic props: a white-listed type mismatch is refused', { skip: needsProps() }, async () => {
  // Valve's white-list carries a type per property, so int and float are not
  // interchangeable even though JSON cannot tell them apart.
  const p = provider({ propertyWhitelist: [{ name: 'accuracy', type: 'float' }] });
  const item = await seedOne(p, 9120);

  const wrong = p.startUpdateProperties();
  p.setPropertyInt(wrong, item.itemId, 'accuracy', 1);
  assert.equal((await h.call(p, 'submitUpdateProperties', wrong)).status, h.RESULT.INVALID_PARAM);

  const right = p.startUpdateProperties();
  p.setPropertyFloat(right, item.itemId, 'accuracy', 1);
  assert.equal((await h.call(p, 'submitUpdateProperties', right)).status, h.RESULT.OK);
});

test('dynamic props: a requiredTag is satisfied by a tag on the item definition', { skip: needsProps() }, async () => {
  // 9001 (Alpha) carries "rarity:common" on its itemdef, 9004 (Widget) carries
  // no tags at all. Valve: the required tag "can exist either on the item or
  // its associated item definition".
  const p = provider({ propertyWhitelist: [{ name: 'kills', type: 'int', requiredTag: 'rarity:common' }] });
  const alpha = await seedOne(p, 9001);
  const widget = await seedOne(p, 9004);

  const tagged = p.startUpdateProperties();
  p.setPropertyInt(tagged, alpha.itemId, 'kills', 1);
  assert.equal((await h.call(p, 'submitUpdateProperties', tagged)).status, h.RESULT.OK);

  const untagged = p.startUpdateProperties();
  p.setPropertyInt(untagged, widget.itemId, 'kills', 1);
  const result = await h.call(p, 'submitUpdateProperties', untagged);
  assert.equal(result.status, h.RESULT.INVALID_PARAM, result.reason || '');
});

test('dynamic props: a requiredTag is satisfied by a per-item tag too', { skip: needsProps() }, async () => {
  // Generator 9041 stamps "color:red" onto the instances it creates; no itemdef
  // in the fixture set carries it. This is the case that proves the check runs
  // against the *effective* tag set and not the definition's alone — the same
  // union a stat-tracker tag_tool would write to.
  const p = provider({
    propertyWhitelist: [{ name: 'kills', type: 'int', requiredTag: 'color:red' }],
    seed: 'prop-tags',
  });
  await h.call(p, 'generateItems', [9041], [1]);
  const [instance] = await h.snapshot(p);
  assert.ok((instance.tags || '').includes('color:red'), `per-item tags were ${instance.tags}`);

  const update = p.startUpdateProperties();
  p.setPropertyInt(update, instance.itemId, 'kills', 1);
  const result = await h.call(p, 'submitUpdateProperties', update);

  assert.equal(result.status, h.RESULT.OK, result.reason || '');
});

test('dynamic props: a category-only requiredTag matches any value of that category', { skip: needsProps() }, async () => {
  // "rarity" rather than "rarity:common": Valve allows restricting to a
  // tag_category:tag_value pair or to any value of a category.
  const p = provider({ propertyWhitelist: [{ name: 'kills', type: 'int', requiredTag: 'rarity' }] });
  const gamma = await seedOne(p, 9003); // rarity:rare
  const widget = await seedOne(p, 9004); // no tags

  const rare = p.startUpdateProperties();
  p.setPropertyInt(rare, gamma.itemId, 'kills', 1);
  assert.equal((await h.call(p, 'submitUpdateProperties', rare)).status, h.RESULT.OK);

  const none = p.startUpdateProperties();
  p.setPropertyInt(none, widget.itemId, 'kills', 1);
  assert.equal((await h.call(p, 'submitUpdateProperties', none)).status, h.RESULT.INVALID_PARAM);
});

// ─── Stack identity ───────────────────────────────────────────────────────────

test('dynamic props: writing a property does not split a stack', { skip: needsProps() }, async () => {
  // Properties are mutable per-instance state, so they are deliberately out of
  // stackKey(). If they were in it, the first counter written to a commodity
  // stack would shatter it — permanently, since the pieces could never key-
  // match again.
  const p = provider();
  await h.seed(p, { 9001: 10 });
  const [stack] = (await h.snapshot(p)).filter(i => i.itemdefid === 9001);
  assert.equal(stack.quantity, 10);

  const update = p.startUpdateProperties();
  p.setPropertyInt(update, stack.itemId, 'kills', 1);
  await h.call(p, 'submitUpdateProperties', update);

  const after = (await h.snapshot(p)).filter(i => i.itemdefid === 9001);
  assert.equal(after.length, 1, 'still one stack');
  assert.equal(after[0].quantity, 10);
  assert.equal(after[0].itemId, stack.itemId, 'and the same instance id');
});

test('dynamic props: a later grant still merges into a stack that carries properties', { skip: needsProps() }, async () => {
  const p = provider();
  await h.seed(p, { 9001: 10 });
  const [stack] = (await h.snapshot(p)).filter(i => i.itemdefid === 9001);

  const update = p.startUpdateProperties();
  p.setPropertyInt(update, stack.itemId, 'kills', 1);
  await h.call(p, 'submitUpdateProperties', update);

  await h.seed(p, { 9001: 5 });
  const after = (await h.snapshot(p)).filter(i => i.itemdefid === 9001);

  assert.equal(after.length, 1, 'the new grant merged rather than starting a second stack');
  assert.equal(after[0].quantity, 15);
  assert.deepEqual(await readProps(p, stack.itemId), { kills: 1 }, 'and the properties survived the merge');
});

// ─── Persistence ──────────────────────────────────────────────────────────────

test('dynamic props: properties survive a save/load round trip', { skip: needsProps('persistence') }, async () => {
  const p = provider();
  const item = await seedOne(p, 9120);

  const update = p.startUpdateProperties();
  p.setPropertyString(update, item.itemId, 'nickname', 'Betsy');
  p.setPropertyFloat(update, item.itemId, 'accuracy', 0.5);
  p.setPropertyBool(update, item.itemId, 'favourite', false);
  await h.call(p, 'submitUpdateProperties', update);

  const state = JSON.parse(JSON.stringify(p.save()));
  const restored = provider();
  restored.load(state);

  assert.deepEqual(await readProps(restored, item.itemId), {
    nickname: 'Betsy',
    accuracy: 0.5,
    favourite: false,
  });
});

test('dynamic props: an unchanged account still saves byte-identically', { skip: needsProps('persistence') }, async () => {
  const p = provider();
  const item = await seedOne(p, 9120);

  const update = p.startUpdateProperties();
  p.setPropertyInt(update, item.itemId, 'zulu', 1);
  p.setPropertyInt(update, item.itemId, 'alpha', 2);
  await h.call(p, 'submitUpdateProperties', update);

  const first = JSON.stringify(p.save());
  const restored = provider();
  restored.load(JSON.parse(first));

  assert.equal(JSON.stringify(restored.save().account), JSON.stringify(JSON.parse(first).account));
});

test('dynamic props: a float that holds a whole number is still a float after a reload', { skip: needsProps('persistence') }, async () => {
  // The wire form cannot carry the distinction (1.0 emits as 1), so the save
  // form keeps the type tag — otherwise a reload would quietly turn a float
  // into an int and start failing a white-list the client passed before.
  const p = provider({ propertyWhitelist: [{ name: 'accuracy', type: 'float' }] });
  const item = await seedOne(p, 9120);

  const update = p.startUpdateProperties();
  p.setPropertyFloat(update, item.itemId, 'accuracy', 1);
  await h.call(p, 'submitUpdateProperties', update);

  const restored = provider({ propertyWhitelist: [{ name: 'accuracy', type: 'float' }] });
  restored.load(JSON.parse(JSON.stringify(p.save())));

  const saved = restored.save().account.instances.find(i => i.itemId === item.itemId);
  assert.deepEqual(saved.dynamicProps.accuracy, { type: 'float', value: 1 });
});

// ─── Value model, through the provider ────────────────────────────────────────

test('dynamic props: the exported constructors force int vs float', { skip: needsProps() }, async () => {
  const p = provider({ propertyWhitelist: [{ name: 'n', type: 'float' }] });
  const item = await seedOne(p, 9120);

  assert.equal(properties.intProperty(1).type, 'int');
  assert.equal(properties.floatProperty(1).type, 'float');

  // setProperty's inference cannot tell them apart, so the white-list refuses it.
  const inferred = p.startUpdateProperties();
  p.setProperty(inferred, item.itemId, 'n', 1);
  assert.equal((await h.call(p, 'submitUpdateProperties', inferred)).status, h.RESULT.INVALID_PARAM);

  const explicit = p.startUpdateProperties();
  p.setPropertyFloat(explicit, item.itemId, 'n', 1);
  assert.equal((await h.call(p, 'submitUpdateProperties', explicit)).status, h.RESULT.OK);
});
