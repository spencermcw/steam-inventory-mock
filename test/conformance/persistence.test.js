'use strict';

/**
 * conformance/persistence.test.js
 *
 * Save and reload a player through the provider surface — the path the Electron
 * client takes when it is closed and reopened.
 *
 * The state that must survive is not just "what items do I have". It is the
 * per-item tags rolled once at creation, the drop buckets that decide when the
 * next supply drop is due, and the promo history that stops a once-per-account
 * grant being claimed twice. Each of those is invisible in a naive inventory
 * comparison, and each is a duplication exploit or a lost cosmetic if it is
 * dropped on reload — so every one is asserted here.
 *
 * Real Steam keeps the inventory server-side and will neither export nor import
 * it, so a SteamProvider advertises `persistence: false` and these skip there.
 */

const test = require('node:test');
const assert = require('node:assert');

const h = require('../harness');
const fixtures = require('../fixtures/synthetic');

const provider = (options = {}) => h.createProvider({ schema: fixtures, ...options });
const needs = (...caps) => h.needs('persistence', ...caps);

/** Play a short session: tagged items, a drop, a promo, an exchange. */
async function playSession(p) {
  await h.call(p, 'addPromoItem', 9060); // Starter Kit — once per account
  await h.call(p, 'generateItems', [9041, 9041], [1, 1]); // tagging generator: color:red + a rolled quality
  await h.call(p, 'generateItems', [9001], [4]);

  p.advanceTime(45); // past 9050's 30-minute drop_interval
  const drop = await h.call(p, 'triggerItemDrop', 9050);
  assert.equal(drop.granted, true, 'the session needs the drop to have been taken');

  const materials = await h.materials(p, { 9001: 2 });
  const exchange = await h.call(p, 'exchangeItems', 9010, materials);
  assert.ok(exchange.ok, `the session needs the exchange to succeed: ${exchange.reason}`);
  return p;
}

// ─── Round trip ───────────────────────────────────────────────────────────────

test('persistence: a saved session reloads item-for-item, tag-for-tag', { skip: needs('customSchema', 'sandboxGrants', 'virtualClock') }, async () => {
  const before = await playSession(provider({ seed: 'save-round-trip' }));
  const expected = await h.snapshot(before);
  assert.ok(expected.some(i => (i.tags || '').includes('color:red')), 'the fixture session should produce tagged items');

  const state = JSON.parse(JSON.stringify(before.save()));

  const after = provider({ seed: 'unrelated-seed' });
  after.load(state);

  // Item ids, itemdefs, quantities *and* the exact per-item tag strings.
  assert.deepEqual(await h.snapshot(after), expected);
  assert.equal(after.account.fingerprint(), before.account.fingerprint());
  assert.deepEqual(after.account.toJSON(), before.account.toJSON());
});

test('persistence: drop buckets survive, so a reload cannot re-roll a spent drop', { skip: needs('customSchema', 'sandboxGrants', 'virtualClock') }, async () => {
  const before = await playSession(provider({ seed: 'save-drops' }));
  const after = provider();
  after.load(JSON.parse(JSON.stringify(before.save())));

  // Immediately after loading, the drop taken during the session is still spent
  // — the clock and the bucket came back together.
  const immediate = await h.call(after, 'triggerItemDrop', 9050);
  assert.equal(immediate.granted, false);
  assert.match(immediate.reason, /playtime/);

  // And the timer resumes from where it was, not from zero.
  after.advanceTime(30);
  const later = await h.call(after, 'triggerItemDrop', 9050);
  assert.equal(later.granted, true);
});

test('persistence: promo history survives, so a once-per-account grant stays spent', { skip: needs('customSchema', 'sandboxGrants', 'virtualClock') }, async () => {
  const before = await playSession(provider({ seed: 'save-promos' }));
  const after = provider();
  after.load(JSON.parse(JSON.stringify(before.save())));

  const again = await h.call(after, 'addPromoItem', 9060);
  assert.equal(again.granted, false);
  assert.match(again.reason, /once per account/);
  assert.equal(after.account.promoGrants.get(9060).count, 1);
});

test('persistence: entitlements survive', { skip: needs('customSchema', 'sandboxGrants', 'entitlements') }, async () => {
  const before = provider();
  h.setEntitlements(before, { ownsApps: [440], achievements: ['first_landing'], playtime: { 570: 900 } });
  await h.call(before, 'addPromoItem', 9062); // promo: owns:440

  const after = provider();
  after.load(JSON.parse(JSON.stringify(before.save())));

  assert.ok(after.account.ownedApps.has(440));
  assert.ok(after.account.achievements.has('first_landing'));
  assert.equal(after.account.playtimeByApp.get(570), 900);
  // The owns:440 promo is still both entitled and already-claimed.
  const again = await h.call(after, 'addPromoItem', 9062);
  assert.equal(again.granted, false);
  assert.match(again.reason, /once per account/);
});

// ─── The instance-id watermark ────────────────────────────────────────────────

test('persistence: an item created after a reload cannot collide with a restored id', { skip: needs('customSchema', 'sandboxGrants', 'virtualClock') }, async () => {
  const before = await playSession(provider({ seed: 'save-watermark' }));
  const state = JSON.parse(JSON.stringify(before.save()));
  const restoredIds = new Set(state.account.instances.map(i => i.itemId));
  assert.ok(restoredIds.size > 0);

  const after = provider();
  after.load(state);

  // 9004 does not auto_stack, so this is guaranteed to be a brand-new instance.
  const created = await h.call(after, 'generateItems', [9004], [1]);
  const newId = created.items[0].itemId;

  assert.ok(!restoredIds.has(newId), `new instance id ${newId} collides with a restored id`);
  assert.ok(newId >= state.nextInstanceId, `new instance id ${newId} is below the saved watermark ${state.nextInstanceId}`);

  // ...and the whole inventory still has one instance per id.
  const ids = (await h.snapshot(after)).map(i => i.itemId);
  assert.equal(new Set(ids).size, ids.length, 'duplicate instance ids after reload');
});

test('persistence: loading two saves into one process keeps every id distinct', { skip: needs('customSchema', 'sandboxGrants', 'virtualClock') }, async () => {
  // The Engine supports several players over one economy, and the id counter is
  // shared by all of them. Loading player B must not rewind past player A.
  const a = await playSession(provider({ seed: 'save-multi-a' }));
  const b = await playSession(provider({ seed: 'save-multi-b' }));
  const saveA = JSON.parse(JSON.stringify(a.save()));
  const saveB = JSON.parse(JSON.stringify(b.save()));

  const engine = provider({ accountId: 'p1' });
  engine.load(saveA);
  const second = h.createProvider({ engine: engine.engine, accountId: 'p2' });
  second.load(saveB, {});

  const idsA = (await h.snapshot(engine)).map(i => i.itemId);
  const idsB = (await h.snapshot(second)).map(i => i.itemId);
  const fresh = await h.call(second, 'generateItems', [9004], [1]);

  assert.ok(!idsA.includes(fresh.items[0].itemId), 'a new id collided with the other player\'s inventory');
  assert.ok(!idsB.includes(fresh.items[0].itemId), 'a new id collided with the restored inventory');
});

// ─── Clock, RNG and versioning ────────────────────────────────────────────────

test('persistence: the clock and the RNG resume where the save left off', { skip: needs('customSchema', 'sandboxGrants', 'virtualClock', 'deterministicRng') }, async () => {
  const before = await playSession(provider({ seed: 'save-continuity' }));
  const state = JSON.parse(JSON.stringify(before.save()));

  // What the original would have rolled next, from the saved RNG state.
  const nextRolls = [];
  for (let i = 0; i < 5; i++) {
    const result = await h.call(before, 'generateItems', [9030], [1]);
    nextRolls.push(result.items.map(i => i.itemdefid).sort());
  }

  const after = provider({ seed: 'a-completely-different-seed' });
  after.load(state);

  assert.equal(after.clock.now(), state.clock.nowMs);
  assert.equal(after.clock.playtime(), state.clock.playtimeMinutes);

  const replayed = [];
  for (let i = 0; i < 5; i++) {
    const result = await h.call(after, 'generateItems', [9030], [1]);
    replayed.push(result.items.map(i => i.itemdefid).sort());
  }
  assert.deepEqual(replayed, nextRolls, 'a restored save must not re-roll differently');
});

test('persistence: a save from a newer build is refused', { skip: needs('customSchema') }, async () => {
  const p = provider();
  const state = p.save();
  assert.throws(() => p.load({ ...state, version: state.version + 1 }), /newer build/);
  assert.throws(() => p.load({ ...state, version: null }), /no usable version/);
});

test('persistence: result handles are not part of a save', { skip: needs('customSchema', 'sandboxGrants') }, async () => {
  const p = provider();
  await h.call(p, 'generateItems', [9001], [1]);
  const state = p.save();

  assert.equal(state.results, undefined);
  assert.equal(state.nextHandle, undefined);
  assert.ok(!JSON.stringify(state).includes('"handle"'));
});

test('persistence: loading while an operation is in flight is refused', { skip: needs('customSchema', 'sandboxGrants') }, async () => {
  const p = provider();
  const state = p.save();
  const handle = p.generateItems([9001], [1]); // dispatched, not yet run
  assert.throws(() => p.load(state), /in flight/);
  await h.call(p, 'getAllItems'); // drain
  p.destroyResult(handle);
  assert.ok(p.load(state));
});
