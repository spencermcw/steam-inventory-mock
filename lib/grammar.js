'use strict';

/**
 * grammar.js
 *
 * Parsers for Steam's Inventory Service wire grammars. Everything in
 * a Steam itemdef JSON file that is not a scalar is a delimited string, and this file
 * is the only place that knows how to take those strings apart.
 *
 * Grammars implemented (see docs/ or https://partner.steamgames.com/doc/features/inventory/schema):
 *
 *   exchange   <exchange>: <recipe> { ";" <recipe> }
 *              <recipe>:   <material> { "," <material> }
 *              <material>: <itemdefid> [ "x" <quantity> ]
 *                        | <tag_name> ":" <tag_value> [ "*" <quantity> ]
 *
 *   bundle     <bundle>: <item_recipe> { ";" <item_recipe> }
 *              <item_recipe>: <itemdefid> [ "x" <quantity> ]
 *              (for generators the quantity slot carries the relative weight)
 *
 *   tags       <tag_list>: <tag_pair> { ";" <tag_pair> }
 *              <tag_pair>: <category_token> ":" <tag_token>
 *
 *   promo      <promo>: <rule> { ";" <rule> }
 *              <rule>: "owns:" <appid> | "ach:" <name>
 *                    | "played:" <appid> [ "/" <minutes> ] | "manual"
 *
 *   tag_generator_values   <value> [ ":" <chance> ] { ";" ... }  (chance default 1)
 *
 * Every parser is total: it either returns a structure or throws with the
 * offending source string, because a parse failure here means the schema
 * contains data that Steam's server would reject.
 */

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Split on `sep`, trim, drop empty segments. */
function split(str, sep) {
  return String(str)
    .split(sep)
    .map(s => s.trim())
    .filter(s => s.length > 0);
}

function parsePositiveInt(text, what, source) {
  if (!/^\d+$/.test(text)) {
    throw new Error(`Invalid ${what} "${text}" in "${source}"`);
  }
  return parseInt(text, 10);
}

// ─── Tags ─────────────────────────────────────────────────────────────────────

/**
 * "band:1;category:item" → [{ key: 'band', value: '1' }, ...]
 * Order is preserved; duplicates are preserved (Steam does not dedupe).
 */
function parseTags(str) {
  if (str == null || str === '') return [];
  return split(str, ';').map(pair => {
    const idx = pair.indexOf(':');
    if (idx <= 0 || idx === pair.length - 1) {
      throw new Error(`Invalid tag pair "${pair}" in "${str}"`);
    }
    return { key: pair.slice(0, idx).trim(), value: pair.slice(idx + 1).trim() };
  });
}

/** [{key,value}] → "key:value;key:value" (the inverse of parseTags). */
function formatTags(tags) {
  return (tags || []).map(t => `${t.key}:${t.value}`).join(';');
}

/** [{key,value}] → Set of "key:value" tokens, for O(1) operand matching. */
function tagTokenSet(tags) {
  const set = new Set();
  for (const t of tags || []) set.add(`${t.key}:${t.value}`);
  return set;
}

// ─── Exchange ─────────────────────────────────────────────────────────────────

/**
 * Parse one material operand.
 *
 * Note the separators differ by form: `x` for itemdefid, `*` for tag. A tag
 * operand is identified by the presence of ":".
 */
function parseMaterial(str) {
  const s = String(str).trim();

  if (s.includes(':')) {
    const m = s.match(/^([^:*]+):([^:*]+)(?:\*(\d+))?$/);
    if (!m) throw new Error(`Invalid tag material "${s}"`);
    return {
      kind: 'tag',
      key: m[1].trim(),
      value: m[2].trim(),
      token: `${m[1].trim()}:${m[2].trim()}`,
      quantity: m[3] ? parsePositiveInt(m[3], 'quantity', s) : 1,
    };
  }

  const m = s.match(/^(\d+)(?:x(\d+))?$/);
  if (!m) throw new Error(`Invalid itemdef material "${s}"`);
  return {
    kind: 'def',
    itemdefid: parsePositiveInt(m[1], 'itemdefid', s),
    quantity: m[2] ? parsePositiveInt(m[2], 'quantity', s) : 1,
  };
}

/**
 * "1002x1,1102x1;category:blueprint*5" →
 *   [ [material, material], [material] ]
 *
 * Recipe order is load-bearing: Steam evaluates recipes in order and takes the
 * first one satisfied by the materials given.
 */
function parseExchange(str) {
  if (str == null || str === '') return [];
  return split(str, ';').map(recipe => split(recipe, ',').map(parseMaterial));
}

// ─── Bundle ───────────────────────────────────────────────────────────────────

/**
 * "1104x700;1105x250" → [{ itemdefid: 1104, quantity: 700 }, ...]
 *
 * For type:bundle the quantity is a literal count. For type:generator and
 * type:playtimegenerator the same slot is the entry's relative weight — the
 * caller decides which reading applies.
 */
function parseBundle(str) {
  if (str == null || str === '') return [];
  return split(str, ';').map(entry => {
    const m = entry.match(/^(\d+)(?:x(\d+))?$/);
    if (!m) throw new Error(`Invalid bundle entry "${entry}" in "${str}"`);
    return {
      itemdefid: parsePositiveInt(m[1], 'itemdefid', str),
      quantity: m[2] ? parsePositiveInt(m[2], 'quantity', str) : 1,
    };
  });
}

// ─── Promo ────────────────────────────────────────────────────────────────────

/** "owns:440;played:570/15;manual" → [{type:'owns',appid:440}, ...] */
function parsePromo(str) {
  if (str == null || str === '') return [];
  return split(str, ';').map(rule => {
    if (rule === 'manual') return { type: 'manual' };

    let m = rule.match(/^owns:(\d+)$/);
    if (m) return { type: 'owns', appid: parseInt(m[1], 10) };

    m = rule.match(/^ach:(.+)$/);
    if (m) return { type: 'ach', name: m[1].trim() };

    m = rule.match(/^played:(\d+)(?:\/(\d+))?$/);
    if (m) {
      return {
        type: 'played',
        appid: parseInt(m[1], 10),
        minutes: m[2] ? parseInt(m[2], 10) : 1,
      };
    }

    throw new Error(`Unrecognised promo rule "${rule}" in "${str}"`);
  });
}

// ─── Tag generators ───────────────────────────────────────────────────────────

/** "legendary:1;common:9" → [{ value:'legendary', chance:1 }, ...] (chance default 1). */
function parseTagGeneratorValues(str) {
  if (str == null || str === '') return [];
  return split(str, ';').map(entry => {
    const idx = entry.lastIndexOf(':');
    if (idx === -1) return { value: entry, chance: 1 };
    const chanceText = entry.slice(idx + 1).trim();
    if (!/^\d+$/.test(chanceText)) return { value: entry, chance: 1 };
    return {
      value: entry.slice(0, idx).trim(),
      chance: parsePositiveInt(chanceText, 'chance', str),
    };
  });
}

/** "101;102" → [101, 102] */
function parseIdList(str) {
  if (str == null || str === '') return [];
  return split(str, ';').map(id => parsePositiveInt(id, 'itemdefid', str));
}

// ─── Steam timestamps ─────────────────────────────────────────────────────────

/**
 * ISO 8601 basic-format UTC, as used by drop_start_time: "20050515T171151Z".
 * Also accepts extended ISO for convenience when hand-writing fixtures.
 */
function parseSteamTime(str) {
  if (str == null || str === '') return null;
  const s = String(str).trim();
  const m = s.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/);
  if (m) {
    return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
  }
  const parsed = Date.parse(s);
  if (Number.isNaN(parsed)) throw new Error(`Invalid Steam timestamp "${s}"`);
  return parsed;
}

/** Inverse of parseSteamTime — epoch ms → "YYYYMMDDTHHMMSSZ". */
function formatSteamTime(ms) {
  const d = new Date(ms);
  const p = n => String(n).padStart(2, '0');
  return (
    `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}` +
    `T${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`
  );
}

module.exports = {
  parseTags,
  formatTags,
  tagTokenSet,
  parseMaterial,
  parseExchange,
  parseBundle,
  parsePromo,
  parseTagGeneratorValues,
  parseIdList,
  parseSteamTime,
  formatSteamTime,
};
