/**
 * client.d.ts
 *
 * Hand-written TypeScript declarations for steam-inventory-mock.
 *
 * The filename and the style below deliberately match ceifa's steamworks.js
 * (https://github.com/ceifa/steamworks.js), whose own `client.d.ts` this is
 * modelled on: namespaced free functions, no semicolons, `export const enum`
 * with explicit numeric values, PascalCase enum members, camelCase functions,
 * `bigint` for 64-bit ids and `number` for 32-bit. steamworks.js ships no
 * `inventory` namespace at all — see its open, unimplemented issues for one —
 * so there is nothing to copy method-for-method; what is matched is the
 * *convention*, so that this file could serve directly as the basis of that
 * missing namespace upstream.
 *
 * One structural difference from steamworks.js is not cosmetic: steamworks.js
 * calls a single global `init()` once and hangs `workshop`/`cloud`/`apps` off
 * the module itself, because one process talks to one running Steam client.
 * This library's `init()` can be called more than once, each time wrapping a
 * fresh, independent MockProvider (several accounts over one economy, or
 * several unrelated economies in one test run) — so `inventory`, `callback`
 * and `mock` below are namespaces in *shape* only, used to type the object
 * `init()` returns. They are not themselves exported from the module, and
 * intentionally so: exporting names nothing imports at runtime would be a
 * declaration that lies.
 */

// ════════════════════════════════════════════════════════════════════════════
// init()
// ════════════════════════════════════════════════════════════════════════════

/** App-level Playtime Item Grants settings (Steamworks → Inventory Service). */
export interface AppDropSettings {
  dropInterval: number
  useDropWindow: boolean
  dropWindow: number
  dropMaxPerWindow: number
  useDropLimit: boolean
  dropLimit: number
}

/**
 * One entry in the partner-site dynamic-property white-list. `null` at the
 * option level (see `EngineOptions.propertyWhitelist`) means "anything is
 * allowed", which is the permissive default this library ships with — a
 * client written against it can still be refused by real Steam.
 */
export interface PropertyWhitelistEntry {
  name: string
  type?: 'string' | 'int' | 'bool' | 'float'
  requiredTag?: string
}

/** Steam wire-format itemdef: whatever fields the schema author put in it. */
export type ItemDefRaw = Record<string, unknown>

/** The parsed shape of a Steam itemdefs.json file, or its in-memory equivalent. */
export interface SchemaSource {
  appid?: number | null
  items: ItemDefRaw[]
}

/** Account ids and appids here are opaque keys — usually strings, but never assumed to be. */
export type AccountId = string | number

/** Options accepted by the `Engine` core (see lib/engine.js DEFAULT_OPTIONS). */
export interface EngineOptions {
  /** Path to a Steam itemdef JSON file, a parsed `{ appid, items }` object, a bare item array, or a `Schema` instance. */
  schema?: string | SchemaSource | ItemDefRaw[] | Schema
  seed?: number | string
  clock?: VirtualClock | RealClock
  /**
   * UNVERIFIED against real Steam. What happens to ExchangeItems materials
   * offered beyond what the winning recipe requires.
   *   'consume' (default) — consume everything passed (Valve's own wording)
   *   'ignore'            — consume only what the recipe calls for
   *   'strict'            — reject the call
   */
  surplusPolicy?: 'consume' | 'ignore' | 'strict'
  /** UNVERIFIED. Whether playtime beyond drop_interval banks toward the next drop. Default false. */
  bankPlaytime?: boolean
  /**
   * UNVERIFIED, and here Valve's own docs disagree with themselves: what a
   * tag_tool application leaves behind. docs/tools.html says a fresh instance
   * is issued; docs/accessories.html says the target is rewritten in place.
   * Both are implemented; 'new-instance' (default) is the more explicit
   * wording. Under 'new-instance' the target's instance id dies with the call.
   */
  toolResultPolicy?: 'new-instance' | 'mutate'
  appDropSettings?: Partial<AppDropSettings>
  /** Guard against a bundle cycle the schema validator cannot see statically. Default 24. */
  maxExpansionDepth?: number
  /** Test-mode only: skip drop_interval / drop_limit / drop_max_per_window checks. Default false. */
  bypassDropGating?: boolean
  /** Test-mode only: skip the once-per-account and recurrence waits on promos. Default false. */
  bypassPromoGating?: boolean
  /** `null` (default) permits every dynamic property name; see PropertyWhitelistEntry. */
  propertyWhitelist?: PropertyWhitelistEntry[] | null
}

/** Options accepted by `MockProvider` (a superset of `EngineOptions`). */
export interface MockProviderOptions extends EngineOptions {
  /** Share an engine between providers to model several players over one economy. */
  engine?: Engine
  accountId?: AccountId
  /** Simulated round-trip in ms; 0 (default) still dispatches on a microtask. */
  latency?: number
  /**
   * Hold GetItemDefinitionIDs / GetItemDefinitionProperty back as empty/null
   * until loadItemDefinitions() is called once, modelling Steam's real
   * async-download startup window. Default false.
   */
  deferDefinitions?: boolean
}

/** Options accepted by `init()` — passed straight through to `MockProvider`. */
export type InitOptions = MockProviderOptions

export interface AdvanceTimeOptions {
  /** Whether playtime accrues too. Default true. */
  playing?: boolean
}

/** ExchangeItems materials at the façade boundary: bare ids or `{itemId, quantity}` entries. */
export type ExchangeMaterial = (bigint | number) | { itemId: bigint | number; quantity: number }

// ── inventory ──────────────────────────────────────────────────────────────

/**
 * Not exported from the module — see the file header. Used only to type
 * `SteamClient.inventory` via `typeof`.
 */
/**
 * NOT a module export. This describes the shape of `client.inventory`, reached through
 * `init()`. Unlike steamworks.js — where these namespaces really are module
 * exports because there is one global client — `init()` here can be called more
 * than once, so the namespaces hang off the returned client rather than off the
 * module. Importing this name directly resolves to `undefined` at runtime.
 */
declare namespace inventory {
  /**
   * SteamItemDetails_t plus the two string-valued extras GetResultItemProperty
   * serves ("tags", "dynamic_props"), decoded into this idiom's types.
   */
  export interface InventoryItem {
    itemId: bigint
    itemDefId: number
    quantity: number
    /**
     * SteamItemDetails_t::m_unFlags, from two places. ItemRemoved and
     * ItemConsumed arrive already set on the row — the engine records *why* a
     * row is in this result set (consumed, spent as exchange material,
     * destroyed by a tag tool, emptied by a split) at the moment it happens,
     * since a row at quantity 0 alone cannot say which. NoTrade is computed
     * here instead, from the itemdef's `tradable` field — it is a fact about
     * the *definition*, not the operation. Never set for a trade or an
     * expiry: neither is modelled anywhere in this library.
     */
    flags: number
    tags: string[]
    dynamicProps: Record<string, string | number | boolean>
  }

  export function getAllItems(): Promise<InventoryItem[]>
  export function getItemsByID(itemIds: ReadonlyArray<bigint | number>): Promise<InventoryItem[]>
  export function exchangeItems(targetItemDefId: number, materials: ReadonlyArray<ExchangeMaterial>): Promise<InventoryItem[]>
  export function consumeItem(itemId: bigint | number, quantity?: number): Promise<InventoryItem[]>
  export function transferItemQuantity(
    itemIdSource: bigint | number,
    quantity: number,
    itemIdDest?: bigint | number | null
  ): Promise<InventoryItem[]>
  export function triggerItemDrop(itemDefId: number): Promise<InventoryItem[]>
  export function addPromoItem(itemDefId: number): Promise<InventoryItem[]>
  export function addPromoItems(itemDefIds: ReadonlyArray<number>): Promise<InventoryItem[]>
  export function grantPromoItems(): Promise<InventoryItem[]>
  /** Sandbox-only on real Steam — refused outside an app in development. */
  export function generateItems(
    itemDefIds: number | ReadonlyArray<number>,
    quantities?: ReadonlyArray<number>
  ): Promise<InventoryItem[]>
  export function submitUpdateProperties(updateHandle: number): Promise<InventoryItem[]>

  export function getItemDefinitionIDs(): number[]
  export function getItemDefinitionProperty(itemDefId: number, propertyName?: string | null): string | null
  export function loadItemDefinitions(): boolean
  export function startUpdateProperties(): number
  export function setProperty(
    updateHandle: number,
    itemId: bigint | number,
    propertyName: string,
    value: string | number | boolean
  ): boolean
  export function setPropertyString(updateHandle: number, itemId: bigint | number, propertyName: string, value: string): boolean
  export function setPropertyInt(updateHandle: number, itemId: bigint | number, propertyName: string, value: number): boolean
  export function setPropertyBool(updateHandle: number, itemId: bigint | number, propertyName: string, value: boolean): boolean
  export function setPropertyFloat(updateHandle: number, itemId: bigint | number, propertyName: string, value: number): boolean
  export function removeProperty(updateHandle: number, itemId: bigint | number, propertyName: string): boolean
  /**
   * GetEligiblePromoItemDefinitionIDs. Reads only the cache the last
   * `requestEligiblePromoItemDefinitionsIDs()` populated: calling this before
   * ever requesting returns `[]`, not the true answer. That is Steam's own
   * trap — the Get call cannot see anything the Request call has not yet
   * delivered — reproduced here rather than papered over.
   */
  export function getEligiblePromoItemDefinitionIDs(accountId?: AccountId | null): number[]
  /**
   * The one place Steam's request/callback split collapses into a single
   * call: resolves with the eligible itemdefids once
   * SteamInventoryEligiblePromoItemDefIDs_t would have fired. The synchronous
   * `getEligiblePromoItemDefinitionIDs` above still has its real trap intact.
   */
  export function requestEligiblePromoItemDefinitionsIDs(accountId?: AccountId | null): Promise<number[]>
  /** Deprecated by Valve and a no-op here; kept for source compatibility. */
  export function sendItemDropHeartbeat(): void
}

// ── callback ──────────────────────────────────────────────────────────────

/** SteamInventoryResultReady_t { m_handle, m_result } */
export interface SteamInventoryResultReady_t {
  handle: number
  result: EResult
}

/** SteamInventoryFullUpdate_t { m_handle } */
export interface SteamInventoryFullUpdate_t {
  handle: number
}

/** SteamInventoryDefinitionUpdate_t — Valve defines no fields. */
export interface SteamInventoryDefinitionUpdate_t {}

/** SteamInventoryEligiblePromoItemDefIDs_t, as this library shapes it. */
export interface SteamInventoryEligiblePromoItemDefIDs_t {
  result: EResult
  accountId: AccountId
  count: number
  cachedData: number[]
}

/** Maps each `SteamCallback` member to the struct `callback.register()` hands its handler. */
export interface CallbackReturns {
  4700: SteamInventoryResultReady_t
  4701: SteamInventoryFullUpdate_t
  4702: SteamInventoryDefinitionUpdate_t
  4703: SteamInventoryEligiblePromoItemDefIDs_t
}

/**
 * Not exported from the module — see the file header. Used only to type
 * `SteamClient.callback` via `typeof`.
 */
/**
 * NOT a module export. This describes the shape of `client.callback`, reached through
 * `init()`. Unlike steamworks.js — where these namespaces really are module
 * exports because there is one global client — `init()` here can be called more
 * than once, so the namespaces hang off the returned client rather than off the
 * module. Importing this name directly resolves to `undefined` at runtime.
 */
declare namespace callback {
  export function register<C extends keyof CallbackReturns>(
    steamCallback: C,
    handler: (value: CallbackReturns[C]) => void
  ): Handle
  export class Handle {
    disconnect(): void
  }
}

// ── mock ──────────────────────────────────────────────────────────────────

export interface Entitlements {
  ownsApps?: ReadonlyArray<AccountId>
  achievements?: ReadonlyArray<string>
  playtime?: Record<string, number>
}

export interface UpdateDescription {
  handle: number
  itemCount: number
  editCount: number
  lastError: string | null
}

/**
 * Not exported from the module — see the file header. Used only to type
 * `SteamClient.mock` via `typeof`.
 *
 * Every member here has NO counterpart in a real steamworks.js binding: time
 * travel, entitlement staging, save/load, and skipping Steam's own
 * server-side gating checks. Swap in a real binding and every one of these
 * fails loudly (`client.mock` does not exist) rather than silently doing
 * nothing — the whole reason this is a separate namespace from `inventory`.
 */
/**
 * NOT a module export. This describes the shape of `client.mock`, reached through
 * `init()`. Unlike steamworks.js — where these namespaces really are module
 * exports because there is one global client — `init()` here can be called more
 * than once, so the namespaces hang off the returned client rather than off the
 * module. Importing this name directly resolves to `undefined` at runtime.
 */
declare namespace mock {
  export function advanceTime(minutes: number, options?: AdvanceTimeOptions): SteamClient
  export function save(): SaveState
  export function load(state: SaveState, options?: LoadOptions): LoadReport
  export function saveToFile(file: string): SaveState
  export function loadFromFile(file: string, options?: LoadOptions): LoadReport
  /** Handles issued and never destroyed. Should stay empty for the client's whole life. */
  export function leakedResults(): number[]
  /** Steam-side facts promo rules read; on a real account these are not test setup. */
  export function setEntitlements(entitlements?: Entitlements): SteamClient
  /** Skips drop_interval / drop_limit / drop_max_per_window checks. Returns the previous setting. */
  export function bypassDropGating(enabled?: boolean): boolean
  /** Sibling of bypassDropGating for promo recurrence; entitlements still apply. */
  export function bypassPromoGating(enabled?: boolean): boolean
  /** Why did setProperty() return false? Mock-only diagnostics on a staged batch. */
  export function describeUpdate(updateHandle: number): UpdateDescription | null
  /** Escape hatch: the handle-based provider underneath this façade. */
  export const provider: MockProvider
  /** Escape hatch: the synchronous engine underneath the provider. */
  export const engine: Engine
}

// ── The client object ────────────────────────────────────────────────────

export interface SteamClient {
  readonly inventory: typeof inventory
  readonly callback: typeof callback
  readonly mock: typeof mock
  /**
   * Present for shape parity with steamworks.js's host-driven callback pump.
   * Unnecessary here — work already lands on the next microtask (or after
   * `latency` ms) without being pumped — but awaiting it is a safe way to say
   * "let everything currently in flight land."
   */
  runCallbacks(): Promise<void>
}

export declare function init(options?: InitOptions): SteamClient

// ════════════════════════════════════════════════════════════════════════════
// Enums, errors
// ════════════════════════════════════════════════════════════════════════════

/**
 * Valve's EResult, restricted to the codes this library actually produces,
 * with Steam's real numeric values (k_EResultOK = 1, and so on).
 */
export const enum EResult {
  OK = 1,
  Fail = 2,
  InvalidParam = 8,
  InvalidState = 11,
  LimitExceeded = 25,
}

/**
 * The callbacks this library raises, numbered with Valve's real k_iCallback
 * ids (k_iSteamInventoryCallbacks = 4700) rather than sequential napi
 * indices. Deliberately short: SteamInventoryStartPurchaseResult and
 * SteamInventoryRequestPricesResult are real Steam callbacks this library has
 * no microtransaction support to raise.
 */
export const enum SteamCallback {
  SteamInventoryResultReady = 4700,
  SteamInventoryFullUpdate = 4701,
  SteamInventoryDefinitionUpdate = 4702,
  SteamInventoryEligiblePromoItemDefIDs = 4703,
}

/**
 * SteamItemDetails_t::m_unFlags. All three are populated — see
 * `inventory.InventoryItem.flags` for which of NoTrade / ItemRemoved /
 * ItemConsumed comes from where, and the one case (trading, item expiry —
 * neither modelled here) that never sets ItemRemoved.
 */
export const enum SteamItemFlags {
  NoTrade = 1,
  ItemRemoved = 256,
  ItemConsumed = 512,
}

/**
 * A non-OK result, raised as a rejection — steamworks.js reports failure by
 * rejecting (workshop.createItem), not by resolving with a status code.
 *
 * `reason` is MockProvider's human-readable diagnostic, which real Steam does
 * not give you: always present here, always `null` against a real binding.
 */
export declare class SteamInventoryError extends Error {
  readonly result: EResult
  readonly reason: string | null
  constructor(result: EResult, reason?: string | null)
}

// ════════════════════════════════════════════════════════════════════════════
// Providers
// ════════════════════════════════════════════════════════════════════════════

/** ExchangeItems materials at the handle-based provider/engine boundary: plain numbers only. */
export type RawExchangeMaterial = number | { itemId: number; quantity: number }

/**
 * The row shape carried on a result set (SteamItemDetails_t plus the two
 * string-valued extras GetResultItemProperty serves). This is the pre-bigint
 * shape the handle-based provider hands back; the steamworks.js façade (see
 * `inventory.InventoryItem`) decodes it further and ORs in NoTrade.
 */
export interface ResultItemRow {
  itemId: number
  itemdefid: number
  quantity: number
  /**
   * ESteamItemFlags bits the engine can know at the point it emptied, spent,
   * or destroyed this instance (ItemRemoved / ItemConsumed) — 0 for a plain
   * read (GetAllItems, GetItemsByID). NoTrade is never set here: it is a
   * property of the item definition, added by the steamworks.js façade.
   */
  flags: number
  /** ";"-delimited "key:value" pairs, exactly as Steam serialises per-item tags. */
  tags: string
  /** JSON object of dynamic property name → raw value. */
  dynamic_props: string
}

export interface EngineResult {
  status: number
  ok: boolean
  items: ResultItemRow[]
  reason: string | null
  granted?: boolean
  recipeIndex?: number
  grantedItemDefIds?: number[]
  skipped?: Array<{ itemdefid: number; reason: string | null }>
  toolItemDefId?: number
}

export interface ProviderCapabilities {
  virtualClock: boolean
  customSchema: boolean
  sandboxGrants: boolean
  deterministicRng: boolean
  failureReasons: boolean
  gatingBypass: boolean
  configurableToolResult: boolean
  persistence: boolean
  configurableSurplus: boolean
  entitlements: boolean
  promoGrantAll: boolean
  dynamicProperties: boolean
}

/** The capability flags every provider (including a hypothetical real SteamProvider) reports false for by default. */
export declare const CAPABILITIES: ProviderCapabilities

export type ProviderEventName = 'resultReady' | 'fullUpdate' | 'definitionUpdate' | 'eligiblePromoItemDefIDs'

export interface EligiblePromoItemDefIDsPayload {
  result: number
  accountId: AccountId
  count: number
  cachedData: number[]
}

/**
 * The contract both implementations satisfy: `MockProvider` (this package)
 * and, later, a native ISteamInventory binding. No inventory method returns
 * a result directly — every one returns a handle, and the result arrives
 * later through the 'resultReady' event, exactly as real Steam delivers
 * SteamInventoryResultReady_t.
 */
export declare class InventoryProvider {
  readonly capabilities: ProviderCapabilities

  getAllItems(): number
  getItemsByID(instanceIds: ReadonlyArray<number>): number
  exchangeItems(targetItemDefId: number, materials: ReadonlyArray<RawExchangeMaterial>): number
  consumeItem(itemId: number, quantity?: number): number
  transferItemQuantity(itemIdSource: number, quantity: number, itemIdDest?: number): number
  triggerItemDrop(itemDefId: number): number
  addPromoItem(itemDefId: number): number
  addPromoItems(itemDefIds: number | ReadonlyArray<number>): number
  grantPromoItems(): number
  startUpdateProperties(): number
  setProperty(updateHandle: number, itemId: number, propertyName: string, value: string | number | boolean): boolean
  setPropertyString(updateHandle: number, itemId: number, propertyName: string, value: string): boolean
  setPropertyInt(updateHandle: number, itemId: number, propertyName: string, value: number): boolean
  setPropertyBool(updateHandle: number, itemId: number, propertyName: string, value: boolean): boolean
  setPropertyFloat(updateHandle: number, itemId: number, propertyName: string, value: number): boolean
  removeProperty(updateHandle: number, itemId: number, propertyName: string): boolean
  submitUpdateProperties(updateHandle: number): number
  getResultItemProperty(handle: number, index: number, propertyName: string): string | null
  requestEligiblePromoItemDefinitionsIDs(accountId?: AccountId): number
  getEligiblePromoItemDefinitionIDs(accountId?: AccountId): number[]
  getItemDefinitionProperty(itemDefId: number, property?: string | null): string | null
  sendItemDropHeartbeat(): void
  getResultStatus(handle: number): number | null
  getResultItems(handle: number): ResultItemRow[] | null
  getResultTimestamp(handle: number): number
  checkResultSteamID(handle: number, steamIDExpected: AccountId): boolean
  destroyResult(handle: number): boolean
  loadItemDefinitions(): boolean
  on(event: string, listener: (...args: any[]) => void): this
}

/** Structural check used by the conformance harness before it runs anything against a provider. */
export declare function assertProviderShape(provider: unknown): boolean

/**
 * Steam's async, handle-based inventory API (ISteamInventory) over the local
 * `Engine`, standing in for the native binding so client code can be written
 * and tested against the real shape before it exists. This is the surface
 * `lib/steamworks.js` (see `SteamClient` above) wraps; it is not replaced by
 * that façade and is exposed here for anyone who wants the Steam-shaped
 * handle protocol directly.
 */
export declare class MockProvider extends InventoryProvider {
  constructor(options?: MockProviderOptions)
  readonly engine: Engine
  readonly clock: VirtualClock | RealClock
  account: Account
  readonly latency: number
  readonly capabilities: ProviderCapabilities

  on(event: 'resultReady', listener: (handle: number, status: number) => void): this
  on(event: 'fullUpdate', listener: (handle: number) => void): this
  on(event: 'definitionUpdate', listener: () => void): this
  on(event: 'eligiblePromoItemDefIDs', listener: (payload: EligiblePromoItemDefIDsPayload) => void): this
  on(event: string, listener: (...args: any[]) => void): this
  once(event: 'resultReady', listener: (handle: number, status: number) => void): this
  once(event: 'fullUpdate', listener: (handle: number) => void): this
  once(event: 'definitionUpdate', listener: () => void): this
  once(event: 'eligiblePromoItemDefIDs', listener: (payload: EligiblePromoItemDefIDsPayload) => void): this
  once(event: string, listener: (...args: any[]) => void): this
  off(event: ProviderEventName | string, listener: (...args: any[]) => void): this

  getAllItems(): number
  getItemsByID(instanceIds: ReadonlyArray<number>): number
  exchangeItems(targetItemDefId: number, materials: ReadonlyArray<RawExchangeMaterial>): number
  consumeItem(itemId: number, quantity?: number): number
  transferItemQuantity(itemIdSource: number, quantity: number, itemIdDest?: number): number
  triggerItemDrop(itemDefId: number): number
  addPromoItem(itemDefId: number): number
  addPromoItems(itemDefIds: number | ReadonlyArray<number>): number
  grantPromoItems(): number
  requestEligiblePromoItemDefinitionsIDs(accountId?: AccountId): number
  getEligiblePromoItemDefinitionIDs(accountId?: AccountId): number[]

  startUpdateProperties(): number
  setProperty(updateHandle: number, itemId: number, propertyName: string, value: string | number | boolean): boolean
  setPropertyString(updateHandle: number, itemId: number, propertyName: string, value: string): boolean
  setPropertyInt(updateHandle: number, itemId: number, propertyName: string, value: number): boolean
  setPropertyBool(updateHandle: number, itemId: number, propertyName: string, value: boolean): boolean
  setPropertyFloat(updateHandle: number, itemId: number, propertyName: string, value: number): boolean
  removeProperty(updateHandle: number, itemId: number, propertyName: string): boolean
  submitUpdateProperties(updateHandle: number): number
  /** Mock-only diagnostics on a staged batch; real Steam gives you the bool and nothing else. */
  describeUpdate(updateHandle: number): UpdateDescription | null
  /** Sandbox-only, like Steam's GenerateItems (apps in development). */
  generateItems(itemDefIds: number | ReadonlyArray<number>, quantities?: ReadonlyArray<number>): number

  getResultStatus(handle: number): number | null
  getResultItems(handle: number): ResultItemRow[] | null
  getResultItemProperty(handle: number, index: number, propertyName: string): string | null
  /** Mock-only diagnostics: real Steam gives you an EResult and nothing else. */
  getResultReason(handle: number): string | null
  getResultTimestamp(handle: number): number
  checkResultSteamID(handle: number, steamIDExpected: AccountId): boolean
  destroyResult(handle: number): boolean
  /** Deprecated by Valve and inert here; warns once rather than throwing. */
  sendItemDropHeartbeat(): void
  /** Handles issued but never destroyed — on Steam these are a memory leak. */
  leakedResults(): number[]

  loadItemDefinitions(): boolean
  getItemDefinitionProperty(itemDefId: number, property?: string | null): string | null
  getItemDefinitionIDs(): number[]

  save(): SaveState
  load(state: SaveState, options?: LoadOptions): LoadReport
  saveToFile(file: string): SaveState
  loadFromFile(file: string, options?: LoadOptions): LoadReport

  advanceTime(minutes: number, options?: AdvanceTimeOptions): this
}

// ════════════════════════════════════════════════════════════════════════════
// Engine core
// ════════════════════════════════════════════════════════════════════════════

/** Subset of Steam's EResult that inventory calls actually surface — the engine-level mirror of `EResult`. */
export const enum RESULT {
  OK = 1,
  FAIL = 2,
  INVALID_PARAM = 8,
  INVALID_STATE = 11,
  LIMIT_EXCEEDED = 25,
}

/**
 * SteamItemDetails_t::m_unFlags bits the engine itself can know and sets on
 * `ResultItemRow.flags` — the engine-level mirror of `SteamItemFlags`, minus
 * NoTrade (a fact about the item definition, added only by the steamworks.js
 * façade — see `inventory.InventoryItem.flags`).
 */
export const enum ITEM_FLAGS {
  REMOVED = 256,
  CONSUMED = 512,
}

export declare const DEFAULT_OPTIONS: {
  readonly surplusPolicy: 'consume' | 'ignore' | 'strict'
  readonly bankPlaytime: boolean
  readonly toolResultPolicy: 'new-instance' | 'mutate'
  readonly appDropSettings: AppDropSettings
  readonly maxExpansionDepth: number
  readonly bypassDropGating: boolean
  readonly bypassPromoGating: boolean
  readonly propertyWhitelist: PropertyWhitelistEntry[] | null
}

/** Valve: "Limited at 10 per window." */
export declare const MAX_DROPS_PER_WINDOW: number
/** Valve: "Currently you can modify up to 100 items for a user in each call." */
export declare const MAX_ITEMS_PER_UPDATE: number
/** Pass as TransferItemQuantity's destination to split rather than merge. */
export declare const k_SteamItemInstanceIDInvalid: number

export interface DropDescription {
  eligible: boolean
  reason: string | null
  settings?: AppDropSettings
  bucket?: DropBucket
  playtimeSince?: number
  windowStartMs?: number | null
  windowGrants?: number
}

export interface PromoDescription {
  eligible: boolean
  reason: string | null
  readyAt?: number
}

/**
 * The inventory engine: exchange resolution, recursive bundle/generator
 * expansion, per-item tag propagation, playtime drops and promo grants. This
 * is the synchronous core `MockProvider` wraps in Steam's async, handle-based
 * protocol — usable directly for deterministic simulation and analysis.
 */
export declare class Engine {
  constructor(options?: EngineOptions)
  readonly schema: Schema
  readonly rng: Rng
  readonly clock: VirtualClock | RealClock
  readonly options: {
    surplusPolicy: 'consume' | 'ignore' | 'strict'
    bankPlaytime: boolean
    toolResultPolicy: 'new-instance' | 'mutate'
    appDropSettings: AppDropSettings
    maxExpansionDepth: number
    bypassDropGating: boolean
    bypassPromoGating: boolean
    propertyWhitelist: PropertyWhitelistEntry[] | null
  }
  readonly accounts: Map<AccountId, Account>

  createAccount(id?: AccountId): Account
  account(id?: AccountId): Account

  advanceTime(minutes: number, options?: AdvanceTimeOptions): this

  /** The union of an item instance's itemdef tags and its per-item tags, as "key:value" tokens. */
  effectiveTags(instance: ItemInstance): Set<string>

  getAllItems(account: Account): EngineResult
  getItemsByID(account: Account, instanceIds: ReadonlyArray<number>): EngineResult
  exchangeItems(account: Account, targetItemDefId: number, materials: ReadonlyArray<RawExchangeMaterial>): EngineResult
  consumeItem(account: Account, itemId: number, quantity?: number): EngineResult
  transferItemQuantity(account: Account, itemIdSource: number, quantity: number, itemIdDest?: number): EngineResult

  describeDrop(account: Account, itemDefId: number): DropDescription
  triggerItemDrop(account: Account, itemDefId: number): EngineResult

  describePromo(account: Account, itemDefId: number): PromoDescription
  addPromoItem(account: Account, itemDefId: number): EngineResult
  addPromoItems(account: Account, itemDefIds: number | ReadonlyArray<number>): EngineResult
  grantPromoItems(account: Account): EngineResult
  eligiblePromoItemDefinitionIDs(account: Account): number[]

  /** Sandbox-only on real Steam. */
  generateItems(account: Account, itemDefIds: number | ReadonlyArray<number>, quantities?: ReadonlyArray<number>): EngineResult

  startUpdateProperties(): number
  setProperty(handle: number, itemId: number, name: string, value: string | number | boolean): boolean
  setPropertyString(handle: number, itemId: number, name: string, value: string): boolean
  setPropertyInt(handle: number, itemId: number, name: string, value: number): boolean
  setPropertyBool(handle: number, itemId: number, name: string, value: boolean): boolean
  setPropertyFloat(handle: number, itemId: number, name: string, value: number): boolean
  removeProperty(handle: number, itemId: number, name: string): boolean
  describeUpdate(handle: number): UpdateDescription | null
  submitUpdateProperties(account: Account, handle: number): EngineResult

  getItemDefinitionProperty(itemDefId: number, property?: string | null): string | null
}

// ════════════════════════════════════════════════════════════════════════════
// Schema
// ════════════════════════════════════════════════════════════════════════════

export interface RawTag {
  key: string
  value: string
}

/** A tag matcher as used by `tags_to_remove_on_tool_use`: a bare category (`value: null`) or an exact pair. */
export interface TagMatcher {
  key: string
  value: string | null
}

export type ExchangeMaterialOperand =
  | { kind: 'def'; itemdefid: number; quantity: number }
  | { kind: 'tag'; key: string; value: string; token: string; quantity: number }

export type ExchangeRecipe = ExchangeMaterialOperand[]

export interface BundleEntry {
  itemdefid: number
  quantity: number
}

export type PromoRule =
  | { type: 'manual' }
  | { type: 'owns'; appid: number }
  | { type: 'ach'; name: string }
  | { type: 'played'; appid: number; minutes: number }

export interface TagGeneratorValue {
  value: string
  chance: number
}

export interface LoadSchemaOptions {
  /** Throw on validation errors. Default true. */
  strict?: boolean
}

/** One parsed Steam itemdef. */
export declare class ItemDef {
  constructor(raw: ItemDefRaw)
  readonly raw: ItemDefRaw
  readonly itemdefid: number
  readonly name: string | undefined
  readonly cls: string | null
  readonly type: string
  readonly tags: RawTag[]
  readonly tagTokens: Set<string>
  readonly exchange: ExchangeRecipe[]
  readonly bundle: BundleEntry[]
  readonly promo: PromoRule[]
  readonly tagGenerators: number[]
  readonly tagGeneratorName: string | null
  readonly tagGeneratorValues: TagGeneratorValue[]
  readonly tagsToRemoveOnToolUse: TagMatcher[]
  readonly allowedTagsFromTools: string[]
  readonly accessoryTag: string | null
  /** `null` when unspecified — distinct from an explicit `accessory_limit: 0`. See `accessoryLimitOrDefault`. */
  readonly accessoryLimit: number | null
  readonly displayType: string | null
  readonly autoStack: boolean
  readonly tradable: boolean
  readonly marketable: boolean
  readonly hidden: boolean
  readonly gameOnly: boolean
  /** Restricts this promo to explicit AddPromoItem(s) calls, excluding it from a GrantPromoItems sweep. */
  readonly grantedManually: boolean
  readonly quantity: number | null
  readonly containerContentsGenerator: number | null
  /** True when this itemdef specifies ANY drop setting, which tracks it in its own drop bucket. */
  readonly hasOwnDropSettings: boolean
  readonly dropInterval: number | null
  readonly useDropWindow: boolean | null
  readonly dropWindow: number | null
  readonly dropMaxPerWindow: number | null
  readonly useDropLimit: boolean | null
  readonly dropLimit: number | null
  readonly dropStartTime: number | null

  /** True for bundle / generator / playtimegenerator: types resolved by expansion rather than instantiation. */
  readonly isComplex: boolean
  /** How many accessories this item may carry — Valve's default of 4 when `accessoryLimit` is unset. */
  readonly accessoryLimitOrDefault: number

  /** Raw wire-format property lookup — GetItemDefinitionProperty, as Steam returns it (a string, or null). */
  property(name: string): string | null
  propertyNames(): string[]
}

export interface SchemaReport {
  errors: string[]
  warnings: string[]
}

export declare class Schema {
  constructor(appid: number | null, defs: ItemDef[])
  readonly appid: number | null
  readonly defs: Map<number, ItemDef>
  readonly byClsName: Map<string, ItemDef>
  readonly tagIndex: Map<string, Set<number>>
  /** Populated by `loadSchema()`; absent on a `Schema` built by hand. */
  readonly report?: SchemaReport

  get(itemdefid: number | string): ItemDef | null
  /** Throwing lookup — the engine wants a hard failure on a bad id. */
  require(itemdefid: number | string): ItemDef
  byCls(cls: string): ItemDef | null
  requireCls(cls: string): ItemDef
  all(): ItemDef[]
  size(): number
}

/**
 * Load and validate a Steam itemdef schema. Loading is strict by default:
 * anything Steam would reject on upload (a dangling bundle reference, an
 * unparsable exchange formula, a duplicate itemdefid) throws rather than
 * surfacing as a runtime surprise later.
 */
export declare function loadSchema(source: string | SchemaSource | ItemDefRaw[], options?: LoadSchemaOptions): Schema

// ════════════════════════════════════════════════════════════════════════════
// State: accounts and item instances
// ════════════════════════════════════════════════════════════════════════════

/** `type`/`value` pairing for a dynamic item property (see Valve's four SetProperty overloads). */
export interface PropertyValue {
  type: 'string' | 'int' | 'bool' | 'float'
  value: string | number | boolean
}

export interface DropBucket {
  key: string
  grants: number
  playtimeAtLastGrant: number
  windowStartMs: number | null
  windowGrants: number
}

export interface PromoRecord {
  itemdefid: number
  count: number
  lastGrantMs: number | null
}

export interface ItemInstanceJSON {
  itemId: number
  itemdefid: number
  quantity: number
  tags: RawTag[]
  dynamicProps: Record<string, PropertyValue>
  acquiredMs: number | null
}

/** One item instance held by an account — a single stack, since quantities live here too. */
export declare class ItemInstance {
  constructor(init: {
    itemId: number
    itemdefid: number
    quantity: number
    tags?: RawTag[]
    acquiredMs?: number
    dynamicProps?: Record<string, PropertyValue>
  })
  itemId: number
  itemdefid: number
  quantity: number
  /** Per-item tags: assigned at creation, persist for the item's lifetime. */
  tags: RawTag[]
  /** Mutable per-instance state, unlike tags — see SetProperty / SubmitUpdateProperties. */
  dynamicProps: Record<string, PropertyValue>
  acquiredMs: number | undefined

  /** Stable identity for stack merging: same itemdef AND same per-item tags. */
  stackKey(): string
  /**
   * The shape returned through result sets — mirrors SteamItemDetails_t.
   * `flags` is supplied by the caller (the engine, at the point it empties,
   * spends or destroys this instance) rather than read off the instance
   * itself — see `ResultItemRow.flags`.
   */
  toResult(flags?: number): ResultItemRow
  toJSON(): ItemInstanceJSON
  static fromJSON(raw: ItemInstanceJSON): ItemInstance
}

export interface AccountJSON {
  id: AccountId
  instances: ItemInstanceJSON[]
  dropBuckets: DropBucket[]
  promoGrants: PromoRecord[]
  ownedApps: number[]
  achievements: string[]
  playtimeByApp: Array<{ appid: number; minutes: number }>
}

/**
 * The per-account state the engine mutates: item instances, playtime-drop
 * buckets, promo grant history, and the Steam entitlements promo rules read.
 */
export declare class Account {
  constructor(id: AccountId)
  readonly id: AccountId
  readonly instances: Map<number, ItemInstance>
  /** Playtime-drop tracking. Key is `"def:<id>"` or `"app"` (the shared budget). */
  readonly dropBuckets: Map<string, DropBucket>
  readonly promoGrants: Map<number, PromoRecord>
  readonly ownedApps: Set<number>
  readonly achievements: Set<string>
  readonly playtimeByApp: Map<number, number>

  begin(): void
  commit(): void
  rollback(): void
  record(undo: () => void): void

  get(itemId: number | string): ItemInstance | null
  list(): ItemInstance[]
  /** All instances of an itemdef — there can be several, with distinct per-item tags. */
  instancesOf(itemdefid: number): ItemInstance[]
  /** Total quantity held of an itemdef, across stacks. */
  countOf(itemdefid: number): number
  add(instance: ItemInstance): ItemInstance
  remove(instance: ItemInstance): void
  setQuantity(instance: ItemInstance, quantity: number): ItemInstance
  setDynamicProps(instance: ItemInstance, props: Record<string, PropertyValue>): ItemInstance
  /** Create a new instance with a fresh, process-unique instance id. */
  createInstance(itemdefid: number, quantity: number, tags: RawTag[], acquiredMs?: number): ItemInstance

  dropBucket(key: string): DropBucket
  updateDropBucket(bucket: DropBucket, changes: Partial<DropBucket>): void

  promoRecord(itemdefid: number): PromoRecord
  updatePromoRecord(record: PromoRecord, changes: Partial<PromoRecord>): void

  toJSON(): AccountJSON
  static fromJSON(json: AccountJSON, options?: { id?: AccountId }): Account

  /** Deterministic, order-independent fingerprint of inventory contents only (not drop/promo/entitlement state). */
  fingerprint(): string
}

// ════════════════════════════════════════════════════════════════════════════
// Persistence
// ════════════════════════════════════════════════════════════════════════════

export interface ClockSnapshot {
  nowMs: number
  playtimeMinutes: number
}

/** A complete save: account, clock and RNG, plus the envelope Steam has no equivalent for. */
export interface SaveState {
  kind: string
  version: number
  savedAt: string
  /** Process-global instance-id watermark — see persistence.js for why this must move with the save. */
  nextInstanceId: number
  rng: number
  clock: ClockSnapshot
  account: AccountJSON
}

export interface LoadOptions {
  /** Load under a different account id than the one the save carries. */
  accountId?: AccountId
  /** What to do with a saved item whose itemdef no longer exists in the loaded schema. Default 'error'. */
  onUnknownItemdef?: 'error' | 'drop'
}

export interface DroppedItem {
  itemId: number
  itemdefid: number
  quantity: number
}

export interface LoadReport {
  account: Account
  version: number
  dropped: DroppedItem[]
  nextInstanceId: number
}

/** Snapshot one account of an engine, plus the engine's clock and RNG. */
export declare function saveState(engine: Engine, options?: { accountId?: AccountId }): SaveState
/** Restore a save into an engine, replacing that account. Validates before mutating anything. */
export declare function loadState(engine: Engine, state: SaveState, options?: LoadOptions): LoadReport
export declare function readSave(file: string): SaveState
/** Writes atomically: a full write to a sibling temp file, then a rename. Returns the resolved path. */
export declare function writeSave(file: string, state: SaveState): string
export declare const SAVE_VERSION: number
/** Marker so a stray JSON file is rejected as a save rather than half-read. */
export declare const SAVE_KIND: string

// ════════════════════════════════════════════════════════════════════════════
// Time and randomness
// ════════════════════════════════════════════════════════════════════════════

/**
 * Virtual clock. Every time-dependent decision in the engine (drop_interval,
 * drop_window, promo recurrence, drop_start_time) reads this instead of
 * Date.now(), turning wall-clock waits into millisecond unit tests.
 */
export declare class VirtualClock {
  constructor(options?: { start?: number | string })
  readonly startMs: number
  /** @param options.playing whether playtime accrues too. Default true. */
  advance(minutes: number, options?: AdvanceTimeOptions): this
  /** Advance playtime without advancing wall time (session compression). */
  advancePlaytimeOnly(minutes: number): this
  now(): number
  playtime(): number
  /** "20260101T000000Z" — the format drop_start_time uses. */
  toSteamTime(): string
  snapshot(): ClockSnapshot
  restore(snap: ClockSnapshot): void
}

/**
 * Adapter with the same surface, backed by real time. `advance()` is a no-op
 * — check `provider.capabilities.virtualClock` before relying on time control.
 */
export declare class RealClock {
  constructor()
  readonly startMs: number
  advance(): this
  advancePlaytimeOnly(): this
  now(): number
  playtime(): number
  toSteamTime(): string
  snapshot(): Record<string, never>
  restore(): void
}

export declare const MS_PER_MINUTE: number

/** Seedable, serialisable PRNG (mulberry32). Reproducibility is a hard requirement for the balance simulator. */
export declare class Rng {
  constructor(seed?: number | string)
  static hashSeed(seed: number | string): number
  /** Float in [0, 1). */
  next(): number
  /** Integer in [0, n). */
  int(n: number): number
  /** Weighted selection; entries with weight <= 0 can never be selected. */
  pickWeighted<T>(entries: ReadonlyArray<T>, weightOf?: (entry: T) => number): T | null
  /** Opaque state snapshot, for transaction rollback and sim checkpoints. */
  save(): number
  restore(state: number): void
}

// ════════════════════════════════════════════════════════════════════════════
// Promise adapters
// ════════════════════════════════════════════════════════════════════════════

export interface AwaitedResult {
  handle: number
  status: number | null
  ok: boolean
  items: ResultItemRow[]
  reason: string | null
  granted: boolean | undefined
  recipeIndex: number | undefined
}

export interface AwaitOptions {
  /** Call destroyResult() after reading. Default true. */
  destroy?: boolean
  timeoutMs?: number
}

/** Resolve when the given handle's result arrives on `provider`. */
export declare function awaitResult(provider: InventoryProvider, handle: number, options?: AwaitOptions): Promise<AwaitedResult>
/** `await call(provider, 'exchangeItems', target, materials)` */
export declare function call(provider: InventoryProvider, method: string, ...args: unknown[]): Promise<AwaitedResult>
/** Whole-inventory snapshot as itemdefid → total quantity. */
export declare function inventoryByDef(provider: InventoryProvider): Promise<Map<number, number>>

// ════════════════════════════════════════════════════════════════════════════
// Wire-format parsers
// ════════════════════════════════════════════════════════════════════════════

/**
 * Parsers for Steam's Inventory Service wire grammars — the delimited-string
 * encodings every non-scalar itemdef field uses. This IS a genuine top-level
 * export (unlike `inventory`/`callback`/`mock` above).
 */
export declare namespace grammar {
  /** "band:1;category:item" → [{ key: 'band', value: '1' }, ...] */
  export function parseTags(str: string | null | undefined): RawTag[]
  export function formatTags(tags: ReadonlyArray<RawTag> | null | undefined): string
  export function tagTokenSet(tags: ReadonlyArray<RawTag> | null | undefined): Set<string>
  export function parseTagMatchers(str: string | null | undefined): TagMatcher[]
  /** Does a matcher select this tag? A null `matcher.value` matches the whole category. */
  export function tagMatches(matcher: TagMatcher, tag: RawTag): boolean
  export function parseCategoryList(str: string | null | undefined): string[]
  export function parseMaterial(str: string): ExchangeMaterialOperand
  export function parseExchange(str: string | null | undefined): ExchangeRecipe[]
  export function parseBundle(str: string | null | undefined): BundleEntry[]
  export function parsePromo(str: string | null | undefined): PromoRule[]
  export function parseTagGeneratorValues(str: string | null | undefined): TagGeneratorValue[]
  export function parseIdList(str: string | null | undefined): number[]
  /** ISO 8601 basic-format UTC ("20050515T171151Z"), as used by drop_start_time. */
  export function parseSteamTime(str: string | null | undefined): number | null
  /** Inverse of parseSteamTime — epoch ms → "YYYYMMDDTHHMMSSZ". */
  export function formatSteamTime(ms: number): string
}

// ════════════════════════════════════════════════════════════════════════════
// Dynamic item properties
// ════════════════════════════════════════════════════════════════════════════

/**
 * The value model for dynamic item properties. A genuine top-level export
 * (the namespace, not flattened names — `properties.intProperty(1)` vs a bare
 * `intProperty` reads as the deliberate type choice it is).
 */
export declare namespace properties {
  const PROPERTY_TYPES: readonly ['string', 'int', 'bool', 'float']
  const PROPERTY_NAME_PATTERN: RegExp
  /** Valve: "a maximum of 1024 bytes of JSON per item at this time". */
  const MAX_PROPERTY_BYTES: number
  const MAX_PROPERTY_NAME_LENGTH: number

  class PropertyError extends Error {}

  function isValidPropertyName(name: string): boolean
  function assertPropertyName(name: string): string

  function property(type: 'string' | 'int' | 'bool' | 'float', value: string | number | boolean): PropertyValue
  function stringProperty(value: string): PropertyValue
  function intProperty(value: number): PropertyValue
  function boolProperty(value: boolean): PropertyValue
  function floatProperty(value: number): PropertyValue
  /**
   * Infer a property from a bare JS value: a whole number infers as `int`
   * (Valve's own example's reading). A float that happens to hold a whole
   * number needs `floatProperty()` — inference cannot read that intent out of
   * `1`.
   */
  function inferProperty(value: string | number | boolean): PropertyValue
  function validateProperty(prop: PropertyValue): PropertyValue

  function propsToJSON(props: Record<string, PropertyValue>): string
  /** UTF-8 byte length of the emitted JSON — the quantity Valve's 1024-byte cap is expressed in. */
  function propsByteLength(props: Record<string, PropertyValue>): number
  function propsToStorage(props: Record<string, PropertyValue>): Record<string, PropertyValue>
  function propsFromStorage(raw: Record<string, PropertyValue>): Record<string, PropertyValue>
}

/** Valve: "a maximum of 1024 bytes of JSON per item at this time". Re-exported alongside the `properties` namespace. */
export declare const MAX_PROPERTY_BYTES: number

// ════════════════════════════════════════════════════════════════════════════
// Example content
// ════════════════════════════════════════════════════════════════════════════

/** The example economy this package's own test suite and demos run against. */
export declare const exampleEconomy: SchemaSource
