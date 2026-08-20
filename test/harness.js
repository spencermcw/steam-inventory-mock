'use strict';

/**
 * harness.js
 *
 * Provider-agnostic test harness. Everything under test/conformance/ is written
 * against this, never against MockProvider directly, so the same behavioural
 * suite can later be pointed at the native SteamProvider:
 *
 *   LSC_PROVIDER=steam node --test mock/test/conformance
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
    capabilities: {
      virtualClock: true,
      customSchema: true,
      sandboxGrants: true,
      deterministicRng: true,
      failureReasons: true,
      /** surplusPolicy is configurable; real Steam's behaviour is fixed and unmeasured. */
      configurableSurplus: true,
      /** Owned apps / achievements / per-app playtime can be set for promo rules. */
      entitlements: true,
      /** bypassDropGating / bypassPromoGating engine options exist and take effect. */
      gatingBypass: true,
      /** State can be exported with save() and reimported with load(). */
      persistence: true,
    },
    create(options = {}) {
      return new MockProvider({ seed: 'conformance', ...options });
    },
  },

  // A SteamProvider target registers here once the native binding exists. It
  // will advertise none of the capabilities above, and the suite will report
  // exactly which semantics went unverified as a result.
};

const targetName = process.env.LSC_PROVIDER || 'mock';
const target = TARGETS[targetName];
if (!target) {
  throw new Error(`Unknown LSC_PROVIDER "${targetName}" (known: ${Object.keys(TARGETS).join(', ')})`);
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

const clsCaches = new WeakMap();

/**
 * Resolve a `cls` authoring name to its itemdefid, by reading the custom `cls`
 * property off the definitions. Both calls used here exist on real Steam
 * (GetItemDefinitionIDs / GetItemDefinitionProperty) and `cls` is uploaded as
 * an extended property, so content tests written this way stay portable.
 */
function resolveCls(provider, cls) {
  if (typeof provider.getItemDefinitionIDs !== 'function') {
    throw new Error(`Provider "${target.name}" cannot enumerate item definitions`);
  }
  let cache = clsCaches.get(provider);
  if (!cache) {
    cache = new Map();
    for (const id of provider.getItemDefinitionIDs()) {
      const name = provider.getItemDefinitionProperty(id, 'cls');
      if (name && !cache.has(name)) cache.set(name, id);
    }
    clsCaches.set(provider, cache);
  }
  const id = cache.get(cls);
  if (id == null) throw new Error(`No itemdef with cls "${cls}" in the loaded schema`);
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
  resolveCls,
  call,
  RESULT,
};
