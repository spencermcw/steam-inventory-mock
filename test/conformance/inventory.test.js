'use strict';

/**
 * conformance/inventory.test.js
 *
 * auto_stack / commodity quantities, consumption, and how quantities surface in
 * results. Steam reports stack changes as quantity changes on the same item id,
 * and reports a fully spent stack as quantity 0 — the client's inventory delta
 * handling depends on both.
 */

const test = require('node:test');
const assert = require('node:assert');

const h = require('../harness');
const fixtures = require('../../examples/economy');

const provider = (options = {}) => h.createProvider({ schema: fixtures, ...options });

test('inventory: auto_stack merges repeated grants into one stack', { skip: h.needs('customSchema', 'sandboxGrants') }, async () => {
  const p = provider();
  await h.seed(p, { 9001: 3 });
  await h.seed(p, { 9001: 4 });

  const stacks = (await h.snapshot(p)).filter(i => i.itemdefid === 9001);
  assert.equal(stacks.length, 1);
  assert.equal(stacks[0].quantity, 7);
});

test('inventory: without auto_stack every grant is its own instance', { skip: h.needs('customSchema', 'sandboxGrants') }, async () => {
  const p = provider();
  await h.seed(p, { 9004: 3 });

  const stacks = (await h.snapshot(p)).filter(i => i.itemdefid === 9004);
  assert.equal(stacks.length, 3);
  assert.ok(stacks.every(s => s.quantity === 1));
});

test('inventory: consumeItem reduces a stack', { skip: h.needs('customSchema', 'sandboxGrants') }, async () => {
  const p = provider();
  await h.seed(p, { 9001: 5 });
  const [stack] = (await h.snapshot(p)).filter(i => i.itemdefid === 9001);

  const result = await h.call(p, 'consumeItem', stack.itemId, 2);
  assert.equal(result.status, h.RESULT.OK);
  assert.equal(await h.countOf(p, 9001), 3);
});

test('inventory: consuming a whole stack reports quantity 0 and removes it', { skip: h.needs('customSchema', 'sandboxGrants') }, async () => {
  const p = provider();
  await h.seed(p, { 9001: 2 });
  const [stack] = (await h.snapshot(p)).filter(i => i.itemdefid === 9001);

  const result = await h.call(p, 'consumeItem', stack.itemId, 2);
  assert.equal(result.items[0].quantity, 0, 'the delta reports the emptied stack');
  assert.equal((await h.snapshot(p)).length, 0);
});

test('inventory: over-consuming is rejected and changes nothing', { skip: h.needs('customSchema', 'sandboxGrants') }, async () => {
  const p = provider();
  await h.seed(p, { 9001: 2 });
  const before = JSON.stringify(await h.snapshot(p));
  const [stack] = (await h.snapshot(p)).filter(i => i.itemdefid === 9001);

  const result = await h.call(p, 'consumeItem', stack.itemId, 3);
  assert.equal(result.status, h.RESULT.INVALID_PARAM);
  assert.equal(JSON.stringify(await h.snapshot(p)), before);
});

test('inventory: consuming an item that is not held is rejected', { skip: h.needs('customSchema') }, async () => {
  const p = provider();
  const result = await h.call(p, 'consumeItem', 987654, 1);
  assert.equal(result.status, h.RESULT.INVALID_PARAM);
});

test('inventory: an exchange result reports both consumed and granted stacks', { skip: h.needs('customSchema', 'sandboxGrants') }, async () => {
  const p = provider();
  await h.seed(p, { 9001: 2 });
  const result = await h.call(p, 'exchangeItems', 9010, await h.materials(p, { 9001: 2 }));

  const byDef = new Map(result.items.map(i => [i.itemdefid, i.quantity]));
  assert.equal(byDef.get(9001), 0, 'spent material reported at quantity 0');
  assert.equal(byDef.get(9010), 1, 'granted target reported');
});
