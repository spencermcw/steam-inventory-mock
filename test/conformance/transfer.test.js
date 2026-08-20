'use strict';

/**
 * conformance/transfer.test.js
 *
 * Transfer flags. Per the project overview, no item is ever `tradable: true` —
 * all inter-player transfer routes through the Community Market so the economy
 * captures every trade. `market` means tradable:false + marketable:true;
 * `account_bound` means both false.
 *
 * This runs against the shipped schema, so it is a standing guard on the
 * transpiler's defaults, not just on the mock.
 */

const test = require('node:test');
const assert = require('node:assert');

const h = require('../harness');
const fixtures = require('../fixtures/synthetic');
const { loadSchema } = require('../../index');

test('transfer: no shipped itemdef is directly tradable', () => {
  const p = h.createProvider();
  const offenders = p
    .getItemDefinitionIDs()
    .filter(id => p.getItemDefinitionProperty(id, 'tradable') === 'true')
    .map(id => `${id} (${p.getItemDefinitionProperty(id, 'cls')})`);

  assert.deepEqual(offenders, [], 'items must be transferable only via the Market');
});

test('transfer: market items are marketable and untradable', () => {
  const p = h.createProvider();
  const marketable = p.getItemDefinitionIDs().filter(id => p.getItemDefinitionProperty(id, 'marketable') === 'true');

  assert.ok(marketable.length > 0, 'some items are market-transferable');
  for (const id of marketable) {
    assert.notEqual(p.getItemDefinitionProperty(id, 'tradable'), 'true', `itemdef ${id}`);
  }
});

test('transfer: loading a tradable itemdef is a hard error', { skip: h.needs('customSchema') }, () => {
  assert.throws(() => loadSchema(fixtures.withTradableItem()), /tradable/i);
  // ...and can be opted out of only explicitly, for tests that need it.
  assert.ok(loadSchema(fixtures.withTradableItem(), { allowTradable: true }));
});
