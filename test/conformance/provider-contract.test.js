'use strict';

/**
 * conformance/provider-contract.test.js
 *
 * The async, handle-based shape itself.
 *
 * These tests exist to make the "mock first" failure mode impossible: if any
 * provider method ever starts returning a result directly, the client can be
 * written against a synchronous fantasy and real Steam integration becomes a
 * rewrite instead of a swap. So the shape is asserted, not assumed.
 */

const test = require('node:test');
const assert = require('node:assert');

const h = require('../harness');
const fixtures = require('../../examples/economy');
const { assertProviderShape } = require('../../index');

const provider = (options = {}) => h.createProvider({ schema: fixtures, ...options });

test('contract: the provider implements the full interface', { skip: h.needs('customSchema') }, () => {
  assert.ok(assertProviderShape(provider()));
});

test('contract: every inventory call returns a handle, never a result', { skip: h.needs('customSchema') }, () => {
  const p = provider();
  const handles = [
    p.getAllItems(),
    p.exchangeItems(9010, [{ itemId: 1, quantity: 1 }]),
    p.consumeItem(1, 1),
    p.triggerItemDrop(9050),
    p.addPromoItem(9060),
  ];
  for (const handle of handles) {
    assert.equal(typeof handle, 'number', 'handles are integers');
  }
  assert.equal(new Set(handles).size, handles.length, 'handles are unique');
  handles.forEach(handle => p.destroyResult(handle));
});

test('contract: no result is available synchronously', { skip: h.needs('customSchema') }, async () => {
  const p = provider();
  const handle = p.getAllItems();
  assert.equal(p.getResultStatus(handle), null, 'the result cannot be read on the same tick');

  await h.call(p, 'getAllItems'); // let the queue drain
  p.destroyResult(handle);
});

test('contract: the result arrives via resultReady and is readable from the handle', { skip: h.needs('customSchema') }, async () => {
  const p = provider();
  const seen = [];
  p.on('resultReady', handle => seen.push(handle));

  const handle = p.getAllItems();
  await new Promise(resolve => setTimeout(resolve, 5));

  assert.deepEqual(seen, [handle]);
  assert.equal(p.getResultStatus(handle), h.RESULT.OK);
  assert.ok(Array.isArray(p.getResultItems(handle)));

  assert.equal(p.destroyResult(handle), true);
  assert.equal(p.getResultStatus(handle), null, 'a destroyed result is gone');
});

test('contract: concurrent calls complete in issue order', { skip: h.needs('customSchema', 'sandboxGrants') }, async () => {
  const p = provider();
  const order = [];
  p.on('resultReady', handle => order.push(handle));

  const first = p.generateItems([9001], [1]);
  const second = p.generateItems([9002], [1]);
  const third = p.getAllItems();
  await new Promise(resolve => setTimeout(resolve, 5));

  assert.deepEqual(order, [first, second, third]);
  // The third call sees the effects of the first two, as it would on a server.
  assert.equal(p.getResultItems(third).length, 2);
  [first, second, third].forEach(handle => p.destroyResult(handle));
});

test('contract: simulated latency does not change ordering or outcome', { skip: h.needs('customSchema', 'sandboxGrants') }, async () => {
  const p = provider({ latency: 5 });
  const started = Date.now();
  const result = await h.call(p, 'generateItems', [9001], [2]);
  assert.ok(Date.now() - started >= 4, 'latency was actually simulated');
  assert.equal(result.items[0].quantity, 2);
});

test('contract: getItemDefinitionProperty is synchronous, as it is on Steam', { skip: h.needs('customSchema') }, () => {
  const p = provider();
  assert.equal(p.getItemDefinitionProperty(9001, 'name'), 'Alpha');
  assert.equal(p.getItemDefinitionProperty(9001, 'type'), 'item');
  assert.equal(p.getItemDefinitionProperty(9001, 'tags'), 'rarity:common;band:1');
  assert.equal(p.getItemDefinitionProperty(9001, 'nonexistent'), null);
  assert.equal(p.getItemDefinitionProperty(424242, 'name'), null);
  assert.ok(p.getItemDefinitionProperty(9001, '').split(',').includes('itemdefid'), 'empty property lists the names');
});

test('contract: results are not auto-destroyed — leaks are visible', { skip: h.needs('customSchema') }, async () => {
  const p = provider();
  const handle = p.getAllItems();
  await new Promise(resolve => setTimeout(resolve, 5));
  assert.deepEqual(p.leakedResults(), [handle]);
  p.destroyResult(handle);
  assert.deepEqual(p.leakedResults(), []);
});
