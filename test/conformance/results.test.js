'use strict';

/**
 * conformance/results.test.js
 *
 * The four ISteamInventory calls that round out the handle/result surface:
 * GetItemsByID (a filtered read), GetResultTimestamp and CheckResultSteamID
 * (metadata about a result that isn't the items themselves), and
 * LoadItemDefinitions (the async arrival real Steam has and an eager mock
 * hides unless asked to defer) — plus SteamItemDetails_t::m_unFlags, which is
 * the part of a result row that says why the row is there at all.
 */

const test = require('node:test');
const assert = require('node:assert');

const h = require('../harness');
const fixtures = require('../../examples/economy');
const { k_SteamItemInstanceIDInvalid } = require('../../index');

const provider = (options = {}) => h.createProvider({ schema: fixtures, ...options });

/**
 * ESteamItemFlags, restated from Valve's header rather than imported from this
 * library. A conformance test that read the numbers out of the thing under
 * test would agree with it by construction, including about being wrong; these
 * are the values a real binding will deliver.
 */
const REMOVED = 1 << 8;
const CONSUMED = 1 << 9;

/** The one instance of an itemdef currently held. */
const instanceOf = async (p, itemdefid) => (await h.snapshot(p)).find(i => i.itemdefid === itemdefid);

// ─── GetItemsByID ───────────────────────────────────────────────────────────

test('results: getItemsByID returns only the requested instances', { skip: h.needs('customSchema', 'sandboxGrants') }, async () => {
  const p = provider();
  await h.seed(p, { 9001: 2 });
  await h.seed(p, { 9004: 3 });
  const all = await h.snapshot(p);
  const [alpha] = all.filter(i => i.itemdefid === 9001);
  const [widget] = all.filter(i => i.itemdefid === 9004);

  const result = await h.call(p, 'getItemsByID', [alpha.itemId]);
  assert.equal(result.status, h.RESULT.OK);
  assert.deepEqual(
    result.items.map(i => i.itemId).sort(),
    [alpha.itemId]
  );
  assert.notEqual(result.items.map(i => i.itemId).includes(widget.itemId), true);
});

test('results: getItemsByID silently ignores instance ids it does not hold', { skip: h.needs('customSchema', 'sandboxGrants') }, async () => {
  const p = provider();
  await h.seed(p, { 9001: 1 });
  const [alpha] = await h.snapshot(p);

  const result = await h.call(p, 'getItemsByID', [alpha.itemId, 999999]);
  assert.equal(result.status, h.RESULT.OK, 'an unknown id is absent, not an error');
  assert.deepEqual(result.items.map(i => i.itemId), [alpha.itemId]);
});

test('results: getItemsByID does not duplicate a repeated id in the request', { skip: h.needs('customSchema', 'sandboxGrants') }, async () => {
  const p = provider();
  await h.seed(p, { 9001: 1 });
  const [alpha] = await h.snapshot(p);

  const result = await h.call(p, 'getItemsByID', [alpha.itemId, alpha.itemId, alpha.itemId]);
  assert.equal(result.items.length, 1);
});

// Result metadata reads (getResultTimestamp / checkResultSteamID) need the
// result record still in the map, so these dispatch directly and wait for
// 'resultReady' instead of going through h.call(), which destroys on read.
function dispatchAndWait(p, method, ...args) {
  return new Promise(resolve => {
    const handle = p[method](...args);
    p.once('resultReady', ready => {
      if (ready === handle) resolve(handle);
    });
  });
}

// ─── GetResultTimestamp ─────────────────────────────────────────────────────

test('results: getResultTimestamp advances as the virtual clock advances', { skip: h.needs('customSchema', 'virtualClock') }, async () => {
  const p = provider();
  const first = await dispatchAndWait(p, 'getAllItems');
  const firstStamp = p.getResultTimestamp(first);
  assert.equal(typeof firstStamp, 'number');
  assert.ok(firstStamp > 0);
  p.destroyResult(first);

  p.advanceTime(60);
  const second = await dispatchAndWait(p, 'getAllItems');
  const secondStamp = p.getResultTimestamp(second);
  p.destroyResult(second);

  assert.ok(secondStamp > firstStamp, 'the timestamp should track the clock, not wall time');
  assert.equal(secondStamp - firstStamp, 60 * 60, 'a uint32 Unix timestamp, in seconds, not milliseconds');
});

test('results: getResultTimestamp is stamped at dispatch time, not call time', { skip: h.needs('customSchema', 'virtualClock') }, async () => {
  const p = provider();
  const handle = p.getAllItems(); // issued now, but not yet run
  p.advanceTime(30); // the clock moves before the queue drains
  await new Promise(resolve => setTimeout(resolve, 5));

  const expected = Math.floor(p.clock.now() / 1000);
  assert.equal(p.getResultTimestamp(handle), expected);
  p.destroyResult(handle);
});

test('results: getResultTimestamp on an unknown handle is 0', { skip: h.needs('customSchema') }, () => {
  const p = provider();
  assert.equal(p.getResultTimestamp(999999), 0);
});

// ─── CheckResultSteamID ─────────────────────────────────────────────────────

test('results: checkResultSteamID is true for the owning account and false for another', { skip: h.needs('customSchema', 'sandboxGrants') }, async () => {
  // Two providers over one economy (see persistence.test.js for the pattern):
  // results are still tracked per-provider handle, but the account each result
  // was produced for is what CheckResultSteamID actually compares.
  const alice = provider({ accountId: 'alice' });
  const bob = h.createProvider({ engine: alice.engine, accountId: 'bob' });

  const aliceHandle = await dispatchAndWait(alice, 'getAllItems');
  const bobHandle = await dispatchAndWait(bob, 'getAllItems');

  assert.equal(alice.checkResultSteamID(aliceHandle, 'alice'), true);
  assert.equal(alice.checkResultSteamID(aliceHandle, 'bob'), false);
  assert.equal(bob.checkResultSteamID(bobHandle, 'bob'), true);
  assert.equal(bob.checkResultSteamID(bobHandle, 'alice'), false);

  alice.destroyResult(aliceHandle);
  bob.destroyResult(bobHandle);
});

test('results: checkResultSteamID compares with String() so a numeric id still works', { skip: h.needs('customSchema') }, async () => {
  const p = provider({ accountId: '42' });
  const handle = await dispatchAndWait(p, 'getAllItems');
  assert.equal(p.checkResultSteamID(handle, 42), true);
  p.destroyResult(handle);
});

test('results: checkResultSteamID on an unknown handle is false', { skip: h.needs('customSchema') }, () => {
  const p = provider();
  assert.equal(p.checkResultSteamID(999999, p.account.id), false);
});

// ─── LoadItemDefinitions ────────────────────────────────────────────────────

test('results: loadItemDefinitions returns true and fires definitionUpdate', { skip: h.needs('customSchema') }, async () => {
  const p = provider();
  let fired = false;
  p.on('definitionUpdate', () => {
    fired = true;
  });

  assert.equal(p.loadItemDefinitions(), true);
  assert.equal(fired, true);
});

test('results: deferDefinitions withholds definitions until loadItemDefinitions is called', { skip: h.needs('customSchema') }, async () => {
  const p = provider({ deferDefinitions: true });

  assert.deepEqual(p.getItemDefinitionIDs(), [], 'nothing has arrived yet');
  assert.equal(p.getItemDefinitionProperty(9001, 'name'), null, 'nothing has arrived yet');

  let fired = false;
  p.on('definitionUpdate', () => {
    fired = true;
  });
  p.loadItemDefinitions();

  assert.equal(fired, true);
  assert.ok(p.getItemDefinitionIDs().includes(9001), 'definitions are available after loadItemDefinitions');
  assert.equal(p.getItemDefinitionProperty(9001, 'name'), 'Alpha');
});

test('results: without deferDefinitions, definitions are available immediately', { skip: h.needs('customSchema') }, () => {
  const p = provider();
  assert.ok(p.getItemDefinitionIDs().includes(9001));
  assert.equal(p.getItemDefinitionProperty(9001, 'name'), 'Alpha');
});

// ─── Result item flags ──────────────────────────────────────────────────────

/**
 * m_unFlags carries the provenance of a row: k_ESteamItemRemoved and
 * k_ESteamItemConsumed say why an operation is reporting this item. The bits
 * are set by the engine where it spends or destroys an instance, so the case
 * these tests really exist for is the one no downstream reader could ever
 * settle for itself — several rows at quantity 0 in one result, arrived at by
 * different routes, and (under 'new-instance') a dead row sharing its itemdef
 * with the live one that replaced it.
 *
 * NoTrade (1 << 0) is not asserted here: it is a fact about an item
 * *definition*, read through GetItemDefinitionProperty, and belongs to the
 * façade's flag assembly rather than to a result row.
 */

test('results: a consumed row says so, and says whether the stack survived it', { skip: h.needs('customSchema', 'sandboxGrants') }, async () => {
  const p = provider();
  await h.seed(p, { 9001: 2 });
  const alpha = await instanceOf(p, 9001);

  const partial = await h.call(p, 'consumeItem', alpha.itemId, 1);
  assert.equal(partial.items[0].quantity, 1);
  assert.equal(partial.items[0].flags & CONSUMED, CONSUMED);
  assert.equal(partial.items[0].flags & REMOVED, 0, 'one unit went; the instance is still held');

  const emptied = await h.call(p, 'consumeItem', alpha.itemId, 1);
  assert.equal(emptied.items[0].quantity, 0);
  assert.equal(emptied.items[0].flags & CONSUMED, CONSUMED);
  assert.equal(emptied.items[0].flags & REMOVED, REMOVED, 'the id is gone; a caller holding it must retire it');
});

test('results: exchange materials are flagged consumed and the product is not', { skip: h.needs('customSchema', 'sandboxGrants') }, async () => {
  const p = provider();
  await h.seed(p, { 9001: 3 }); // 9010 costs 9001x2

  const surviving = await h.call(p, 'exchangeItems', 9010, await h.materials(p, { 9001: 2 }));
  assert.equal(surviving.status, h.RESULT.OK, surviving.reason || '');
  const spent = surviving.items.find(i => i.itemdefid === 9001);
  assert.equal(spent.quantity, 1);
  assert.equal(spent.flags & CONSUMED, CONSUMED, 'two of the three units were spent as material');
  assert.equal(spent.flags & REMOVED, 0, 'the stack outlived the exchange');
  const product = surviving.items.find(i => i.itemdefid === 9010);
  assert.equal(product.flags, 0, 'what the exchange produced was neither removed nor consumed');

  // Now spend the stack down to nothing: same CONSUMED, and REMOVED with it.
  await h.seed(p, { 9001: 1 });
  const emptied = await h.call(p, 'exchangeItems', 9010, await h.materials(p, { 9001: 2 }));
  assert.equal(emptied.status, h.RESULT.OK, emptied.reason || '');
  const gone = emptied.items.find(i => i.itemdefid === 9001);
  assert.equal(gone.quantity, 0);
  assert.equal(gone.flags & CONSUMED, CONSUMED);
  assert.equal(gone.flags & REMOVED, REMOVED);
});

test("results: under toolResultPolicy 'new-instance' the flags separate the dead target from the live one", { skip: h.needs('customSchema', 'sandboxGrants', 'configurableToolResult') }, async () => {
  // The case the whole feature exists for. This call returns three rows, two
  // of them itemdef 9101, and `items.find(i => i.itemdefid === 9101)` picks by
  // position — which is a coin flip between an item the player holds and an id
  // that no longer exists.
  const p = provider({ toolResultPolicy: 'new-instance' });
  await h.seed(p, { 9100: 1, 9101: 1 });
  const before = await instanceOf(p, 9101);

  const result = await h.call(p, 'exchangeItems', 9101, await h.materials(p, { 9100: 1, 9101: 1 }));
  assert.equal(result.status, h.RESULT.OK, result.reason || '');

  const hats = result.items.filter(i => i.itemdefid === 9101);
  assert.equal(hats.length, 2, 'the destroyed target and its replacement share an itemdefid');
  const destroyed = hats.find(i => i.flags & REMOVED);
  const replacement = hats.find(i => !(i.flags & REMOVED));

  assert.equal(destroyed.itemId, before.itemId, 'the row carrying the old id is the removed one');
  assert.equal(destroyed.quantity, 0);
  assert.equal(destroyed.flags & CONSUMED, 0, 'destroyed by the tool use, not spent as material');
  assert.notEqual(replacement.itemId, before.itemId);
  assert.equal(replacement.flags, 0, 'the item the player now holds is flagged nothing at all');

  const held = (await h.snapshot(p)).map(i => i.itemId);
  assert.equal(held.includes(replacement.itemId), true);
  assert.equal(held.includes(destroyed.itemId), false);

  const tool = result.items.find(i => i.itemdefid === 9100);
  assert.equal(tool.flags & CONSUMED, CONSUMED, 'the tool was spent');
  assert.equal(tool.flags & REMOVED, REMOVED, 'and it was the last one');
});

test("results: under toolResultPolicy 'mutate' the surviving target is flagged neither", { skip: h.needs('customSchema', 'sandboxGrants', 'configurableToolResult') }, async () => {
  const p = provider({ toolResultPolicy: 'mutate' });
  await h.seed(p, { 9100: 1, 9101: 1 });
  const before = await instanceOf(p, 9101);

  const result = await h.call(p, 'exchangeItems', 9101, await h.materials(p, { 9100: 1, 9101: 1 }));
  assert.equal(result.status, h.RESULT.OK, result.reason || '');

  const hats = result.items.filter(i => i.itemdefid === 9101);
  assert.equal(hats.length, 1, 'nothing was destroyed, so there is nothing to replace');
  assert.equal(hats[0].itemId, before.itemId);
  assert.equal(hats[0].flags, 0, 'same instance, same id, different tags — removed nor consumed');
});

test('results: a split that empties its source flags it removed and not consumed', { skip: h.needs('customSchema', 'sandboxGrants') }, async () => {
  const p = provider();
  await h.seed(p, { 9001: 3 });
  const alpha = await instanceOf(p, 9001);

  const partial = await h.call(p, 'transferItemQuantity', alpha.itemId, 1, k_SteamItemInstanceIDInvalid);
  const kept = partial.items.find(i => i.itemId === alpha.itemId);
  const split = partial.items.find(i => i.itemId !== alpha.itemId);
  assert.equal(kept.flags, 0, 'a source that survives a split is flagged nothing');
  assert.equal(split.flags, 0, 'and neither is the new stack');

  const whole = await h.call(p, 'transferItemQuantity', alpha.itemId, 2, k_SteamItemInstanceIDInvalid);
  const emptied = whole.items.find(i => i.itemId === alpha.itemId);
  assert.equal(emptied.quantity, 0);
  assert.equal(emptied.flags & REMOVED, REMOVED, 'splitting the whole stack retires the source id');
  assert.equal(emptied.flags & CONSUMED, 0, 'the quantity moved; nothing was spent');
});

test('results: grants and plain reads carry no removal flags', { skip: h.needs('customSchema', 'sandboxGrants') }, async () => {
  const p = provider();
  const granted = await h.call(p, 'generateItems', [9001, 9020], [2, 1]);
  assert.equal(granted.items.length > 1, true, 'a bundle expands to several rows');
  for (const item of granted.items) assert.equal(item.flags, 0, `granted itemdef ${item.itemdefid}`);

  // A read reports 0 because that is the fact about a read, not because a
  // default happened to be left in place: nothing GetAllItems returns was
  // removed or consumed by GetAllItems.
  const all = await h.call(p, 'getAllItems');
  for (const item of all.items) assert.equal(item.flags, 0);
});

// ─── Deprecated and lifecycle callbacks ──────────────────────────────────────

test('results: sendItemDropHeartbeat is inert rather than an error', { skip: h.needs('customSchema') }, () => {
  // Valve deprecated it. A client ported from an older SDK still calls it, and
  // throwing on something real Steam merely ignores sends someone chasing a
  // bug that does not exist.
  const p = h.createProvider({ schema: fixtures });
  assert.doesNotThrow(() => p.sendItemDropHeartbeat());
  assert.doesNotThrow(() => p.sendItemDropHeartbeat());
});

test('results: a successful grant raises fullUpdate, a failure does not', { skip: h.needs('customSchema', 'sandboxGrants') }, async () => {
  const p = h.createProvider({ schema: fixtures });
  let updates = 0;
  p.on('fullUpdate', () => updates++);

  await h.call(p, 'generateItems', [9001], [2]);
  assert.equal(updates, 1, 'the grant refreshed the inventory');

  // 9015 has no exchange formula, so this fails without touching anything.
  await h.call(p, 'exchangeItems', 9015, [{ itemId: 1, quantity: 1 }]);
  assert.equal(updates, 1, 'a failed call must not train the client to redraw');
});
