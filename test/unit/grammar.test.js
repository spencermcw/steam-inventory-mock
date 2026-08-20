'use strict';

/**
 * unit/grammar.test.js — the wire-format parsers, in isolation.
 */

const test = require('node:test');
const assert = require('node:assert');

const g = require('../../lib/grammar');

// ─── Exchange ─────────────────────────────────────────────────────────────────

test('grammar: exchange splits recipes on ";" and materials on ","', () => {
  // Valve's own example: one 100 + one 101; or five 102; or three each of 103,104.
  const recipes = g.parseExchange('100,101;102x5;103x3,104x3');
  assert.equal(recipes.length, 3);
  assert.deepEqual(recipes[0], [
    { kind: 'def', itemdefid: 100, quantity: 1 },
    { kind: 'def', itemdefid: 101, quantity: 1 },
  ]);
  assert.deepEqual(recipes[1], [{ kind: 'def', itemdefid: 102, quantity: 5 }]);
  assert.equal(recipes[2].length, 2);
});

test('grammar: quantity defaults to 1 in both material forms', () => {
  assert.equal(g.parseMaterial('100').quantity, 1);
  assert.equal(g.parseMaterial('handed:left').quantity, 1);
});

test('grammar: "x" is the itemdefid separator and "*" the tag separator', () => {
  assert.deepEqual(g.parseMaterial('102x5'), { kind: 'def', itemdefid: 102, quantity: 5 });
  assert.deepEqual(g.parseMaterial('type:tree*3'), {
    kind: 'tag',
    key: 'type',
    value: 'tree',
    token: 'type:tree',
    quantity: 3,
  });
});

test('grammar: a mixed recipe parses both forms', () => {
  const [recipe] = g.parseExchange('201x1,flavor:banana*2');
  assert.equal(recipe[0].kind, 'def');
  assert.equal(recipe[1].kind, 'tag');
  assert.equal(recipe[1].quantity, 2);
});

test('grammar: an empty exchange field yields no recipes', () => {
  assert.deepEqual(g.parseExchange(''), []);
  assert.deepEqual(g.parseExchange(undefined), []);
});

test('grammar: malformed materials throw rather than silently parse', () => {
  assert.throws(() => g.parseMaterial('abc'), /Invalid itemdef material/);
  assert.throws(() => g.parseMaterial('100y5'), /Invalid itemdef material/);
  assert.throws(() => g.parseMaterial('tag:'), /Invalid tag material/);
});

// ─── Bundle ───────────────────────────────────────────────────────────────────

test('grammar: bundle entries split on ";" with an optional xN', () => {
  assert.deepEqual(g.parseBundle('101x1;102x5'), [
    { itemdefid: 101, quantity: 1 },
    { itemdefid: 102, quantity: 5 },
  ]);
  assert.deepEqual(g.parseBundle('201;202;203'), [
    { itemdefid: 201, quantity: 1 },
    { itemdefid: 202, quantity: 1 },
    { itemdefid: 203, quantity: 1 },
  ]);
});

test('grammar: generator weights use the same slot as bundle quantities', () => {
  assert.deepEqual(g.parseBundle('501x90;502x9;503x1').map(e => e.quantity), [90, 9, 1]);
});

// ─── Tags ─────────────────────────────────────────────────────────────────────

test('grammar: tags are category:value pairs joined by ";"', () => {
  const tags = g.parseTags('class:elf;farms:potato;rarity:legendary');
  assert.equal(tags.length, 3);
  assert.deepEqual(tags[0], { key: 'class', value: 'elf' });
  assert.equal(g.formatTags(tags), 'class:elf;farms:potato;rarity:legendary');
});

test('grammar: tag tokens round-trip through a set', () => {
  const set = g.tagTokenSet(g.parseTags('band:1;category:item'));
  assert.ok(set.has('band:1'));
  assert.ok(!set.has('band:2'));
});

test('grammar: a malformed tag pair throws', () => {
  assert.throws(() => g.parseTags('band'), /Invalid tag pair/);
});

// ─── Promo ────────────────────────────────────────────────────────────────────

test('grammar: promo rules parse all four forms', () => {
  assert.deepEqual(g.parsePromo('owns:440;owns:480'), [
    { type: 'owns', appid: 440 },
    { type: 'owns', appid: 480 },
  ]);
  assert.deepEqual(g.parsePromo('played:570/15'), [{ type: 'played', appid: 570, minutes: 15 }]);
  assert.deepEqual(g.parsePromo('played:570'), [{ type: 'played', appid: 570, minutes: 1 }]);
  assert.deepEqual(g.parsePromo('ach:beat_the_game'), [{ type: 'ach', name: 'beat_the_game' }]);
  assert.deepEqual(g.parsePromo('manual'), [{ type: 'manual' }]);
});

test('grammar: an unrecognised promo rule throws', () => {
  assert.throws(() => g.parsePromo('sometimes'), /Unrecognised promo rule/);
});

// ─── Tag generators ───────────────────────────────────────────────────────────

test('grammar: tag_generator_values default chance to 1', () => {
  assert.deepEqual(g.parseTagGeneratorValues('legendary:1;common:9'), [
    { value: 'legendary', chance: 1 },
    { value: 'common', chance: 9 },
  ]);
  assert.deepEqual(g.parseTagGeneratorValues('flames;sparks;lasers'), [
    { value: 'flames', chance: 1 },
    { value: 'sparks', chance: 1 },
    { value: 'lasers', chance: 1 },
  ]);
});

// ─── Timestamps ───────────────────────────────────────────────────────────────

test('grammar: Steam timestamps round-trip', () => {
  const ms = g.parseSteamTime('20050515T171151Z');
  assert.equal(ms, Date.UTC(2005, 4, 15, 17, 11, 51));
  assert.equal(g.formatSteamTime(ms), '20050515T171151Z');
});
