'use strict';

/**
 * unit/schema.test.js — ingesting Steam's wire format.
 *
 * The load is strict on purpose: a dangling reference or malformed delimited
 * string in whatever pipeline produced the itemdef file should fail loudly
 * here, at load time, rather than at runtime on Steam.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert');

const { loadSchema } = require('../../index');
const fixtures = require('../../examples/economy');

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

test('schema: loads from a real file on disk', () => {
  // The only test in this file that exercises the fs read path — everything
  // else above hands loadSchema a parsed object directly. This is the
  // acceptance check that the package works against a fresh Steam-format
  // itemdef file with no host-project files present.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'steam-inventory-mock-'));
  const file = path.join(dir, 'itemdefs.json');
  try {
    fs.writeFileSync(file, JSON.stringify(fixtures));
    const schema = loadSchema(file);
    assert.deepEqual(schema.report.errors, []);
    assert.ok(schema.get(9001), 'a known itemdef came back');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('schema: loadSchema() with no source is a hard error', () => {
  // The library ships with no default schema, on purpose: guessing at one is
  // how a mock ends up silently validating the wrong content.
  assert.throws(() => loadSchema(), /requires an itemdef source/);
});

// ─── Capability-list integrity ────────────────────────────────────────────────

test('capabilities: every canonical flag is answered by the conformance target', () => {
  // `needs()` skips a test when a flag is missing, so a flag that exists in
  // CAPABILITIES but not on the target silently disables whole files while the
  // suite still reports green. That has happened twice; this is the guard.
  const { CAPABILITIES } = require('../../lib/provider-interface');
  const h = require('../harness');
  const unanswered = Object.keys(CAPABILITIES).filter(flag => h.capabilities[flag] === undefined);
  assert.deepEqual(unanswered, [], 'target must answer every canonical capability, true or false');
});
