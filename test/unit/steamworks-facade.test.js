'use strict';

/**
 * unit/steamworks-facade.test.js
 *
 * The steamworks.js-shaped façade (lib/steamworks.js). Unit, not conformance:
 * every behavioural question about the economy is settled by the conformance
 * suite against MockProvider, and nothing here re-litigates it. What is on
 * trial is the translation — the bigint boundary, the tag split, the property
 * parse, rejection on a non-OK result, handle lifecycle, and the line between
 * `client.inventory` and `client.mock`.
 *
 * Three of these exist because the failure they catch is silent. The
 * MAX_SAFE_INTEGER test, because `Number(bigint)` truncates without complaint
 * and would silently address a different item. The leak test, because a handle
 * the façade forgot to destroy costs nothing here and leaks memory on real
 * Steam. And the reflective test, because a convenience invented in this file
 * would look like a Steam call to everyone downstream.
 */

const test = require('node:test');
const assert = require('node:assert');

const { init, SteamCallback, EResult, SteamItemFlags, SteamInventoryError, RESULT, MockProvider } = require('../../index');
const { ASYNC_CALLS, SYNC_CALLS } = require('../../lib/steamworks');
const fixtures = require('../../examples/economy');

const client = (options = {}) => init({ schema: fixtures, seed: 'facade', ...options });

/** One stack of `defId`, seeded and read back as an InventoryItem. */
async function seedOne(c, defId, quantity = 1) {
  const items = await c.inventory.generateItems([defId], [quantity]);
  return items[0];
}

// ─── Shape ────────────────────────────────────────────────────────────────────

test('facade: init() returns the four namespaces and a callback pump', () => {
  const c = client();
  assert.equal(typeof c.inventory, 'object');
  assert.equal(typeof c.callback.register, 'function');
  assert.equal(typeof c.mock, 'object');
  assert.equal(typeof c.runCallbacks, 'function');
});

test('facade: every inventory function is a real MockProvider method', () => {
  const c = client();
  // The point of the guard: a helper invented here would look, to everyone
  // downstream, exactly like a call Valve ships. If this fails, either the
  // façade grew an invention or a genuine call was misspelled.
  for (const name of Object.keys(c.inventory)) {
    assert.equal(
      typeof MockProvider.prototype[name],
      'function',
      `client.inventory.${name} has no corresponding MockProvider method`
    );
  }
  // And the tables really are the whole surface — nothing bound outside them.
  const expected = [
    ...Object.keys(ASYNC_CALLS),
    ...Object.keys(SYNC_CALLS),
    'requestEligiblePromoItemDefinitionsIDs',
  ].sort();
  assert.deepEqual(Object.keys(c.inventory).sort(), expected);
});

test('facade: mock-only affordances live in client.mock and nowhere else', () => {
  const c = client();
  // Each of these is something a real steamworks.js build could not do. If one
  // ever appears on client.inventory, swapping in a real binding stops failing
  // loudly and starts lying quietly, which is the whole reason for the split.
  const mockOnly = [
    'advanceTime',
    'save',
    'load',
    'saveToFile',
    'loadFromFile',
    'leakedResults',
    'setEntitlements',
    'bypassDropGating',
    'bypassPromoGating',
    'describeUpdate',
    'provider',
    'engine',
  ];
  for (const name of mockOnly) {
    assert.equal(name in c.inventory, false, `client.inventory must not expose ${name}`);
    assert.ok(name in c.mock, `client.mock should expose ${name}`);
  }
});

test('facade: EResult carries Steam\'s numbers and mirrors the engine\'s RESULT', () => {
  for (const [name, value] of Object.entries(RESULT)) {
    assert.ok(
      Object.values(EResult).includes(value),
      `RESULT.${name} = ${value} has no EResult member — the two have drifted`
    );
  }
  assert.equal(EResult.OK, 1);
  assert.equal(EResult.InvalidParam, 8);
  assert.equal(EResult.LimitExceeded, 25);
});

// ─── The bigint boundary ──────────────────────────────────────────────────────

test('facade: itemId comes out as bigint, itemDefId stays a number', async () => {
  const item = await seedOne(client(), 9001, 3);
  assert.equal(typeof item.itemId, 'bigint');
  assert.equal(typeof item.itemDefId, 'number');
  assert.equal(item.itemDefId, 9001);
  assert.equal(item.quantity, 3);
});

test('facade: an itemId goes in as either a bigint or a number', async () => {
  const c = client();
  const item = await seedOne(c, 9001, 4);

  const [asBigint] = await c.inventory.getItemsByID([item.itemId]);
  assert.equal(asBigint.itemId, item.itemId);

  const [asNumber] = await c.inventory.getItemsByID([Number(item.itemId)]);
  assert.equal(asNumber.itemId, item.itemId);

  // And through a call that mutates, not just one that reads.
  await c.inventory.consumeItem(Number(item.itemId), 1);
  await c.inventory.consumeItem(item.itemId, 1);
  const [left] = await c.inventory.getItemsByID([item.itemId]);
  assert.equal(left.quantity, 2);
});

test('facade: a bigint past MAX_SAFE_INTEGER is refused, not truncated', async () => {
  const c = client();
  const tooBig = BigInt(Number.MAX_SAFE_INTEGER) + 1n;

  await assert.rejects(() => c.inventory.consumeItem(tooBig, 1), err => {
    assert.ok(err instanceof RangeError);
    assert.match(err.message, /outside the range/);
    return true;
  });
  await assert.rejects(() => c.inventory.getItemsByID([tooBig]), RangeError);
  assert.throws(() => c.inventory.setProperty(1, tooBig, 'nickname', 'x'), RangeError);
});

test('facade: TransferItemQuantity still splits when handed Valve\'s ~0 sentinel', async () => {
  const c = client();
  const item = await seedOne(c, 9001, 5);

  // 18446744073709551615n is k_SteamItemInstanceIDInvalid on a uint64 — past
  // the ceiling itemIdIn refuses, but it means "no destination", not a bad id.
  const split = await c.inventory.transferItemQuantity(item.itemId, 2, 18446744073709551615n);
  assert.equal(split.length, 2);
  const fresh = split.find(i => i.itemId !== item.itemId);
  assert.equal(fresh.quantity, 2);

  // Omitting the destination entirely is the same call.
  const omitted = await c.inventory.transferItemQuantity(item.itemId, 1);
  assert.equal(omitted.length, 2);
});

test('facade: exchange materials accept bigint ids and per-entry quantities', async () => {
  const c = client();
  const seeded = await c.inventory.generateItems([9001, 9002], [2, 5]);
  const alpha = seeded.find(i => i.itemDefId === 9001);
  const beta = seeded.find(i => i.itemDefId === 9002);

  const items = await c.inventory.exchangeItems(9010, [
    { itemId: alpha.itemId, quantity: 2 },
    { itemId: beta.itemId, quantity: 5 },
  ]);
  const made = items.find(i => i.itemDefId === 9010);
  assert.equal(typeof made.itemId, 'bigint');
  assert.equal(made.quantity, 1);
});

// ─── Result shape ─────────────────────────────────────────────────────────────

test('facade: tags come back as a string array, and an untagged item gives []', async () => {
  const c = client();

  const plain = await seedOne(c, 9001);
  assert.deepEqual(plain.tags, []); // not [''] — the provider hands us ''

  // 9041 rolls one generator tag onto a Beta and carries color:red itself.
  const [tagged] = await c.inventory.generateItems([9041], [1]);
  assert.ok(Array.isArray(tagged.tags));
  assert.ok(tagged.tags.includes('color:red'));
  assert.equal(tagged.tags.length, 2);
  for (const tag of tagged.tags) assert.equal(typeof tag, 'string');
});

test('facade: dynamicProps round-trip as plain JS values', async () => {
  const c = client();
  const item = await seedOne(c, 9001);

  const update = c.inventory.startUpdateProperties();
  c.inventory.setPropertyString(update, item.itemId, 'nickname', 'Old Faithful');
  c.inventory.setPropertyInt(update, item.itemId, 'kills', 7);
  c.inventory.setPropertyBool(update, item.itemId, 'favourite', true);
  c.inventory.setPropertyFloat(update, item.itemId, 'wear', 0.25);
  await c.inventory.submitUpdateProperties(update);

  const [read] = await c.inventory.getItemsByID([item.itemId]);
  assert.deepEqual(read.dynamicProps, {
    favourite: true,
    kills: 7,
    nickname: 'Old Faithful',
    wear: 0.25,
  });
  assert.equal(typeof read.dynamicProps.kills, 'number');
  assert.equal(typeof read.dynamicProps.favourite, 'boolean');

  const removal = c.inventory.startUpdateProperties();
  c.inventory.removeProperty(removal, item.itemId, 'kills');
  await c.inventory.submitUpdateProperties(removal);
  const [after] = await c.inventory.getItemsByID([item.itemId]);
  assert.equal('kills' in after.dynamicProps, false);
});

test('facade: an item with no properties gives {}, not null', async () => {
  const item = await seedOne(client(), 9002);
  assert.deepEqual(item.dynamicProps, {});
});

test('facade: flags report NoTrade from the itemdef and fabricate nothing else', async () => {
  const c = client();
  const item = await seedOne(c, 9001); // the fixture is tradable: false throughout
  assert.equal(item.flags & SteamItemFlags.NoTrade, SteamItemFlags.NoTrade);

  // Removed/Consumed say *why a row is in a result set*, and this library's
  // rows carry no such provenance — a consumed stack and a split source that
  // emptied are the same row. Reporting 0 is the honest answer; see flagsFor.
  const consumed = await c.inventory.consumeItem(item.itemId, 1);
  assert.equal(consumed[0].quantity, 0);
  assert.equal(consumed[0].flags & SteamItemFlags.ItemConsumed, 0);
  assert.equal(consumed[0].flags & SteamItemFlags.ItemRemoved, 0);
});

test('facade: flags claim nothing while item definitions are still loading', async () => {
  const c = client({ deferDefinitions: true });
  const item = await seedOne(c, 9001);
  // GetItemDefinitionProperty serves nothing yet, so "not tradable" is unknown
  // rather than false, and unknown is 0.
  assert.equal(item.flags, 0);

  c.inventory.loadItemDefinitions();
  const [loaded] = await c.inventory.getItemsByID([item.itemId]);
  assert.equal(loaded.flags & SteamItemFlags.NoTrade, SteamItemFlags.NoTrade);
});

// ─── Failure ──────────────────────────────────────────────────────────────────

test('facade: a non-OK result rejects with a SteamInventoryError carrying the EResult', async () => {
  const c = client();
  await assert.rejects(
    () => c.inventory.consumeItem(999999, 1),
    err => {
      assert.ok(err instanceof SteamInventoryError);
      assert.equal(err.name, 'SteamInventoryError');
      assert.equal(err.result, EResult.InvalidParam);
      assert.equal(typeof err.reason, 'string'); // mock-only diagnostic
      assert.match(err.message, /InvalidParam/);
      return true;
    }
  );
});

test('facade: an exchange with no matching recipe rejects rather than resolving empty', async () => {
  const c = client();
  const item = await seedOne(c, 9001, 1);
  await assert.rejects(
    () => c.inventory.exchangeItems(9010, [{ itemId: item.itemId, quantity: 1 }]),
    SteamInventoryError
  );
});

test('facade: no handles leak, across successful and failing calls alike', async () => {
  const c = client();
  const item = await seedOne(c, 9001, 4);

  const outcomes = await Promise.allSettled([
    c.inventory.getAllItems(),
    c.inventory.consumeItem(item.itemId, 1),
    c.inventory.consumeItem(999999, 1),
    c.inventory.exchangeItems(9015, [{ itemId: item.itemId, quantity: 1 }]),
    c.inventory.getItemsByID([item.itemId]),
    c.inventory.triggerItemDrop(9053),
  ]);
  assert.ok(outcomes.some(o => o.status === 'fulfilled'));
  assert.ok(outcomes.some(o => o.status === 'rejected'));

  // A handle the façade forgot to destroy is free here and a memory leak on
  // real Steam, so the rejection path has to collect just as the happy one does.
  assert.deepEqual(c.mock.leakedResults(), []);
});

// ─── Callbacks ────────────────────────────────────────────────────────────────

test('facade: callback.register delivers, and disconnect() stops delivery', async () => {
  const c = client();
  const seen = [];
  const handle = c.callback.register(SteamCallback.SteamInventoryResultReady, struct => seen.push(struct));

  await c.inventory.getAllItems();
  assert.equal(seen.length, 1);
  assert.equal(typeof seen[0].handle, 'number');
  assert.equal(seen[0].result, EResult.OK);

  handle.disconnect();
  await c.inventory.getAllItems();
  assert.equal(seen.length, 1);
});

test('facade: registering an unknown callback throws instead of never firing', () => {
  const c = client();
  assert.throws(() => c.callback.register(999, () => {}), /Unknown SteamCallback 999/);
  assert.throws(() => c.callback.register(undefined, () => {}), /Unknown SteamCallback/);
});

test('facade: the definition-update callback delivers Valve\'s empty struct', () => {
  const c = client({ deferDefinitions: true });
  const seen = [];
  c.callback.register(SteamCallback.SteamInventoryDefinitionUpdate, struct => seen.push(struct));
  c.inventory.loadItemDefinitions();
  assert.deepEqual(seen, [{}]);
});

test('facade: the full-update callback fires for results that touched items', async () => {
  const c = client();
  const seen = [];
  c.callback.register(SteamCallback.SteamInventoryFullUpdate, struct => seen.push(struct.handle));
  await c.inventory.generateItems([9001], [1]);
  assert.equal(seen.length, 1);
});

test('facade: requestEligiblePromoItemDefinitionsIDs resolves with the ids', async () => {
  const c = client();
  c.mock.setEntitlements({ ownsApps: [440] });

  // The synchronous getter sees nothing until a request has delivered — the
  // trap real Steam sets, kept intact behind the promise.
  assert.deepEqual(c.inventory.getEligiblePromoItemDefinitionIDs(), []);

  const ids = await c.inventory.requestEligiblePromoItemDefinitionsIDs();
  assert.ok(ids.includes(9062), 'owns:440 should make the Owner Reward eligible');
  for (const id of ids) assert.equal(typeof id, 'number'); // SteamItemDef_t is int32
  assert.deepEqual(c.inventory.getEligiblePromoItemDefinitionIDs(), ids);
});

test('facade: runCallbacks() is safe to call and lets pending work land', async () => {
  const c = client({ latency: 5 });
  const seen = [];
  c.callback.register(SteamCallback.SteamInventoryResultReady, struct => seen.push(struct));

  const pending = c.inventory.getAllItems();
  assert.equal(seen.length, 0);
  await c.runCallbacks();
  assert.equal(seen.length, 1, 'runCallbacks() should return only once in-flight work has landed');

  await pending;
  await c.runCallbacks(); // idle is not an error
  assert.deepEqual(c.mock.leakedResults(), []);
});

// ─── The mock namespace ───────────────────────────────────────────────────────

test('facade: mock.advanceTime drives playtime drops', async () => {
  const c = client();
  // An ineligible drop is a success with nothing in it, as on Steam — so it
  // resolves empty rather than rejecting, and the façade must not turn the
  // absence of items into an error.
  assert.deepEqual(await c.inventory.triggerItemDrop(9050), []);

  c.mock.advanceTime(30);
  const dropped = await c.inventory.triggerItemDrop(9050);
  assert.equal(dropped[0].itemDefId, 9001);
});

test('facade: mock.bypassDropGating reports the setting it replaced', async () => {
  const c = client();
  assert.equal(c.mock.bypassDropGating(true), false);
  const dropped = await c.inventory.triggerItemDrop(9050); // no playtime accrued
  assert.equal(dropped.length, 1);
  assert.equal(c.mock.bypassDropGating(false), true);
});

test('facade: mock.save / mock.load round-trip through JSON, which bigint could not', async () => {
  const c = client();
  const item = await seedOne(c, 9001, 3);

  const state = c.mock.save();
  const wire = JSON.parse(JSON.stringify(state)); // the boundary stops at the façade

  const restored = client();
  restored.mock.load(wire);
  const [same] = await restored.inventory.getItemsByID([item.itemId]);
  assert.equal(same.itemId, item.itemId);
  assert.equal(typeof same.itemId, 'bigint');
  assert.equal(same.quantity, 3);
});

test('facade: mock.provider and mock.engine are the same objects the façade drives', async () => {
  const c = client();
  await seedOne(c, 9001, 2);
  assert.equal(c.mock.provider.engine, c.mock.engine);
  assert.equal(c.mock.engine.account('player'), c.mock.provider.account);
});
