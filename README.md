# steam-inventory-mock

An in-process mock of Steam's Inventory Service (`ISteamInventory`) — exchange formulas, recursive
bundle and generator expansion, per-item tags, tag tools and accessories, dynamic item properties,
playtime drops and promo grants — driven by a **virtual clock** and a seedable RNG. That clock is
the reason to want it: a `playtimegenerator`'s `drop_interval`, a manual promo's monthly
recurrence and a six-week progression curve all run on real wall-clock playtime, which makes them
effectively untestable against live Steam. Here each one is a millisecond unit test. Zero runtime
dependencies, CommonJS, Node ≥ 22, 308 tests on Node's built-in runner and no test framework.

## ⚠️ Before you adopt this

### Nothing here has been verified against real Steam

No vertical slice of this library has ever been run against a real test app. The implementation is
inference from [Valve's public documentation](https://partner.steamgames.com/doc/features/inventory)
— mirrored in `docs/` in the repository, which is not redistributed in the npm package — plus a
reading of what
the servers plausibly do. Where the docs are explicit, the behaviour follows them. Everywhere else
it is a considered guess.

Divergence from real Steam should be treated as expected until somebody measures it. The
conformance suite ([below](#conformance-and-the-capability-model)) exists so that measurement is a
matter of pointing the existing tests at a native binding, but until that happens nothing in this
repository is evidence about Steam's behaviour — only about this library's.

### Six behaviours are encoded guesses, and you inherit them

Each is decided in `lib/engine.js` and documented at the point it is decided, most of them flagged
`UNVERIFIED` in the comment there. Four are named options with a default; the last two are
hardcoded and cannot be swapped at all. `docs/coverage.md` records the rest, including one further
guess about accessories described [below](#tag-tools-and-accessories).

| Option | Default | Why that default, and what it costs |
|---|---|---|
| `surplusPolicy` | `'consume'` | Materials offered beyond what the winning recipe requires are consumed anyway. Valve's wording is that the exchange consumes the materials you pass, and a client written against that reading is correct under either one — it never over-supplies. `'ignore'` consumes only what the recipe calls for; `'strict'` rejects the call outright, which is how you find a sloppy material list in development rather than in a player's inventory. |
| `bankPlaytime` | `false` | Playtime beyond `drop_interval` is discarded at grant time: the bucket's watermark is set to the clock's current playtime, so 90 minutes of play against a 30-minute interval yields one drop, not three. `true` advances the watermark by exactly one interval instead, so a backlog accumulates and can be claimed drop by drop. Nothing in Valve's documentation settles which one the servers do. |
| `appDropSettings` | `{ dropInterval: 30, useDropWindow: false, dropWindow: 1440, dropMaxPerWindow: 1, useDropLimit: false, dropLimit: 0 }` | These are the app-level Playtime Item Grants fields somebody typed into the Steamworks partner site for one appid, and this library has no way to read them. The *override* rule is documented and implemented — an itemdef naming any drop field is tracked in its own bucket, one naming none shares a single budget with every other bare `playtimegenerator` — but the values are not. Mirror your partner-site configuration into this option; the defaults are a stand-in, not a fact. |
| `toolResultPolicy` | `'new-instance'` | **Valve's own two pages contradict each other.** `docs/tools.html` says applying a tag tool creates "a new item (copied from the target item)"; `docs/accessories.html` says the call will "atomically consume the sticker and update the tags on the target item". Both are implemented and both are pinned by tests; the default is the more explicit wording. This is not cosmetic: under `'new-instance'` the target's instance id **dies with the call**, so an equipped-item reference, a pending UI list or a saved loadout is invalidated by a *successful* exchange, and the caller must read the new id out of the result. |
| — (not configurable) | both bits | A stack consumed to zero carries **both** `ItemRemoved` and `ItemConsumed`. It was consumed, and the instance is now gone; setting one bit would hide half of what happened. Real Steam may set only one. Unmeasured. |
| — (not configurable) | `ItemConsumed` | Exchange materials are flagged `ItemConsumed` even though `ConsumeItem` was not the call that spent them, on the reading that Valve documents the exchange's destroy array as the items the exchange consumes. Also unmeasured. |

Being a named, test-pinned option makes a guess **visible and swappable, not correct**. Flipping
`toolResultPolicy` changes which of two documented sentences this library obeys; it does not tell
you which one Steam obeys. The last two rows do not even come with a switch.

One more default worth knowing before you write client code: **`propertyWhitelist` is `null`,
meaning any dynamic property may be set.** Real Steam refuses a client-side `SetProperty` for a
property that is not white-listed on the partner site. That list is configuration this library
cannot know, and refusing everything by default would make the subsystem unusable out of the box —
so the permissive reading is the default, and the cost is that **a client that works here can still
be refused in production, on exactly the calls the white-list exists to govern.** If you are
shipping against a real binding, mirror your partner-site configuration into the option and test
against it.

### The Community Market, the Item Store and pricing are out of scope

There is no order book, no listings, no price discovery, no fees and no liquidity. `RequestPrices`,
`GetNumItemsWithPrices`, `GetItemsWithPrices`, `GetItemPrice` and `StartPurchase` are
unimplemented, and so are the `SteamInventoryStartPurchaseResult_t` and
`SteamInventoryRequestPricesResult_t` callbacks. The `price`, `price_category`, `store_tags`,
`store_images`, `store_hidden`, `use_bundle_price`, `purchase_bundle_discount` and `purchase_limit`
itemdef fields are parsed and readable through `getItemDefinitionProperty`, but they are inert —
nothing reads them back. `SerializeResult` and `DeserializeResult` are absent too: they exist to
hand a result to a game server for verification, and there is no server here.

The consequence, stated outright: **if your project's economics centre on trading between players,
this library models none of that half of the system.** It can tell you what a crafting tree does to
one player's inventory. It can tell you nothing about what a market does to prices, to supply, or
to the value of anything in that tree.

## Coverage

[`docs/coverage.md`](docs/coverage.md) is the authoritative statement of what is and is not
implemented, call by call. Condensed:

| Area | Status |
|---|---|
| Result management | `GetResultStatus`, `GetResultItems`, `GetResultItemProperty` (including `tags` and `dynamic_props`), `GetResultTimestamp`, `CheckResultSteamID`, `DestroyResult`. **No** `SerializeResult`/`DeserializeResult`. |
| Inventory queries | `GetAllItems`, `GetItemsByID`, `GetItemDefinitionIDs`, `GetItemDefinitionProperty` (both synchronous, as on Steam), `LoadItemDefinitions` — with a `deferDefinitions` option that models the pre-load window a real client has to survive. |
| Grants | `AddPromoItem`, `AddPromoItems`, `GrantPromoItems` (respects `granted_manually`), `RequestEligiblePromoItemDefinitionsIDs` + `GetEligiblePromoItemDefinitionIDs`, `GenerateItems` (sandbox-only on Steam, and here too). |
| Exchange, consume, drops | `ExchangeItems` on both of its paths — recipe and `tag_tool` — `ConsumeItem`, `TransferItemQuantity` (split and merge, with tag identity enforced), `TriggerItemDrop` against the virtual clock, `SendItemDropHeartbeat` (a no-op; Valve deprecated it). |
| Dynamic properties | The whole staging cycle: `StartUpdateProperties`, typed `SetProperty`, `RemoveProperty`, transactional `SubmitUpdateProperties`, and both documented limits (100 items per call, 1024 bytes of JSON per item). **No** per-user rate limiting — a partner-side policy with no published window. |
| Tag tools, accessories | `tag_tool`, `tags_to_remove_on_tool_use`, `allowed_tags_from_tools`, `tag_generators` on a tool, `accessory_tag`/`accessory_limit` (default 4, duplicates refused). What the call leaves behind is `toolResultPolicy` — see the warning above. |
| Callbacks | `SteamInventoryResultReady_t`, `SteamInventoryFullUpdate_t`, `SteamInventoryDefinitionUpdate_t`, `SteamInventoryEligiblePromoItemDefIDs_t`. |
| Prices, purchase, Market | **None of it.** |
| Item flags | All three of `k_ESteamItemNoTrade`, `k_ESteamItemRemoved`, `k_ESteamItemConsumed` — with the narrowing described under [Item flags carry row provenance](#item-flags-carry-row-provenance). |
| Not modelled at all | Trading between accounts, the Community Market, the Item Store and checkout, Workshop items, localisation (`name_<lang>` is readable but never selected between), icon and image hosting, and the `IInventoryService` Web API. |

Itemdef fields outside the parsed set — including every extended or custom property your content
pipeline emits — are preserved on `ItemDef.raw` and readable through `getItemDefinitionProperty`,
exactly as Steam returns extended schema properties.

## Quick start

The package ships an example economy at [`examples/economy.js`](examples/economy.js): 46 itemdefs
in Steam's *wire* format (delimited strings, as a real `itemdefs.json` carries them), covering
multi-recipe exchanges, tag operands, nested bundles, weighted generators, drop windows and limits,
promo recurrence, tag tools and accessories. The tests and all three demos run against it.

### The façade — `init()`

Shaped like [steamworks.js](https://github.com/ceifa/steamworks.js): namespaced free functions,
promises, `bigint` item ids, `callback.register()`.

```js
const { init, SteamCallback } = require('steam-inventory-mock');

const client = init({ schema: require('./itemdefs.json'), seed: 'session-1' });

const ready = client.callback.register(SteamCallback.SteamInventoryResultReady,
  ({ handle, result }) => console.log(handle, result));

await client.inventory.addPromoItem(9060);            // → [{ itemId: 1n, itemDefId: 9001, ... }]
const items = await client.inventory.getAllItems();

// A recipe exchange. The material stack comes back at quantity 2 with
// flags 513 — NoTrade | ItemConsumed — and the crafted item as its own row.
await client.inventory.exchangeItems(9011, [{ itemId: items[0].itemId, quantity: 3 }]);

// The virtual clock. 9050 has drop_interval: 30.
await client.inventory.triggerItemDrop(9050);         // → [] — not eligible yet
client.mock.advanceTime(30);
await client.inventory.triggerItemDrop(9050);         // → [{ itemDefId: 9001, quantity: 3, ... }]

ready.disconnect();
client.mock.leakedResults();                          // → [] — the façade owns handle lifetime
```

Failures reject with a `SteamInventoryError` carrying `.result` (the `EResult`) and `.reason` (a
human-readable diagnostic that is always present here and always `null` against a real binding —
debugging output, never control flow).

### The provider — `MockProvider`

Valve's actual shape: every call returns an integer handle, results arrive on an event, and results
must be destroyed.

```js
const { MockProvider, RESULT } = require('steam-inventory-mock');
const economy = require('steam-inventory-mock/examples/economy');

const provider = new MockProvider({ schema: economy, seed: 'readme' });

provider.on('resultReady', handle => {
  if (provider.getResultStatus(handle) === RESULT.OK) {
    for (const row of provider.getResultItems(handle)) {
      console.log(row.itemId, row.itemdefid, row.quantity, row.flags, row.tags);
    }
  } else {
    console.log('failed:', provider.getResultReason(handle));
  }
  provider.destroyResult(handle);                     // or it leaks, as on Steam
});

provider.addPromoItem(9060);
provider.getAllItems();
```

`lib/await.js` provides `awaitResult(provider, handle)`, `call(provider, method, ...args)` and
`inventoryByDef(provider)` for tests and scripts. They live *outside* the provider deliberately:
the provider surface stays exactly as awkward as Steam's, so nobody writes client code against a
synchronous fantasy, and anything that wants promises has to reach for that file and thereby admit
it.

### The engine, synchronously

```js
const { Engine } = require('steam-inventory-mock');

const engine  = new Engine({ schema: economy, seed: 'sim' });
const account = engine.account('player');

engine.generateItems(account, [9001], [10]);
const stack = account.list()[0];                  // instance ids are issued process-wide
engine.exchangeItems(account, 9011, [{ itemId: stack.itemId, quantity: 3 }]);
engine.advanceTime(30);
engine.describeDrop(account, 9050);   // { eligible: true, settings, bucket, playtimeSince: 30, ... }
```

No handles, no promises — for Monte Carlo runs and balance analysis, where the throughput matters.

## Two API layers, and why both exist

`MockProvider` is a faithful mirror of `ISteamInventory`, and it is what a native napi binding maps
onto one-to-one. It does not change. The `init()` façade sits on top of it and every call goes
through the provider exactly as a client's would; it adds no logic of its own, only converting ids,
splitting a delimited string, parsing a JSON blob and turning a status code into a rejection.
Behaviour that is tempting to add there belongs in the engine instead, or the two layers can
disagree about the economy.

Three boundaries hold the arrangement together:

**`bigint` at the façade, plain numbers inside.** Item *instance* ids are `SteamItemInstanceID_t`,
a uint64, so they cross the public surface as `bigint` — steamworks.js does the same for
`publishedFileId`. Item *definition* ids stay plain numbers, because `SteamItemDef_t` is an int32,
and so do update handles, which are opaque and process-local. The conversion happens in
`lib/steamworks.js` and nowhere else, applied by the call tables rather than at each call site:
`Number(5n)` is `5`, so an unconverted path would work by accident until the day it silently did
not, and a boundary you have to remember to apply is not a boundary. Everything underneath keeps JS
numbers, because a `bigint` does not survive `JSON.stringify` and a save file that cannot be
serialised is not a save file.

**`client.mock` is a separate namespace.** Everything under it is something a real steamworks.js
build could not do: travel in time, hand you the account's state, arrange entitlements that are
facts on a real account, skip Steam's server-side gating. Keeping them out of `client.inventory`
means swapping in a real binding fails loudly on `client.mock.advanceTime` instead of silently
no-op'ing — which is the failure mode that turns "mock first" into a rewrite. The same rule decides
where anything new belongs: if Valve ships it, `inventory`; if only this library can, `mock`.
`GenerateItems` is the instructive case — it is sandbox-only, but it is genuine `ISteamInventory`,
so it lives in `inventory` and a real binding fails the call on a released app.

**Nothing is synchronous that Steam makes asynchronous.** The exceptions are the calls Steam itself
returns immediately: `GetItemDefinitionIDs` and `GetItemDefinitionProperty` (itemdefs are
downloaded up front and read from a local cache) and the property staging calls
`StartUpdateProperties` / `SetProperty` / `RemoveProperty`, which only accumulate a batch
client-side.

## Conformance and the capability model

Everything under `test/conformance/` is written against [`test/harness.js`](test/harness.js), never
against `MockProvider` directly, so the same behavioural suite can later be pointed at a native
`SteamProvider`:

```
STEAM_MOCK_PROVIDER=steam node --test test/conformance/*.test.js
```

Divergence between mock and reality then shows up as a failing test in CI, continuously, rather
than as a surprise during final integration.

Providers advertise capabilities (the canonical list is `CAPABILITIES` in
[`lib/provider-interface.js`](lib/provider-interface.js)), and a test that needs something a
provider cannot physically do skips instead of failing:

| Capability | What it gates |
|---|---|
| `virtualClock` | `advanceTime()` actually moves time. You cannot time-travel live Steam. |
| `customSchema` | The provider can be built against a fixture schema, not the app's uploaded itemdefs. |
| `sandboxGrants` | `GenerateItems` is available for seeding inventories. |
| `deterministicRng` | Results are reproducible from a seed. Steam rolls server-side. |
| `failureReasons` | Failures carry a human-readable `reason`. Steam returns a bare `EResult`. |
| `gatingBypass` | `bypassDropGating` / `bypassPromoGating` take effect. Steam enforces its own gating and offers no override. |
| `configurableToolResult` | `toolResultPolicy` can be selected. Steam does exactly one of the two and cannot be told which. |
| `persistence` | `save()` / `load()`. Steam holds the inventory server-side and neither hands it over nor takes it back. |
| `configurableSurplus` | `surplusPolicy` can be selected. |
| `entitlements` | Owned apps, achievements and per-app playtime can be arranged for promo rules to read. On a real account these are facts, not test setup. |
| `promoGrantAll` | The four promo grant/eligibility calls are wired up. **Real Steam supports these** — a real binding should advertise it `true`. |
| `dynamicProperties` | The property staging cycle is wired up. **Real Steam supports these too** — a real binding should advertise it `true`. |

The last two are the ones to read carefully. They are not mock-only conveniences; they exist so a
partial or older binding can decline what it has not wired up yet, not to grant this mock a licence
the real API lacks.

`MockProvider` advertises all twelve, which is why the suite reports **0 skipped** here. A real
target will skip a great many, and that is the point: **a skip is an honest statement that a
semantic went unverified on that target, where a green test against a stubbed-out capability would
be a lie.**

### Registering a real SteamProvider

`test/harness.js` carries a worked example in a comment block, next to the `mock` target. The shape
is a name, a capability object and a factory:

```js
const { SteamProvider } = require('../lib/steam-provider');

steam: {
  name: 'steam',
  capabilities: {
    virtualClock: false,          // you cannot time-travel live Steam
    customSchema: false,          // a real provider loads the app's uploaded itemdefs
    sandboxGrants: false,         // GenerateItems is sandbox-only
    deterministicRng: false,      // rolls happen server-side; there is no seed
    failureReasons: false,        // Steam gives an EResult, not a sentence
    gatingBypass: false,          // drop_interval / drop_limit / promo recurrence are server-side
    entitlements: false,          // owned apps, achievements and playtime are facts, not setup
    configurableSurplus: false,   // Steam's surplus behaviour is fixed and unmeasured
    persistence: false,           // the inventory lives on Steam's servers
    // promoGrantAll and dynamicProperties should be `true` once the binding
    // wires them up — real Steam supports both.
  },
  create(options = {}) {
    return new SteamProvider(options);
  },
},
```

`needs()` treats an omitted flag as absent, so an incomplete capability object over-skips rather
than over-claims. The `mock` target does not restate its flags at all — it reads them off a freshly
constructed `MockProvider`, because a hand-maintained copy of that list has drifted twice already
and the failure is quiet in the worst direction: one missing flag makes `needs()` skip a whole
file, and the suite goes green by not running.

Do not stub a capability to make tests pass. A `virtualClock` that returns without moving time
turns every drop test into a tautology.

## Module map

| File | What lives there |
|---|---|
| `index.js` | The public surface: `init`, `MockProvider`, `Engine`, schema and persistence helpers, `VirtualClock`, `Rng`, the promise adapters, the example economy. |
| `lib/steamworks.js` | The steamworks.js-shaped façade, the `bigint` boundary, `EResult` / `SteamCallback` / `SteamItemFlags`, `SteamInventoryError`. |
| `lib/provider.js` | `MockProvider` — Steam's async, handle-based protocol over the engine; result handles, dispatch, leak tracking, save/load passthrough. |
| `lib/provider-interface.js` | The contract both implementations satisfy, plus `CAPABILITIES` and `assertProviderShape`. |
| `lib/engine.js` | Exchange resolution, bundle and generator expansion, tag propagation, drops, promos, dynamic properties, transactions, `DEFAULT_OPTIONS`. |
| `lib/matching.js` | Max-flow material assignment (Edmonds–Karp on a tiny bipartite graph). |
| `lib/grammar.js` | Parsers for every delimited string in an itemdef: `exchange`, `bundle`, tags, tag matchers, `promo`, `tag_generator_values`, Steam timestamps. Total — a parse failure means the schema would be rejected on upload. |
| `lib/schema.js` | Loads the wire format and pre-parses it into structure. Strict: a bundle pointing at a missing itemdefid is a load error, not a runtime surprise. |
| `lib/inventory.js` | `Account` and `ItemInstance`; the transaction journal; stack keys. |
| `lib/properties.js` | The typed value model for dynamic properties, the 1024-byte accounting, name validation. |
| `lib/persistence.js` | The save envelope, `SAVE_VERSION`, the migration chain, the instance-id watermark. |
| `lib/clock.js` | `VirtualClock` (wall time and playtime tracked separately) and `RealClock`. |
| `lib/rng.js` | Seedable mulberry32; 32 bits of state, so save/restore is one integer. |
| `lib/await.js` | `awaitResult`, `call`, `inventoryByDef`. |
| `client.d.ts` | Hand-written TypeScript declarations, styled after steamworks.js's own `client.d.ts`. |
| `docs/` | Valve's five schema pages, mirrored, plus `coverage.md`. |

## Implemented semantics

### Exchange: first-match recipes, max-flow materials

`ExchangeItems` has two structurally different modes behind one call, and the engine forks between
them once the offered materials are resolved: the tag-tool path, and the recipe path.

On the recipe path, recipes are tried **in order** and the first one satisfied by the materials
given is the one that runs. Recipe order is load-bearing — the example economy contains two
itemdefs with the same pair of recipes in opposite orders, precisely so that a change in selection
shows up as a failing test.

Deciding whether the offered stacks satisfy a recipe is an **assignment problem, not a greedy
walk**. One stack can satisfy several operands: an item tagged `rarity:common;band:1` matches both
operands of `rarity:common*1,band:1*1`, while a `rarity:common` item matches only the first. A
greedy pass that spends the first stack on the first operand then reports a satisfiable recipe
unsatisfiable. So `lib/matching.js` solves it exactly, as max flow on a tiny bipartite graph:

```
source → offer_i     capacity = quantity offered
offer_i → operand_j  capacity = min(offer, demand), edge exists only if the stack matches
operand_j → sink     capacity = required quantity
```

The recipe is satisfied iff the flow saturates total demand, and the flow on the middle edges *is*
the consumption plan — the same computation answers both questions. Recipes top out at a handful of
operands, so plain Edmonds–Karp is far more than fast enough.

Operands match against an item's **effective** tags: the union of its itemdef's tags and its
per-item tags. Checking itemdef tags alone would make instance-tagged items silently fail recipes
that work on real Steam.

### Bundles, generators and tag generators

Grants expand recursively. A `bundle` grants every entry; a `generator` or `playtimegenerator`
reads the same `bundle` field as relative weights and picks exactly one entry per grant. Tags on
any node of that chain are inherited by everything created beneath it. A cycle the schema validator
cannot see statically is caught by `maxExpansionDepth` (24). A `tag_generator` grants nothing
itself — it exists to be rolled for a tag value by the node referencing it.

`auto_stack` merges a grant into an existing stack only when the **stack key** matches: same
itemdef *and* the same per-item tags. Two Alphas with different rolled tags are two stacks, because
merging them would have to discard one side's tags. `TransferItemQuantity` enforces the same
identity on a merge, and splits into a fresh instance when given no destination.

### Playtime drops and promo grants

`TriggerItemDrop` is gated on the virtual clock's **playtime**, `drop_window` and `drop_start_time`
on its **wall time**; `advanceTime(minutes, { playing: false })` moves the second without the first,
which is how you model time passing between sessions. Not being eligible is not an error — Steam
returns a valid empty result — so callers check `granted`, or equivalently `items.length`.
`drop_max_per_window` is capped at 10 per window whatever the itemdef says, per Valve.

Promo rules (`owns:`, `ach:`, `played:`, `manual`) are OR-ed. A promo grants once per account unless
it is `manual` *and* carries a `drop_interval`, which is the only shape that recurs. `granted_manually`
excludes an itemdef from a `GrantPromoItems` sweep without excluding it from an explicit
`AddPromoItem`. `describeDrop()` and `describePromo()` on the engine are non-mutating eligibility
checks that return the reason as a sentence — useful in a simulator, and not part of `ISteamInventory`.

### Transactions are journalled, not snapshotted

Real `ExchangeItems` is atomic — Valve documents it, and the whole `requires`-style pattern (name
an item in the recipe and re-issue it in the bundle, so ownership is checked without the item being
spent) depends on it. Every operation here runs inside a transaction, and every mutation records
its own undo closure on a journal. Rollback replays the journal backwards.

Rollback also **restores the RNG**, whose entire state is one 32-bit integer. Without that, a
generator roll inside a failed exchange would consume randomness that the retry then never sees,
and a seeded replay would desynchronise from the run it was meant to reproduce. A failed call
leaves the inventory byte-identical — `npm run demo` asserts exactly that on an underfunded
exchange.

### Item flags carry row provenance

`SteamItemDetails_t::m_unFlags` describes *why a row is in this result set*, not what the item is —
so the flags are set at the point the engine empties, spends or destroys an instance, and never
inferred downstream from `quantity === 0`. That inference cannot be made: a row at zero is a
consumed stack, a stack spent as exchange material, or the source of a split that emptied, and
those are three different flags on one indistinguishable row.

This matters more than it sounds. Painting a hat with a paint can under the default
`toolResultPolicy` returns three rows:

```
itemdefid 9100  id 4  quantity 0  flags 768  ''                  the tool, consumed and gone
itemdefid 9101  id 5  quantity 0  flags 256  ''                  the target, destroyed
itemdefid 9101  id 6  quantity 1  flags   0  'paint_color:red'   the replacement
```

Two rows share an itemdefid, so `result.find(i => i.itemDefId === 9101)` is a coin flip between a
live item and a dead id. `ItemRemoved` (`1 << 8`, the `256` above) is the only thing that tells them
apart. `NoTrade` (`1 << 0`) is the odd one out — a fact about the *definition*, read back through
`GetItemDefinitionProperty("tradable")` rather than recorded per operation, which is why the façade
adds it and the handle-based rows above, which come straight off the engine, do not.

**One real semantic gap.** Valve's `k_ESteamItemRemoved` also covers an item **traded away** or
**expired**. This library models neither trading nor item expiry, so no row will ever carry the bit
for those reasons: here `ItemRemoved` means "this call removed it" and never "someone else took
it". A client that reads the flag as Valve defines it will see a strictly narrower set of cases
here than in production, and code that handles the trade case will never be exercised.

## Dynamic properties

Valve's "arbitrary string, integer, boolean, or float properties on any item instance", with the
full staging cycle: `startUpdateProperties()` returns a handle, `setProperty` /
`setPropertyString|Int|Bool|Float` / `removeProperty` accumulate a batch client-side and return
`bool`, and `submitUpdateProperties(handle)` applies it in one transaction that rolls back whole.

```js
const h = client.inventory.startUpdateProperties();
client.inventory.setPropertyInt(h, itemId, 'enchant_level', 3);   // → true, or false and no reason

// Mock-only: what the batch has staged, and why the last set was refused.
// Steam's SetProperty returns a bare bool and no explanation.
client.mock.describeUpdate(h);           // → { handle: 1, itemCount: 1, editCount: 1, lastError: null }

const rows = await client.inventory.submitUpdateProperties(h);
rows[0].dynamicProps;                    // → { enchant_level: 3 }
```

`int` and `float` are genuinely different types — Valve exposes separate overloads and the
white-list carries a type per property, so a white-list declaring `float` refuses an int. JS has one
number type, so inference alone cannot express the distinction: `setProperty` infers, while
`setPropertyInt` / `setPropertyFloat` state it, and `properties.intProperty(1)` /
`properties.floatProperty(1)` construct a value that carries its type. The namespace is exported
unflattened deliberately — a bare `intProperty` in a client's import list does not read as the
deliberate type choice it is. The 1024-byte cap is measured on the emitted JSON in **bytes**, not
characters, so a non-Latin value costs what it really costs; exceeding it, or exceeding 100 items
in one call, fails with `LIMIT_EXCEEDED`.

Property names are validated against `[a-zA-Z0-9._-]+`, derived from Valve's own `%token%`
replacement regex read literally rather than as a character range — the narrow reading is the one
that cannot admit a name real Steam refuses.

Not modelled: `%token%` substitution into an item's description (web-view rendering, which nothing
here does), trading clearing an item's properties (there is no trading), and Steam's per-user rate
limit on property modification (no published window). And see the `propertyWhitelist` warning
above — the default is permissive, real Steam is not.

## Tag tools and accessories

A `tag_tool` is applied through `ExchangeItems` by naming the **target's own itemdefid** as the
thing to generate and passing the tool and the target as materials. The engine detects that shape
and forks off the recipe path — which is why a target with no `exchange` formula at all, like
Valve's hat, works.

The sequence: strip every tag matching `tags_to_remove_on_tool_use` (a bare category, or a full
`category:value`), roll any referenced `tag_generators`, merge the tool's own `tags` and the rolled
values onto what survived. The target opts in per category via `allowed_tags_from_tools`; a refusal
does **not** consume the tool. `accessory_tag` marks a category as an accessory slot and
`accessory_limit` caps it (default 4); each attached accessory's tag value must name a known
itemdefid, and attaching a duplicate is refused rather than silently ignored, per Valve.

Two readings here are unconfirmed. `toolResultPolicy` is [the sharp one](#six-behaviours-are-encoded-guesses-and-you-inherit-them).
The other: an item's `accessory_tag` category is treated as implicitly writable by tools even when
`allowed_tags_from_tools` does not repeat it. Valve does not say either way; the strict reading
would make an item declaring only `accessory_tag` inert, which no schema author writing that field
could plausibly intend.

## Save and load

There is no server behind the mock, so the save file *is* the account. A complete save is three
things that must move together — the account (instances with their per-item tags and dynamic
properties, drop buckets, promo history, entitlements), the clock (wall time and accrued playtime),
and the RNG. Restoring the account alone would reset every `drop_interval` and promo recurrence
timer to zero; restoring without the RNG would let a seeded run replay with different rolls after a
restart.

```js
client.mock.saveToFile('player.json');
client.mock.loadFromFile('player.json');          // or save()/load() for plain JSON
```

The envelope carries `kind: 'steam-inventory-mock.save'` and `version`, currently **2**. A version
this build does not recognise is a hard, named error (`err.code === 'SAVE_UNSUPPORTED'`) rather than
a best effort, because these files live on players' machines and a silently mis-read save corrupts
an inventory nobody can rebuild. Older payloads are brought forward through `MIGRATIONS`, applied in
sequence; the one entry, 1 → 2, gives every instance a `dynamicProps` map. It is a normalisation
rather than a rescue — `ItemInstance.fromJSON` already reads a missing field as empty — and it earns
its keep by making a migrated v1 save and a native v2 save the same bytes, which is what makes
diffing two saves evidence of anything. Validation happens before anything is mutated, so a bad save
leaves the engine as it was. An instance whose itemdef has since been deprecated is an error by
default, or droppable with `{ onUnknownItemdef: 'drop' }`.

**The instance-id watermark** is the part worth understanding. The id counter is module-level:
process-global, and not part of the account. Reload without saving it and ids restart at 1 while the
restored inventory already holds 1..N. **Nothing throws.** Two different items answer to one
identity, and later an exchange consumes the wrong one, or two stacks merge, or the item the player
clicked is not the item that is spent — silent corruption, discovered long after the save that
caused it. So the counter is saved, and on load it is *raised* to the maximum of where it already
is, the saved counter, and one past the highest restored id. The saved counter matters beyond
max+1: ids that were allocated and then consumed are gone from the inventory but are not free, and
Steam never reissues an item instance id.

That failure mode is invisible in-process, because a module-level counter never restarts inside one
run. So it is proven by a test that writes a save, then loads it in a **child `node` process** —
which is what an application restart actually is — and asserts the id issued afterwards collides
with nothing restored. `npm run demo:save-load` does the same and prints both halves.

Result handles are deliberately not saved: a handle is a pointer into a live result set, meaningless
once the process that issued it is gone. Real Steam's handles do not survive a restart either.

## Test-mode gating bypass

Two engine options, both defaulting to `false`, and neither safe to ship enabled:

```js
const previous = client.mock.bypassDropGating(true);   // returns the setting it replaced
client.mock.bypassPromoGating(true);
```

`bypassDropGating` reports every `playtimegenerator` as immediately eligible — no `drop_interval`
wait, no `drop_limit`, no `drop_max_per_window` cooldown — so a tester can claim supply drops on
demand. The `type !== 'playtimegenerator'` check still applies: this does not turn `triggerItemDrop`
into a free-form grant (`generateItems` is that, and it is sandbox-only on Steam). Bookkeeping stays
consistent either way, so a bypassed grant still updates the bucket.

`bypassPromoGating` ignores the once-per-account record and the `manual` + `drop_interval`
recurrence wait. Rule satisfaction (`owns:` / `ach:` / `played:` / `manual`) and `drop_start_time`
still apply — **this bypasses the waiting, not the entitlement.**

Real Steam enforces all of this server-side and offers no override, which is why the
`gatingBypass` capability is false for any real provider and the tests pinning these options skip
there.

## Verification

```
npm test                  # 308 tests, 308 pass, 0 fail, 0 skipped — ~0.5s
npm run test:unit         # 125
npm run test:conformance  # 183 against the `mock` target
```

Node's built-in test runner, no framework, no dependencies. The conformance suite reports **0
skipped** because `MockProvider` advertises every capability; against a real binding the skip count
is the honest measure of what remains unverified.

Three demos, all against `examples/economy.js`:

```
npm run demo               # node demo/playthrough.js [seed]
npm run demo:save-load     # node demo/save-load.js [seed]
npm run demo:distribution  # node demo/distribution.js [itemdefid] [rolls] [seed]
```

`demo` is the worked API example, through the façade: claim a promo and watch a second claim grant
nothing, run a successful exchange, watch an underfunded one fail with the inventory byte-identical
afterwards, paint an item with a tag tool and read the per-item tag back, stamp a dynamic property
and read that back, then take a playtime drop through the virtual clock — refused at t+0, granted at
t+30, refused again immediately after. It ends by printing `17` `SteamInventoryResultReady`
callbacks observed and `0` undestroyed result handles.

`demo:save-load` plays a short session, writes a 1,456-byte v2 save (`rng=3208825046`,
`nextInstanceId=5`, `clock: playtimeMinutes=30`), loads it into a fresh provider built with a
*different* seed, and compares everything that has to survive a restart — inventory, per-item tags,
dynamic properties, account payload, clock, RNG state, drop bucket, the drop cool-down and its
expiry, promo history — then repeats the load in a child process to check the watermark from a
genuinely cold start.

`demo:distribution` rolls itemdef 9030 (`bundle: '9001x70;9002x20;9003x10'`) 20,000 times under seed
`"distribution"`:

```
Outcome        weight   expected   observed    error
Alpha              70     70.00%     69.64%    -0.360pp
Beta               20     20.00%     20.00%     0.000pp
Gamma              10     10.00%     10.36%     0.360pp

same seed  → identical distribution: yes
other seed → different distribution: yes
```

Both properties are preconditions for using the engine as a balance simulator: the roll is unbiased
with respect to the declared weights, and it is exactly reproducible from the seed.
