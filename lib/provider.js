'use strict';

/**
 * provider.js
 *
 * MockProvider — Steam's async, handle-based inventory API (ISteamInventory)
 * over the local engine, standing in for the native binding so client code
 * can be written and tested against the real shape before it exists.
 * Swapping in a real SteamProvider is then meant to be a one-line change, not
 * a rewrite.
 *
 * Shape notes, all deliberate mirrors of real Steam:
 *   • Calls return an integer handle immediately and do the work later.
 *   • Results are delivered via the 'resultReady' event.
 *   • Results are read out of the handle (getResultStatus / getResultItems) and
 *     must be destroyed (destroyResult) — leaking them leaks memory on Steam,
 *     so we track leaks here rather than hiding the requirement.
 *   • Work executes at dispatch time, not at call time, so two operations issued
 *     back-to-back see each other's effects in issue order — as they would
 *     against a server.
 */

const { EventEmitter } = require('node:events');
const { Engine, RESULT } = require('./engine');
const { VirtualClock } = require('./clock');
const { InventoryProvider, CAPABILITIES } = require('./provider-interface');
const { saveState, loadState, readSave, writeSave } = require('./persistence');

// ─── MockProvider ─────────────────────────────────────────────────────────────

class MockProvider extends InventoryProvider {
  /**
   * @param {object} [options]
   * @param {string|object} [options.schema] path to a Steam itemdef JSON file,
   *   a parsed schema object, or a Schema instance
   * @param {number|string} [options.seed=0] RNG seed
   * @param {number} [options.latency=0] simulated round-trip in ms; 0 dispatches
   *   on a microtask (still asynchronous)
   * @param {string} [options.accountId='player']
   * @param {Engine} [options.engine] share an engine between providers to model
   *   several players against one economy
   * @param {boolean} [options.deferDefinitions=false] hold GetItemDefinitionIDs
   *   / GetItemDefinitionProperty back as empty/null until loadItemDefinitions()
   *   is called once. Real Steam downloads itemdefs asynchronously at startup;
   *   this library loads them synchronously at construction, which quietly
   *   hides a real client bug — code that reads definitions before they are
   *   ready. Set this to exercise that pre-load window against the mock.
   */
  constructor(options = {}) {
    super();
    const { engine, accountId = 'player', latency = 0, clock, deferDefinitions = false, ...engineOptions } = options;

    this.emitter = new EventEmitter();
    this.clock = clock || (engine ? engine.clock : new VirtualClock());
    this.engine = engine || new Engine({ ...engineOptions, clock: this.clock });
    this.account = this.engine.account(accountId);
    this.latency = latency;
    this._definitionsLoaded = !deferDefinitions;

    this._nextHandle = 1;
    this._results = new Map();
    this._pending = new Set();
    /** Populated by requestEligiblePromoItemDefinitionsIDs(); see that method. */
    this._eligiblePromoCache = null;
  }

  get capabilities() {
    // Spread the canonical flag list so a flag added to CAPABILITIES later
    // cannot be silently unadvertised here — MockProvider supports all of it.
    return {
      ...CAPABILITIES,
      virtualClock: true,
      customSchema: true,
      sandboxGrants: true,
      deterministicRng: true,
      failureReasons: true,
      gatingBypass: true,
      persistence: true,
      configurableSurplus: true,
      entitlements: true,
      promoGrantAll: true,
      dynamicProperties: true,
    };
  }

  // ── Events ──

  on(event, listener) {
    this.emitter.on(event, listener);
    return this;
  }

  once(event, listener) {
    this.emitter.once(event, listener);
    return this;
  }

  off(event, listener) {
    this.emitter.off(event, listener);
    return this;
  }

  // ── Dispatch ──

  /**
   * Allocate a handle and schedule `work` (which returns an engine result).
   * Nothing about the outcome is visible to the caller until 'resultReady'.
   */
  _dispatch(work) {
    const handle = this._nextHandle++;
    this._pending.add(handle);

    const run = () => {
      let result;
      try {
        result = work();
      } catch (err) {
        result = { status: RESULT.FAIL, ok: false, items: [], reason: err.message };
      }
      this._pending.delete(handle);
      this._results.set(handle, {
        handle,
        status: result.status,
        items: result.items || [],
        granted: result.granted,
        reason: result.reason || null,
        recipeIndex: result.recipeIndex,
        // GetResultTimestamp and CheckResultSteamID both describe the moment
        // the result was actually produced, so both are captured here — at
        // dispatch time, when `work` runs — rather than back in the call that
        // scheduled it. `this.account` can change (see load()) between the
        // call and the drain, so reading it here is what makes
        // CheckResultSteamID meaningful when several providers share an engine.
        timestampMs: this.clock.now(),
        accountId: this.account.id,
      });
      this.emitter.emit('resultReady', handle, result.status);

      // SteamInventoryFullUpdate_t. Steam raises this when the full inventory
      // has been refreshed, so a client can re-read rather than reconcile a
      // delta. Only successful results that actually touched items qualify —
      // a failed exchange changed nothing, and saying otherwise would train a
      // client to redraw on noise.
      if (result.status === RESULT.OK && Array.isArray(result.items) && result.items.length > 0) {
        this.emitter.emit('fullUpdate', handle);
      }
    };

    if (this.latency > 0) setTimeout(run, this.latency);
    else queueMicrotask(run);

    return handle;
  }

  // ── Inventory operations (all handle-based) ──

  getAllItems() {
    return this._dispatch(() => this.engine.getAllItems(this.account));
  }

  /** Subset of getAllItems by instance id; ids not held are simply absent. */
  getItemsByID(instanceIds) {
    return this._dispatch(() => this.engine.getItemsByID(this.account, instanceIds));
  }

  /**
   * @param {number} targetItemDefId the single itemdef to generate
   * @param {Array<{itemId:number, quantity:number}>|number[]} materials
   *   item *instance* ids (with quantities), as ExchangeItems takes on Steam
   */
  exchangeItems(targetItemDefId, materials) {
    return this._dispatch(() => this.engine.exchangeItems(this.account, targetItemDefId, materials));
  }

  consumeItem(itemId, quantity = 1) {
    return this._dispatch(() => this.engine.consumeItem(this.account, itemId, quantity));
  }

  /**
   * Split a quantity off `itemIdSource` into a new instance (pass
   * k_SteamItemInstanceIDInvalid, or nothing, as `itemIdDest`), or merge it
   * into an existing instance. A merge across differing per-item tags fails —
   * see Engine.transferItemQuantity.
   */
  transferItemQuantity(itemIdSource, quantity, itemIdDest) {
    return this._dispatch(() => this.engine.transferItemQuantity(this.account, itemIdSource, quantity, itemIdDest));
  }

  triggerItemDrop(itemDefId) {
    return this._dispatch(() => this.engine.triggerItemDrop(this.account, itemDefId));
  }

  addPromoItem(itemDefId) {
    return this._dispatch(() => this.engine.addPromoItem(this.account, itemDefId));
  }

  /** AddPromoItems: bulk addPromoItem by explicit itemdefid list — see Engine.addPromoItems for the skip-vs-fatal rule. */
  addPromoItems(itemDefIds) {
    return this._dispatch(() => this.engine.addPromoItems(this.account, itemDefIds));
  }

  /** GrantPromoItems: every eligible promo itemdef not marked granted_manually. */
  grantPromoItems() {
    return this._dispatch(() => this.engine.grantPromoItems(this.account));
  }

  /**
   * RequestEligiblePromoItemDefinitionsIDs. On real Steam this is backed by a
   * SteamAPICall_t and its own callback struct (SteamInventoryEligiblePromoItemDefIDs_t),
   * not the generic SteamInventoryResult_t/'resultReady' pair every other
   * inventory call above uses — so, deliberately, this does not go through
   * _dispatch/_results/getResultItems. It computes the answer, caches it for
   * getEligiblePromoItemDefinitionIDs to read back synchronously, and fires
   * its own 'eligiblePromoItemDefIDs' event with a payload shaped like that
   * struct. Still returns a handle, for symmetry with every other call and
   * because real Steam does too (just a SteamAPICall_t, not a result handle).
   *
   * `accountId` mirrors the CSteamID parameter the real call takes. This mock
   * provider is already scoped to one account (`this.account`), so it is not
   * used to select *which* account to compute for — it is only threaded
   * through onto the emitted event, matching what the real callback reports.
   */
  requestEligiblePromoItemDefinitionsIDs(accountId = this.account.id) {
    const handle = this._nextHandle++;
    const run = () => {
      const cachedData = this.engine.eligiblePromoItemDefinitionIDs(this.account);
      this._eligiblePromoCache = cachedData;
      this.emitter.emit('eligiblePromoItemDefIDs', { result: RESULT.OK, accountId, count: cachedData.length, cachedData });
    };
    if (this.latency > 0) setTimeout(run, this.latency);
    else queueMicrotask(run);
    return handle;
  }

  /**
   * GetEligiblePromoItemDefinitionIDs. Synchronous, and reads only the cache
   * the last requestEligiblePromoItemDefinitionsIDs() populated. Reading
   * before ever requesting returns an empty array rather than computing the
   * answer on demand — that is the trap real Steam sets (the Get call cannot
   * see anything the Request call has not yet delivered), and quietly
   * computing here instead would hide that trap rather than teach it.
   */
  getEligiblePromoItemDefinitionIDs(accountId = this.account.id) { // eslint-disable-line no-unused-vars
    return this._eligiblePromoCache || [];
  }

  // ── Dynamic item properties ──

  /**
   * StartUpdateProperties / SetProperty / RemoveProperty are synchronous and
   * return immediately, unlike every other call on this provider — because
   * they are synchronous on real Steam too. Valve's StartUpdateProperties
   * hands back a SteamInventoryUpdateHandle_t there and then, and the Set/
   * Remove calls return a bare bool; only SubmitUpdateProperties produces a
   * SteamInventoryResult_t and goes through the async result machinery.
   *
   * So the asynchrony rule this provider exists to enforce is not being bent
   * here: nothing observable about the *account* is available synchronously.
   * Staging edits touches no inventory state at all.
   */
  startUpdateProperties() {
    return this.engine.startUpdateProperties();
  }

  /** SetProperty with an inferred type; a whole number infers as int. */
  setProperty(handle, itemId, name, value) {
    return this.engine.setProperty(handle, itemId, name, value);
  }

  /** Valve's typed SetProperty overloads, which JS cannot express as overloads. */
  setPropertyString(handle, itemId, name, value) {
    return this.engine.setPropertyString(handle, itemId, name, value);
  }

  setPropertyInt(handle, itemId, name, value) {
    return this.engine.setPropertyInt(handle, itemId, name, value);
  }

  setPropertyBool(handle, itemId, name, value) {
    return this.engine.setPropertyBool(handle, itemId, name, value);
  }

  setPropertyFloat(handle, itemId, name, value) {
    return this.engine.setPropertyFloat(handle, itemId, name, value);
  }

  removeProperty(handle, itemId, name) {
    return this.engine.removeProperty(handle, itemId, name);
  }

  /** The one asynchronous call of the four — it is the one that reaches Steam. */
  submitUpdateProperties(handle) {
    return this._dispatch(() => this.engine.submitUpdateProperties(this.account, handle));
  }

  /** Mock-only diagnostics on a staged batch (why did SetProperty return false?). */
  describeUpdate(handle) {
    return this.engine.describeUpdate(handle);
  }

  /** Sandbox-only, like Steam's GenerateItems (apps in development). */
  generateItems(itemDefIds, quantities) {
    return this._dispatch(() => this.engine.generateItems(this.account, itemDefIds, quantities));
  }

  // ── Result access ──

  getResultStatus(handle) {
    const result = this._results.get(handle);
    return result ? result.status : null;
  }

  getResultItems(handle) {
    const result = this._results.get(handle);
    return result ? result.items : null;
  }

  /**
   * Mirrors GetResultItemProperty(handle, index, "tags") and, by the same
   * route, ("dynamic_props") — both are string-valued fields carried on the
   * result row itself (see ItemInstance.toResult), so this stays one generic
   * lookup rather than growing a special case per property name.
   */
  getResultItemProperty(handle, index, property) {
    const result = this._results.get(handle);
    if (!result || !result.items[index]) return null;
    const item = result.items[index];
    const value = item[property];
    return value == null ? null : String(value);
  }

  /** Mock-only diagnostics: real Steam gives you an EResult and nothing else. */
  getResultReason(handle) {
    const result = this._results.get(handle);
    return result ? result.reason : null;
  }

  /**
   * Mirrors GetResultTimestamp. Steam's is a uint32 Unix timestamp in
   * *seconds*; the virtual clock tracks milliseconds, so this converts down.
   * This is one of the few places the virtual clock becomes directly
   * observable through the Steam-shaped surface rather than through mock-only
   * helpers. An unknown handle returns 0, as an uninitialised uint32 would.
   */
  getResultTimestamp(handle) {
    const result = this._results.get(handle);
    return result ? Math.floor(result.timestampMs / 1000) : 0;
  }

  /**
   * Mirrors CheckResultSteamID. Real Steam compares against a CSteamID; this
   * library identifies accounts by an opaque string id (`accountId`, default
   * 'player') instead, since one Engine deliberately supports several
   * providers/accounts over one economy — so results genuinely can belong to
   * different accounts. Both sides go through String(...) so a caller passing
   * a numeric id still works. An unknown handle returns false.
   */
  checkResultSteamID(handle, steamIDExpected) {
    const result = this._results.get(handle);
    if (!result) return false;
    return String(result.accountId) === String(steamIDExpected);
  }

  destroyResult(handle) {
    return this._results.delete(handle);
  }

  /** Handles issued but never destroyed — on Steam these are a memory leak. */
  /**
   * Deprecated by Valve, and inert here. It survives because a client ported
   * from an older SDK will still call it, and a mock that threw on a call real
   * Steam merely ignores would send someone chasing a bug that does not exist.
   * Warns once so it does not become invisible either.
   */
  sendItemDropHeartbeat() {
    if (!this._heartbeatWarned) {
      this._heartbeatWarned = true;
      console.warn('sendItemDropHeartbeat() is deprecated by Valve and does nothing; playtime drops are driven by triggerItemDrop().');
    }
  }

  leakedResults() {
    return [...this._results.keys()];
  }

  // ── Item definitions (synchronous on Steam too) ──

  /**
   * Real Steam loads item definitions asynchronously at startup and fires
   * SteamInventoryDefinitionUpdate_t (no fields) when they land; until then
   * GetItemDefinitionIDs/GetItemDefinitionProperty have nothing to serve. This
   * library loads them synchronously at construction by default, which hides a
   * real client bug: code that reads definitions before they are ready. With
   * `deferDefinitions: true` this call is what makes them available, so a
   * client can be tested against that pre-load window.
   */
  loadItemDefinitions() {
    this._definitionsLoaded = true;
    this.emitter.emit('definitionUpdate');
    return true;
  }

  getItemDefinitionProperty(itemDefId, property) {
    if (!this._definitionsLoaded) return null;
    return this.engine.getItemDefinitionProperty(itemDefId, property);
  }

  getItemDefinitionIDs() {
    if (!this._definitionsLoaded) return [];
    return this.engine.schema.all().map(def => def.itemdefid);
  }

  // ── Persistence (mock-only; guard on capabilities.persistence) ──

  /**
   * The one call the Electron app makes: this player's whole state as plain
   * JSON — account, clock, RNG, instance-id watermark.
   *
   * Layering, deliberately: `Account.toJSON()` knows the account's own
   * collections and nothing else; `persistence.js` composes the account with
   * the engine-owned clock and RNG and stamps the version envelope; this method
   * is the one-call front door, because the app has a provider, not an engine.
   * Putting the composition on Account would have it reach up into the engine
   * for the clock; putting it only on the Engine would make the app find the
   * account id itself, and the simulator (which drives the Engine directly) can
   * still call `saveState(engine, { accountId })`.
   *
   * Result handles are not saved — see persistence.js.
   */
  save() {
    return saveState(this.engine, { accountId: this.account.id });
  }

  /**
   * Restore a save into this provider, replacing its account.
   *
   * @param {object} state output of save()
   * @param {object} [options] see persistence.loadState (onUnknownItemdef)
   */
  load(state, options = {}) {
    if (this._pending.size > 0) {
      throw new Error(`Cannot load while ${this._pending.size} operation(s) are in flight`);
    }
    const report = loadState(this.engine, state, { accountId: this.account.id, ...options });
    this.account = report.account;
    return report;
  }

  /** Convenience for the app: save straight to disk, atomically. */
  saveToFile(file) {
    const state = this.save();
    writeSave(file, state);
    return state;
  }

  loadFromFile(file, options = {}) {
    return this.load(readSave(file), options);
  }

  // ── Time control (mock-only; guard on capabilities.virtualClock) ──

  advanceTime(minutes, options) {
    this.clock.advance(minutes, options);
    return this;
  }
}

module.exports = { MockProvider };
