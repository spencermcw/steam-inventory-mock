# Reference documentation

> **In the npm package, only `coverage.md` from this directory is present.** The Valve pages listed
> below are mirrored in the git repository for offline reference and are not redistributed — follow
> the links to read them. (npm includes every `README.md` it finds, which is why this file ships
> even though the pages it describes do not.)

Local copies of Valve's public Steamworks documentation for the Inventory Service, saved so the
behaviour this library emulates can be checked against its source without a network round trip.

Retrieved **19 August 2026** from `https://partner.steamgames.com`:

| File | Source |
|---|---|
| `schema.html` | [/doc/features/inventory/schema](https://partner.steamgames.com/doc/features/inventory/schema) — itemdef schema, bundle/generator format, exchange formulas, promo rules, playtime item drops, pricing |
| `itemtags.html` | [/doc/features/inventory/itemtags](https://partner.steamgames.com/doc/features/inventory/itemtags) — item tag format, per-item tags, `tag_generator` |
| `dynamicproperties.html` | [/doc/features/inventory/dynamicproperties](https://partner.steamgames.com/doc/features/inventory/dynamicproperties) — `dynamic_props`, update handles, whitelisting, tag restrictions |
| `accessories.html` | [/doc/features/inventory/accessories](https://partner.steamgames.com/doc/features/inventory/accessories) — `accessory_tag`, `accessory_limit`, single-use accessories via `tag_tool` |
| `tools.html` | [/doc/features/inventory/tools](https://partner.steamgames.com/doc/features/inventory/tools) — `tag_tool`, `tags_to_remove_on_tool_use`, `allowed_tags_from_tools` |

The API surface itself is documented at
[/doc/api/ISteamInventory](https://partner.steamgames.com/doc/api/ISteamInventory), which is not
mirrored here.

**`coverage.md`** in this directory is ours, not Valve's: it records exactly which parts of
`ISteamInventory` this library implements and which it does not.

These pages are Valve's copyright and are kept here for reference only. They are excluded from the
published package (see `files` in `package.json`).
