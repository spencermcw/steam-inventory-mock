'use strict';

/**
 * index.js
 *
 * Public surface of the mock Steam Inventory Service.
 *
 *   const { MockProvider } = require('./mock');           // async, Steam-shaped
 *   const { Engine }       = require('./mock');           // sync core, for the simulator
 *
 * Both sit on the same engine by construction, so the economy the balance
 * simulator validates is the economy the client plays.
 */

const { MockProvider } = require('./lib/provider');
const {
  Engine,
  RESULT,
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
  // Providers
  MockProvider,
  InventoryProvider,
  assertProviderShape,
  CAPABILITIES,

  // Engine core
  Engine,
  RESULT,
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
