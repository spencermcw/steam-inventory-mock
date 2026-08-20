'use strict';

/**
 * engine.js
 *
 * The inventory engine: exchange resolution, recursive bundle/generator
 * expansion, per-item tag propagation, playtime drops and promo grants.
 *
 * This is the piece that is shared, deliberately, between the mock provider and
 * the balance simulator. The provider (provider.js) wraps it in Steam's async,
 * handle-based skin; the simulator drives it directly, synchronously, millions
 * of times. Built once, they cannot drift — and a simulator that drifts from the
 * shipped engine validates an economy nobody plays.
 *
 * Every operation is transactional. Real ExchangeItems is atomic (Valve,
 * documented), and the whole `requires` ownership-check pattern depends on it.
 *
 * Where Steam's behaviour is documented, we follow the document. Where it is
 * not, the choice is an explicit, named option and the guess is recorded in
 * mock/README.md under "Encoded guesses".
 */

const { loadSchema } = require('./schema');
const { Account, stackKeyFor } = require('./inventory');
const { Rng } = require('./rng');
const { VirtualClock, MS_PER_MINUTE } = require('./clock');
const { assignMaterials } = require('./matching');

// ─── Result codes ─────────────────────────────────────────────────────────────

/** Subset of Steam's EResult that inventory calls actually surface. */
const RESULT = {
  OK: 1,
  FAIL: 2,
  INVALID_PARAM: 8,
  INVALID_STATE: 11,
  LIMIT_EXCEEDED: 25,
};

const DEFAULT_OPTIONS = {
  /**
   * What happens to materials passed to ExchangeItems beyond what the winning
   * recipe requires. UNVERIFIED against real Steam (see "Semantics that must be
   * verified" in wiki/Tech/Provider Architecture.md).
   *   'consume' — consume everything passed (Valve's wording, and the default:
   *               a client written against it is correct under either reading)
   *   'ignore'  — consume only what the recipe calls for
   *   'strict'  — reject the call, to catch sloppy material lists in dev
   */
  surplusPolicy: 'consume',

  /**
   * Whether playtime beyond drop_interval banks toward the next drop.
   * UNVERIFIED. false = surplus playtime is discarded at grant time.
   */
  bankPlaytime: false,

  /** App-level Playtime Item Grants settings (Steamworks → Inventory Service). */
  appDropSettings: {
    dropInterval: 30,
    useDropWindow: false,
    dropWindow: 1440,
    dropMaxPerWindow: 1,
    useDropLimit: false,
    dropLimit: 0,
  },

  /** Guard against a bundle cycle the schema validator cannot see statically. */
  maxExpansionDepth: 24,

  /**
   * Test-mode only. When true, `describeDrop` reports every `playtimegenerator`
   * as immediately eligible — no drop_interval wait, no drop_limit, no
   * drop_max_per_window cooldown — so a tester can claim supply drops and other
   * playtime grants on demand. `type !== 'playtimegenerator'` is still enforced;
   * this does not turn triggerItemDrop into a free-form item grant (see
   * generateItems for that). Production default is false; never enable outside
   * a dev/QA build. See mock/README.md ("Test-mode gating bypass").
   */
  bypassDropGating: false,

  /**
   * Test-mode only, sibling to bypassDropGating. When true, `describePromo`
   * ignores the once-per-account record and the `manual` + drop_interval
   * recurrence wait, so a tester can re-claim a promo (e.g. the new-player
   * promo) repeatedly. Rule satisfaction (`owns:` / `ach:` / `played:` /
   * `manual`) and `drop_start_time` still apply — this bypasses the *waiting*,
   * not entitlement checks. Production default is false.
   */
  bypassPromoGating: false,
};

/** Valve: "Limited at 10 per window." */
const MAX_DROPS_PER_WINDOW = 10;

// ─── Engine ───────────────────────────────────────────────────────────────────

class Engine {
  /**
   * @param {object} [options]
   * @param {string|object} [options.schema] path to dist/itemdefs.json, a parsed
   *   schema object, or a Schema instance
   * @param {number|string} [options.seed=0]
   * @param {VirtualClock} [options.clock]
   */
  constructor(options = {}) {
    const { schema, seed = 0, clock, ...rest } = options;

    this.schema =
      schema && typeof schema.get === 'function' && typeof schema.all === 'function'
        ? schema
        : loadSchema(schema, options);

    this.rng = new Rng(seed);
    this.clock = clock || new VirtualClock();
    this.options = {
      ...DEFAULT_OPTIONS,
      ...rest,
      appDropSettings: { ...DEFAULT_OPTIONS.appDropSettings, ...(rest.appDropSettings || {}) },
    };
    this.accounts = new Map();
  }

  // ── Accounts ──

  createAccount(id = 'player') {
    if (this.accounts.has(id)) throw new Error(`Account "${id}" already exists`);
    const account = new Account(id);
    this.accounts.set(id, account);
    return account;
  }

  account(id = 'player') {
    return this.accounts.get(id) || this.createAccount(id);
  }

  // ── Time ──

  advanceTime(minutes, opts) {
    this.clock.advance(minutes, opts);
    return this;
  }

  // ── Result helpers ──

  _ok(items, extra = {}) {
    return { status: RESULT.OK, ok: true, items, reason: null, ...extra };
  }

  _fail(status, reason) {
    return { status, ok: false, items: [], reason };
  }

  /**
   * Run `body` inside a transaction. Any throw, or any falsy-ok result, rolls
   * back inventory state *and* the RNG, so a failed generator roll does not
   * silently consume randomness and desynchronise a replay.
   */
  _transact(account, body) {
    const rngState = this.rng.save();
    account.begin();
    let result;
    try {
      result = body();
    } catch (err) {
      account.rollback();
      this.rng.restore(rngState);
      throw err;
    }
    if (result && result.ok) {
      account.commit();
    } else {
      account.rollback();
      this.rng.restore(rngState);
    }
    return result;
  }

  // ── Tags ──

  /**
   * The effective tag set of an item instance: the union of its itemdef's tags
   * and its per-item tags. Recipe operands like `rarity:common*5` match against
   * this union — checking itemdef tags alone would make instance-tagged items
   * silently fail recipes that work on real Steam.
   */
  effectiveTags(instance) {
    const def = this.schema.get(instance.itemdefid);
    const tokens = new Set(def ? def.tagTokens : []);
    for (const tag of instance.tags) tokens.add(`${tag.key}:${tag.value}`);
    return tokens;
  }

  /** Roll one value from each referenced tag_generator. */
  _rollTagGenerators(ids) {
    const rolled = [];
    for (const id of ids) {
      const def = this.schema.get(id);
      if (!def || def.type !== 'tag_generator' || def.tagGeneratorValues.length === 0) continue;
      const pick = this.rng.pickWeighted(def.tagGeneratorValues, e => e.chance);
      if (pick) rolled.push({ key: def.tagGeneratorName, value: pick.value });
    }
    return rolled;
  }

  // ── Granting ──

  /**
   * Grant `quantity` of an itemdef, expanding complex types recursively.
   *
   * @param {Array<{key,value}>} inheritedTags per-item tags accumulated from the
   *   generator/bundle chain above this node. Valve: tags on a generator,
   *   playtimegenerator or bundle are copied wholesale onto created items and
   *   persist across ownership changes.
   */
  _grant(account, itemdefid, quantity, inheritedTags, touched, depth = 0) {
    if (depth > this.options.maxExpansionDepth) {
      throw new Error(`Bundle expansion exceeded depth ${this.options.maxExpansionDepth} at itemdef ${itemdefid}`);
    }
    const def = this.schema.get(itemdefid);
    if (!def) throw new Error(`Grant of unknown itemdefid ${itemdefid}`);

    if (def.type === 'tag_generator') {
      // Applies tags to other items; grants nothing itself.
      return;
    }

    if (def.isComplex) {
      const tags = mergeTags(inheritedTags, def.tags, this._rollTagGenerators(def.tagGenerators));

      if (def.type === 'bundle') {
        for (const entry of def.bundle) {
          this._grant(account, entry.itemdefid, entry.quantity * quantity, tags, touched, depth + 1);
        }
        return;
      }

      // generator / playtimegenerator: the bundle field carries relative
      // weights, and exactly one entry is selected per grant.
      for (let n = 0; n < quantity; n++) {
        const pick = this.rng.pickWeighted(def.bundle, e => e.quantity);
        if (!pick) throw new Error(`Generator ${def.itemdefid} has no selectable entries`);
        this._grant(account, pick.itemdefid, 1, tags, touched, depth + 1);
      }
      return;
    }

    this._instantiate(account, def, quantity, inheritedTags, touched);
  }

  /** Create or stack-merge concrete item instances. */
  _instantiate(account, def, quantity, inheritedTags, touched) {
    // Tags already on the itemdef need not be repeated on the instance: the
    // effective set is the union either way.
    const instanceTags = inheritedTags.filter(t => !def.tagTokens.has(`${t.key}:${t.value}`));

    if (def.autoStack) {
      const wanted = stackKeyFor(def.itemdefid, instanceTags);
      const existing = account.instancesOf(def.itemdefid).find(i => i.stackKey() === wanted);
      if (existing) {
        account.setQuantity(existing, existing.quantity + quantity);
        touched.add(existing);
        return;
      }
      const created = account.createInstance(def.itemdefid, quantity, instanceTags, this.clock.now());
      touched.add(created);
      return;
    }

    // Without auto_stack each grant is its own item instance.
    for (let n = 0; n < quantity; n++) {
      touched.add(account.createInstance(def.itemdefid, 1, instanceTags, this.clock.now()));
    }
  }

  // ── GetAllItems ──

  getAllItems(account) {
    return this._ok(account.list().map(i => i.toResult()));
  }

  // ── ExchangeItems ──

  /**
   * @param {Account} account
   * @param {number} targetItemDefId the single item to generate (Steam requires
   *   the generate array to be size 1, quantity 1)
   * @param {Array<{itemId:number, quantity:number}>|number[]} materials
   */
  exchangeItems(account, targetItemDefId, materials) {
    const target = this.schema.get(targetItemDefId);
    if (!target) return this._fail(RESULT.INVALID_PARAM, `Unknown target itemdefid ${targetItemDefId}`);
    if (target.exchange.length === 0) {
      return this._fail(RESULT.INVALID_PARAM, `itemdef ${targetItemDefId} has no exchange formula`);
    }

    // Aggregate the offered material list by instance id.
    const offered = new Map();
    for (const entry of materials || []) {
      const itemId = Number(typeof entry === 'object' ? entry.itemId : entry);
      const quantity = typeof entry === 'object' && entry.quantity != null ? Number(entry.quantity) : 1;
      if (!Number.isFinite(itemId) || !Number.isFinite(quantity) || quantity <= 0) {
        return this._fail(RESULT.INVALID_PARAM, `Malformed material entry ${JSON.stringify(entry)}`);
      }
      offered.set(itemId, (offered.get(itemId) || 0) + quantity);
    }
    if (offered.size === 0) return this._fail(RESULT.INVALID_PARAM, 'No materials supplied');

    const offers = [];
    for (const [itemId, quantity] of offered) {
      const instance = account.get(itemId);
      if (!instance) return this._fail(RESULT.INVALID_PARAM, `Item instance ${itemId} not in inventory`);
      if (instance.quantity < quantity) {
        return this._fail(
          RESULT.INVALID_PARAM,
          `Item instance ${itemId} holds ${instance.quantity}, ${quantity} offered`
        );
      }
      offers.push({ instance, available: quantity, tokens: this.effectiveTags(instance) });
    }

    // First-match recipe selection: Steam checks each recipe in order and takes
    // the FIRST satisfied by the materials given. Recipe order is load-bearing.
    let chosen = null;
    let chosenIndex = -1;
    for (let r = 0; r < target.exchange.length; r++) {
      const recipe = target.exchange[r];
      const plan = assignMaterials(offers, recipe, (i, j) => {
        const operand = recipe[j];
        return operand.kind === 'def'
          ? offers[i].instance.itemdefid === operand.itemdefid
          : offers[i].tokens.has(operand.token);
      });
      if (plan) {
        chosen = plan;
        chosenIndex = r;
        break;
      }
    }
    if (!chosen) {
      return this._fail(RESULT.FAIL, `No recipe of itemdef ${targetItemDefId} is satisfied by the materials given`);
    }

    // Surplus handling — see options.surplusPolicy.
    const consumption = offers.map((offer, i) => {
      const matched = chosen.consumed[i];
      if (this.options.surplusPolicy === 'ignore') return matched;
      return offer.available;
    });
    if (this.options.surplusPolicy === 'strict') {
      const surplus = offers
        .map((offer, i) => (offer.available > chosen.consumed[i] ? offer.instance.itemId : null))
        .filter(Boolean);
      if (surplus.length > 0) {
        return this._fail(
          RESULT.INVALID_PARAM,
          `Surplus materials offered (instances ${surplus.join(', ')}); surplusPolicy is "strict"`
        );
      }
    }

    return this._transact(account, () => {
      const touched = new Set();
      for (let i = 0; i < offers.length; i++) {
        const amount = consumption[i];
        if (amount <= 0) continue;
        const instance = offers[i].instance;
        account.setQuantity(instance, instance.quantity - amount);
        touched.add(instance);
      }
      // Exactly one target item per call.
      this._grant(account, target.itemdefid, 1, [], touched);
      return this._ok([...touched].map(i => i.toResult()), { recipeIndex: chosenIndex });
    });
  }

  // ── ConsumeItem ──

  consumeItem(account, itemId, quantity = 1) {
    const instance = account.get(itemId);
    if (!instance) return this._fail(RESULT.INVALID_PARAM, `Item instance ${itemId} not in inventory`);
    if (!(quantity > 0)) return this._fail(RESULT.INVALID_PARAM, `Invalid consume quantity ${quantity}`);
    if (instance.quantity < quantity) {
      return this._fail(RESULT.INVALID_PARAM, `Item instance ${itemId} holds ${instance.quantity}, ${quantity} requested`);
    }
    return this._transact(account, () => {
      account.setQuantity(instance, instance.quantity - quantity);
      return this._ok([instance.toResult()]);
    });
  }

  // ── Playtime drops ──

  /** Per-itemdef settings win over app-level settings, field by field. */
  _dropSettings(def) {
    const app = this.options.appDropSettings;
    return {
      dropInterval: def.dropInterval != null ? def.dropInterval : app.dropInterval,
      useDropWindow: def.useDropWindow != null ? def.useDropWindow : app.useDropWindow,
      dropWindow: def.dropWindow != null ? def.dropWindow : app.dropWindow,
      dropMaxPerWindow: Math.min(
        def.dropMaxPerWindow != null ? def.dropMaxPerWindow : app.dropMaxPerWindow,
        MAX_DROPS_PER_WINDOW
      ),
      useDropLimit: def.useDropLimit != null ? def.useDropLimit : app.useDropLimit,
      dropLimit: def.dropLimit != null ? def.dropLimit : app.dropLimit,
    };
  }

  /**
   * Isolation rule: an itemdef that specifies ANY drop setting is tracked on its
   * own; one that specifies none shares a single budget with every other bare
   * playtimegenerator and with the app-level setting.
   */
  _dropBucketKey(def) {
    return def.hasOwnDropSettings ? `def:${def.itemdefid}` : 'app';
  }

  /** Non-mutating eligibility check — also the diagnostic the simulator reads. */
  describeDrop(account, itemDefId) {
    const def = this.schema.get(itemDefId);
    if (!def) return { eligible: false, reason: `Unknown itemdefid ${itemDefId}` };
    if (def.type !== 'playtimegenerator') {
      return { eligible: false, reason: `itemdef ${itemDefId} is type "${def.type}", not playtimegenerator` };
    }

    const settings = this._dropSettings(def);
    const bucket = account.dropBuckets.get(this._dropBucketKey(def)) || {
      grants: 0,
      playtimeAtLastGrant: 0,
      windowStartMs: null,
      windowGrants: 0,
    };
    const now = this.clock.now();

    // A window whose duration has elapsed is already over, whether or not
    // anything wrote to the bucket since.
    let windowStartMs = bucket.windowStartMs;
    let windowGrants = bucket.windowGrants;
    if (settings.useDropWindow && windowStartMs != null && now - windowStartMs >= settings.dropWindow * MS_PER_MINUTE) {
      windowStartMs = null;
      windowGrants = 0;
    }

    const playtimeSince = this.clock.playtime() - bucket.playtimeAtLastGrant;

    // Test-mode only: skip drop_limit / drop_interval / drop_max_per_window,
    // but not the playtimegenerator type check above, and not accounting below
    // — triggerItemDrop still reads settings/bucket/playtimeSince/windowStartMs/
    // windowGrants off this return value, so bookkeeping stays consistent.
    if (this.options.bypassDropGating) {
      return { eligible: true, reason: null, settings, bucket, playtimeSince, windowStartMs, windowGrants };
    }

    if (settings.useDropLimit && bucket.grants >= settings.dropLimit) {
      return { eligible: false, reason: 'drop_limit reached', settings, bucket, playtimeSince };
    }
    if (settings.dropInterval != null && playtimeSince < settings.dropInterval) {
      return {
        eligible: false,
        reason: `needs ${settings.dropInterval} min of playtime, ${playtimeSince.toFixed(2)} accrued`,
        settings,
        bucket,
        playtimeSince,
      };
    }
    if (settings.useDropWindow && windowGrants >= settings.dropMaxPerWindow) {
      return { eligible: false, reason: 'drop_max_per_window reached, in cool-down', settings, bucket, playtimeSince };
    }

    return { eligible: true, reason: null, settings, bucket, playtimeSince, windowStartMs, windowGrants };
  }

  /**
   * TriggerItemDrop. Not being eligible is not an error — Steam returns a valid
   * empty result — so callers check `granted`, or equivalently items.length.
   */
  triggerItemDrop(account, itemDefId) {
    const def = this.schema.get(itemDefId);
    if (!def) return this._fail(RESULT.INVALID_PARAM, `Unknown itemdefid ${itemDefId}`);
    if (def.type !== 'playtimegenerator') {
      return this._fail(RESULT.INVALID_PARAM, `itemdef ${itemDefId} is type "${def.type}", not playtimegenerator`);
    }

    const check = this.describeDrop(account, itemDefId);
    if (!check.eligible) return this._ok([], { granted: false, reason: check.reason });

    return this._transact(account, () => {
      const bucket = account.dropBucket(this._dropBucketKey(def));
      const now = this.clock.now();
      const touched = new Set();
      this._grant(account, def.itemdefid, 1, [], touched);

      account.updateDropBucket(bucket, {
        grants: bucket.grants + 1,
        playtimeAtLastGrant: this.options.bankPlaytime
          ? bucket.playtimeAtLastGrant + check.settings.dropInterval
          : this.clock.playtime(),
        windowStartMs: check.settings.useDropWindow
          ? check.windowStartMs != null
            ? check.windowStartMs
            : now
          : bucket.windowStartMs,
        windowGrants: check.settings.useDropWindow ? check.windowGrants + 1 : bucket.windowGrants,
      });

      return this._ok([...touched].map(i => i.toResult()), { granted: true });
    });
  }

  // ── Promo items ──

  /** Evaluate the promo rule list (rules are OR-ed). */
  _promoRulesSatisfied(account, def) {
    for (const rule of def.promo) {
      switch (rule.type) {
        case 'manual':
          // AddPromoItem is the explicit call this rule exists for.
          return true;
        case 'owns':
          if (account.ownedApps.has(rule.appid)) return true;
          break;
        case 'ach':
          if (account.achievements.has(rule.name)) return true;
          break;
        case 'played':
          if ((account.playtimeByApp.get(rule.appid) || 0) >= rule.minutes) return true;
          break;
        default:
          break;
      }
    }
    return false;
  }

  describePromo(account, itemDefId) {
    const def = this.schema.get(itemDefId);
    if (!def) return { eligible: false, reason: `Unknown itemdefid ${itemDefId}` };
    if (def.promo.length === 0) return { eligible: false, reason: `itemdef ${itemDefId} is not a promo item` };

    const now = this.clock.now();
    if (def.dropStartTime != null && now < def.dropStartTime) {
      return { eligible: false, reason: 'before drop_start_time' };
    }
    if (!this._promoRulesSatisfied(account, def)) {
      return { eligible: false, reason: 'no promo rule satisfied' };
    }

    // Test-mode only: skip the once-per-account and interval-recurrence waits
    // below. Rule satisfaction and drop_start_time, checked above, still apply
    // — this bypasses re-claim waiting, not entitlement.
    if (this.options.bypassPromoGating) {
      return { eligible: true, reason: null };
    }

    const record = account.promoGrants.get(itemDefId);
    if (record && record.count > 0) {
      // Repeat grants exist only for manual promos with a drop_interval.
      const manual = def.promo.some(r => r.type === 'manual');
      if (!manual || def.dropInterval == null) {
        return { eligible: false, reason: 'promo already granted (once per account)' };
      }
      const readyAt = record.lastGrantMs + def.dropInterval * MS_PER_MINUTE;
      if (now < readyAt) {
        return {
          eligible: false,
          reason: `promo interval not elapsed (${Math.ceil((readyAt - now) / MS_PER_MINUTE)} min remaining)`,
          readyAt,
        };
      }
    }
    return { eligible: true, reason: null };
  }

  addPromoItem(account, itemDefId) {
    const def = this.schema.get(itemDefId);
    if (!def) return this._fail(RESULT.INVALID_PARAM, `Unknown itemdefid ${itemDefId}`);
    if (def.promo.length === 0) {
      return this._fail(RESULT.INVALID_PARAM, `itemdef ${itemDefId} is not a promo item`);
    }

    const check = this.describePromo(account, itemDefId);
    if (!check.eligible) return this._ok([], { granted: false, reason: check.reason });

    return this._transact(account, () => {
      const touched = new Set();
      this._grant(account, def.itemdefid, 1, [], touched);
      const record = account.promoRecord(itemDefId);
      account.updatePromoRecord(record, { count: record.count + 1, lastGrantMs: this.clock.now() });
      return this._ok([...touched].map(i => i.toResult()), { granted: true });
    });
  }

  // ── GenerateItems (sandbox only) ──

  /**
   * ISteamInventory::GenerateItems — only permitted for apps in development on
   * real Steam. Present so tests and the simulator can seed an inventory
   * without laundering items through a promo.
   */
  generateItems(account, itemDefIds, quantities = []) {
    const ids = Array.isArray(itemDefIds) ? itemDefIds : [itemDefIds];
    for (const id of ids) {
      if (!this.schema.get(id)) return this._fail(RESULT.INVALID_PARAM, `Unknown itemdefid ${id}`);
    }
    return this._transact(account, () => {
      const touched = new Set();
      ids.forEach((id, index) => {
        this._grant(account, id, quantities[index] != null ? quantities[index] : 1, [], touched);
      });
      return this._ok([...touched].map(i => i.toResult()));
    });
  }

  // ── Item definition properties ──

  getItemDefinitionProperty(itemDefId, property) {
    const def = this.schema.get(itemDefId);
    if (!def) return null;
    if (property == null || property === '') return def.propertyNames().join(',');
    return def.property(property);
  }
}

// ─── Tag merging ──────────────────────────────────────────────────────────────

/** Concatenate tag lists, dropping exact duplicate "key:value" tokens. */
function mergeTags(...lists) {
  const seen = new Set();
  const out = [];
  for (const list of lists) {
    for (const tag of list || []) {
      const token = `${tag.key}:${tag.value}`;
      if (seen.has(token)) continue;
      seen.add(token);
      out.push(tag);
    }
  }
  return out;
}

module.exports = { Engine, RESULT, DEFAULT_OPTIONS, MAX_DROPS_PER_WINDOW, mergeTags };
