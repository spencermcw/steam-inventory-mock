'use strict';

/**
 * conformance/tag-tools.test.js
 *
 * The tag_tool mode of ExchangeItems: one call, one tool, one target item.
 *
 * Settled (Valve, docs/tools.html): the generate array carries the *target's
 * own* itemdefid; `tags_to_remove_on_tool_use` is stripped before anything new
 * is applied; the target opts in per category through `allowed_tags_from_tools`;
 * a tool may roll its tags from a `tag_generator` instead of naming them.
 *
 * Open (docs/tools.html vs docs/accessories.html): whether the call issues a
 * copy of the target under a new instance id or rewrites the target in place.
 * Valve says both, in two different places, so the engine implements both under
 * `toolResultPolicy` and the pair of tests below pins each reading. That option
 * is not cosmetic — under 'new-instance' every reference to the old instance id
 * dies with the call.
 */

const test = require('node:test');
const assert = require('node:assert');

const h = require('../harness');
const fixtures = require('../../examples/economy');

const provider = (options = {}) => h.createProvider({ schema: fixtures, ...options });

const tagsOf = item => (item.tags || '').split(';').filter(Boolean);
const categoryOf = (item, key) => tagsOf(item).filter(t => t.startsWith(`${key}:`));

/** The one instance of an itemdef in a snapshot. */
async function only(p, itemdefid) {
  const items = (await h.snapshot(p)).filter(i => i.itemdefid === itemdefid);
  assert.equal(items.length, 1, `expected exactly one instance of itemdef ${itemdefid}, got ${items.length}`);
  return items[0];
}

/** Apply a tool to a target: both go in as materials, the target's own def comes out. */
async function apply(p, toolDefId, targetDefId) {
  return h.call(p, 'exchangeItems', targetDefId, await h.materials(p, { [toolDefId]: 1, [targetDefId]: 1 }));
}

// ─── Applying and removing ────────────────────────────────────────────────────

test('tag tools: a paint can tags the hat and is consumed', { skip: h.needs('customSchema', 'sandboxGrants') }, async () => {
  const p = provider();
  await h.seed(p, { 9100: 1, 9101: 1 });

  const result = await apply(p, 9100, 9101);
  assert.equal(result.status, h.RESULT.OK, result.reason || '');

  const hat = await only(p, 9101);
  assert.deepEqual(tagsOf(hat), ['paint_color:red']);
  assert.equal(await h.countOf(p, 9100), 0, 'the tool is spent');
});

test('tag tools: repainting replaces the colour rather than stacking a second one', { skip: h.needs('customSchema', 'sandboxGrants') }, async () => {
  // 9104 rolls its colour from tag_generator 9103 and, like 9100, declares
  // tags_to_remove_on_tool_use: paint_color — so the old colour goes first.
  const p = provider({ seed: 'repaint' });
  await h.seed(p, { 9100: 1, 9104: 1, 9101: 1 });

  assert.equal((await apply(p, 9100, 9101)).status, h.RESULT.OK);
  assert.equal((await apply(p, 9104, 9101)).status, h.RESULT.OK);

  const hat = await only(p, 9101);
  assert.equal(categoryOf(hat, 'paint_color').length, 1, `one colour only, got ${hat.tags}`);
});

test('tag tools: a tool with no tags of its own only strips', { skip: h.needs('customSchema', 'sandboxGrants') }, async () => {
  const p = provider();
  await h.seed(p, { 9100: 1, 9102: 1, 9101: 1 });

  await apply(p, 9100, 9101);
  assert.equal((await apply(p, 9102, 9101)).status, h.RESULT.OK);

  const hat = await only(p, 9101);
  assert.deepEqual(tagsOf(hat), [], `the stripper leaves nothing behind, got ${hat.tags}`);
  assert.equal(await h.countOf(p, 9102), 0);
});

test('tag tools: a stat tracker writes its category onto the rocket launcher', { skip: h.needs('customSchema', 'sandboxGrants') }, async () => {
  // Valve's dynamic-property example: the tag is the thing that later unlocks
  // a restricted property, so what matters is that it lands exactly once.
  const p = provider();
  await h.seed(p, { 9120: 1, 9121: 2 });

  assert.equal((await apply(p, 9121, 9120)).status, h.RESULT.OK);
  assert.equal((await apply(p, 9121, 9120)).status, h.RESULT.OK, 'idempotent: it removes the pair it applies');

  const launcher = await only(p, 9120);
  assert.deepEqual(tagsOf(launcher), ['stat_tracker:kills']);
  assert.equal(await h.countOf(p, 9121), 0, 'each application spends one tool');
});

// ─── Rolled tags ──────────────────────────────────────────────────────────────

test('tag tools: a generator-driven tool applies exactly one rolled value', { skip: h.needs('customSchema', 'sandboxGrants') }, async () => {
  const p = provider({ seed: 'random-paint' });
  await h.seed(p, { 9104: 1, 9101: 1 });

  assert.equal((await apply(p, 9104, 9101)).status, h.RESULT.OK);

  const colours = categoryOf(await only(p, 9101), 'paint_color');
  assert.equal(colours.length, 1, 'one value out of the generator, not one per weight');
  assert.ok(
    ['paint_color:red', 'paint_color:blue', 'paint_color:green', 'paint_color:gold'].includes(colours[0]),
    `unexpected roll ${colours[0]}`
  );
});

test('tag tools: the roll is reproducible under a fixed seed', { skip: h.needs('customSchema', 'sandboxGrants', 'deterministicRng') }, async () => {
  const roll = async () => {
    const p = provider({ seed: 'fixed' });
    await h.seed(p, { 9104: 1, 9101: 1 });
    await apply(p, 9104, 9101);
    return (await only(p, 9101)).tags;
  };
  assert.equal(await roll(), await roll());
});

// ─── Permission ───────────────────────────────────────────────────────────────

test('tag tools: a target that does not allow the category refuses, and keeps the tool', { skip: h.needs('customSchema', 'sandboxGrants') }, async () => {
  // The hat allows paint_color and nothing else; 9111 writes `sticker`.
  const p = provider();
  await h.seed(p, { 9111: 1, 9101: 1 });

  const before = await h.snapshot(p);
  const result = await h.call(p, 'exchangeItems', 9101, await h.materials(p, { 9111: 1, 9101: 1 }));

  assert.notEqual(result.status, h.RESULT.OK);
  assert.equal(await h.countOf(p, 9111), 1, 'a refused application does not consume the tool');
  assert.deepEqual(await h.snapshot(p), before, 'and leaves the inventory byte-identical');
});

test('tag tools: a bare remover is allowed on a target with no allowed_tags_from_tools', { skip: h.needs('customSchema', 'sandboxGrants') }, async () => {
  // 9102 writes nothing, so there is no category to permit. Removing is not
  // writing, and Valve gates only what a tool would apply.
  const p = h.createProvider({
    schema: {
      appid: fixtures.appid,
      items: [
        { itemdefid: 9740, name: 'Plain Thing', type: 'item' },
        { itemdefid: 9741, name: 'Stripper', type: 'tag_tool', tags_to_remove_on_tool_use: 'paint_color' },
      ],
    },
  });
  await h.seed(p, { 9740: 1, 9741: 1 });

  const result = await h.call(p, 'exchangeItems', 9740, await h.materials(p, { 9741: 1, 9740: 1 }));
  assert.equal(result.status, h.RESULT.OK, result.reason || '');
});

// ─── toolResultPolicy: both readings of Valve's docs ──────────────────────────

// These two need an engine option that only a mock can offer — a real
// SteamProvider does one of the two and cannot be told which. Gated on
// configurableSurplus, the existing flag for "unverified behaviour is
// selectable here"; an integrator adding a `configurableToolResult` capability
// should move these onto it.

test("tag tools: toolResultPolicy 'new-instance' issues the target under a fresh id", { skip: h.needs('customSchema', 'sandboxGrants', 'configurableSurplus') }, async () => {
  const p = provider({ toolResultPolicy: 'new-instance' });
  await h.seed(p, { 9100: 1, 9101: 1 });

  const before = await only(p, 9101);
  assert.equal((await apply(p, 9100, 9101)).status, h.RESULT.OK);

  const after = await only(p, 9101);
  assert.notEqual(after.itemId, before.itemId, 'the old instance id is dead — callers must reread it');
  assert.deepEqual(tagsOf(after), ['paint_color:red']);
});

test("tag tools: toolResultPolicy 'mutate' keeps the target's instance id", { skip: h.needs('customSchema', 'sandboxGrants', 'configurableSurplus') }, async () => {
  const p = provider({ toolResultPolicy: 'mutate' });
  await h.seed(p, { 9100: 1, 9101: 1 });

  const before = await only(p, 9101);
  assert.equal((await apply(p, 9100, 9101)).status, h.RESULT.OK);

  const after = await only(p, 9101);
  assert.equal(after.itemId, before.itemId, 'the same item, retagged in place');
  assert.deepEqual(tagsOf(after), ['paint_color:red']);
});

test("tag tools: a refusal under 'mutate' restores the target's tags", { skip: h.needs('customSchema', 'sandboxGrants', 'configurableSurplus') }, async () => {
  const p = provider({ toolResultPolicy: 'mutate' });
  await h.seed(p, { 9100: 1, 9111: 1, 9101: 1 });
  await apply(p, 9100, 9101);

  const before = await h.snapshot(p);
  const result = await h.call(p, 'exchangeItems', 9101, await h.materials(p, { 9111: 1, 9101: 1 }));

  assert.notEqual(result.status, h.RESULT.OK);
  assert.deepEqual(await h.snapshot(p), before);
});

// ─── The fork itself ──────────────────────────────────────────────────────────

test('tag tools: an ordinary recipe exchange is untouched by the tool fork', { skip: h.needs('customSchema', 'sandboxGrants') }, async () => {
  const p = provider();
  await h.seed(p, { 9001: 2 });

  const result = await h.call(p, 'exchangeItems', 9010, await h.materials(p, { 9001: 2 }));
  assert.equal(result.status, h.RESULT.OK, result.reason || '');
  assert.equal(result.recipeIndex, 0);
  assert.equal(await h.countOf(p, 9010), 1);
  assert.equal(await h.countOf(p, 9001), 0);
});

test('tag tools: a recipe that names a tag_tool as a material wins over the tool path', { skip: h.needs('customSchema', 'sandboxGrants') }, async () => {
  // The one shape the two paths could both claim: an itemdef whose recipe
  // consumes a tag_tool and produces itself. Writing 9731 into `exchange` is
  // the author saying it is a material, so the recipe takes it.
  const p = h.createProvider({
    schema: {
      appid: fixtures.appid,
      items: [
        { itemdefid: 9731, name: 'Upgrade Kit', type: 'tag_tool', tags: 'grade:mk2' },
        {
          itemdefid: 9730,
          name: 'Upgradable Rifle',
          type: 'item',
          allowed_tags_from_tools: 'grade',
          exchange: '9730x1,9731x1',
        },
      ],
    },
  });
  await h.seed(p, { 9730: 1, 9731: 1 });

  const result = await h.call(p, 'exchangeItems', 9730, await h.materials(p, { 9731: 1, 9730: 1 }));
  assert.equal(result.status, h.RESULT.OK, result.reason || '');
  assert.equal(result.recipeIndex, 0, 'the recipe path ran');

  const rifle = await only(p, 9730);
  assert.deepEqual(tagsOf(rifle), [], 'a recipe grants a plain item; it does not apply the tool');
});

test('tag tools: a stacked target is refused rather than tagged wholesale', { skip: h.needs('customSchema', 'sandboxGrants') }, async () => {
  const p = h.createProvider({
    schema: {
      appid: fixtures.appid,
      items: [
        { itemdefid: 9750, name: 'Stackable Charm', type: 'item', auto_stack: true, allowed_tags_from_tools: 'paint_color' },
        { itemdefid: 9751, name: 'Red Paint Can', type: 'tag_tool', tags: 'paint_color:red', tags_to_remove_on_tool_use: 'paint_color' },
      ],
    },
  });
  await h.seed(p, { 9750: 3, 9751: 1 });

  const before = await h.snapshot(p);
  const result = await h.call(p, 'exchangeItems', 9750, await h.materials(p, { 9751: 1, 9750: 1 }));

  assert.notEqual(result.status, h.RESULT.OK);
  assert.deepEqual(await h.snapshot(p), before, 'no half-tagged stack, and the tool survives');
});
