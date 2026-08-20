'use strict';

/**
 * example-steam-target.js
 *
 * A runnable template for pointing the conformance suite at a real
 * ISteamInventory binding. Copy it into your own project, change the two
 * marked lines, and run:
 *
 *   node node_modules/steam-inventory-mock/test/conformance-report.js --target ./steam-target.js
 *
 * It is honest about what it is: there is no Steam in this file and it cannot
 * talk to one. Every capability is declared false, so the suite skips every
 * test and runs none — and that is precisely what makes it useful unchanged:
 * it proves the registration mechanism works end to end, and its output is the
 * shape of the report you will get on the day your binding registers for real
 * but has nothing wired up yet.
 *
 * The provider it hands back extends InventoryProvider, so it satisfies
 * assertProviderShape (every method exists) and throws 'not implemented' the
 * moment anything actually calls one. Nothing calls one here, because nothing
 * is declared supported. That is the invariant this design rests on: a target
 * is exercised exactly as far as it claims it can go.
 */

// In your own copy: require('steam-inventory-mock')
const { InventoryProvider } = require('../index');

// ─── The provider under test ──────────────────────────────────────────────────

class SteamProviderTemplate extends InventoryProvider {
  constructor(options = {}) {
    super();
    this.options = options;
    // Replace the whole class with your binding — this file exists so that
    // `create()` below has something structurally valid to return:
    //
    //   const { SteamProvider } = require('./native/steam-provider');
    //
    // Every inventory method must return a *handle* and deliver its result
    // through the 'resultReady' event, exactly as ISteamInventory does. See
    // lib/provider-interface.js for the full list, and
    // test/conformance/provider-contract.test.js for the tests that pin it.
  }
}

// ─── The target ───────────────────────────────────────────────────────────────

module.exports = {
  name: 'steam',

  /**
   * Every flag in CAPABILITIES, answered explicitly. Registration is refused if
   * one is missing: an omitted flag reads as absent, skips every test that
   * wants it, and lets the suite report green by not running. The reasoning
   * matters more than the value — a flag you cannot justify is a flag you have
   * not thought about.
   */
  capabilities: {
    // You cannot time-travel live Steam.
    virtualClock: false,
    // A real provider loads the app's uploaded itemdefs, not a fixture.
    customSchema: false,
    // GenerateItems is sandbox-only (apps in development), not something a
    // live provider can invoke.
    sandboxGrants: false,
    // Drops and generator rolls happen server-side; there is no seed to fix
    // them against.
    deterministicRng: false,
    // Steam answers with an EResult, not a human-readable sentence.
    failureReasons: false,
    // drop_interval / drop_limit / promo recurrence are enforced server-side;
    // there is no client override to exercise.
    gatingBypass: false,
    // Steam does exactly one of the two documented tag_tool outcomes and
    // cannot be told which, so the tests pinning both readings must skip.
    configurableToolResult: false,
    // Steam holds the inventory server-side and neither hands it over nor
    // takes it back.
    persistence: false,
    // Steam's surplus behaviour is fixed and unmeasured.
    configurableSurplus: false,
    // An account's owned apps, achievements and playtime are facts, not
    // something a test can arrange.
    entitlements: false,

    // The last two are NOT mock-only conveniences: real Steam supports both,
    // so a finished binding advertises them true and lets those tests run.
    // They are false here only because this template wires up nothing.
    //
    // AddPromoItems / GrantPromoItems / RequestEligiblePromoItemDefinitionsIDs
    // / GetEligiblePromoItemDefinitionIDs.
    promoGrantAll: false,
    // StartUpdateProperties / SetProperty / RemoveProperty /
    // SubmitUpdateProperties, and GetResultItemProperty serving "dynamic_props".
    dynamicProperties: false,
  },

  /**
   * Build a provider for one test. The suite passes engine-level options the
   * mock understands (`schema`, `seed`, `surplusPolicy`, …); a real target
   * declines those by declaring the matching capability false, so whatever
   * arrives here is only what your capabilities admitted.
   */
  create(options = {}) {
    // Replace with: return new SteamProvider(options);
    return new SteamProviderTemplate(options);
  },
};
