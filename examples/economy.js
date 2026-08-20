'use strict';

/**
 * examples/economy.js
 *
 * The example economy for this package: a small, complete, hand-written
 * itemdef set in Steam's *wire* format (delimited strings, exactly as a real
 * itemdefs.json carries them). The test suite loads it as its fixture schema,
 * and the demos run against it — one economy, exercised both ways.
 *
 * The comments on each block below are the documentation of what that block
 * demonstrates: multi-recipe exchanges, tag operands, nested bundles, tag
 * generators, drop windows and limits, promo recurrence, non-stacking items.
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

  // ── requires round-trip: check ownership of a facility without spending it ──
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

  // ═══ 9100+: fixtures for tag tools, accessories, dynamic properties and ═══
  // ═══ promo grants — nothing in the package consumes these yet, but the  ═══
  // ═══ upcoming work on lib/engine.js needs them, so they're laid down    ═══
  // ═══ ahead of time, copied straight from Valve's own worked examples.  ═══

  // ── Tag tools: simple paint example (docs/tools.html, "Simple Example") ──
  // A tag_tool applies its `tags` to the target and, per Valve, first strips
  // any tags matching `tags_to_remove_on_tool_use` so re-painting doesn't
  // stack duplicate tag categories. The target opts in per category via
  // `allowed_tags_from_tools` — without it the tool has nothing to write to.
  { itemdefid: 9100, name: 'Red Paint Can', type: 'tag_tool', tradable: false, tags: 'paint_color:red', tags_to_remove_on_tool_use: 'paint_color' },
  { itemdefid: 9101, name: 'Hat', type: 'item', tradable: false, allowed_tags_from_tools: 'paint_color' },
  // A tool that only strips — no `tags` of its own, so applying it just
  // clears whatever paint_color the target is currently carrying.
  { itemdefid: 9102, name: 'Paint Stripper', type: 'tag_tool', tradable: false, tags_to_remove_on_tool_use: 'paint_color' },

  // ── Tag tools: random paint via tag_generator (docs/tools.html, "Tag Generator Example") ──
  // Same paint_color category, but the tool picks a value by weight instead
  // of hard-coding one: 33/33/33/1 out of 100, so gold is a ~1% pull.
  { itemdefid: 9103, name: 'Paint Color Generator', type: 'tag_generator', tradable: false, tag_generator_name: 'paint_color', tag_generator_values: 'red:33;blue:33;green:33;gold:1' },
  { itemdefid: 9104, name: 'Random Paint Can', type: 'tag_tool', tradable: false, tag_generators: '9103', tags_to_remove_on_tool_use: 'paint_color' },

  // ── Accessories: backpack and stickers (docs/accessories.html) ──
  // `accessory_tag` marks an item as customizable with a per-item tag
  // category; `accessory_limit` caps how many can be attached (default 4 if
  // omitted — see 9113 below). Each sticker is its own tag_tool whose `tags`
  // applies the accessory category with the sticker's *own* itemdefid as the
  // value, exactly as Valve's example (itemdefid 1001 -> `sticker:1001`).
  { itemdefid: 9110, name: 'Everyday Backpack', type: 'item', tradable: false, accessory_tag: 'sticker', accessory_limit: 3, allowed_tags_from_tools: 'sticker' },
  { itemdefid: 9111, name: 'Blue Star Sticker', type: 'tag_tool', tradable: false, tags: 'sticker:9111' },
  { itemdefid: 9112, name: 'Red Star Sticker', type: 'tag_tool', tradable: false, tags: 'sticker:9112' },
  // No `accessory_limit` at all — Valve documents a default of 4 for items
  // that omit it, so this item is the fixture for testing that default.
  { itemdefid: 9113, name: 'Trophy Case', type: 'item', tradable: false, accessory_tag: 'badge' },

  // ── Dynamic property restriction pair (docs/tools.html, "Dynamic Properties Restriction Example") ──
  // Valve's example gates a dynamic property (e.g. "kills") on the item
  // carrying a `stat_tracker` tag. The rocket launcher starts without that
  // tag — and without `allowed_tags_from_tools` a tag_tool couldn't write it
  // at all — so it declares the category up front; once the Kill Stat
  // Tracker is applied, the dynamic property becomes settable.
  { itemdefid: 9120, name: 'Rocket Launcher', type: 'item', tradable: false, allowed_tags_from_tools: 'stat_tracker' },
  { itemdefid: 9121, name: 'Kill Stat Tracker', type: 'tag_tool', tradable: false, tags: 'stat_tracker:kills', tags_to_remove_on_tool_use: 'stat_tracker:kills' },

  // ── Promo grants: granted_manually (docs/schema.html) ──
  // `granted_manually` defaults to false per Valve. true restricts the item
  // to explicit AddPromoItem(s) calls — a bulk GrantPromoItems must skip it.
  { itemdefid: 9130, name: 'Manual-Only Badge', type: 'item', auto_stack: true, tradable: false, promo: 'manual', granted_manually: true },
  // Non-manual promo rule, `granted_manually` omitted (i.e. false): a bulk
  // GrantPromoItems call should pick this one up.
  { itemdefid: 9131, name: 'Bulk-Eligible Reward', type: 'item', auto_stack: true, tradable: false, promo: 'owns:440' },

  // ── Stack-transfer coverage ──
  // No new itemdefs needed: 9001 (Alpha) and 9002 (Beta) are both plain
  // `auto_stack: true` items with no exchange/bundle entanglements, so
  // they're the safe pair to split and merge stacks against.

  // ── Pathological: a bundle that contains itself, to prove rollback on throw ──
  { itemdefid: 9099, name: 'Recursive Bundle', type: 'bundle', tradable: false, bundle: '9099x1' },
];

module.exports = {
  appid: 4522590,
  items,
};
