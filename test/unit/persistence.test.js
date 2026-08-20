'use strict';

/**
 * unit/persistence.test.js — the save envelope, the account payload, and the
 * instance-id watermark.
 *
 * The watermark cases are the point of this file. A save/load that loses the
 * module-level instance-id counter does not fail loudly: it reissues ids the
 * restored inventory already holds, and the damage surfaces later as items
 * merging or an exchange spending the wrong instance. Every assertion below
 * that touches ids is guarding against that.
 *
 * Note that the counter is process-global, so these tests assert *relationships*
 * (nothing collides, nothing goes backwards) rather than absolute ids — which
 * is also exactly the property the real code has to hold.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const { Account, peekNextInstanceId, reserveInstanceIds } = require('../../lib/inventory');
const { saveState, loadState, migrate, writeSave, readSave, SAVE_VERSION, SAVE_KIND } = require('../../lib/persistence');
const { Engine } = require('../../lib/engine');
const fixtures = require('../fixtures/synthetic');

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** An account with something in every one of the six collections. */
function populatedAccount(id = 'player') {
  const account = new Account(id);
  account.createInstance(9001, 5, [{ key: 'quality', value: 'legendary' }], 1000);
  account.createInstance(9002, 1, [{ key: 'color', value: 'red' }, { key: 'faction', value: 'corp' }], 2000);
  account.createInstance(9004, 1, [], 3000);

  account.updateDropBucket(account.dropBucket('def:9050'), {
    grants: 2,
    playtimeAtLastGrant: 60,
    windowStartMs: 1234567,
    windowGrants: 1,
  });
  account.updateDropBucket(account.dropBucket('app'), { grants: 1, playtimeAtLastGrant: 30 });

  account.updatePromoRecord(account.promoRecord(9060), { count: 1, lastGrantMs: 55555 });
  account.updatePromoRecord(account.promoRecord(9061), { count: 3, lastGrantMs: 99999 });

  account.ownedApps.add(440);
  account.achievements.add('first_landing');
  account.playtimeByApp.set(570, 900);
  return account;
}

const engineWithFixtures = () => new Engine({ schema: fixtures, seed: 'persistence' });

// ─── Account payload ──────────────────────────────────────────────────────────

test('save: an account round-trips all six collections', () => {
  const before = populatedAccount();
  const after = Account.fromJSON(JSON.parse(JSON.stringify(before.toJSON())));

  assert.deepEqual(after.toJSON(), before.toJSON());
  assert.equal(after.fingerprint(), before.fingerprint());

  // The fingerprint is lossy — these are the parts it does not cover, and they
  // are exactly the parts a "looks fine" save/load quietly drops.
  assert.deepEqual(after.dropBuckets.get('def:9050'), before.dropBuckets.get('def:9050'));
  assert.equal(after.dropBuckets.get('def:9050').windowStartMs, 1234567);
  assert.equal(after.promoGrants.get(9061).count, 3);
  assert.equal(after.promoGrants.get(9061).lastGrantMs, 99999);
  assert.ok(after.ownedApps.has(440));
  assert.ok(after.achievements.has('first_landing'));
  assert.equal(after.playtimeByApp.get(570), 900);
});

test('save: per-item tags survive as structured pairs, in order', () => {
  const before = populatedAccount();
  const after = Account.fromJSON(JSON.parse(JSON.stringify(before.toJSON())));

  const tagged = after.instancesOf(9002)[0];
  assert.deepEqual(tagged.tags, [
    { key: 'color', value: 'red' },
    { key: 'faction', value: 'corp' },
  ]);
  // ...and therefore still stack-compatible with the instance they came from.
  assert.equal(tagged.stackKey(), before.instancesOf(9002)[0].stackKey());
  assert.equal(tagged.toResult().tags, 'color:red;faction:corp');
});

test('save: an untagged item stays untagged rather than becoming null-tagged', () => {
  const after = Account.fromJSON(populatedAccount().toJSON());
  assert.deepEqual(after.instancesOf(9004)[0].tags, []);
  assert.equal(after.instancesOf(9004)[0].toResult().tags, '');
});

test('save: the payload is stable, so an unchanged account saves byte-identically', () => {
  // Same payload, collections inserted in the opposite order: the sort in
  // toJSON() is what makes two equal accounts produce equal bytes.
  const payload = populatedAccount().toJSON();
  const shuffled = {
    ...payload,
    instances: [...payload.instances].reverse(),
    dropBuckets: [...payload.dropBuckets].reverse(),
    promoGrants: [...payload.promoGrants].reverse(),
  };
  assert.equal(JSON.stringify(Account.fromJSON(payload).toJSON()), JSON.stringify(Account.fromJSON(shuffled).toJSON()));
});

test('save: serialising mid-transaction is refused', () => {
  const account = populatedAccount();
  account.begin();
  assert.throws(() => account.toJSON(), /mid-transaction/);
  account.rollback();
  assert.ok(account.toJSON());
});

test('save: a corrupt instance is rejected, not silently loaded', () => {
  assert.throws(() => Account.fromJSON({ id: 'p', instances: [{ itemId: 0, itemdefid: 9001, quantity: 1 }] }), /bad itemId/);
  assert.throws(() => Account.fromJSON({ id: 'p', instances: [{ itemId: 3, itemdefid: 9001, quantity: 0 }] }), /bad quantity/);
  assert.throws(
    () =>
      Account.fromJSON({
        id: 'p',
        instances: [
          { itemId: 7, itemdefid: 9001, quantity: 1 },
          { itemId: 7, itemdefid: 9002, quantity: 1 },
        ],
      }),
    /duplicate item instance id/
  );
});

// ─── The instance-id watermark ────────────────────────────────────────────────

test('watermark: restoring raises the counter past every restored id', () => {
  const high = peekNextInstanceId() + 5000;
  const account = Account.fromJSON({
    id: 'player',
    instances: [{ itemId: high, itemdefid: 9001, quantity: 1, tags: [] }],
  });
  assert.ok(peekNextInstanceId() > high, `counter ${peekNextInstanceId()} must be past ${high}`);

  const created = account.createInstance(9002, 1, [], 0);
  assert.ok(created.itemId > high, `new id ${created.itemId} collides with restored id ${high}`);
});

test('watermark: it is a floor, never an assignment', () => {
  const top = peekNextInstanceId() + 10000;
  reserveInstanceIds(top);
  const after = peekNextInstanceId();

  // A second account restored from an older, lower-numbered save must not rewind
  // the counter and start reissuing ids the first account already holds.
  Account.fromJSON({ id: 'other', instances: [{ itemId: 1, itemdefid: 9001, quantity: 1, tags: [] }] });
  reserveInstanceIds(1);
  assert.equal(peekNextInstanceId(), after);
});

test('watermark: consumed ids are not reissued after a reload', () => {
  const engine = engineWithFixtures();
  const account = engine.account('waterline');

  engine.generateItems(account, [9004, 9004, 9004], [1, 1, 1]); // non-stacking: three instances
  const ids = account.list().map(i => i.itemId);
  const doomed = Math.max(...ids);
  engine.consumeItem(account, doomed, 1);

  const state = saveState(engine, { accountId: 'waterline' });
  assert.ok(state.nextInstanceId > doomed, 'the saved counter is past the consumed id');
  assert.ok(!state.account.instances.some(i => i.itemId === doomed), 'the consumed instance is gone from the save');

  // Restoring must move the watermark past the *saved counter*, not merely past
  // the highest surviving id — otherwise `doomed` is handed straight back out.
  // (Only the child-process test below can observe that from a cold counter;
  // this asserts the number the loader computes.)
  const fresh = engineWithFixtures();
  const report = loadState(fresh, JSON.parse(JSON.stringify(state)), { accountId: 'waterline' });
  const highestRestored = Math.max(...fresh.account('waterline').list().map(i => i.itemId));
  assert.ok(highestRestored < doomed, 'the consumed id was the highest one');
  assert.ok(report.nextInstanceId > doomed, `watermark ${report.nextInstanceId} would reissue consumed id ${doomed}`);
});

test('watermark: a genuinely fresh process does not reissue restored ids', () => {
  // The counter is module-level, so no in-process test can see it start over —
  // and starting over is precisely the failure mode. This one loads the save in
  // a child node process, which is what an app restart actually is.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lsc-mock-save-'));
  const file = path.join(dir, 'player.json');
  try {
    const engine = engineWithFixtures();
    const account = engine.account('player');
    engine.generateItems(account, [9001, 9004, 9004, 9004], [3, 1, 1, 1]);
    // Consume the highest id, so that "one past the highest *restored* id" and
    // "one past the saved counter" are different numbers — only the second is
    // safe, because Steam never reissues an instance id.
    const consumed = Math.max(...account.list().map(i => i.itemId));
    engine.consumeItem(account, consumed, 1);
    const restoredIds = account.list().map(i => i.itemId);
    writeSave(file, saveState(engine, { accountId: 'player' }));

    const child = `
      const { MockProvider, readSave, call } = require(${JSON.stringify(path.resolve(__dirname, '../../index.js'))});
      const fixtures = require(${JSON.stringify(path.resolve(__dirname, '../fixtures/synthetic.js'))});
      const provider = new MockProvider({ schema: fixtures });
      provider.load(readSave(${JSON.stringify(file)}));
      call(provider, 'generateItems', [9004], [1]).then(r => {
        console.log(JSON.stringify({ itemId: r.items[0].itemId }));
      });
    `;
    const out = JSON.parse(execFileSync(process.execPath, ['-e', child], { encoding: 'utf8' }));

    assert.ok(
      !restoredIds.includes(out.itemId),
      `a restarted process reissued instance id ${out.itemId}, already held by ${restoredIds.join(', ')}`
    );
    assert.ok(
      out.itemId > consumed,
      `a restarted process reissued consumed instance id ${consumed} (got ${out.itemId})`
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ─── Envelope and versioning ──────────────────────────────────────────────────

test('version: a current save carries kind and version', () => {
  const engine = engineWithFixtures();
  engine.generateItems(engine.account('v'), [9001], [2]);
  const state = saveState(engine, { accountId: 'v' });

  assert.equal(state.kind, SAVE_KIND);
  assert.equal(state.version, SAVE_VERSION);
  assert.equal(typeof state.rng, 'number');
  assert.deepEqual(Object.keys(state.clock).sort(), ['nowMs', 'playtimeMinutes']);
  assert.equal(migrate(state), state);
});

test('version: a save from a newer build is refused, not guessed at', () => {
  const engine = engineWithFixtures();
  const state = saveState(engine, { accountId: engine.account('future').id });
  const fromTheFuture = { ...state, version: SAVE_VERSION + 1 };

  assert.throws(() => loadState(engine, fromTheFuture), /newer build/);
  try {
    loadState(engine, fromTheFuture);
  } catch (err) {
    assert.equal(err.code, 'SAVE_UNSUPPORTED');
  }
});

test('version: a missing, non-integer or foreign envelope is refused', () => {
  const engine = engineWithFixtures();
  const state = saveState(engine, { accountId: engine.account('envelope').id });

  assert.throws(() => loadState(engine, { ...state, version: undefined }), /no usable version/);
  assert.throws(() => loadState(engine, { ...state, version: '1' }), /no usable version/);
  assert.throws(() => loadState(engine, { ...state, kind: 'something.else' }), /Not a lsc\.mock\.save file/);
  assert.throws(() => loadState(engine, null), /must be an object/);
  assert.throws(() => loadState(engine, { kind: SAVE_KIND, version: 1 }), /no account payload/);
});

test('version: an unbridgeable older version fails loudly rather than half-loading', () => {
  // SAVE_VERSION is 1 today, so version 0 stands in for "older than anything we
  // can migrate" — the shape the check will take once real migrations exist.
  assert.throws(() => migrate({ kind: SAVE_KIND, version: 0, account: {} }), /no usable version/i);
});

// ─── Engine-level load ────────────────────────────────────────────────────────

test('load: clock and rng continue where the save left off', () => {
  const engine = engineWithFixtures();
  const account = engine.account('continuity');
  engine.advanceTime(45);
  engine.advanceTime(120, { playing: false });
  engine.rng.next();

  const state = saveState(engine, { accountId: 'continuity' });
  const expectedRolls = [engine.rng.next(), engine.rng.next(), engine.rng.next()];

  const fresh = engineWithFixtures();
  loadState(fresh, JSON.parse(JSON.stringify(state)), { accountId: 'continuity' });

  assert.equal(fresh.clock.now(), engine.clock.now());
  assert.equal(fresh.clock.playtime(), 45);
  assert.deepEqual([fresh.rng.next(), fresh.rng.next(), fresh.rng.next()], expectedRolls);
});

test('load: an item whose itemdef no longer exists errors, or drops on request', () => {
  const engine = engineWithFixtures();
  const state = saveState(engine, { accountId: engine.account('stale').id });
  state.account.instances.push({ itemId: peekNextInstanceId() + 90000, itemdefid: 8888, quantity: 1, tags: [] });

  assert.throws(() => loadState(engine, state, { accountId: 'stale' }), /not in the loaded schema/);

  const report = loadState(engine, state, { accountId: 'stale', onUnknownItemdef: 'drop' });
  assert.equal(report.dropped.length, 1);
  assert.equal(report.dropped[0].itemdefid, 8888);
  assert.equal(report.account.list().length, 0);
});

test('load: a rejected save leaves the engine untouched', () => {
  const engine = engineWithFixtures();
  engine.generateItems(engine.account('intact'), [9001], [3]);
  engine.advanceTime(10);
  const before = engine.account('intact').fingerprint();
  const clockBefore = engine.clock.now();
  const rngBefore = engine.rng.save();

  assert.throws(() => loadState(engine, { kind: SAVE_KIND, version: 99, account: {} }));
  assert.equal(engine.account('intact').fingerprint(), before);
  assert.equal(engine.clock.now(), clockBefore);
  assert.equal(engine.rng.save(), rngBefore);
});

test('load: a save can be restored under a different account id', () => {
  const engine = engineWithFixtures();
  engine.generateItems(engine.account('p1'), [9001], [4]);
  const state = saveState(engine, { accountId: 'p1' });

  const fresh = engineWithFixtures();
  loadState(fresh, state, { accountId: 'p2' });
  assert.equal(fresh.account('p2').countOf(9001), 4);
  assert.equal(fresh.account('p2').id, 'p2');
});

// ─── Files ────────────────────────────────────────────────────────────────────

test('save: writeSave/readSave round-trip and leave no temp file behind', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lsc-mock-save-'));
  const file = path.join(dir, 'nested', 'player.json');
  try {
    const engine = engineWithFixtures();
    engine.generateItems(engine.account('disk'), [9001, 9003], [7, 2]);
    const state = saveState(engine, { accountId: 'disk' });

    writeSave(file, state);
    assert.deepEqual(readSave(file), JSON.parse(JSON.stringify(state)));
    assert.deepEqual(fs.readdirSync(path.dirname(file)), ['player.json'], 'temp file was not cleaned up');

    const fresh = engineWithFixtures();
    loadState(fresh, readSave(file), { accountId: 'disk' });
    assert.equal(fresh.account('disk').countOf(9001), 7);
    assert.equal(fresh.account('disk').countOf(9003), 2);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('save: a truncated save file is a named error, not a crash mid-load', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lsc-mock-save-'));
  const file = path.join(dir, 'broken.json');
  try {
    fs.writeFileSync(file, '{"kind":"lsc.mock.save","vers');
    assert.throws(() => readSave(file), /not valid JSON/);
    assert.throws(() => readSave(path.join(dir, 'missing.json')), /Cannot read save file/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
