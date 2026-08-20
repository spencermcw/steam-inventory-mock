'use strict';

/**
 * fixtures/synthetic.js
 *
 * Hand-written itemdefs in Steam's *wire* format (delimited strings, exactly as
 * dist/itemdefs.json carries them) covering grammar corners the shipped content
 * does not currently exercise — multi-recipe exchanges, tag_generators,
 * drop windows, promo recurrence, non-stacking items.
 *
 * Content-driven tests use the real transpiler output instead; see
 * conformance/shipped-content.test.js.
 */

// ─── Base materials ───────────────────────────────────────────────────────────

const items = [
  { itemdefid: 9001, name: 'Alpha', type: 'item', auto_stack: true, tradable: false, tags: 'rarity:common;band:1' },
  { itemdefid: 9002, name: 'Beta', type: 'item', auto_stack: true, tradable: false, tags: 'rarity:common' },
  { itemdefid: 9003, name: 'Gamma', type: 'item', auto_stack: true, tradable: false, tags: 'rarity:rare' },
  { itemdefid: 9004, name: 'Unstacked Widget', type: 'item', tradable: false },

  // ── Exchange: recipe ordering ──
  // Same two recipes, opposite order. Offered the union of both material sets,
  // a first-match server consumes the first recipe listed — so these two
  // itemdefs must resolve differently.
  { itemdefid: 9010, name: 'Cheap First', type: 'item', auto_stack: true, tradable: false, exchange: '9001x2;9002x5' },
  { itemdefid: 9012, name: 'Expensive First', type: 'item', auto_stack: true, tradable: false, exchange: '9002x5;9001x2' },

  // ── Exchange: tag operands ──
  { itemdefid: 9011, name: 'Tag Recipe', type: 'item', auto_stack: true, tradable: false, exchange: 'rarity:common*3' },
  {
    itemdefid: 9013,
    name: 'Two Tag Operands',
    type: 'item',
    auto_stack: true,
    tradable: false,
    // Deliberately ambiguous: an Alpha satisfies either operand, a Beta only the
    // first. A greedy matcher that spends the Alpha on `rarity:common` fails.
    exchange: 'rarity:common*1,band:1*1',
  },
  { itemdefid: 9014, name: 'Instance Tag Recipe', type: 'item', auto_stack: true, tradable: false, exchange: 'color:red*1' },
  { itemdefid: 9015, name: 'No Recipe', type: 'item', auto_stack: true, tradable: false },

  // ── Bundles ──
  { itemdefid: 9020, name: 'Nested Bundle', type: 'bundle', tradable: false, bundle: '9021x2;9003x1' },
  { itemdefid: 9021, name: 'Inner Bundle', type: 'bundle', tradable: false, bundle: '9001x3' },
  { itemdefid: 9022, name: 'Bundle Recipe', type: 'bundle', tradable: false, exchange: '9003x1', bundle: '9001x2;9002x2' },

  // ── requires round-trip (what the transpiler emits for `requires:`) ──
  { itemdefid: 9091, name: 'Facility', type: 'item', auto_stack: true, tradable: false },
  {
    itemdefid: 9090,
    name: 'Facility Craft',
    type: 'bundle',
    tradable: false,
    // requires 9091, consumes 9002x2 — and re-issues 9091 in the bundle, so the
    // facility is checked for ownership without being spent.
    exchange: '9091x1,9002x2',
    bundle: '9003x1;9091x1',
  },

  // ── Generators ──
  { itemdefid: 9030, name: 'Weighted Generator', type: 'generator', tradable: false, hidden: true, bundle: '9001x70;9002x20;9003x10' },
  { itemdefid: 9031, name: 'Uneven Weights', type: 'generator', tradable: false, hidden: true, bundle: '9001x3;9002x1' },
  { itemdefid: 9032, name: 'Generator Recipe', type: 'generator', tradable: false, hidden: true, bundle: '9001x1', exchange: '9003x1' },

  // ── Tag generators ──
  { itemdefid: 9040, name: 'Quality Tags', type: 'tag_generator', tag_generator_name: 'quality', tag_generator_values: 'legendary:1;common:9' },
  {
    itemdefid: 9041,
    name: 'Tagging Generator',
    type: 'generator',
    tradable: false,
    hidden: true,
    bundle: '9002x1',
    tags: 'color:red',
    tag_generators: '9040',
  },

  // ── Playtime drops ──
  {
    itemdefid: 9050,
    name: 'Daily Drop',
    type: 'playtimegenerator',
    tradable: false,
    bundle: '9001x1',
    drop_interval: 30,
    use_drop_window: true,
    drop_window: 1440,
    drop_max_per_window: 3,
  },
  {
    itemdefid: 9051,
    name: 'Limited Drop',
    type: 'playtimegenerator',
    tradable: false,
    bundle: '9002x1',
    drop_interval: 1,
    use_drop_limit: true,
    drop_limit: 2,
  },
  {
    itemdefid: 9052,
    name: 'Over-capped Drop',
    type: 'playtimegenerator',
    tradable: false,
    bundle: '9003x1',
    drop_interval: 1,
    use_drop_window: true,
    drop_window: 60,
    // Valve caps this at 10 per window regardless of what the itemdef says.
    drop_max_per_window: 25,
  },
  {
    itemdefid: 9053,
    name: 'Retired Drop',
    type: 'playtimegenerator',
    tradable: false,
    bundle: '9001x1',
    drop_interval: 1,
    use_drop_limit: true,
    drop_limit: 0,
  },
  // Two bare playtimegenerators: no drop settings at all, so they share one
  // budget with each other and with the app-level setting.
  { itemdefid: 9054, name: 'Bare Drop A', type: 'playtimegenerator', tradable: false, bundle: '9001x1' },
  { itemdefid: 9055, name: 'Bare Drop B', type: 'playtimegenerator', tradable: false, bundle: '9002x1' },

  // ── Promos ──
  { itemdefid: 9060, name: 'Starter Kit', type: 'bundle', tradable: false, promo: 'manual', bundle: '9001x5;9002x2' },
  {
    itemdefid: 9061,
    name: 'Weekly Token',
    type: 'item',
    auto_stack: true,
    tradable: false,
    promo: 'manual',
    drop_interval: 10080, // one week
  },
  { itemdefid: 9062, name: 'Owner Reward', type: 'item', auto_stack: true, tradable: false, promo: 'owns:440' },
  { itemdefid: 9063, name: 'Achievement Reward', type: 'item', auto_stack: true, tradable: false, promo: 'ach:first_landing' },
  { itemdefid: 9064, name: 'Playtime Reward', type: 'item', auto_stack: true, tradable: false, promo: 'played:570/15' },
  {
    itemdefid: 9065,
    name: 'Future Token',
    type: 'item',
    auto_stack: true,
    tradable: false,
    promo: 'manual',
    drop_start_time: '20260601T000000Z',
  },

  // ── Pathological: a bundle that contains itself, to prove rollback on throw ──
  { itemdefid: 9099, name: 'Recursive Bundle', type: 'bundle', tradable: false, bundle: '9099x1' },
];

module.exports = {
  appid: 4522590,
  items,
  /** A copy of the fixture set with one itemdef marked tradable. */
  withTradableItem() {
    return {
      appid: 4522590,
      items: [...items, { itemdefid: 9999, name: 'Illegal Tradable', type: 'item', tradable: true }],
    };
  },
};
