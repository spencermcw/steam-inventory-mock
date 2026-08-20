'use strict';

/**
 * schema.js
 *
 * Loads Steam's wire format for itemdefs and pre-parses every delimited
 * string into structure.
 *
 * We deliberately ingest the wire format — the `exchange`/`bundle`/`tags`/
 * `promo` strings exactly as Steam receives them — rather than some
 * higher-level source description. That makes this loader an integration
 * test of whatever pipeline produced the file (see docs/ for local copies of
 * Valve's Steamworks documentation).
 *
 * Loading is strict: anything Steam would reject on upload — a bundle
 * pointing at a missing itemdefid, an unparsable exchange formula, a
 * duplicate id — is a load error here, not a runtime surprise.
 */

const fs = require('fs');
const g = require('./grammar');

const ITEM_TYPES = new Set(['item', 'bundle', 'generator', 'playtimegenerator', 'tag_generator', 'tag_tool']);

/** Types whose grant is resolved by expansion rather than by instantiation. */
const COMPLEX_TYPES = new Set(['bundle', 'generator', 'playtimegenerator']);

// ─── Field coercion ───────────────────────────────────────────────────────────

/** Steam accepts booleans as real booleans or as the strings "true"/"false". */
function asBool(value, fallback = false) {
  if (value == null) return fallback;
  if (typeof value === 'boolean') return value;
  const s = String(value).trim().toLowerCase();
  if (s === 'true' || s === '1') return true;
  if (s === 'false' || s === '0') return false;
  return fallback;
}

function asInt(value, fallback = null) {
  if (value == null || value === '') return fallback;
  const n = parseInt(String(value), 10);
  return Number.isNaN(n) ? fallback : n;
}

// ─── ItemDef ──────────────────────────────────────────────────────────────────

/** The drop fields whose mere presence flips an itemdef into its own drop bucket. */
const DROP_SETTING_FIELDS = ['drop_interval', 'use_drop_window', 'drop_window', 'drop_max_per_window'];

class ItemDef {
  constructor(raw) {
    this.raw = raw;
    this.itemdefid = asInt(raw.itemdefid);
    this.name = raw.name;
    this.cls = raw.cls || null;
    this.type = raw.type || 'item';

    this.tags = g.parseTags(raw.tags);
    this.tagTokens = g.tagTokenSet(this.tags);

    this.exchange = g.parseExchange(raw.exchange);
    this.bundle = g.parseBundle(raw.bundle);
    this.promo = g.parsePromo(raw.promo);

    this.tagGenerators = g.parseIdList(raw.tag_generators);
    this.tagGeneratorName = raw.tag_generator_name || null;
    this.tagGeneratorValues = g.parseTagGeneratorValues(raw.tag_generator_values);

    this.autoStack = asBool(raw.auto_stack, false);
    this.tradable = asBool(raw.tradable, false);
    this.marketable = asBool(raw.marketable, false);
    this.hidden = asBool(raw.hidden, false);
    this.gameOnly = asBool(raw.game_only, false);
    this.quantity = asInt(raw.quantity, null);
    this.containerContentsGenerator = asInt(raw.container_contents_generator, null);

    // Playtime drop settings. Per Valve: an itemdef that specifies ANY of these
    // is tracked independently; one that specifies none shares the app-level
    // budget with every other bare playtimegenerator.
    this.hasOwnDropSettings = DROP_SETTING_FIELDS.some(f => raw[f] != null);
    this.dropInterval = asInt(raw.drop_interval, null);
    this.useDropWindow = raw.use_drop_window != null ? asBool(raw.use_drop_window) : null;
    this.dropWindow = asInt(raw.drop_window, null);
    this.dropMaxPerWindow = asInt(raw.drop_max_per_window, null);
    this.useDropLimit = raw.use_drop_limit != null ? asBool(raw.use_drop_limit) : null;
    this.dropLimit = asInt(raw.drop_limit, null);
    this.dropStartTime = raw.drop_start_time ? g.parseSteamTime(raw.drop_start_time) : null;
  }

  get isComplex() {
    return COMPLEX_TYPES.has(this.type);
  }

  /** Property lookup for GetItemDefinitionProperty — raw wire values, as Steam returns them. */
  property(name) {
    const value = this.raw[name];
    if (value == null) return null;
    return String(value);
  }

  propertyNames() {
    return Object.keys(this.raw);
  }
}

// ─── Schema ───────────────────────────────────────────────────────────────────

class Schema {
  constructor(appid, defs) {
    this.appid = appid;
    this.defs = new Map();
    this.byClsName = new Map();
    this.tagIndex = new Map(); // "key:value" → Set<itemdefid>

    for (const def of defs) {
      this.defs.set(def.itemdefid, def);
      if (def.cls) this.byClsName.set(def.cls, def);
      for (const token of def.tagTokens) {
        if (!this.tagIndex.has(token)) this.tagIndex.set(token, new Set());
        this.tagIndex.get(token).add(def.itemdefid);
      }
    }
  }

  get(itemdefid) {
    return this.defs.get(Number(itemdefid)) || null;
  }

  /** Throwing lookup — the engine wants a hard failure on a bad id. */
  require(itemdefid) {
    const def = this.get(itemdefid);
    if (!def) throw new Error(`Unknown itemdefid ${itemdefid}`);
    return def;
  }

  byCls(cls) {
    return this.byClsName.get(cls) || null;
  }

  requireCls(cls) {
    const def = this.byCls(cls);
    if (!def) throw new Error(`Unknown cls "${cls}"`);
    return def;
  }

  all() {
    return [...this.defs.values()];
  }

  size() {
    return this.defs.size;
  }
}

// ─── Validation ───────────────────────────────────────────────────────────────

/**
 * Structural checks that mirror what Steam would reject on upload.
 */
function validate(schema, options = {}) {
  const errors = [];
  const warnings = [];

  for (const def of schema.all()) {
    const where = `itemdef ${def.itemdefid}${def.cls ? ` (${def.cls})` : ''}`;

    if (!Number.isInteger(def.itemdefid) || def.itemdefid <= 0) {
      errors.push(`${where}: missing or invalid itemdefid`);
    }
    if (!ITEM_TYPES.has(def.type)) {
      errors.push(`${where}: unknown type "${def.type}"`);
    }

    for (const entry of def.bundle) {
      if (!schema.get(entry.itemdefid)) {
        errors.push(`${where}: bundle references unknown itemdefid ${entry.itemdefid}`);
      }
    }
    for (const recipe of def.exchange) {
      for (const material of recipe) {
        if (material.kind === 'def' && !schema.get(material.itemdefid)) {
          errors.push(`${where}: exchange references unknown itemdefid ${material.itemdefid}`);
        }
        if (material.kind === 'tag' && !schema.tagIndex.has(material.token)) {
          warnings.push(`${where}: exchange tag operand "${material.token}" matches no itemdef`);
        }
      }
    }
    for (const id of def.tagGenerators) {
      const gen = schema.get(id);
      if (!gen) errors.push(`${where}: tag_generators references unknown itemdefid ${id}`);
      else if (gen.type !== 'tag_generator') {
        errors.push(`${where}: tag_generators references itemdef ${id} of type "${gen.type}"`);
      }
    }
    if (def.containerContentsGenerator != null && !schema.get(def.containerContentsGenerator)) {
      errors.push(`${where}: container_contents_generator references unknown itemdefid ${def.containerContentsGenerator}`);
    }

    if (def.isComplex && def.bundle.length === 0) {
      warnings.push(`${where}: type "${def.type}" with an empty bundle grants nothing`);
    }
    if (def.type === 'tag_generator' && (!def.tagGeneratorName || def.tagGeneratorValues.length === 0)) {
      errors.push(`${where}: tag_generator needs both tag_generator_name and tag_generator_values`);
    }
  }

  return { errors, warnings };
}

// ─── Loading ──────────────────────────────────────────────────────────────────

/**
 * @param {string|object} source path to a Steam itemdef JSON file, or the
 *   parsed object itself (`{ appid, items: [...] }` or a bare item array).
 * @param {object} [options]
 * @param {boolean} [options.strict=true] throw on validation errors
 */
function loadSchema(source, options = {}) {
  if (source == null) {
    throw new Error('loadSchema() requires an itemdef source: a path to a Steam itemdef JSON file, a parsed { appid, items } object, or a bare item array.');
  }

  const strict = options.strict !== false;

  let data;
  if (typeof source === 'string') {
    const file = source;
    if (!fs.existsSync(file)) {
      throw new Error(`No itemdef schema at ${file}`);
    }
    data = JSON.parse(fs.readFileSync(file, 'utf-8'));
  } else {
    data = source;
  }

  const items = Array.isArray(data) ? data : data.items;
  if (!Array.isArray(items)) throw new Error('Schema source has no "items" array');

  const seen = new Set();
  const duplicates = [];
  const defs = [];
  for (const raw of items) {
    const def = new ItemDef(raw);
    if (seen.has(def.itemdefid)) duplicates.push(def.itemdefid);
    seen.add(def.itemdefid);
    defs.push(def);
  }

  const schema = new Schema(Array.isArray(data) ? null : data.appid ?? null, defs);
  const report = validate(schema, options);
  if (duplicates.length > 0) {
    report.errors.unshift(`duplicate itemdefid(s): ${[...new Set(duplicates)].join(', ')}`);
  }
  schema.report = report;

  if (strict && report.errors.length > 0) {
    throw new Error(`Invalid itemdef schema:\n  ${report.errors.join('\n  ')}`);
  }
  return schema;
}

module.exports = {
  loadSchema,
  validate,
  Schema,
  ItemDef,
  COMPLEX_TYPES,
  ITEM_TYPES,
  asBool,
  asInt,
};
