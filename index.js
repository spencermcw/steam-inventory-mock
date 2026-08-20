'use strict';

/**
 * index.js
 *
 * Public surface of the mock Steam Inventory Service.
 *
 *   const { init }         = require('steam-inventory-mock');  // steamworks.js-shaped façade
 *   const { MockProvider } = require('steam-inventory-mock');  // the handle-based ISteamInventory
 *   const { Engine }       = require('steam-inventory-mock');  // the synchronous core
 *
 * All three sit on the same engine by construction. That matters if you drive
 * the Engine directly — a simulation over millions of operations, say — because
 * the economy it resolves is then the same one the client plays, rather than a
 * second implementation free to drift from it.
 */

const { MockProvider } = require('./lib/provider');
const { init, SteamCallback, EResult, SteamItemFlags, SteamInventoryError } = require('./lib/steamworks');
const {
  Engine,
  RESULT,
  ITEM_FLAGS,
  DEFAULT_OPTIONS,
  MAX_DROPS_PER_WINDOW,
  MAX_ITEMS_PER_UPDATE,
  k_SteamItemInstanceIDInvalid,
} = require('./lib/engine');
const { InventoryProvider, assertProviderShape, CAPABILITIES } = require('./lib/provider-interface');
const { loadSchema, Schema, ItemDef } = require('./lib/schema');
const { Account, ItemInstance } = require('./lib/inventory');
const { saveState, loadState, readSave, writeSave, SAVE_VERSION, SAVE_KIND } = require('./lib/persistence');
const { VirtualClock, RealClock, MS_PER_MINUTE } = require('./lib/clock');
const { Rng } = require('./lib/rng');
const { awaitResult, call, inventoryByDef } = require('./lib/await');
const grammar = require('./lib/grammar');
const properties = require('./lib/properties');
const exampleEconomy = require('./examples/economy');

module.exports = {
  /**
   * steamworks.js-shaped façade over MockProvider (see lib/steamworks.js):
   * namespaced free functions, promises, bigint item ids. The handle-based
   * MockProvider below is unchanged and remains the surface a real napi
   * binding maps onto — this is a second layer on top of it, not a
   * replacement.
   */
  init,
  SteamCallback,
  EResult,
  SteamItemFlags,
  SteamInventoryError,

  // Providers
  MockProvider,
  InventoryProvider,
  assertProviderShape,
  CAPABILITIES,

  // Engine core
  Engine,
  RESULT,
  /** SteamItemDetails_t::m_unFlags bits, as set on the handle-based provider's result rows. */
  ITEM_FLAGS,
  DEFAULT_OPTIONS,
  MAX_DROPS_PER_WINDOW,
  /** Valve: "up to 100 items for a user in each call" to SubmitUpdateProperties. */
  MAX_ITEMS_PER_UPDATE,
  /** Pass as TransferItemQuantity's destination to split rather than merge. */
  k_SteamItemInstanceIDInvalid,

  // Schema
  loadSchema,
  Schema,
  ItemDef,

  // State
  Account,
  ItemInstance,

  // Persistence (save/load; see lib/persistence.js)
  saveState,
  loadState,
  readSave,
  writeSave,
  SAVE_VERSION,
  SAVE_KIND,

  // Time and randomness
  VirtualClock,
  RealClock,
  MS_PER_MINUTE,
  Rng,

  // Promise adapters (tests, demos, simulator scripts)
  awaitResult,
  call,
  inventoryByDef,

  // Wire-format parsers
  grammar,

  /**
   * Dynamic item property values (see lib/properties.js). The namespace, not
   * flattened names: `properties.intProperty(1)` vs `properties.floatProperty(1)`
   * reads as the deliberate type choice it is, where a bare `intProperty` in a
   * client's import list does not.
   */
  properties,
  /** Valve: "a maximum of 1024 bytes of JSON per item at this time". */
  MAX_PROPERTY_BYTES: properties.MAX_PROPERTY_BYTES,

  // Example content
  exampleEconomy,
};
