'use strict';

/**
 * properties.js
 *
 * The value model for dynamic item properties — Valve's "arbitrary string,
 * integer, boolean, or float properties on any item instance".
 *
 * It lives in its own file because the engine already owns exchange
 * resolution, expansion, drops and promos; a typed value system with its own
 * validation and wire format is a second concern, and folding it in would
 * make both harder to read. The engine below stages and applies edits; what a
 * *value* is, and what it costs in bytes, is decided here.
 *
 * Two things are load-bearing and easy to get wrong:
 *
 *   • int and float are different property types. Valve exposes separate
 *     SetProperty overloads for int64 and float, and the partner-site
 *     white-list carries a "type" field per property, so `1` and `1.0` are
 *     not interchangeable — a white-list declaring `float` refuses an int.
 *     JS has one number type, so inference alone cannot express the
 *     distinction and explicit constructors exist for callers that care.
 *
 *   • The 1024-byte cap is measured on the emitted JSON in *bytes*, not
 *     characters. A property value in a non-Latin script costs two to four
 *     bytes per character, so a character count would let a client write
 *     something real Steam rejects and only discover it in production.
 *
 * Deliberately NOT modelled here:
 *   • %token% substitution of property values into an item's description.
 *     That is web-view rendering of the user's backpack, not inventory state
 *     — nothing in this library renders a description, so implementing it
 *     would produce output no caller could observe.
 *   • Trading clearing an item's dynamic properties. Valve is explicit that
 *     it happens; this library has no trading (no second party, no trade
 *     offers), so there is no moment at which to do it. A binding that gains
 *     trading must clear `dynamicProps` on transfer.
 */

// ─── Types and limits ─────────────────────────────────────────────────────────

/** The four types Valve documents. Order is display order, nothing more. */
const PROPERTY_TYPES = Object.freeze(['string', 'int', 'bool', 'float']);

/** Valve: "a maximum of 1024 bytes of JSON per item at this time". */
const MAX_PROPERTY_BYTES = 1024;

/**
 * The legal characters in a property name.
 *
 * Valve never states the rule directly. What it does state is the regular
 * expression for a description replacement token: "%([a-zA-Z0-9.-_]+)%". A
 * property whose name cannot appear in that token can never be substituted,
 * so the token charset is the tightest defensible bound on a name — and read
 * literally rather than as a regex, because `.-_` inside a character class is
 * a range spanning U+002E..U+005F (which would sweep in `/`, `:`, `;`, `<`,
 * `=`, `>`, `?`, `@` and `[\]^`). Valve plainly meant the three punctuation
 * marks, not that range, and the narrow reading is the one that cannot let a
 * name through that real Steam refuses.
 */
const PROPERTY_NAME_PATTERN = /^[a-zA-Z0-9._-]+$/;

/** Names cannot be unbounded, or a single name could blow the byte cap alone. */
const MAX_PROPERTY_NAME_LENGTH = 128;

// ─── Errors ───────────────────────────────────────────────────────────────────

/**
 * Thrown by the constructors and validators below. The engine catches it and
 * turns it into a `false` return from SetProperty, because Valve's SetProperty
 * returns bool and never a reason — the message survives only as a diagnostic
 * on the staged batch.
 */
class PropertyError extends Error {
  constructor(message) {
    super(message);
    this.name = 'PropertyError';
  }
}

// ─── Names ────────────────────────────────────────────────────────────────────

function isValidPropertyName(name) {
  return (
    typeof name === 'string' &&
    name.length > 0 &&
    name.length <= MAX_PROPERTY_NAME_LENGTH &&
    PROPERTY_NAME_PATTERN.test(name)
  );
}

function assertPropertyName(name) {
  if (!isValidPropertyName(name)) {
    throw new PropertyError(
      `Invalid dynamic property name ${JSON.stringify(name)}: expected 1-${MAX_PROPERTY_NAME_LENGTH} characters ` +
        `matching ${PROPERTY_NAME_PATTERN}`
    );
  }
  return name;
}

// ─── Values ───────────────────────────────────────────────────────────────────

/**
 * A property value is `{ type, value }` and nothing else — no name. Names key
 * the map on the instance, so a value can be built, validated and measured
 * without knowing what it will be called.
 */
function property(type, value) {
  if (!PROPERTY_TYPES.includes(type)) {
    throw new PropertyError(`Unknown dynamic property type ${JSON.stringify(type)}`);
  }
  return validateProperty({ type, value });
}

function stringProperty(value) {
  return property('string', value);
}

function intProperty(value) {
  return property('int', value);
}

function boolProperty(value) {
  return property('bool', value);
}

function floatProperty(value) {
  return property('float', value);
}

/**
 * Infer a property from a bare JS value, for the single-argument setProperty.
 *
 * A whole number infers as `int`, which is the useful default (counters,
 * kills, times fired) and the one Valve's own example uses. A caller who
 * means a float that happens to hold a whole number must say so with
 * floatProperty() — inference cannot read intent out of `1`.
 */
function inferProperty(value) {
  if (typeof value === 'string') return stringProperty(value);
  if (typeof value === 'boolean') return boolProperty(value);
  if (typeof value === 'number') {
    return Number.isInteger(value) ? intProperty(value) : floatProperty(value);
  }
  if (typeof value === 'bigint') {
    // Valve's int is an int64, which a JS number cannot hold past 2^53. A
    // BigInt would carry the range, but JSON.stringify throws on one and the
    // emitted `dynamic_props` must be JSON — so this is refused loudly here
    // rather than surfacing as a serialisation crash at submit time.
    throw new PropertyError(
      'BigInt dynamic property values are not supported: dynamic_props is JSON, and JSON has no bigint. ' +
        'Use a string property if the value exceeds Number.MAX_SAFE_INTEGER.'
    );
  }
  throw new PropertyError(
    `Cannot infer a dynamic property type from ${value === null ? 'null' : typeof value} — ` +
      `expected string, number or boolean`
  );
}

/** Throws PropertyError on anything real Steam would not store. */
function validateProperty(prop) {
  if (!prop || typeof prop !== 'object') {
    throw new PropertyError('A dynamic property must be a { type, value } object');
  }
  const { type, value } = prop;
  switch (type) {
    case 'string':
      if (typeof value !== 'string') {
        throw new PropertyError(`A string property needs a string value, got ${typeof value}`);
      }
      break;
    case 'bool':
      if (typeof value !== 'boolean') {
        throw new PropertyError(`A bool property needs a boolean value, got ${typeof value}`);
      }
      break;
    case 'int':
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        throw new PropertyError(`An int property needs a finite number, got ${describeNumber(value)}`);
      }
      if (!Number.isInteger(value)) {
        throw new PropertyError(`An int property needs a whole number, got ${value} — use floatProperty() instead`);
      }
      if (!Number.isSafeInteger(value)) {
        // Steam stores an int64; past 2^53 a JS number no longer represents
        // consecutive integers, so accepting one would silently store a
        // different number than the caller passed.
        throw new PropertyError(`Int property ${value} is beyond Number.MAX_SAFE_INTEGER and cannot round-trip`);
      }
      break;
    case 'float':
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        throw new PropertyError(`A float property needs a finite number, got ${describeNumber(value)}`);
      }
      break;
    default:
      throw new PropertyError(`Unknown dynamic property type ${JSON.stringify(type)}`);
  }
  return { type, value };
}

/** NaN and ±Infinity are both `typeof 'number'`; say which one was passed. */
function describeNumber(value) {
  if (typeof value !== 'number') return typeof value;
  if (Number.isNaN(value)) return 'NaN';
  return String(value);
}

// ─── Serialisation ────────────────────────────────────────────────────────────

/**
 * The `dynamic_props` payload: a plain JSON object of name → raw value, which
 * is what Valve says GetResultItemProperty hands back ("the string
 * representation of the JSON for all the dynamic properties for the item").
 *
 * The type tag does not survive into the JSON, because it does not survive on
 * Steam either — a float 1.0 and an int 1 both emit as `1`, and the client
 * reading them back gets a JSON number either way. The type is kept on the
 * stored property so the white-list can enforce it and so a save round trip
 * does not quietly turn a float into an int.
 *
 * Keys are emitted in sorted order so the same property set always produces
 * the same bytes: the 1024-byte measurement below has to be stable, and a
 * save has to stay byte-identical when nothing changed.
 */
function propsToJSON(props) {
  const plain = {};
  for (const name of Object.keys(props || {}).sort()) {
    plain[name] = props[name].value;
  }
  return JSON.stringify(plain);
}

/**
 * UTF-8 byte length of the emitted JSON — the quantity Valve's 1024-byte cap
 * is expressed in. Buffer.byteLength, not String.length: "☠" is one character
 * and three bytes, and counting characters would pass a payload real Steam
 * rejects.
 */
function propsByteLength(props) {
  return Buffer.byteLength(propsToJSON(props), 'utf8');
}

// ─── Save form ────────────────────────────────────────────────────────────────

/**
 * Save form keeps the type tag, unlike the `dynamic_props` wire form: a
 * reloaded float that came back as an int would start failing a white-list
 * that the same client passed before the restart. Sorted for byte-identical
 * saves, same as every other collection in inventory.js.
 */
function propsToStorage(props) {
  const out = {};
  for (const name of Object.keys(props || {}).sort()) {
    out[name] = { type: props[name].type, value: props[name].value };
  }
  return out;
}

/** Inverse of propsToStorage. Rejects anything that would not validate now. */
function propsFromStorage(raw) {
  const out = {};
  for (const name of Object.keys(raw || {}).sort()) {
    assertPropertyName(name);
    out[name] = validateProperty(raw[name]);
  }
  return out;
}

module.exports = {
  PROPERTY_TYPES,
  PROPERTY_NAME_PATTERN,
  MAX_PROPERTY_BYTES,
  MAX_PROPERTY_NAME_LENGTH,
  PropertyError,
  isValidPropertyName,
  assertPropertyName,
  property,
  stringProperty,
  intProperty,
  boolProperty,
  floatProperty,
  inferProperty,
  validateProperty,
  propsToJSON,
  propsByteLength,
  propsToStorage,
  propsFromStorage,
};
