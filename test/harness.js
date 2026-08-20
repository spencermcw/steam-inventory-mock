'use strict';

/**
 * harness.js
 *
 * Provider-agnostic test harness. Everything under test/conformance/ is written
 * against this, never against MockProvider directly, so the same behavioural
 * suite can be pointed at a real ISteamInventory binding — including from a
 * project that merely installed this package:
 *
 *   # against the mock, the default
 *   node --test test/conformance/*.test.js
 *
 *   # against your own binding, from your own project
 *   STEAM_MOCK_TARGET=./steam-target.js \
 *     node --test node_modules/steam-inventory-mock/test/conformance/*.test.js
 *
 *   # the same run, with a summary of what went unverified
 *   node node_modules/steam-inventory-mock/test/conformance-report.js --target ./steam-target.js
 *
 * Divergence between mock and reality then shows up as a failing test in CI,
 * continuously — rather than as a surprise during final integration.
 *
 * Targets are registered from outside this file, because for everyone but this
 * repo this file is in node_modules and is overwritten on reinstall. The
 * mechanism and its validation live in lib/conformance.js; a copyable target
 * lives in test/example-steam-target.js.
 *
 * Providers advertise capabilities; tests that need something a provider cannot
 * physically do (time travel, fixture schemas, sandbox grants) skip rather than
 * fail. A skip is honest — it says "this semantic is unverified here" — where a
 * green test against a stubbed-out capability would be a lie.
 */

const { MockProvider, call, RESULT } = require('../index');
const { registerTarget, resolveTarget, verifyShape, skipReason } = require('../lib/conformance');

// ─── Targets ──────────────────────────────────────────────────────────────────

registerTarget({
  name: 'mock',
  // Derived from the provider rather than restated here. A hand-maintained
  // copy of this list has drifted from the canonical one twice already, and
  // the failure is quiet in the worst direction: a flag missing here makes
  // `needs()` skip a whole file, so the suite goes green by not running.
  // MockProvider spreads CAPABILITIES, so asking it is always current.
  //
  // A registered target has no such licence: lib/conformance.js refuses one
  // that does not answer every flag, so a third party cannot under-declare by
  // omission the way this file once could.
  get capabilities() {
    return new MockProvider({ schema: { appid: 0, items: [] } }).capabilities;
  },
  create(options = {}) {
    return new MockProvider({ seed: 'conformance', ...options });
  },
});

// A real SteamProvider target is registered from the outside — see
// test/example-steam-target.js for a runnable template declaring every
// capability, with the reasoning for each. It advertises almost none of them,
// and the suite then reports exactly which semantics went unverified as a
// result.

const target = resolveTarget();
const capabilities = target.capabilities;

/** Build a provider for one test. `schema` requires the customSchema capability. */
function createProvider(options = {}) {
  if (options.schema && !capabilities.customSchema) {
    throw new Error(`Provider "${target.name}" cannot load a fixture schema`);
  }
  const provider = target.create(options);
  // The contract check runs at registration where the target can be built with
  // no options; targets that need arguments (the mock refuses to guess a
  // schema) are checked here instead, on the first provider they hand over.
  if (!target.shapeVerified) verifyShape(target, provider);
  return provider;
}

/** `{ skip: needs('virtualClock') }` on a node:test case. */
function needs(...caps) {
  const unknown = caps.filter(c => !(c in capabilities));
  if (unknown.length > 0) {
    // A misspelt flag is never present, so the test would skip forever while
    // reading as covered — the same silent-green failure the capability model
    // exists to prevent, one layer up.
    throw new Error(`needs(): no such capability: ${unknown.join(', ')}`);
  }
  const missing = caps.filter(c => !capabilities[c]);
  return missing.length === 0 ? false : skipReason(target.name, missing);
}

// ─── Inventory helpers ────────────────────────────────────────────────────────

/** Seed an inventory: { itemdefid: quantity }. Requires sandboxGrants. */
async function seed(provider, spec) {
  const ids = Object.keys(spec).map(Number);
  const quantities = ids.map(id => spec[id]);
  const result = await call(provider, 'generateItems', ids, quantities);
  if (!result.ok) throw new Error(`seed() failed: ${result.reason}`);
  return result;
}

/**
 * Set the Steam-side entitlements promo rules read. On a real provider these
 * are facts about the account, not something a test can arrange — hence the
 * capability gate.
 */
function setEntitlements(provider, { ownsApps = [], achievements = [], playtime = {} } = {}) {
  if (!capabilities.entitlements) throw new Error(`Provider "${target.name}" cannot set entitlements`);
  const account = provider.account;
  for (const appid of ownsApps) account.ownedApps.add(Number(appid));
  for (const name of achievements) account.achievements.add(name);
  for (const [appid, minutes] of Object.entries(playtime)) account.playtimeByApp.set(Number(appid), minutes);
  return provider;
}

// ─── Item definition lookup ───────────────────────────────────────────────────

const propertyCaches = new WeakMap();

/**
 * Resolve an item definition by the value of an arbitrary extended property,
 * reading it off every definition via GetItemDefinitionIDs /
 * GetItemDefinitionProperty. Both of those are real Steam calls, which is
 * precisely what makes this portable to a real provider target.
 *
 * `cls` — a host authoring convention uploaded as an extended property — was
 * the original, hardcoded use of this, but `cls` is not a Steam concept: any
 * custom property your content pipeline emits works here just as well.
 */
function resolveByProperty(provider, property, value) {
  if (typeof provider.getItemDefinitionIDs !== 'function') {
    throw new Error(`Provider "${target.name}" cannot enumerate item definitions`);
  }
  let providerCaches = propertyCaches.get(provider);
  if (!providerCaches) {
    providerCaches = new Map();
    propertyCaches.set(provider, providerCaches);
  }
  let cache = providerCaches.get(property);
  if (!cache) {
    cache = new Map();
    for (const id of provider.getItemDefinitionIDs()) {
      const propValue = provider.getItemDefinitionProperty(id, property);
      if (propValue && !cache.has(propValue)) cache.set(propValue, id);
    }
    providerCaches.set(property, cache);
  }
  const id = cache.get(value);
  if (id == null) throw new Error(`No itemdef with ${property} "${value}" in the loaded schema`);
  return id;
}

/** Full inventory, sorted — the canonical form for byte-identical comparison. */
async function snapshot(provider) {
  const result = await call(provider, 'getAllItems');
  return result.items
    .map(i => ({ itemId: i.itemId, itemdefid: i.itemdefid, quantity: i.quantity, tags: i.tags }))
    .sort((a, b) => a.itemId - b.itemId);
}

async function totals(provider) {
  const items = await snapshot(provider);
  const map = new Map();
  for (const item of items) map.set(item.itemdefid, (map.get(item.itemdefid) || 0) + item.quantity);
  return map;
}

async function countOf(provider, itemdefid) {
  return (await totals(provider)).get(itemdefid) || 0;
}

/**
 * Turn { itemdefid: quantity } into the instance-id material list ExchangeItems
 * wants, drawing across stacks. Throws if the inventory cannot cover it — a
 * test that means to under-supply should build its list explicitly.
 */
async function materials(provider, spec) {
  const items = await snapshot(provider);
  const out = [];
  for (const [defIdText, wanted] of Object.entries(spec)) {
    const defId = Number(defIdText);
    let remaining = wanted;
    for (const item of items.filter(i => i.itemdefid === defId)) {
      if (remaining <= 0) break;
      const take = Math.min(remaining, item.quantity);
      out.push({ itemId: item.itemId, quantity: take });
      remaining -= take;
    }
    if (remaining > 0) throw new Error(`materials(): inventory holds too few of itemdef ${defId}`);
  }
  return out;
}

module.exports = {
  target,
  targetName: target.name,
  capabilities,
  createProvider,
  needs,
  seed,
  setEntitlements,
  snapshot,
  totals,
  countOf,
  materials,
  resolveByProperty,
  call,
  RESULT,
};
