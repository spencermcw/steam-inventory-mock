'use strict';

/**
 * unit/schema.test.js — ingesting Steam's wire format.
 *
 * The load is strict on purpose: reading dist/itemdefs.json (not the YAML) makes
 * this an integration test of the transpiler, and a dangling reference in its
 * output should fail loudly here rather than at runtime on Steam.
 */

const test = require('node:test');
const assert = require('node:assert');

const { loadSchema, DEFAULT_SCHEMA_PATH } = require('../../index');
const fixtures = require('../fixtures/synthetic');

test('schema: the transpiler output loads clean', () => {
  const schema = loadSchema(DEFAULT_SCHEMA_PATH);
  assert.deepEqual(schema.report.errors, []);
  assert.ok(schema.size() > 100);
  assert.ok(schema.appid > 0);
});

test('schema: delimited fields are pre-parsed into structure', () => {
  const schema = loadSchema(fixtures);
  const target = schema.get(9010);
  assert.equal(target.exchange.length, 2, 'two recipes');
  assert.deepEqual(target.exchange[0][0], { kind: 'def', itemdefid: 9001, quantity: 2 });

  const generator = schema.get(9030);
  assert.equal(generator.bundle.length, 3);
  assert.equal(generator.bundle[0].quantity, 70, 'weights live in the quantity slot');

  assert.ok(schema.get(9001).tagTokens.has('rarity:common'));
});

test('schema: cls lookup works both ways on shipped content', () => {
  const schema = loadSchema(DEFAULT_SCHEMA_PATH);
  const xp = schema.requireCls('xp');
  assert.equal(schema.get(xp.itemdefid).cls, 'xp');
  assert.throws(() => schema.requireCls('no_such_cls'), /Unknown cls/);
});

test('schema: dangling references are load errors', () => {
  const broken = { appid: 1, items: [{ itemdefid: 1, type: 'bundle', name: 'Broken', bundle: '999x1' }] };
  assert.throws(() => loadSchema(broken), /unknown itemdefid 999/);
});

test('schema: duplicate itemdefids are load errors', () => {
  const dupes = {
    appid: 1,
    items: [
      { itemdefid: 5, type: 'item', name: 'A' },
      { itemdefid: 5, type: 'item', name: 'B' },
    ],
  };
  assert.throws(() => loadSchema(dupes), /duplicate itemdefid/);
});

test('schema: booleans survive Steam\'s string form', () => {
  const schema = loadSchema({
    appid: 1,
    items: [{ itemdefid: 1, type: 'playtimegenerator', name: 'D', bundle: '2x1', use_drop_window: 'true', drop_window: '1440' }, { itemdefid: 2, type: 'item', name: 'X' }],
  });
  const def = schema.get(1);
  assert.equal(def.useDropWindow, true);
  assert.equal(def.dropWindow, 1440);
});

test('schema: an itemdef with any drop setting is tracked independently', () => {
  const schema = loadSchema(fixtures);
  assert.equal(schema.get(9050).hasOwnDropSettings, true);
  assert.equal(schema.get(9054).hasOwnDropSettings, false, 'bare generator shares the app budget');
});

test('schema: a tag operand matching no itemdef is a warning, not an error', () => {
  const schema = loadSchema({
    appid: 1,
    items: [{ itemdefid: 1, type: 'item', name: 'A', exchange: 'nobody:home*2' }],
  });
  assert.deepEqual(schema.report.errors, []);
  assert.match(schema.report.warnings.join('\n'), /nobody:home/);
});

test('schema: the shipped content set has no warnings either', () => {
  const schema = loadSchema(DEFAULT_SCHEMA_PATH);
  assert.deepEqual(schema.report.warnings, []);
});
