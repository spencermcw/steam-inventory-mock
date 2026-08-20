# ISteamInventory coverage

What this library implements, and what it does not. Authoritative — the README summarises this file.

Status key: **yes** implemented · **no** not implemented · **n/a** cannot be meaningfully mocked

Source: [ISteamInventory](https://partner.steamgames.com/doc/api/ISteamInventory) plus the five
schema pages mirrored in this directory.

## Result management

| Steam | Here | Status |
|---|---|---|
| `GetResultStatus` | `getResultStatus(handle)` | yes |
| `GetResultItems` | `getResultItems(handle)` | yes |
| `GetResultItemProperty` | `getResultItemProperty(handle, index, prop)` | yes — incl. `tags` and `dynamic_props` |
| `GetResultTimestamp` | `getResultTimestamp(handle)` | yes — virtual-clock stamped |
| `CheckResultSteamID` | `checkResultSteamID(handle, accountId)` | yes |
| `DestroyResult` | `destroyResult(handle)` | yes — leaks tracked by `leakedResults()` |
| `SerializeResult` / `DeserializeResult` | — | no — for handing a result to a game server to verify; there is no server here |

## Inventory queries

| Steam | Here | Status |
|---|---|---|
| `GetAllItems` | `getAllItems()` | yes |
| `GetItemsByID` | `getItemsByID(ids)` | yes |
| `GetItemDefinitionIDs` | `getItemDefinitionIDs()` | yes — synchronous, as on Steam |
| `GetItemDefinitionProperty` | `getItemDefinitionProperty(id, prop)` | yes — synchronous, as on Steam |
| `LoadItemDefinitions` | `loadItemDefinitions()` | yes — with a `deferDefinitions` option to model the pre-load window |

## Grants

| Steam | Here | Status |
|---|---|---|
| `AddPromoItem` | `addPromoItem(defId)` | yes |
| `AddPromoItems` | `addPromoItems(defIds)` | yes — one transaction |
| `GrantPromoItems` | `grantPromoItems()` | yes — respects `granted_manually` |
| `RequestEligiblePromoItemDefinitionsIDs` | `requestEligiblePromoItemDefinitionsIDs()` | yes |
| `GetEligiblePromoItemDefinitionIDs` | `getEligiblePromoItemDefinitionIDs()` | yes |
| `GenerateItems` | `generateItems(defIds, quantities)` | yes — sandbox-only on Steam, and here too |

## Exchange, consume, drops

| Steam | Here | Status |
|---|---|---|
| `ExchangeItems` — recipe path | `exchangeItems(target, materials)` | yes — first-match selection, max-flow material assignment |
| `ExchangeItems` — `tag_tool` path | same call, forked on tool detection | yes — see Tag tools below |
| `ConsumeItem` | `consumeItem(itemId, qty)` | yes |
| `TransferItemQuantity` | `transferItemQuantity(src, qty, dest)` | yes — split and merge, tag identity enforced |
| `TriggerItemDrop` | `triggerItemDrop(defId)` | yes — against the virtual clock |
| `SendItemDropHeartbeat` | `sendItemDropHeartbeat()` | yes — no-op; deprecated by Valve |

## Dynamic properties

| Steam | Here | Status |
|---|---|---|
| `StartUpdateProperties` | `startUpdateProperties()` | yes |
| `SetProperty` (string/int/bool/float) | `setProperty(h, itemId, name, value)` | yes — type inferred, explicit variants available |
| `RemoveProperty` | `removeProperty(h, itemId, name)` | yes |
| `SubmitUpdateProperties` | `submitUpdateProperties(h)` | yes — transactional, rolls back whole |
| 100 items/call, 1024 bytes/item limits | enforced | yes — `LIMIT_EXCEEDED` |
| Client property whitelist + tag restrictions | `propertyWhitelist` option | yes — off by default; partner-site config the mock cannot know |
| Cleared on trade | — | n/a — no trading here |
| `%token%` description substitution | — | n/a — web-view rendering |

## Tag tools and accessories

| Steam | Here | Status |
|---|---|---|
| `tag_tool` item type | yes | yes |
| `tags_to_remove_on_tool_use` | yes | yes — bare category or full `category:value` |
| `allowed_tags_from_tools` | yes | yes — failure does not consume the tool |
| `tag_generators` on a tool | yes | yes |
| `accessory_tag` / `accessory_limit` | yes | yes — default limit 4; duplicates refused |
| `accessory_description_<lang>` | — | n/a — web-view rendering |

## Prices and purchase — **not implemented**

| Steam | Status |
|---|---|
| `RequestPrices`, `GetNumItemsWithPrices`, `GetItemsWithPrices`, `GetItemPrice` | no |
| `StartPurchase` | no — opens a real overlay transaction; a mock could only fake the `EResult` |
| `price`, `price_category`, `store_tags`, `store_images`, `store_hidden`, `use_bundle_price`, `purchase_bundle_discount`, `purchase_limit` | parsed into `ItemDef.raw` and readable, but inert |

The **Community Market** is likewise entirely out of scope: no order book, no listings, no price
discovery, no fees, no liquidity.

## Callbacks

| Steam | Here | Status |
|---|---|---|
| `SteamInventoryResultReady_t` | `resultReady` / `SteamCallback.SteamInventoryResultReady` | yes |
| `SteamInventoryFullUpdate_t` | `fullUpdate` | yes |
| `SteamInventoryDefinitionUpdate_t` | `definitionUpdate` | yes |
| `SteamInventoryEligiblePromoItemDefIDs_t` | `eligiblePromoItemDefIDs` | yes |
| `SteamInventoryStartPurchaseResult_t` | — | no — purchase is out of scope |
| `SteamInventoryRequestPricesResult_t` | — | no — pricing is out of scope |

## Itemdef schema fields

Parsed into structure and acted on: `itemdefid`, `type`, `name`, `description`, `tags`,
`tag_generators`, `tag_generator_name`, `tag_generator_values`, `exchange`, `bundle`, `promo`,
`drop_start_time`, `auto_stack`, `tradable`, `marketable`, `hidden`, `game_only`, `quantity`,
`container_contents_generator`, `use_drop_limit`, `drop_limit`, `drop_interval`, `use_drop_window`,
`drop_window`, `drop_max_per_window`, `granted_manually`, `tags_to_remove_on_tool_use`,
`allowed_tags_from_tools`, `accessory_tag`, `accessory_limit`.

Every other field — including all extended/custom properties you define — is preserved on
`ItemDef.raw` and readable through `getItemDefinitionProperty`, exactly as Steam returns extended
schema properties.

## Not modelled at all

Trading between accounts, the Community Market, the Item Store and checkout, Workshop items,
localisation (`name_<lang>` and friends are readable but never selected between), icon/image hosting,
and the `IInventoryService` Web API.
