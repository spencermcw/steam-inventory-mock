'use strict';

/**
 * conformance/accessories.test.js
 *
 * Accessories: per-item tags in an itemdef's `accessory_tag` category, whose
 * value is the itemdefid of the accessory attached (docs/accessories.html).
 *
 * Settled (Valve): the tag value is an ItemDefID; `accessory_limit` caps how
 * many one item can carry and defaults to 4; and "adding two instances of the
 * same accessory to an item is not currently supported. Attempting to do so
 * will fail in the ExchangeItems call and will not consume the accessory item."
 * That last sentence is the one worth guarding — a mock that failed the call
 * but ate the sticker would teach a client to hide a real loss.
 *
 * The example economy ships one backpack, two stickers and a trophy case. A
 * limit test needs more distinct accessories than that (duplicates are refused,
 * so each attach must be a different itemdef), and the trophy case declares no
 * badge tool at all — so the schemas below extend the fixture set rather than
 * edit it.
 */

const test = require('node:test');
const assert = require('node:assert');

const h = require('../harness');
const fixtures = require('../../examples/economy');

/** Valve's sticker shape: a tag_tool whose `tags` names its own itemdefid. */
const accessory = (itemdefid, category, name) => ({
  itemdefid,
  name,
  type: 'tag_tool',
  tradable: false,
  tags: `${category}:${itemdefid}`,
});

const EXTRA = [
  // Two more stickers, so the backpack's accessory_limit of 3 can be exceeded
  // without repeating one (a repeat fails for a different reason).
  accessory(9700, 'sticker', 'Green Star Sticker'),
  accessory(9701, 'sticker', 'Gold Star Sticker'),
  // Badges for 9113 Trophy Case, which declares accessory_tag but no limit.
  accessory(9710, 'badge', 'Bronze Badge'),
  accessory(9711, 'badge', 'Silver Badge'),
  accessory(9712, 'badge', 'Gold Badge'),
  accessory(9713, 'badge', 'Platinum Badge'),
  accessory(9714, 'badge', 'Diamond Badge'),
  // A sticker pointing at nothing: the value must resolve to a real itemdef.
  { itemdefid: 9720, name: 'Phantom Sticker', type: 'tag_tool', tradable: false, tags: 'sticker:9999998' },
];

const provider = (options = {}) =>
  h.createProvider({ schema: { appid: fixtures.appid, items: [...fixtures.items, ...EXTRA] }, ...options });

const tagsOf = item => (item.tags || '').split(';').filter(Boolean);

async function only(p, itemdefid) {
  const items = (await h.snapshot(p)).filter(i => i.itemdefid === itemdefid);
  assert.equal(items.length, 1, `expected exactly one instance of itemdef ${itemdefid}, got ${items.length}`);
  return items[0];
}

/** Attach an accessory: tool and target in, the target's own itemdef out. */
async function attach(p, toolDefId, targetDefId) {
  return h.call(p, 'exchangeItems', targetDefId, await h.materials(p, { [toolDefId]: 1, [targetDefId]: 1 }));
}

// ─── Attaching ────────────────────────────────────────────────────────────────

test('accessories: two different stickers attach to one backpack', { skip: h.needs('customSchema', 'sandboxGrants') }, async () => {
  const p = provider();
  await h.seed(p, { 9110: 1, 9111: 1, 9112: 1 });

  assert.equal((await attach(p, 9111, 9110)).status, h.RESULT.OK);
  assert.equal((await attach(p, 9112, 9110)).status, h.RESULT.OK);

  const backpack = await only(p, 9110);
  assert.deepEqual(tagsOf(backpack).sort(), ['sticker:9111', 'sticker:9112']);
  assert.equal(await h.countOf(p, 9111), 0, 'both stickers are spent');
  assert.equal(await h.countOf(p, 9112), 0);
});

test('accessories: the attached tag value names a real itemdef', { skip: h.needs('customSchema', 'sandboxGrants') }, async () => {
  const p = provider();
  await h.seed(p, { 9110: 1, 9111: 1 });
  await attach(p, 9111, 9110);

  const [category, value] = tagsOf(await only(p, 9110))[0].split(':');
  assert.equal(category, 'sticker');
  assert.equal(p.getItemDefinitionProperty(Number(value), 'name'), 'Blue Star Sticker');
});

test('accessories: a tool whose value is not an itemdefid is refused, and not consumed', { skip: h.needs('customSchema', 'sandboxGrants') }, async () => {
  const p = provider();
  await h.seed(p, { 9110: 1, 9720: 1 });

  const before = await h.snapshot(p);
  const result = await h.call(p, 'exchangeItems', 9110, await h.materials(p, { 9720: 1, 9110: 1 }));

  assert.notEqual(result.status, h.RESULT.OK);
  assert.deepEqual(await h.snapshot(p), before);
});

// ─── Duplicates ───────────────────────────────────────────────────────────────

test('accessories: the same accessory twice fails and keeps the second tool', { skip: h.needs('customSchema', 'sandboxGrants') }, async () => {
  const p = provider();
  await h.seed(p, { 9110: 1, 9111: 2 });

  assert.equal((await attach(p, 9111, 9110)).status, h.RESULT.OK);

  const before = await h.snapshot(p);
  const result = await attach(p, 9111, 9110);

  assert.notEqual(result.status, h.RESULT.OK);
  assert.equal(await h.countOf(p, 9111), 1, 'Valve: the failed call does not consume the accessory item');
  assert.deepEqual(await h.snapshot(p), before);
  assert.deepEqual(tagsOf(await only(p, 9110)), ['sticker:9111'], 'and it is still attached exactly once');
});

// ─── Limits ───────────────────────────────────────────────────────────────────

test('accessories: accessory_limit 3 refuses the fourth sticker', { skip: h.needs('customSchema', 'sandboxGrants') }, async () => {
  const p = provider();
  await h.seed(p, { 9110: 1, 9111: 1, 9112: 1, 9700: 1, 9701: 1 });

  for (const sticker of [9111, 9112, 9700]) {
    assert.equal((await attach(p, sticker, 9110)).status, h.RESULT.OK, `sticker ${sticker}`);
  }

  const before = await h.snapshot(p);
  const result = await attach(p, 9701, 9110);

  assert.equal(result.status, h.RESULT.LIMIT_EXCEEDED);
  assert.equal(await h.countOf(p, 9701), 1, 'the refused sticker survives');
  assert.deepEqual(await h.snapshot(p), before);
  assert.equal(tagsOf(await only(p, 9110)).length, 3);
});

test('accessories: an item with no accessory_limit gets Valve default of 4', { skip: h.needs('customSchema', 'sandboxGrants') }, async () => {
  // 9113 Trophy Case declares accessory_tag: badge and no limit at all.
  const p = provider();
  await h.seed(p, { 9113: 1, 9710: 1, 9711: 1, 9712: 1, 9713: 1, 9714: 1 });

  for (const badge of [9710, 9711, 9712, 9713]) {
    assert.equal((await attach(p, badge, 9113)).status, h.RESULT.OK, `badge ${badge}`);
  }
  assert.equal(tagsOf(await only(p, 9113)).length, 4);

  const result = await attach(p, 9714, 9113);
  assert.equal(result.status, h.RESULT.LIMIT_EXCEEDED, 'the fifth exceeds the default');
  assert.equal(await h.countOf(p, 9714), 1);
});

test('accessories: a limit of 1 is a limit of 1', { skip: h.needs('customSchema', 'sandboxGrants') }, async () => {
  const p = h.createProvider({
    schema: {
      appid: fixtures.appid,
      items: [
        { itemdefid: 9760, name: 'Pin Board', type: 'item', accessory_tag: 'pin', accessory_limit: 1, allowed_tags_from_tools: 'pin' },
        accessory(9761, 'pin', 'First Pin'),
        accessory(9762, 'pin', 'Second Pin'),
      ],
    },
  });
  await h.seed(p, { 9760: 1, 9761: 1, 9762: 1 });

  assert.equal((await attach(p, 9761, 9760)).status, h.RESULT.OK);
  assert.equal((await attach(p, 9762, 9760)).status, h.RESULT.LIMIT_EXCEEDED);
  assert.deepEqual(tagsOf(await only(p, 9760)), ['pin:9761']);
});

test('accessories: accessory_limit 0 is a schema error, not a zero-capacity item', { skip: h.needs('customSchema') }, async () => {
  assert.throws(
    () =>
      h.createProvider({
        schema: {
          appid: fixtures.appid,
          items: [{ itemdefid: 9770, name: 'Impossible Case', type: 'item', accessory_tag: 'pin', accessory_limit: 0 }],
        },
      }),
    /accessory_limit/
  );
});
