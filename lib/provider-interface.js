'use strict';

/**
 * provider-interface.js
 *
 * The contract both implementations satisfy: MockProvider (here) and, later,
 * SteamProvider (the native ISteamInventory binding).
 *
 *   InventoryProvider
 *     getAllItems()                     -> handle
 *     getItemsByID(instanceIds)         -> handle
 *     exchangeItems(target, materials)  -> handle
 *     consumeItem(itemId, quantity)     -> handle
 *     transferItemQuantity(src, qty, dst) -> handle
 *     triggerItemDrop(itemDefId)        -> handle
 *     addPromoItem(itemDefId)           -> handle
 *     getItemDefinitionProperty(id, prop)
 *     getResultTimestamp(handle)
 *     checkResultSteamID(handle, steamIDExpected)
 *     loadItemDefinitions()
 *     on('resultReady', handle => ...)
 *
 * ⚠️ No inventory method returns a result. Every one returns a *handle*, and the
 * result arrives later through the 'resultReady' event, exactly as real Steam
 * delivers SteamInventoryResultReady_t. The single most common way "mock first"
 * fails is a client written against a synchronous fantasy — at which point real
 * integration is a rewrite instead of a swap. Keeping the mock async makes that
 * mistake impossible to make.
 *
 * getItemDefinitionProperty is the one synchronous call, because it is
 * synchronous on real Steam too: item definitions are downloaded up front and
 * read out of a local cache.
 *
 * `capabilities` lets the conformance suite skip tests a given provider cannot
 * physically support (you cannot time-travel live Steam, nor hand it a fixture
 * schema).
 */

// ─── Capability flags ─────────────────────────────────────────────────────────

const CAPABILITIES = {
  /** advanceTime() actually moves time. */
  virtualClock: false,
  /** The provider can be constructed against an arbitrary fixture schema. */
  customSchema: false,
  /** generateItems() is available for seeding inventories. */
  sandboxGrants: false,
  /** Results are reproducible given a seed. */
  deterministicRng: false,
  /** Failure results carry a human-readable `reason` (mock-only diagnostics). */
  failureReasons: false,
  /**
   * `bypassDropGating` / `bypassPromoGating` engine options exist and take
   * effect. Test-mode only; a real SteamProvider can never support skipping
   * Steam's own server-side drop_interval / drop_limit / promo recurrence
   * checks, so conformance tests for this must skip rather than fail there.
   */
  gatingBypass: false,
  /**
   * Provider state can be exported and reimported (`save()` / `load()`), so a
   * session survives a process restart. Real Steam holds the inventory
   * server-side and neither hands it over nor takes it back — a SteamProvider
   * advertises this false and persistence tests skip there.
   */
  persistence: false,
  /**
   * surplusPolicy can be selected per provider. Real Steam's surplus
   * behaviour is fixed and unmeasured, so a SteamProvider advertises this
   * false.
   */
  configurableSurplus: false,
  /**
   * Owned apps / achievements / per-app playtime can be arranged for promo
   * rules to read. On a real account these are facts, not test setup, so a
   * SteamProvider advertises this false.
   */
  entitlements: false,
};

// ─── Abstract base ────────────────────────────────────────────────────────────

class InventoryProvider {
  get capabilities() {
    return { ...CAPABILITIES };
  }

  /* eslint-disable no-unused-vars */
  getAllItems() {
    throw new Error('not implemented');
  }
  getItemsByID(instanceIds) {
    throw new Error('not implemented');
  }
  exchangeItems(targetItemDefId, materials) {
    throw new Error('not implemented');
  }
  consumeItem(itemId, quantity) {
    throw new Error('not implemented');
  }
  transferItemQuantity(itemIdSource, quantity, itemIdDest) {
    throw new Error('not implemented');
  }
  triggerItemDrop(itemDefId) {
    throw new Error('not implemented');
  }
  addPromoItem(itemDefId) {
    throw new Error('not implemented');
  }
  getItemDefinitionProperty(itemDefId, property) {
    throw new Error('not implemented');
  }
  getResultStatus(handle) {
    throw new Error('not implemented');
  }
  getResultItems(handle) {
    throw new Error('not implemented');
  }
  getResultTimestamp(handle) {
    throw new Error('not implemented');
  }
  checkResultSteamID(handle, steamIDExpected) {
    throw new Error('not implemented');
  }
  destroyResult(handle) {
    throw new Error('not implemented');
  }
  loadItemDefinitions() {
    throw new Error('not implemented');
  }
  on(event, listener) {
    throw new Error('not implemented');
  }
  /* eslint-enable no-unused-vars */
}

/** Structural check used by the conformance harness before it runs anything. */
function assertProviderShape(provider) {
  const required = [
    'getAllItems',
    'getItemsByID',
    'exchangeItems',
    'consumeItem',
    'transferItemQuantity',
    'triggerItemDrop',
    'addPromoItem',
    'getItemDefinitionProperty',
    'getResultStatus',
    'getResultItems',
    'getResultTimestamp',
    'checkResultSteamID',
    'destroyResult',
    'loadItemDefinitions',
    'on',
  ];
  const missing = required.filter(name => typeof provider[name] !== 'function');
  if (missing.length > 0) {
    throw new Error(`Provider is missing required method(s): ${missing.join(', ')}`);
  }
  return true;
}

module.exports = { InventoryProvider, assertProviderShape, CAPABILITIES };
