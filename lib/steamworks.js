'use strict';

/**
 * steamworks.js
 *
 * A steamworks.js-shaped façade over MockProvider.
 *
 *   const { init, SteamCallback } = require('steam-inventory-mock');
 *   const client = init({ schema: require('./itemdefs.json') });
 *   const items  = await client.inventory.getAllItems();
 *
 * Why a second surface at all. MockProvider is a faithful mirror of Valve's
 * ISteamInventory: every call returns an integer handle, results arrive on an
 * event, and results must be destroyed. That is what a napi binding maps onto
 * one-to-one and what the conformance suite drives, so it does not change and
 * this file does not replace it — it sits on top, and every call below goes
 * through the provider exactly as a client would.
 *
 * The shape is ceifa's steamworks.js (https://github.com/ceifa/steamworks.js),
 * which has no inventory namespace — there is nothing to copy method for
 * method, so what is matched is its *conventions*, taken from its `workshop`,
 * `cloud` and `apps` namespaces: namespaced free functions rather than
 * classes; a Promise wherever Steam needs a callback round-trip and a plain
 * synchronous return wherever Steam's own call is synchronous; camelCase
 * functions and PascalCase enum members with explicit numeric values; `bigint`
 * for 64-bit ids and `number` for 32-bit; `callback.register()` returning a
 * handle with `.disconnect()` rather than an EventEmitter; a top-level
 * `runCallbacks()` pump; and failures reported by rejecting, the way
 * `workshop.createItem()` reports an error.
 *
 * ⚠️ `client.mock` is a separate namespace on purpose. Everything under it is
 * something a real steamworks.js build could not do — travel in time, hand you
 * the account's state, arrange entitlements that are facts on a real account,
 * skip Steam's server-side gating. Keeping them out of `client.inventory`
 * means swapping in a real binding fails loudly on `client.mock.advanceTime`
 * instead of silently no-op'ing, which is the failure mode that turns "mock
 * first" into a rewrite. The same rule decides where anything new belongs: if
 * Valve ships it, `inventory`; if only this library can, `mock`.
 *
 * This layer adds no logic of its own. It converts ids, splits a delimited
 * string, parses a JSON blob, and turns a status code into a rejection —
 * nothing that could make the mock and the engine disagree about the economy.
 * Where behaviour is tempting here, it belongs in the engine instead.
 */

const { MockProvider } = require('./provider');
const { RESULT, k_SteamItemInstanceIDInvalid } = require('./engine');
const { awaitResult } = require('./await');

// ─── Enums ────────────────────────────────────────────────────────────────────

/**
 * Valve's EResult, restricted to the codes this library actually produces, with
 * Steam's real numeric values (k_EResultOK = 1, and so on). It mirrors RESULT
 * from engine.js — same numbers, steamworks.js's PascalCase member names — and
 * the unit suite asserts the two never drift apart.
 */
const EResult = Object.freeze({
  OK: 1,
  Fail: 2,
  InvalidParam: 8,
  InvalidState: 11,
  LimitExceeded: 25,
});

/**
 * The callbacks this library raises. steamworks.js numbers its SteamCallback
 * members sequentially from zero because they are napi enum indices; these
 * carry Valve's own k_iCallback ids (k_iSteamInventoryCallbacks = 4700) since
 * those are the real, stable numbers for exactly these four structs, and a
 * value that means something beats a value that only counts.
 *
 * Deliberately short: only what MockProvider emits. SteamInventoryStartPurchaseResult
 * and SteamInventoryRequestPricesResult are real callbacks this library has no
 * microtransaction support to raise, and listing them would advertise a wire
 * that is not connected.
 */
const SteamCallback = Object.freeze({
  SteamInventoryResultReady: 4700,
  SteamInventoryFullUpdate: 4701,
  SteamInventoryDefinitionUpdate: 4702,
  SteamInventoryEligiblePromoItemDefIDs: 4703,
});

/**
 * SteamItemDetails_t::m_unFlags, as Valve defines ESteamItemFlags.
 *
 * Only NoTrade is ever set here; see `flagsFor` for what the other two would
 * need and why this library cannot honestly claim to know it.
 */
const SteamItemFlags = Object.freeze({
  NoTrade: 1 << 0,
  ItemRemoved: 1 << 8,
  ItemConsumed: 1 << 9,
});

const RESULT_NAMES = new Map(Object.entries(EResult).map(([name, value]) => [value, name]));

// ─── Errors ───────────────────────────────────────────────────────────────────

/**
 * A non-OK result, raised as a rejection — steamworks.js reports failure by
 * rejecting (workshop.createItem), and a Promise that resolved with a status
 * code would leave every caller writing the `if (!ok)` this idiom exists to
 * delete.
 *
 * `.result` is the EResult, and is the part a real binding would also carry.
 * `.reason` is MockProvider's human-readable diagnostic, which real Steam does
 * not give you — it is always present here and always null against a real
 * binding, so treat it as debugging output, never as control flow.
 */
class SteamInventoryError extends Error {
  constructor(result, reason) {
    const label = RESULT_NAMES.get(result) || `EResult ${result}`;
    super(reason ? `${label}: ${reason}` : label);
    this.name = 'SteamInventoryError';
    this.result = result;
    this.reason = reason == null ? null : reason;
  }
}

// ─── The bigint boundary ──────────────────────────────────────────────────────

/**
 * Item instance ids are uint64 on Steam (SteamItemInstanceID_t), so they cross
 * this surface as `bigint` — steamworks.js does the same for publishedFileId.
 * Item *definition* ids stay plain numbers: SteamItemDef_t is an int32.
 *
 * The conversion happens here and nowhere else. Everything underneath — engine,
 * matching, persistence, every existing test — keeps JS numbers, because a
 * bigint does not survive JSON.stringify and a save file that cannot be
 * serialised is not a save file.
 *
 * Every argument that carries an instance id is routed through `itemIdIn` by
 * the call tables below rather than converted at the call site. That is the
 * point: `Number(5n)` is 5, so an unconverted path would work by accident until
 * the day it silently did not, and a boundary you have to remember to apply is
 * not a boundary.
 */
const MAX_SAFE_ITEM_ID = BigInt(Number.MAX_SAFE_INTEGER);

/** engine number → API bigint. */
function itemIdOut(itemId) {
  return BigInt(itemId);
}

/**
 * API bigint|number → engine number.
 *
 * Instance ids here are issued from 1 upward as JS numbers, so anything past
 * the safe-integer ceiling cannot be an id this library ever handed out.
 * Truncating it would turn a caller's typo into a lookup against some other
 * player's item, so it is refused instead.
 */
function itemIdIn(itemId) {
  if (typeof itemId === 'bigint') {
    if (itemId < 0n || itemId > MAX_SAFE_ITEM_ID) {
      throw new RangeError(
        `itemId ${itemId} is outside the range this mock can represent ` +
          `(instance ids are JS numbers, 0..${Number.MAX_SAFE_INTEGER})`
      );
    }
    return Number(itemId);
  }
  if (typeof itemId === 'number') {
    if (!Number.isSafeInteger(itemId) || itemId < 0) {
      throw new RangeError(`itemId ${itemId} is not a non-negative safe integer`);
    }
    return itemId;
  }
  throw new TypeError(`itemId must be a bigint or a number, got ${typeof itemId}`);
}

// ─── Argument coercion ────────────────────────────────────────────────────────

/** Anything that is not an instance id: itemdefids, quantities, names, values. */
const PASS = value => value;

const ITEM_ID = itemIdIn;

const ITEM_IDS = itemIds => (itemIds || []).map(itemIdIn);

/** ExchangeItems materials: `{ itemId, quantity }` entries or bare ids. */
const MATERIALS = entries =>
  (entries || []).map(entry =>
    entry !== null && typeof entry === 'object'
      ? { itemId: itemIdIn(entry.itemId), quantity: entry.quantity }
      : itemIdIn(entry)
  );

/**
 * TransferItemQuantity's destination, which is allowed to be absent.
 *
 * Valve's k_SteamItemInstanceIDInvalid is ~0 on a uint64, so a caller porting
 * that literal across hands us 18446744073709551615n — past the ceiling
 * `itemIdIn` refuses. It means "no destination, split into a new stack", not a
 * bad id, so it is folded onto the engine's sentinel here rather than thrown.
 * See `isNoDestination` in engine.js, which makes the same allowance.
 */
const ITEM_ID_DEST = itemIdDest => {
  if (itemIdDest == null) return k_SteamItemInstanceIDInvalid;
  if (typeof itemIdDest === 'bigint' && itemIdDest > MAX_SAFE_ITEM_ID) return k_SteamItemInstanceIDInvalid;
  return itemIdIn(itemIdDest);
};

function coerce(spec, args) {
  return spec.map((convert, index) => convert(args[index]));
}

// ─── Call tables ──────────────────────────────────────────────────────────────

/**
 * The inventory namespace is generated from these two tables rather than
 * written out method by method, so that every id-carrying argument passes
 * through the converters above by construction — a hand-written surface only
 * needs one forgotten call site to leak a bigint into the engine.
 *
 * The keys are MockProvider method names, which is also the thing the unit
 * suite reflects over: the façade cannot grow a call Steam does not have,
 * because a name that is not on the provider is not a name the loop can bind.
 *
 * Each value is the per-argument coercion list, positionally. A trailing
 * argument the caller omitted arrives as undefined and the provider's own
 * default applies, exactly as if it had been called directly.
 */

/** Handle-based on Steam, so Promise-returning here. Each resolves to InventoryItem[]. */
const ASYNC_CALLS = {
  getAllItems: [],
  getItemsByID: [ITEM_IDS],
  exchangeItems: [PASS /* targetItemDefId */, MATERIALS],
  consumeItem: [ITEM_ID, PASS /* quantity */],
  transferItemQuantity: [ITEM_ID, PASS /* quantity */, ITEM_ID_DEST],
  triggerItemDrop: [PASS /* itemDefId */],
  addPromoItem: [PASS /* itemDefId */],
  addPromoItems: [PASS /* itemDefIds */],
  grantPromoItems: [],
  /**
   * GenerateItems is sandbox-only — Steam refuses it outside an app in
   * development — but it is genuine ISteamInventory, not a mock affordance, so
   * it belongs here and not in `client.mock`. A real binding exposes it too and
   * fails the call on a released app, which is the honest outcome; hiding it in
   * the mock namespace would say Valve does not ship it.
   */
  generateItems: [PASS /* itemDefIds */, PASS /* quantities */],
  submitUpdateProperties: [PASS /* updateHandle */],
};

/**
 * Synchronous on Steam, so synchronous here. steamworks.js draws the same line
 * — cloud.readFile(), apps.isDlcInstalled() and workshop.state() are plain
 * returns because the answer is already in a local cache.
 *
 * Update handles (SteamInventoryUpdateHandle_t) stay plain numbers rather than
 * bigint: they are opaque, process-local, never serialised and never an item
 * id, so widening them would add a conversion with no consumer on either side.
 */
const SYNC_CALLS = {
  getItemDefinitionIDs: [],
  getItemDefinitionProperty: [PASS /* itemDefId */, PASS /* propertyName, may be null */],
  loadItemDefinitions: [],
  startUpdateProperties: [],
  setProperty: [PASS /* updateHandle */, ITEM_ID, PASS /* propertyName */, PASS /* value */],
  setPropertyString: [PASS, ITEM_ID, PASS, PASS],
  setPropertyInt: [PASS, ITEM_ID, PASS, PASS],
  setPropertyBool: [PASS, ITEM_ID, PASS, PASS],
  setPropertyFloat: [PASS, ITEM_ID, PASS, PASS],
  removeProperty: [PASS /* updateHandle */, ITEM_ID, PASS /* propertyName */],
  getEligiblePromoItemDefinitionIDs: [PASS /* accountId, may be null */],
  sendItemDropHeartbeat: [],
};

// ─── Result mapping ───────────────────────────────────────────────────────────

/**
 * `tags` arrives from the provider as Steam's ";"-delimited "key:value" string.
 * steamworks.js would hand back an array — WorkshopItem.tags is Array<string> —
 * so it is split here. An item with no tags gives [], never [''].
 */
function parseTags(text) {
  if (!text) return [];
  return String(text)
    .split(';')
    .filter(token => token.length > 0);
}

/** `dynamic_props` is the JSON string Valve documents; callers want the values. */
function parseDynamicProps(json) {
  if (!json) return {};
  return JSON.parse(json);
}

/**
 * SteamItemDetails_t::m_unFlags.
 *
 * NoTrade is knowable: it is the itemdef's `tradable` field, read back through
 * GetItemDefinitionProperty — the same call a real client would use, so this
 * agrees with a real binding rather than reaching into the schema behind it.
 * An itemdef that does not say `tradable` is not tradable, which is Valve's
 * default and the schema's.
 *
 * ItemRemoved and ItemConsumed are NOT populated, and report 0 rather than a
 * guess. Valve sets them on rows in a result set to say why that row is there,
 * and this library's result rows carry no such provenance: a row at quantity 0
 * could be a consumed stack, a stack spent as exchange material, or the source
 * of a split that emptied — three different flags, one indistinguishable row.
 * Inferring one would be wrong for the other two, and a client that learned to
 * branch on a fabricated flag here would branch wrongly against real Steam,
 * which is the exact failure this whole library exists to prevent. Populating
 * them honestly needs the engine to report why each row changed; that is an
 * engine change, not a translation, so it does not happen in this file.
 */
function flagsFor(provider, row) {
  let flags = 0;
  const tradable = provider.getItemDefinitionProperty(row.itemdefid, 'tradable');
  // null means the definitions are not loaded yet (see `deferDefinitions`) or
  // the itemdef is unknown — both are "cannot know", which reports nothing.
  if (tradable != null) {
    const text = String(tradable).trim().toLowerCase();
    if (text !== 'true' && text !== '1') flags |= SteamItemFlags.NoTrade;
  }
  return flags;
}

/** SteamItemDetails_t plus the two string-valued extras, in this idiom's types. */
function toInventoryItem(provider, row) {
  return {
    itemId: itemIdOut(row.itemId),
    itemDefId: row.itemdefid,
    quantity: row.quantity,
    flags: flagsFor(provider, row),
    tags: parseTags(row.tags),
    dynamicProps: parseDynamicProps(row.dynamic_props),
  };
}

// ─── Callback table ───────────────────────────────────────────────────────────

/**
 * Each entry maps a SteamCallback onto the provider event that stands for it,
 * plus the struct Valve delivers — steamworks.js hands the callback struct to
 * the handler, so the provider's positional event arguments are reassembled
 * into one object here.
 */
const CALLBACKS = {
  [SteamCallback.SteamInventoryResultReady]: {
    event: 'resultReady',
    /** SteamInventoryResultReady_t { m_handle, m_result }. */
    struct: (handle, result) => ({ handle, result }),
  },
  [SteamCallback.SteamInventoryFullUpdate]: {
    event: 'fullUpdate',
    /** SteamInventoryFullUpdate_t { m_handle }. */
    struct: handle => ({ handle }),
  },
  [SteamCallback.SteamInventoryDefinitionUpdate]: {
    event: 'definitionUpdate',
    /** SteamInventoryDefinitionUpdate_t — Valve defines no fields. */
    struct: () => ({}),
  },
  [SteamCallback.SteamInventoryEligiblePromoItemDefIDs]: {
    event: 'eligiblePromoItemDefIDs',
    /** The provider already emits this one struct-shaped; itemdefids stay numbers. */
    struct: payload => payload,
  },
};

// ─── init ─────────────────────────────────────────────────────────────────────

/**
 * @param {object} [options] passed straight to MockProvider (schema, seed,
 *   latency, accountId, engine, deferDefinitions, and the engine options).
 */
function init(options = {}) {
  const provider = new MockProvider(options);

  /**
   * The one lifecycle rule this façade takes over from its caller: a result
   * handle must be destroyed, or it leaks on real Steam. awaitResult() destroys
   * on the way out whether the status was OK or not, so the rejection path
   * below is reading an already-collected result — which is why a batch of
   * failing calls leaves `mock.leakedResults()` as empty as a batch of
   * successful ones, and why the unit suite checks both.
   */
  async function invoke(method, spec, args) {
    const handle = provider[method](...coerce(spec, args));
    const result = await awaitResult(provider, handle);
    if (!result.ok) throw new SteamInventoryError(result.status, result.reason);
    return result.items.map(row => toInventoryItem(provider, row));
  }

  const inventory = {};
  for (const [method, spec] of Object.entries(ASYNC_CALLS)) {
    inventory[method] = (...args) => invoke(method, spec, args);
  }
  for (const [method, spec] of Object.entries(SYNC_CALLS)) {
    inventory[method] = (...args) => provider[method](...coerce(spec, args));
  }

  /**
   * RequestEligiblePromoItemDefinitionsIDs is the one place Steam's
   * request/callback split is collapsed into a single call. On Steam it returns
   * a SteamAPICall_t and the ids arrive later on
   * SteamInventoryEligiblePromoItemDefIDs_t, after which
   * GetEligiblePromoItemDefinitionIDs can read them back — and a Promise is
   * precisely what that split means in this idiom, so resolving with the ids is
   * a translation of the pattern rather than a shortcut around it. The
   * synchronous Get call is still exposed above, with its real trap intact: it
   * sees nothing until a request has delivered.
   *
   * @param {string|number|null} [accountId] mirrors the call's CSteamID.
   * @returns {Promise<number[]>} eligible itemdefids (SteamItemDef_t: numbers).
   */
  inventory.requestEligiblePromoItemDefinitionsIDs = accountId =>
    new Promise((resolve, reject) => {
      const onReady = payload => {
        provider.off('eligiblePromoItemDefIDs', onReady);
        if (payload.result !== RESULT.OK) {
          reject(new SteamInventoryError(payload.result, null));
          return;
        }
        resolve(payload.cachedData);
      };
      provider.on('eligiblePromoItemDefIDs', onReady);
      provider.requestEligiblePromoItemDefinitionsIDs(accountId);
    });

  // ── callback ──

  const callback = {
    /**
     * @param {number} steamCallback a SteamCallback member
     * @param {(struct: object) => void} handler
     * @returns {{disconnect: () => void}}
     */
    register(steamCallback, handler) {
      const entry = CALLBACKS[steamCallback];
      // Throwing beats returning a handle that can never fire: a listener that
      // is silently never called looks exactly like a game that never raises
      // the event, and that is a day of debugging over a typo.
      if (!entry) {
        throw new Error(
          `Unknown SteamCallback ${steamCallback} (known: ${Object.keys(SteamCallback).join(', ')})`
        );
      }
      const listener = (...args) => handler(entry.struct(...args));
      provider.on(entry.event, listener);
      return {
        disconnect() {
          provider.off(entry.event, listener);
        },
      };
    },
  };

  // ── mock ──

  const mock = {
    /** @param {number} minutes @param {{playing?: boolean}} [options] */
    advanceTime(minutes, options) {
      provider.advanceTime(minutes, options);
      return client;
    },
    save() {
      return provider.save();
    },
    load(state, options) {
      return provider.load(state, options);
    },
    saveToFile(file) {
      return provider.saveToFile(file);
    },
    loadFromFile(file, options) {
      return provider.loadFromFile(file, options);
    },
    /** Handles issued and never destroyed. The façade owns that lifecycle, so
     *  this should stay empty for the life of a client; if it does not, a path
     *  in this file stopped going through `invoke`. */
    leakedResults() {
      return provider.leakedResults();
    },
    /**
     * The Steam-side facts promo rules read. On a real account these are not
     * test setup, which is the whole reason this namespace exists.
     */
    setEntitlements({ ownsApps = [], achievements = [], playtime = {} } = {}) {
      for (const appid of ownsApps) provider.account.ownedApps.add(Number(appid));
      for (const name of achievements) provider.account.achievements.add(name);
      for (const [appid, minutes] of Object.entries(playtime)) {
        provider.account.playtimeByApp.set(Number(appid), minutes);
      }
      return client;
    },
    /**
     * Skip the server-side drop_interval / drop_limit / drop window checks.
     * Returns the previous setting so a test can put it back. Real Steam
     * enforces these itself and offers no override.
     */
    bypassDropGating(enabled = true) {
      const previous = provider.engine.options.bypassDropGating;
      provider.engine.options.bypassDropGating = enabled;
      return previous;
    },
    /** Sibling of the above for promo recurrence; entitlements still apply. */
    bypassPromoGating(enabled = true) {
      const previous = provider.engine.options.bypassPromoGating;
      provider.engine.options.bypassPromoGating = enabled;
      return previous;
    },
    /**
     * Why did setProperty() return false? Real Steam gives a bare bool and no
     * explanation, so this is mock-only diagnostics and belongs on this side of
     * the line even though its subject — a staged property batch — does not.
     */
    describeUpdate(updateHandle) {
      return provider.describeUpdate(updateHandle);
    },
    /** Escape hatches: the handle-based provider and the synchronous engine. */
    provider,
    engine: provider.engine,
  };

  /**
   * steamworks.js requires the host to pump callbacks from its own loop, so the
   * function exists here for shape parity — a host loop written against
   * steamworks.js keeps working unchanged.
   *
   * It is not necessary. Work is dispatched on a microtask (or on a timer, with
   * `latency`), so anything pending lands on its own as soon as the caller
   * yields; there is no queue this could pump that the runtime is not already
   * pumping. What it does honestly do is wait for that to have happened, which
   * is why it returns a Promise where steamworks.js returns void: awaiting it
   * means "let everything in flight land", and ignoring the return value costs
   * nothing, because the same work lands either way. The timer is scheduled at
   * the provider's own latency so it queues behind every dispatch already
   * pending at the moment of the call.
   */
  function runCallbacks() {
    return new Promise(resolve => setTimeout(resolve, provider.latency));
  }

  const client = {
    inventory: Object.freeze(inventory),
    callback: Object.freeze(callback),
    mock: Object.freeze(mock),
    runCallbacks,
  };
  return Object.freeze(client);
}

module.exports = {
  init,
  SteamCallback,
  EResult,
  SteamItemFlags,
  SteamInventoryError,
  // Exported for the unit suite, which asserts the generated surface matches
  // MockProvider — not part of the public API.
  ASYNC_CALLS,
  SYNC_CALLS,
};
