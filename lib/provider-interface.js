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
 *     addPromoItems(itemDefIds)         -> handle
 *     grantPromoItems()                 -> handle
 *     startUpdateProperties()           -> update handle, SYNCHRONOUS
 *     setProperty(uh, itemId, name, value)              -> bool, SYNCHRONOUS
 *     setPropertyString/Int/Bool/Float(uh, itemId, name, value) -> bool, SYNCHRONOUS
 *     removeProperty(uh, itemId, name)  -> bool, SYNCHRONOUS
 *     submitUpdateProperties(uh)        -> handle
 *     requestEligiblePromoItemDefinitionsIDs(accountId) -> handle, fires 'eligiblePromoItemDefIDs'
 *     getEligiblePromoItemDefinitionIDs(accountId)      -> itemdefid[], synchronous
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
 * The dynamic-property staging calls are the other synchronous ones, for the
 * same reason: Valve's StartUpdateProperties returns a handle immediately and
 * SetProperty/RemoveProperty return bool, because they only accumulate a batch
 * client-side. Nothing about the account is read or changed until
 * SubmitUpdateProperties, which is asynchronous like everything else.
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
   * `toolResultPolicy` can be selected. Valve's own documentation contradicts
   * itself on what a tag_tool leaves behind — docs/tools.html says a new item
   * is created, docs/accessories.html says the target is updated in place — so
   * this library implements both and lets the caller choose. Real Steam does
   * exactly one of the two and cannot be told which, so a SteamProvider
   * advertises this false and the tests pinning both readings skip there.
   */
  configurableToolResult: false,

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
  /**
   * AddPromoItems, GrantPromoItems, and the RequestEligiblePromoItemDefinitionsIDs
   * / GetEligiblePromoItemDefinitionIDs pair are implemented. Unlike every
   * other flag above, this is NOT a mock-only convenience — real Steam
   * supports all four calls, so a real SteamProvider should advertise this
   * true as well. The flag exists so a partial or older binding can decline
   * the ones it has not wired up yet, not to grant this mock license the real
   * API lacks.
   */
  promoGrantAll: false,
  /**
   * StartUpdateProperties / SetProperty / RemoveProperty /
   * SubmitUpdateProperties are implemented, and GetResultItemProperty serves
   * "dynamic_props". Like promoGrantAll and unlike the mock-only flags above,
   * this is NOT a mock convenience — real Steam supports dynamic item
   * properties, so a real SteamProvider should advertise this true as well.
   * The flag exists so a partial or older binding can decline what it has not
   * wired up yet, not to excuse the mock from matching Steam.
   *
   * What a real binding will additionally enforce and this cannot: the
   * partner-site property white-list (see the engine's `propertyWhitelist`
   * option), and Steam's per-user rate limit on property modification.
   */
  dynamicProperties: false,
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
  addPromoItems(itemDefIds) {
    throw new Error('not implemented');
  }
  grantPromoItems() {
    throw new Error('not implemented');
  }
  startUpdateProperties() {
    throw new Error('not implemented');
  }
  setProperty(updateHandle, itemId, propertyName, value) {
    throw new Error('not implemented');
  }
  setPropertyString(updateHandle, itemId, propertyName, value) {
    throw new Error('not implemented');
  }
  setPropertyInt(updateHandle, itemId, propertyName, value) {
    throw new Error('not implemented');
  }
  setPropertyBool(updateHandle, itemId, propertyName, value) {
    throw new Error('not implemented');
  }
  setPropertyFloat(updateHandle, itemId, propertyName, value) {
    throw new Error('not implemented');
  }
  removeProperty(updateHandle, itemId, propertyName) {
    throw new Error('not implemented');
  }
  submitUpdateProperties(updateHandle) {
    throw new Error('not implemented');
  }
  getResultItemProperty(handle, index, propertyName) {
    throw new Error('not implemented');
  }
  requestEligiblePromoItemDefinitionsIDs(accountId) {
    throw new Error('not implemented');
  }
  getEligiblePromoItemDefinitionIDs(accountId) {
    throw new Error('not implemented');
  }
  getItemDefinitionProperty(itemDefId, property) {
    throw new Error('not implemented');
  }
  sendItemDropHeartbeat() {
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
    'addPromoItems',
    'grantPromoItems',
    'startUpdateProperties',
    'setProperty',
    'removeProperty',
    'submitUpdateProperties',
    'getResultItemProperty',
    'requestEligiblePromoItemDefinitionsIDs',
    'getEligiblePromoItemDefinitionIDs',
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
