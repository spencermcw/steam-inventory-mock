'use strict';

/**
 * conformance/shipped-content.test.js
 *
 * The same semantics, exercised against the real transpiler output in
 * dist/itemdefs.json rather than fixtures. This is where the mock doubles as a
 * transpiler integration test: it parses the exact delimited strings that would
 * be uploaded to Steam, so a transpiler bug shows up as a gameplay failure here
 * instead of in production.
 *
 * Run `npm run transpile` first.
 */

const test = require('node:test');
const assert = require('node:assert');

const h = require('../harness');

const provider = (options = {}) => h.createProvider(options); // default schema = dist/itemdefs.json

test('content: the shipped schema loads and every reference resolves', () => {
  const p = provider();
  const ids = p.getItemDefinitionIDs();
  assert.ok(ids.length > 100, `expected a real content set, got ${ids.length} itemdefs`);
});

test('content: the new-player promo grants the welcome bundle', async () => {
  const p = provider();
  const welcome = h.resolveCls(p, 'welcome_bundle');

  const result = await h.call(p, 'addPromoItem', welcome);
  assert.equal(result.status, h.RESULT.OK, result.reason || '');
  assert.ok(result.items.length >= 3, 'the bundle expanded');
  assert.equal(await h.countOf(p, welcome), 0, 'the bundle itself is not held');

  assert.ok((await h.countOf(p, h.resolveCls(p, 'xp'))) > 0);
  assert.ok((await h.countOf(p, h.resolveCls(p, 'employee'))) > 0);
  assert.ok((await h.countOf(p, h.resolveCls(p, 'operation_101'))) > 0);

  const second = await h.call(p, 'addPromoItem', welcome);
  assert.equal(second.items.length, 0, 'once per account');
});

test('content: running a harvest operation consumes the op and yields materials', async () => {
  const p = provider({ seed: 'harvest' });
  await h.call(p, 'addPromoItem', h.resolveCls(p, 'welcome_bundle'));

  const xp = h.resolveCls(p, 'xp');
  const employee = h.resolveCls(p, 'employee');
  const operation = h.resolveCls(p, 'operation_101');
  const exec = h.resolveCls(p, 'exec_operation_101');

  const before = await h.totals(p);
  const result = await h.call(p, 'exchangeItems', exec, await h.materials(p, { [xp]: 1, [operation]: 1, [employee]: 1 }));

  assert.equal(result.status, h.RESULT.OK, result.reason || '');
  const after = await h.totals(p);

  assert.equal(after.get(operation) || 0, (before.get(operation) || 0) - 1, 'the operation is spent');
  assert.equal(after.get(employee) || 0, before.get(employee) - 1, 'an employee is spent');
  assert.ok((after.get(xp) || 0) >= 1, 'XP is required, consumed, and re-issued by the yield bundle');
  assert.equal(after.get(exec) || 0, 0, 'the generator itself is never held');

  // The yield bundles for OP-101 pay out coal and iron ore.
  const coal = h.resolveCls(p, 'coal');
  const iron = h.resolveCls(p, 'iron_ore');
  assert.ok((after.get(coal) || 0) + (after.get(iron) || 0) > 0, 'materials were granted');
});

test('content: a craft without its facility fails and leaves inventory untouched', async () => {
  const p = provider({ seed: 'craft-fail' });
  await h.call(p, 'addPromoItem', h.resolveCls(p, 'welcome_bundle'));

  const before = JSON.stringify(await h.snapshot(p));
  const employee = h.resolveCls(p, 'employee');
  const craft_smelter = h.resolveCls(p, 'craft_smelter');

  const result = await h.call(p, 'exchangeItems', craft_smelter, await h.materials(p, { [employee]: 1 }));
  assert.equal(result.status, h.RESULT.FAIL, 'no recipe satisfied by provided materials');
  assert.equal(JSON.stringify(await h.snapshot(p)), before, 'inventory unchanged after failed craft');
});

test('content: a facility recipe consumes and re-issues the facility', { skip: h.needs('sandboxGrants') }, async () => {
  // power_cell_recipe requires the power plant and consumes coal, iron and an
  // employee; its bundle hands the power plant straight back.
  const p = provider({ seed: 'power-cell' });
  const plant = h.resolveCls(p, 'power_plant');
  const employee = h.resolveCls(p, 'employee');
  const coal = h.resolveCls(p, 'coal');
  const iron = h.resolveCls(p, 'iron_ore');
  const cell = h.resolveCls(p, 'power_cell');
  const recipe = h.resolveCls(p, 'power_cell_recipe');

  await h.seed(p, { [plant]: 1, [employee]: 5, [coal]: 40, [iron]: 5 });
  const result = await h.call(p, 'exchangeItems', recipe, await h.materials(p, { [plant]: 1, [employee]: 1, [coal]: 20, [iron]: 1 }));

  assert.equal(result.status, h.RESULT.OK, result.reason || '');
  assert.equal(await h.countOf(p, plant), 1, 'the facility survives the craft');
  assert.equal(await h.countOf(p, coal), 20, 'coal was spent');
  assert.ok((await h.countOf(p, cell)) > 0, 'power cells produced');
});

test('content: a tag-operand recipe accepts any matching blueprint', { skip: h.needs('sandboxGrants') }, async () => {
  // recycle_blueprint's exchange is the bare tag operand "category:blueprint".
  const p = provider({ seed: 'recycle' });
  const recycle = h.resolveCls(p, 'recycle_blueprint');
  const blueprint = h.resolveCls(p, 'copper_wire_blueprint');
  const inspiration = h.resolveCls(p, 'inspiration');

  await h.seed(p, { [blueprint]: 1 });
  const result = await h.call(p, 'exchangeItems', recycle, await h.materials(p, { [blueprint]: 1 }));

  assert.equal(result.status, h.RESULT.OK, result.reason || '');
  assert.equal(await h.countOf(p, blueprint), 0);
  assert.equal(await h.countOf(p, inspiration), 1);
});

test('content: the supply drop honours its drop_interval', { skip: h.needs('virtualClock') }, async () => {
  const p = provider({ seed: 'supply' });
  const supplyDrop = h.resolveCls(p, 'supply_drop');

  const interval = Number(p.getItemDefinitionProperty(supplyDrop, 'drop_interval'));
  assert.ok(interval > 0, 'supply_drop specifies its own drop_interval');

  const first = await h.call(p, 'triggerItemDrop', supplyDrop);
  assert.equal(first.items.length, 0, 'no drop before the interval has accrued');

  p.advanceTime(interval);
  const second = await h.call(p, 'triggerItemDrop', supplyDrop);
  assert.ok(second.items.length > 0, 'the drop lands once playtime is accrued');
});

test('content: every itemdef parses — exchange, bundle and tags alike', () => {
  // Loading is strict, so reaching this point means every delimited string in
  // the transpiler's output was parsed and every id reference resolved.
  const p = provider();
  for (const id of p.getItemDefinitionIDs()) {
    assert.ok(p.getItemDefinitionProperty(id, 'name'), `itemdef ${id} has a name`);
  }
});
