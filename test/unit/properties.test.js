'use strict';

/**
 * unit/properties.test.js
 *
 * The dynamic property value model on its own, with no engine, no provider and
 * no account in the way.
 *
 * Two of these are the reason the module exists. The int/float pair, because
 * Valve's white-list carries a type and `1` is not `1.0` there; and the byte
 * measurement, because the 1024-byte cap is quoted in bytes and a JS string
 * length would silently pass payloads real Steam rejects.
 */

const test = require('node:test');
const assert = require('node:assert');

const props = require('../../lib/properties');

// ─── Inference ────────────────────────────────────────────────────────────────

test('properties: a string infers as string', () => {
  assert.deepEqual(props.inferProperty('kills'), { type: 'string', value: 'kills' });
});

test('properties: a boolean infers as bool', () => {
  assert.deepEqual(props.inferProperty(true), { type: 'bool', value: true });
  assert.deepEqual(props.inferProperty(false), { type: 'bool', value: false });
});

test('properties: a whole number infers as int, a fractional one as float', () => {
  assert.deepEqual(props.inferProperty(100), { type: 'int', value: 100 });
  assert.deepEqual(props.inferProperty(-3), { type: 'int', value: -3 });
  assert.deepEqual(props.inferProperty(0.5), { type: 'float', value: 0.5 });
});

test('properties: inference cannot see the difference between 1 and 1.0 — that is what the constructors are for', () => {
  // JS has one number type, so `1.0` arrives here as `1`. A caller who means a
  // float must say so; a white-list declaring float will refuse the int.
  assert.equal(props.inferProperty(1.0).type, 'int');
  assert.equal(props.floatProperty(1.0).type, 'float');
  assert.equal(props.intProperty(1).type, 'int');
});

test('properties: inference refuses values with no property type', () => {
  for (const value of [null, undefined, {}, [], Symbol('x'), () => {}]) {
    assert.throws(() => props.inferProperty(value), props.PropertyError, `${String(value)} should be refused`);
  }
});

test('properties: a bigint is refused rather than silently truncated', () => {
  // Steam's int is an int64 and a BigInt would carry it, but dynamic_props is
  // JSON and JSON.stringify throws on one — better to refuse here than to
  // crash at submit.
  assert.throws(() => props.inferProperty(10n), props.PropertyError);
});

// ─── Validation ───────────────────────────────────────────────────────────────

test('properties: NaN and Infinity are refused for both numeric types', () => {
  for (const value of [NaN, Infinity, -Infinity]) {
    assert.throws(() => props.intProperty(value), props.PropertyError);
    assert.throws(() => props.floatProperty(value), props.PropertyError);
    assert.throws(() => props.inferProperty(value), props.PropertyError);
  }
});

test('properties: a non-integer int is refused, and says to use a float', () => {
  assert.throws(() => props.intProperty(1.5), err => /floatProperty/.test(err.message));
});

test('properties: an int beyond the safe integer range is refused', () => {
  // Past 2^53 a JS number no longer represents consecutive integers, so
  // storing one would mean storing a different number than was passed.
  assert.throws(() => props.intProperty(Number.MAX_SAFE_INTEGER + 2), props.PropertyError);
  assert.doesNotThrow(() => props.intProperty(Number.MAX_SAFE_INTEGER));
});

test('properties: a string property refuses a non-string value', () => {
  assert.throws(() => props.stringProperty(7), props.PropertyError);
  assert.throws(() => props.stringProperty(null), props.PropertyError);
  assert.doesNotThrow(() => props.stringProperty(''));
});

test('properties: a bool property refuses truthy non-booleans', () => {
  assert.throws(() => props.boolProperty(1), props.PropertyError);
  assert.throws(() => props.boolProperty('true'), props.PropertyError);
});

test('properties: an unknown type is refused', () => {
  assert.throws(() => props.property('int64', 1), props.PropertyError);
  assert.throws(() => props.validateProperty({ type: 'date', value: 1 }), props.PropertyError);
});

// ─── Names ────────────────────────────────────────────────────────────────────

test('properties: names accept the replacement-token charset', () => {
  // Valve's own token regex is "%([a-zA-Z0-9.-_]+)%", read as the literal set
  // [a-zA-Z0-9._-] — see properties.js for why the range reading is wrong.
  for (const name of ['kills', 'num_times_fired', 'stats.kills', 'v1-2', 'A_1.b-C']) {
    assert.ok(props.isValidPropertyName(name), `${name} should be a legal name`);
  }
});

test('properties: names reject everything outside that charset', () => {
  for (const name of ['', 'has space', 'colon:name', 'slash/name', 'brack[et]', 'emoji☠', '%wrapped%', null, 7]) {
    assert.equal(props.isValidPropertyName(name), false, `${String(name)} should be refused`);
  }
});

test('properties: an over-long name is refused', () => {
  assert.ok(props.isValidPropertyName('a'.repeat(props.MAX_PROPERTY_NAME_LENGTH)));
  assert.equal(props.isValidPropertyName('a'.repeat(props.MAX_PROPERTY_NAME_LENGTH + 1)), false);
});

// ─── JSON encoding ────────────────────────────────────────────────────────────

test('properties: dynamic_props is a flat JSON object of name to raw value', () => {
  const set = {
    kills: props.intProperty(100),
    accuracy: props.floatProperty(0.25),
    nickname: props.stringProperty('Betsy'),
    favourite: props.boolProperty(true),
  };
  assert.equal(props.propsToJSON(set), '{"accuracy":0.25,"favourite":true,"kills":100,"nickname":"Betsy"}');
});

test('properties: keys are emitted sorted, whatever order they were written in', () => {
  const forwards = { alpha: props.intProperty(1), beta: props.intProperty(2) };
  const backwards = { beta: props.intProperty(2), alpha: props.intProperty(1) };
  assert.equal(props.propsToJSON(forwards), props.propsToJSON(backwards));
});

test('properties: an empty set encodes as {} rather than null', () => {
  assert.equal(props.propsToJSON({}), '{}');
  assert.equal(props.propsToJSON(null), '{}');
});

test('properties: the type tag does not survive into the wire form', () => {
  // Valve's dynamic_props is the property values, not their declarations —
  // and a float 1.0 emits as `1` on Steam too. The type is kept in the save
  // form instead, where the white-list can still consult it.
  assert.equal(props.propsToJSON({ n: props.floatProperty(1.0) }), '{"n":1}');
  assert.equal(props.propsToJSON({ n: props.intProperty(1) }), '{"n":1}');
});

// ─── Byte measurement ─────────────────────────────────────────────────────────

test('properties: the payload is measured in UTF-8 bytes, not characters', () => {
  // "日本語" is 3 characters and 9 bytes. {"n":"日本語"} is 11 characters and
  // 17 bytes; a length-based cap would let through payloads Steam rejects.
  const set = { n: props.stringProperty('日本語') };
  assert.equal(props.propsToJSON(set).length, 11);
  assert.equal(props.propsByteLength(set), 17);
});

test('properties: a set that fits by characters can still blow the byte cap', () => {
  // 400 multi-byte characters: 400 chars of value, 1200 bytes of value.
  const set = { n: props.stringProperty('☠'.repeat(400)) };
  assert.ok(props.propsToJSON(set).length < props.MAX_PROPERTY_BYTES, 'under the cap by characters');
  assert.ok(props.propsByteLength(set) > props.MAX_PROPERTY_BYTES, 'over it by bytes');
});

test('properties: the measurement counts the whole JSON, names and punctuation included', () => {
  assert.equal(props.propsByteLength({}), 2); // "{}"
  assert.equal(props.propsByteLength({ a: props.intProperty(1) }), '{"a":1}'.length);
});

// ─── Save form ────────────────────────────────────────────────────────────────

test('properties: the save form keeps the type and round-trips', () => {
  const set = {
    kills: props.intProperty(3),
    ratio: props.floatProperty(3),
    name: props.stringProperty('x'),
    on: props.boolProperty(false),
  };
  const stored = props.propsToStorage(set);
  assert.deepEqual(stored.kills, { type: 'int', value: 3 });
  assert.deepEqual(stored.ratio, { type: 'float', value: 3 }, 'a whole-numbered float stays a float');
  assert.deepEqual(props.propsFromStorage(stored), set);
});

test('properties: the save form emits sorted keys so an unchanged set saves byte-identically', () => {
  const a = props.propsToStorage({ z: props.intProperty(1), a: props.intProperty(2) });
  const b = props.propsToStorage({ a: props.intProperty(2), z: props.intProperty(1) });
  assert.equal(JSON.stringify(a), JSON.stringify(b));
});

test('properties: loading a save rejects a value that would not be settable now', () => {
  assert.throws(() => props.propsFromStorage({ kills: { type: 'int', value: 1.5 } }), props.PropertyError);
  assert.throws(() => props.propsFromStorage({ 'bad name': { type: 'int', value: 1 } }), props.PropertyError);
});

test('properties: an absent save field loads as no properties', () => {
  assert.deepEqual(props.propsFromStorage(undefined), {});
});
