'use strict';

/**
 * conformance/results.test.js
 *
 * The four ISteamInventory calls that round out the handle/result surface:
 * GetItemsByID (a filtered read), GetResultTimestamp and CheckResultSteamID
 * (metadata about a result that isn't the items themselves), and
 * LoadItemDefinitions (the async arrival real Steam has and an eager mock
 * hides unless asked to defer).
 */

const test = require('node:test');
const assert = require('node:assert');

const h = require('../harness');
const fixtures = require('../../examples/economy');

const provider = (options = {}) => h.createProvider({ schema: fixtures, ...options });

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
