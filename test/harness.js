'use strict';

/**
 * harness.js
 *
 * Provider-agnostic test harness. Everything under test/conformance/ is written
 * against this, never against MockProvider directly, so the same behavioural
 * suite can later be pointed at the native SteamProvider:
 *
 *   STEAM_MOCK_PROVIDER=steam node --test test/conformance/*.test.js
 *
 * Divergence between mock and reality then shows up as a failing test in CI,
 * continuously — rather than as a surprise during final integration.
 *
 * Providers advertise capabilities; tests that need something a provider cannot
 * physically do (time travel, fixture schemas, sandbox grants) skip rather than
 * fail. A skip is honest — it says "this semantic is unverified here" — where a
 * green test against a stubbed-out capability would be a lie.
 */

const { MockProvider, call, RESULT } = require('../index');

// ─── Targets ──────────────────────────────────────────────────────────────────

const TARGETS = {
  mock: {
    name: 'mock',
    // Derived from the provider rather than restated here. A hand-maintained
    // copy of this list has drifted from the canonical one twice already, and
    // the failure is quiet in the worst direction: a flag missing here makes
    // `needs()` skip a whole file, so the suite goes green by not running.
    // MockProvider spreads CAPABILITIES, so asking it is always current.
    get capabilities() {
      return new MockProvider({ schema: { appid: 0, items: [] } }).capabilities;
    },
    create(options = {}) {
      return new MockProvider({ seed: 'conformance', ...options });
    },
  },

  // A SteamProvider target registers here once the native binding exists. It
  // will advertise none of the capabilities above, and the suite will report
  // exactly which semantics went unverified as a result. A skip is honest —
  // it says "this semantic is unverified here" — where a green test against
  // a stubbed-out capability would be a lie. A worked example, for whoever
  // wires up the native binding:
  //
  //   const { SteamProvider } = require('../lib/steam-provider');
  //
  //   steam: {
  //     name: 'steam',
  //     capabilities: {
  //       // You cannot time-travel live Steam.
  //       virtualClock: false,
  //       // A real provider loads the app's uploaded itemdefs, not a fixture.
  //       customSchema: false,
  //       // GenerateItems is sandbox-only (apps in development), not something
  //       // a live provider can invoke.
  //       sandboxGrants: false,
  //       // Item drops and other rolls happen server-side; there is no seed
  //       // to fix them against.
  //       deterministicRng: false,
  //       // A real provider is not given a human-readable failure reason.
  //       failureReasons: false,
  //       // drop_interval / drop_limit / promo recurrence are enforced
  //       // server-side; there is no client override to exercise.
  //       gatingBypass: false,
  //       // An account's owned apps / achievements / playtime are facts, not
  //       // something a test can arrange.
  //       entitlements: false,
  //       // Steam's surplus behaviour is fixed and unmeasured.
  //       configurableSurplus: false,
  //       // Steam holds the inventory server-side and neither hands it over
  //       // nor takes it back.
  //       persistence: false,
  //     },
  //     create(options = {}) {
  //       return new SteamProvider(options);
  //     },
  //   },
  //
  // Run the suite against it with:
  //
  //   STEAM_MOCK_PROVIDER=steam node --test test/conformance/*.test.js
};

const targetName = process.env.STEAM_MOCK_PROVIDER || 'mock';
const target = TARGETS[targetName];
if (!target) {
  throw new Error(`Unknown STEAM_MOCK_PROVIDER "${targetName}" (known: ${Object.keys(TARGETS).join(', ')})`);
}

const capabilities = target.capabilities;

/** Build a provider for one test. `schema` requires the customSchema capability. */
function createProvider(options = {}) {
  if (options.schema && !capabilities.customSchema) {
    throw new Error(`Provider "${target.name}" cannot load a fixture schema`);
  }
  return target.create(options);
}

/** `{ skip: needs('virtualClock') }` on a node:test case. */
function needs(...caps) {
  const missing = caps.filter(c => !capabilities[c]);
  return missing.length === 0 ? false : `provider "${target.name}" lacks: ${missing.join(', ')}`;
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
