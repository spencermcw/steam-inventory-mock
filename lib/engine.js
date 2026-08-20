'use strict';

/**
 * engine.js
 *
 * The inventory engine: exchange resolution, recursive bundle/generator
 * expansion, per-item tag propagation, playtime drops and promo grants.
 *
 * This is the piece that is shared, deliberately, between the async provider skin
 * and any synchronous consumer. The provider (provider.js) wraps this engine in
 * Steam's async, handle-based protocol; a consumer that drives it directly,
 * synchronously, can use it for deterministic simulation and analysis. Built once,
 * they cannot drift — and behavior drifting from the shipped engine invalidates
 * the analysis.
 *
 * Every operation is transactional. Real ExchangeItems is atomic (Valve,
 * documented), and the whole `requires` ownership-check pattern depends on it.
 *
 * Where Steam's behaviour is documented, we follow the document. Where it is
 * not, the choice is an explicit, named option and the guess is recorded in
 * README.md under "Encoded guesses".
 */

const { loadSchema } = require('./schema');
const { tagMatches } = require('./grammar');
const { Account, stackKeyFor } = require('./inventory');
const { Rng } = require('./rng');
const { VirtualClock, MS_PER_MINUTE } = require('./clock');
const { assignMaterials } = require('./matching');
const {
  MAX_PROPERTY_BYTES,
  PropertyError,
  assertPropertyName,
  inferProperty,
  property: makeProperty,
  propsByteLength,
} = require('./properties');

// ─── Result codes ─────────────────────────────────────────────────────────────

/** Subset of Steam's EResult that inventory calls actually surface. */
const RESULT = {
  OK: 1,
  FAIL: 2,
  INVALID_PARAM: 8,
  INVALID_STATE: 11,
  LIMIT_EXCEEDED: 25,
};

// ─── Result item flags ────────────────────────────────────────────────────────

/**
 * ESteamItemFlags: the bits SteamItemDetails_t::m_unFlags carries on a result
 * row, in Valve's own words —
 *
 *   k_ESteamItemRemoved  (1 << 8) "the item has been destroyed, traded away,
 *                                  expired, or otherwise invalidated"
 *   k_ESteamItemConsumed (1 << 9) "the item quantity has been decreased by 1
 *                                  via ConsumeItem API"
 *
 * They describe *why a row is in a result set*, not the item — which is why
 * they are set here, at the point the engine empties, spends or destroys an
 * instance, and never inferred downstream from `quantity === 0`. That
 * inference cannot be made: a row at zero is a consumed stack, a stack spent
 * as exchange material, or the source of a split that emptied, and those are
 * three different flags on one indistinguishable row.
 *
 * What this engine sets them for, exhaustively:
 *
 *   ConsumeItem            CONSUMED, plus REMOVED if the stack emptied
 *   exchange material      CONSUMED, plus REMOVED if the stack emptied
 *   tag tool (the tool)    CONSUMED, plus REMOVED if the last one was spent
 *   tag tool target,
 *     'new-instance'       REMOVED — destroyed, not spent
 *     'mutate'             nothing — the instance survives, id intact
 *   split/merge source     REMOVED if it emptied; otherwise nothing
 *   grants, reads,
 *     property updates     nothing
 *
 * Left unflagged, deliberately: Valve's REMOVED also covers an item traded
 * away or expired, and this library models neither trading nor item expiry.
 * No row here will ever carry the bit for those reasons, so REMOVED means
 * "this call removed it" and never "someone else took it". A client that
 * expects to learn about a trade from a result row learns nothing, here or
 * (since the call never happened) on Steam.
 *
 * k_ESteamItemNoTrade (1 << 0) is absent on purpose: it is a fact about the
 * item *definition* rather than about an operation, so it is read through
 * GetItemDefinitionProperty("tradable"). steamworks.js's public SteamItemFlags
 * restates all three for callers and ORs that one in; the unit suite asserts
 * the two tables never drift.
 */
const ITEM_FLAGS = {
  REMOVED: 1 << 8,
  CONSUMED: 1 << 9,
};

/** REMOVED once an instance is gone from the account, nothing while it stands. */
function removedIfEmpty(instance) {
  return instance.quantity <= 0 ? ITEM_FLAGS.REMOVED : 0;
}

const DEFAULT_OPTIONS = {
  /**
   * What happens to materials passed to ExchangeItems beyond what the winning
   * recipe requires. This behavior is UNVERIFIED against real Steam — the actual
   * handling may differ.
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

  /**
   * What ExchangeItems leaves behind when a tag_tool is applied to an item.
   * This behavior is UNVERIFIED against real Steam, and here Valve's own two
   * pages read differently: docs/tools.html says "a new item (copied from the
   * target item) will be created", while docs/accessories.html says the call
   * will "atomically consume the sticker and update the tags on the target
   * item". Those are not the same outcome, so both are implemented.
   *   'new-instance' — destroy the target and issue a copy under a FRESH
   *                    instance id (tools.html's wording, and the default:
   *                    it is the more explicit of the two). The old id is
   *                    gone, so anything holding it — an equipped-item
   *                    reference, a pending UI list, a saved loadout — is
   *                    invalidated by a successful call, exactly as
   *                    transferItemQuantity's split invalidates a source id.
   *                    Callers must read the new id out of the result.
   *   'mutate'       — rewrite the target's per-item tags in place, so the
   *                    instance id survives (accessories.html's wording).
   */
  toolResultPolicy: 'new-instance',

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
   * a dev/QA build. See README.md ("Test-mode gating bypass").
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

  /**
   * Which dynamic properties a client may set, or `null` for "anything".
   *
   * `null` is the default because the white-list is partner-site
   * configuration — a list somebody typed into the Steam Inventory Service
   * page for one appid — and this library has no way to know it. Refusing
   * every property by default would make the subsystem unusable out of the
   * box; permitting every property models a partner site with nothing
   * configured.
   *
   * Understand what that default costs: on real Steam, a client-side
   * SetProperty for a property that is NOT white-listed is refused outright.
   * A client written against the permissive default therefore works here and
   * breaks on contact with Steam, on exactly the calls the white-list was
   * meant to govern. Anyone shipping against a real binding should mirror
   * their partner-site configuration into this option and test against it —
   * that is the whole reason it is configurable rather than hardcoded off.
   *
   * When set, an array of:
   *   { name, type?, requiredTag? }
   *     name        — exact property name; anything unlisted is refused
   *     type        — 'string' | 'int' | 'bool' | 'float'; a mismatch is
   *                   refused, because Valve's white-list carries a type too
   *     requiredTag — 'stat_tracker' (any value of that category) or
   *                   'stat_tracker:kills' (that exact pair), checked against
   *                   the item's *effective* tags: Valve says the required
   *                   tag "can exist either on the item or its associated item
   *                   definition", which is precisely effectiveTags().
   */
  propertyWhitelist: null,
};

/** Valve: "Limited at 10 per window." */
const MAX_DROPS_PER_WINDOW = 10;

/**
 * Valve: "Currently you can modify up to 100 items for a user in each call."
 *
 * Distinct *items*, not edits: a batch may set six properties on one item and
 * still be one item against this cap.
 */
const MAX_ITEMS_PER_UPDATE = 100;

/**
 * TransferItemQuantity's "no destination — make me a new stack" sentinel.
 *
 * Valve defines k_SteamItemInstanceIDInvalid as ~0 on a uint64
 * (18446744073709551615), which a JS number cannot even hold exactly — it
 * rounds to ...616, so an equality test against the literal is not reliable.
 * Instance ids here are JS numbers issued from 1 upward, so 0 is the sentinel
 * that can never collide with a real id, and `isNoDestination` additionally
 * treats null/undefined and anything at or beyond the safe-integer ceiling as
 * "no destination" — that last case being how a caller porting Valve's literal
 * across still lands on the split path instead of on a confusing
 * unknown-instance failure.
 */
const k_SteamItemInstanceIDInvalid = 0;

function isNoDestination(itemIdDest) {
  if (itemIdDest == null || itemIdDest === k_SteamItemInstanceIDInvalid) return true;
  const n = Number(itemIdDest);
  return Number.isFinite(n) && (n === 0 || n >= Number.MAX_SAFE_INTEGER);
}

// ─── Result rows ──────────────────────────────────────────────────────────────

/**
 * The rows one operation will report, and why each of them is there.
 *
 * A plain Set of touched instances is enough to *list* the rows, and is what
 * this replaced; what a Set cannot carry is the one thing only the operation
 * knows — whether the instance it is reporting was consumed, spent, destroyed,
 * or merely changed. Flags are recorded as each mutation happens, which is the
 * only moment that answer exists.
 *
 * The add-as-you-go shape is kept deliberately: `_grant` and `_instantiate`
 * push rows up through several levels of bundle expansion and just `.add()`
 * what they created, unflagged, without needing to know what the call around
 * them is doing to everything else.
 *
 * Insertion order is the Set's, and ORing another bit onto an instance already
 * present does not move it (Map.set on an existing key keeps its place), so
 * result order is unchanged by any of this.
 */
class ResultRows {
  constructor() {
    this._flags = new Map();
  }

  /** Put an instance in the result, ORing `flags` onto whatever it already says. */
  add(instance, flags = 0) {
    this._flags.set(instance, (this._flags.get(instance) || 0) | flags);
    return this;
  }

  rows() {
    return [...this._flags].map(([instance, flags]) => instance.toResult(flags));
  }
}

// ─── Engine ───────────────────────────────────────────────────────────────────

class Engine {
  /**
   * @param {object} [options]
   * @param {string|object} [options.schema] path to a Steam itemdef JSON file, a parsed
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

    /**
     * Staged dynamic-property batches, keyed by update handle. Valve's
     * SteamInventoryUpdateHandle_t is a uint64; a monotonically increasing JS
     * number is enough here, for the same reason result handles are — nothing
     * is persisted across processes, ids only need to be unique within one
     * run, and 2^53 batches is not a session anyone will have. Handles live on
     * the engine rather than the provider so several providers sharing one
     * economy cannot collide.
     */
    this._updates = new Map();
    this._nextUpdateHandle = 1;
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
   * @param {ResultRows} touched rows this operation will report. Everything a
   *   grant adds goes in unflagged: creating or growing a stack removes
   *   nothing and consumes nothing, whatever else the surrounding call did.
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

  // ── GetItemsByID ──

  /**
   * Subset of GetAllItems by instance id. An id the account does not hold is
   * simply absent from the result, not a failure — Steam returns what it has
   * rather than erroring on a stale client-side id. Duplicate ids in the
   * request collapse to one result entry.
   */
  getItemsByID(account, instanceIds) {
    const seen = new Set();
    const items = [];
    for (const raw of instanceIds || []) {
      const itemId = Number(raw);
      if (seen.has(itemId)) continue;
      seen.add(itemId);
      const instance = account.get(itemId);
      if (instance) items.push(instance.toResult());
    }
    return this._ok(items);
  }

  // ── ExchangeItems ──

  /**
   * ExchangeItems has two structurally different modes behind one call, and
   * this method forks between them once the offered materials are resolved:
   * the recipe path below, and the tag_tool path (see _matchTagToolUse).
   *
   * @param {Account} account
   * @param {number} targetItemDefId the single item to generate (Steam requires
   *   the generate array to be size 1, quantity 1)
   * @param {Array<{itemId:number, quantity:number}>|number[]} materials
   */
  exchangeItems(account, targetItemDefId, materials) {
    const target = this.schema.get(targetItemDefId);
    if (!target) return this._fail(RESULT.INVALID_PARAM, `Unknown target itemdefid ${targetItemDefId}`);

    // The "no exchange formula" rejection cannot come first any more: a tag
    // tool names the *target's own* itemdefid in the generate array, and the
    // hat in Valve's example has no exchange formula at all. Resolving the
    // materials is what tells the two calls apart, so it happens first and the
    // recipe-only checks move below the fork.

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

    // ── Fork: tag tool, or recipe ──
    const toolUse = this._matchTagToolUse(target, offers);
    if (toolUse) return this._applyTagTool(account, target, toolUse.tool, toolUse.subject);

    if (target.exchange.length === 0) {
      return this._fail(RESULT.INVALID_PARAM, `itemdef ${targetItemDefId} has no exchange formula`);
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
      const touched = new ResultRows();
      for (let i = 0; i < offers.length; i++) {
        const amount = consumption[i];
        if (amount <= 0) continue;
        const instance = offers[i].instance;
        account.setQuantity(instance, instance.quantity - amount);
        // Spent as material. CONSUMED even though ConsumeItem was not the call
        // that spent it: Valve's destroy array is documented as the items the
        // exchange consumes, and the flag is what the row means, not which
        // function was invoked. REMOVED joins it only when the stack actually
        // emptied, since that is the part the caller cannot recover from — the
        // instance id is gone and any reference to it is now stale.
        touched.add(instance, ITEM_FLAGS.CONSUMED | removedIfEmpty(instance));
      }
      // Exactly one target item per call. Its rows go in unflagged — except
      // where a `requires`-style recipe re-issues a material back into the very
      // stack it just drew from, which keeps CONSUMED (units really were
      // consumed) and correctly lacks REMOVED (the instance stands).
      this._grant(account, target.itemdefid, 1, [], touched);
      return this._ok(touched.rows(), { recipeIndex: chosenIndex });
    });
  }

  // ── ExchangeItems: the tag_tool path ──

  /**
   * Is this ExchangeItems call a tag_tool application rather than a recipe?
   *
   * Valve's C++ example is the whole shape: the generate array holds the
   * *target item's own* itemdefid, and the destroy array holds the tool and
   * the target. Three things must hold at once, and no ordinary recipe
   * satisfies all three by accident:
   *
   *   1. exactly one offered instance is of type `tag_tool`;
   *   2. the offer list is that tool plus exactly ONE other instance, whose
   *      itemdefid is the itemdefid being generated;
   *   3. no recipe on the target itemdef claims that tool as a material.
   *
   * (2) is what a recipe would have to imitate: producing itemdef X from a
   * two-material list that already contains an instance of X. The `requires`
   * pattern comes close — a recipe that checks ownership of a facility by
   * consuming it and re-issuing it in its bundle — but there the *generated*
   * itemdef is the recipe's own, not the material's, so it never trips.
   *
   * (3) settles the one genuinely ambiguous schema left: an itemdef whose own
   * recipe consumes a tag_tool and produces itself. Writing the tool into an
   * `exchange` string is an explicit statement that it is a material, so the
   * recipe wins and the tool path stands down. Nothing about the tool's tag
   * fields is consulted here — a tool that has nothing to apply is still a
   * tool, and must fail as one rather than fall through and fail as a
   * mismatched recipe.
   */
  _matchTagToolUse(target, offers) {
    if (offers.length !== 2) return null;

    const tools = offers.filter(offer => {
      const def = this.schema.get(offer.instance.itemdefid);
      return def && def.type === 'tag_tool';
    });
    if (tools.length !== 1) return null;

    const tool = tools[0];
    const subject = offers.find(offer => offer !== tool);
    if (subject.instance.itemdefid !== target.itemdefid) return null;

    const claimedByRecipe = target.exchange.some(recipe =>
      recipe.some(operand =>
        operand.kind === 'def'
          ? operand.itemdefid === tool.instance.itemdefid
          : tool.tokens.has(operand.token)
      )
    );
    if (claimedByRecipe) return null;

    return { tool, subject };
  }

  /**
   * Apply a tag tool to one item: strip, apply, then reissue or rewrite.
   *
   * Order is Valve's: "Any matching tags will be removed first before any new
   * ones are applied." The permission check runs ahead of all of it because
   * accessories.html is explicit that a rejected application "will not consume
   * the accessory item" — and the whole body is inside _transact, so even the
   * checks that can only be made after the roll (a duplicate accessory, an
   * over-limit item) leave the inventory and the RNG stream untouched.
   *
   * Removals apply to per-item tags only. A tag that comes from the target's
   * own itemdef is part of the definition of that item and no per-instance
   * operation can strip it.
   */
  _applyTagTool(account, target, toolOffer, subjectOffer) {
    const toolDef = this.schema.require(toolOffer.instance.itemdefid);
    const subject = subjectOffer.instance;

    // Tags belong to an instance, and an instance here can be a stack. Tagging
    // one would tag every unit in it — and an accessorised item is, in Valve's
    // words, a "Unique" (non-commodity) listing, i.e. precisely not a stack.
    if (subject.quantity !== 1) {
      return this._fail(
        RESULT.INVALID_STATE,
        `Item instance ${subject.itemId} holds ${subject.quantity}; a tag tool applies to a single item ` +
          '(split the stack with TransferItemQuantity first)'
      );
    }

    // The categories the tool would write. tag_generator picks are unrolled
    // here — the category is fixed by tag_generator_name, so permission can be
    // decided without spending randomness on a call that may be refused.
    const categories = new Set(toolDef.tags.map(t => t.key));
    for (const id of toolDef.tagGenerators) {
      const gen = this.schema.get(id);
      if (gen && gen.tagGeneratorName) categories.add(gen.tagGeneratorName);
    }

    // An item's accessory_tag category is writable by tools without being
    // repeated in allowed_tags_from_tools. Declaring a category as the item's
    // accessory slot IS the opt-in; Valve's sticker example lists both fields,
    // which is consistent with this but does not establish that the second is
    // required. UNVERIFIED, and deliberately the permissive reading: the
    // strict one would make `accessory_tag` alone inert, which no schema
    // author writing it could plausibly intend.
    const allowed = new Set(target.allowedTagsFromTools);
    if (target.accessoryTag) allowed.add(target.accessoryTag);

    const refused = [...categories].filter(category => !allowed.has(category));
    if (refused.length > 0) {
      return this._fail(
        RESULT.INVALID_PARAM,
        `itemdef ${target.itemdefid} does not accept tag ${refused.length > 1 ? 'categories' : 'category'} ` +
          `"${refused.join(', ')}" from tools (it accepts: "${[...allowed].join(';')}")`
      );
    }

    return this._transact(account, () => {
      const kept = subject.tags.filter(
        tag => !toolDef.tagsToRemoveOnToolUse.some(matcher => tagMatches(matcher, tag))
      );
      const rolled = this._rollTagGenerators(toolDef.tagGenerators);
      const applied = [...toolDef.tags, ...rolled];
      // Copied, not shared: these objects came off an itemdef, and an itemdef
      // must never hand live references into an account's instances.
      const nextTags = mergeTags(kept, applied).map(tag => ({ key: tag.key, value: tag.value }));

      if (target.accessoryTag) {
        const category = target.accessoryTag;
        const attached = nextTags.filter(tag => tag.key === category);

        for (const accessory of attached) {
          if (!this.schema.get(accessory.value)) {
            return this._fail(
              RESULT.INVALID_PARAM,
              `Accessory tag "${category}:${accessory.value}" on itemdef ${target.itemdefid} does not name a known itemdefid`
            );
          }
        }

        // Duplicates are measured against what survives the strip, not against
        // what the item held on arrival: a tool that explicitly removes the
        // accessory it re-applies is replacing it, which is a coherent thing
        // to author. Valve: adding two instances of the same accessory "will
        // fail in the ExchangeItems call and will not consume the accessory
        // item" — hence a refusal, not a silent no-op.
        const already = new Set(kept.filter(tag => tag.key === category).map(tag => tag.value));
        const duplicate = applied.find(tag => tag.key === category && already.has(tag.value));
        if (duplicate) {
          return this._fail(
            RESULT.INVALID_STATE,
            `Item instance ${subject.itemId} already carries accessory ${duplicate.value}; ` +
              'two instances of the same accessory are not supported'
          );
        }

        const limit = target.accessoryLimitOrDefault;
        if (attached.length > limit) {
          return this._fail(
            RESULT.LIMIT_EXCEEDED,
            `itemdef ${target.itemdefid} allows ${limit} ${limit === 1 ? 'accessory' : 'accessories'}, ` +
              `${attached.length} would be attached`
          );
        }
      }

      const touched = new ResultRows();

      // One tool, one use — regardless of how much of the stack was offered.
      // surplusPolicy has nothing to say here: there is no recipe, so there is
      // no notion of a material offered beyond what it calls for.
      account.setQuantity(toolOffer.instance, toolOffer.instance.quantity - 1);
      // The tool is spent exactly as a material is, so it is flagged as one.
      touched.add(toolOffer.instance, ITEM_FLAGS.CONSUMED | removedIfEmpty(toolOffer.instance));

      if (this.options.toolResultPolicy === 'mutate') {
        const previous = subject.tags;
        subject.tags = nextTags;
        account.record(() => {
          subject.tags = previous;
        });
        // Unflagged, and that is the whole difference between the policies:
        // this row is the same instance the caller passed in, still held,
        // under the same id, with different tags.
        touched.add(subject);
      } else {
        // 'new-instance': the target is destroyed and a copy issued. Via
        // _instantiate so an auto_stack itemdef still merges the copy into a
        // matching stack rather than sitting beside it forever.
        //
        // REMOVED and not CONSUMED: the target was destroyed as part of
        // applying the tool, not spent as material and not passed to
        // ConsumeItem — Valve's "otherwise invalidated" is exactly this. It is
        // also the flag that makes the result readable at all, because the
        // call returns two rows of the same itemdef and the id the caller knew
        // is on the dead one. `result.find(i => i.itemdefid === target)` picks
        // whichever comes first; the flag is what tells them apart.
        account.setQuantity(subject, 0);
        touched.add(subject, ITEM_FLAGS.REMOVED);
        this._instantiate(account, target, 1, nextTags, touched);
      }

      return this._ok(touched.rows(), { toolItemDefId: toolDef.itemdefid });
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
      // ConsumeItem is the call k_ESteamItemConsumed is named for, so the row
      // carries it whether one unit went or the whole stack. When the stack
      // empties, REMOVED is true of the same row as well — the instance is
      // gone from the inventory, which is the "otherwise invalidated" half of
      // Valve's wording — and a caller holding that id must retire it rather
      // than re-read it. Both readings are honest, so both bits are set;
      // setting only one would hide half of what happened. UNVERIFIED: whether
      // real Steam pairs them the same way on a stack consumed to zero.
      return this._ok([instance.toResult(ITEM_FLAGS.CONSUMED | removedIfEmpty(instance))]);
    });
  }

  // ── TransferItemQuantity ──

  /**
   * Move `quantity` from one item instance to another.
   *
   * Two modes, as on Steam: with no destination (see k_SteamItemInstanceIDInvalid)
   * the quantity is *split* off into a brand-new instance; with a real
   * destination instance it is *merged* into that stack.
   *
   * A merge is refused unless both sides share a stack key — same itemdef AND
   * the same per-item tags. Merging differently tagged instances has no honest
   * outcome: the result is one stack with one tag set, so one side's tags are
   * destroyed. Nothing would throw, the inventory would still look plausible,
   * and the loss would surface much later as an item that has quietly shed its
   * cosmetics or its provenance — the same silent corruption the instance-id
   * watermark exists to prevent. Refusing is the only answer that cannot lie.
   *
   * Deliberately NOT enforced: that the itemdef is auto_stack. Steam does not
   * document what TransferItemQuantity does to a non-stacking itemdef, and
   * guessing "reject" here would make the mock stricter than the thing it
   * stands in for. The stack-key rule above is the invariant worth defending;
   * stackability is a schema-authoring question.
   *
   * Splitting the *entire* quantity is allowed, and behaves as a split whose
   * source empties: the source is removed exactly as consumeItem removes a
   * spent stack (reported at quantity 0) and the whole quantity lands under a
   * fresh instance id. The alternative — rejecting at the boundary — would make
   * the legal range asymmetric between split (`< quantity`) and merge
   * (`<= quantity`, since merging a whole stack away is the ordinary case) and
   * force every caller to special-case the last unit. Callers must read the
   * new id out of the result rather than assume the source id survived.
   *
   * @param {Account} account
   * @param {number} itemIdSource instance to take from
   * @param {number} quantity
   * @param {number} [itemIdDest] destination instance, or the invalid sentinel to split
   */
  transferItemQuantity(account, itemIdSource, quantity, itemIdDest) {
    const source = account.get(itemIdSource);
    if (!source) return this._fail(RESULT.INVALID_PARAM, `Item instance ${itemIdSource} not in inventory`);

    const amount = Number(quantity);
    if (!Number.isFinite(amount) || amount <= 0) {
      return this._fail(RESULT.INVALID_PARAM, `Invalid transfer quantity ${quantity}`);
    }
    if (source.quantity < amount) {
      return this._fail(
        RESULT.INVALID_PARAM,
        `Item instance ${itemIdSource} holds ${source.quantity}, ${amount} requested`
      );
    }

    const splitting = isNoDestination(itemIdDest);
    let destination = null;
    if (!splitting) {
      destination = account.get(itemIdDest);
      if (!destination) {
        return this._fail(RESULT.INVALID_PARAM, `Destination item instance ${itemIdDest} not in inventory`);
      }
      if (destination === source) {
        return this._fail(RESULT.INVALID_PARAM, `Cannot transfer item instance ${itemIdSource} into itself`);
      }
      if (destination.itemdefid !== source.itemdefid) {
        return this._fail(
          RESULT.INVALID_PARAM,
          `Cannot merge item instance ${source.itemId} (itemdef ${source.itemdefid}) into ` +
            `${destination.itemId} (itemdef ${destination.itemdefid})`
        );
      }
      if (destination.stackKey() !== source.stackKey()) {
        return this._fail(
          RESULT.INVALID_PARAM,
          `Cannot merge item instance ${source.itemId} into ${destination.itemId}: per-item tags differ ` +
            `("${tagText(source)}" vs "${tagText(destination)}") — the merge would destroy one side's tags`
        );
      }
    }

    return this._transact(account, () => {
      const touched = new ResultRows();

      if (splitting) {
        // Copy the tag array *and* each tag object: aliasing them would make a
        // later edit of one instance's tags silently rewrite the other's.
        // createInstance (not _instantiate) because the new stack is by
        // definition tag-identical to the source, so the auto_stack merge path
        // would fold it straight back in and the split would be a no-op.
        destination = account.createInstance(
          source.itemdefid,
          amount,
          source.tags.map(t => ({ key: t.key, value: t.value })),
          this.clock.now()
        );
      } else {
        account.setQuantity(destination, destination.quantity + amount);
      }

      // Emptying the source removes it, exactly as consumeItem does, and still
      // reports it at quantity 0 so the client can retire the id.
      account.setQuantity(source, source.quantity - amount);

      // A transfer consumes nothing: the quantity moved, it was not spent, so
      // an emptied source is REMOVED and never CONSUMED. A source that
      // survives is neither, and the destination — new stack or grown one — is
      // neither either.
      touched.add(source, removedIfEmpty(source));
      touched.add(destination);
      return this._ok(touched.rows());
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
      const touched = new ResultRows();
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

      return this._ok(touched.rows(), { granted: true });
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
      const touched = new ResultRows();
      this._grant(account, def.itemdefid, 1, [], touched);
      const record = account.promoRecord(itemDefId);
      account.updatePromoRecord(record, { count: record.count + 1, lastGrantMs: this.clock.now() });
      return this._ok(touched.rows(), { granted: true });
    });
  }

  /**
   * AddPromoItems: the same grant addPromoItem performs, for an explicit list
   * of itemdefids in one call. Ids are explicit here exactly as they are for
   * addPromoItem, so `granted_manually` never gates this path either — that
   * field only steers GrantPromoItems' automatic sweep, below.
   *
   * Two very different kinds of "no" are possible per id, and they are handled
   * differently on purpose:
   *   - Unknown itemdefid: a caller mistake, not a state the account can be
   *     in. The whole call is rejected before anything is touched, exactly
   *     like addPromoItem does for a single bad id.
   *   - Known itemdefid that describePromo currently refuses (already granted
   *     once-per-account, recurrence wait not elapsed, rule unsatisfied,
   *     before drop_start_time): skipped, not fatal. A bulk call reads as
   *     "give me everything on this list I'm currently owed" — one already-
   *     spent or not-yet-ready promo failing the whole batch would make a
   *     client re-request the ones that *did* work one at a time, defeating
   *     the point of a bulk call.
   *
   * All grants happen inside one transaction: a throw partway through (e.g.
   * the bundle-expansion depth guard) leaves the account exactly as it was,
   * same as every other engine operation.
   */
  addPromoItems(account, itemDefIds) {
    const ids = Array.isArray(itemDefIds) ? itemDefIds : [itemDefIds];
    for (const id of ids) {
      if (!this.schema.get(id)) return this._fail(RESULT.INVALID_PARAM, `Unknown itemdefid ${id}`);
    }

    return this._transact(account, () => {
      const touched = new ResultRows();
      const grantedItemDefIds = [];
      const skipped = [];
      for (const id of ids) {
        const check = this.describePromo(account, id);
        if (!check.eligible) {
          skipped.push({ itemdefid: id, reason: check.reason });
          continue;
        }
        this._grant(account, id, 1, [], touched);
        const record = account.promoRecord(id);
        account.updatePromoRecord(record, { count: record.count + 1, lastGrantMs: this.clock.now() });
        grantedItemDefIds.push(id);
      }
      return this._ok(touched.rows(), {
        granted: grantedItemDefIds.length > 0,
        grantedItemDefIds,
        skipped,
      });
    });
  }

  /**
   * GrantPromoItems: every promo itemdef in the schema that describePromo
   * currently says the account may claim, excluding any with
   * `granted_manually === true`. That flag is the *only* extra gate beyond
   * describePromo's own rule/recurrence checks — deliberately: reusing
   * describePromo rather than re-deriving eligibility here means a promo rule
   * only ever has one implementation to get right, and a `manual` rule with
   * `granted_manually` left at its default (false) is swept exactly like an
   * `owns:`/`ach:`/`played:` rule would be. The 9130/9131 fixture pair in
   * examples/economy.js isolates the flag from the rule type on purpose: both
   * are otherwise-eligible promos, and only the flagged one is excluded here.
   *
   * Granting nothing is success with an empty item list — a player who
   * currently qualifies for nothing (or has already claimed everything on
   * offer) has not hit an error, any more than an empty GetAllItems does.
   *
   * One transaction for the whole sweep, same rollback-on-throw guarantee as
   * addPromoItems.
   */
  grantPromoItems(account) {
    return this._transact(account, () => {
      const touched = new ResultRows();
      const grantedItemDefIds = [];
      for (const def of this.schema.all()) {
        if (def.promo.length === 0 || def.grantedManually) continue;
        const check = this.describePromo(account, def.itemdefid);
        if (!check.eligible) continue;
        this._grant(account, def.itemdefid, 1, [], touched);
        const record = account.promoRecord(def.itemdefid);
        account.updatePromoRecord(record, { count: record.count + 1, lastGrantMs: this.clock.now() });
        grantedItemDefIds.push(def.itemdefid);
      }
      return this._ok(touched.rows(), {
        granted: grantedItemDefIds.length > 0,
        grantedItemDefIds,
      });
    });
  }

  /**
   * The itemdefids describePromo currently says are grantable for this
   * account — the read-only query behind RequestEligiblePromoItemDefinitionsIDs
   * / GetEligiblePromoItemDefinitionIDs. `granted_manually` items ARE included:
   * they are genuinely eligible in the Steam sense, they simply will never be
   * the ones a GrantPromoItems sweep hands out (see grantPromoItems above).
   * Excluding them here would conflate "eligible" with "bulk-grantable", which
   * are different questions Steam itself keeps separate.
   *
   * Non-mutating, like describeDrop/describePromo — sorted so the client-
   * facing id list is stable for the same account state instead of tracking
   * schema iteration order.
   */
  eligiblePromoItemDefinitionIDs(account) {
    const ids = [];
    for (const def of this.schema.all()) {
      if (def.promo.length === 0) continue;
      if (this.describePromo(account, def.itemdefid).eligible) ids.push(def.itemdefid);
    }
    return ids.sort((a, b) => a - b);
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
      const touched = new ResultRows();
      ids.forEach((id, index) => {
        this._grant(account, id, quantities[index] != null ? quantities[index] : 1, [], touched);
      });
      return this._ok(touched.rows());
    });
  }

  // ── Dynamic item properties ──

  /**
   * StartUpdateProperties. Opens a batch and returns its handle; nothing about
   * the account is read or touched until submit.
   *
   * The staging calls below only record intent, which is why they can be
   * synchronous and return a bare bool the way Valve's do: there is no server
   * round trip to make until SubmitUpdateProperties. In particular an edit
   * staged against an item the account does not hold is NOT an error here —
   * Steam validates the batch when it receives it, and a mock that rejected
   * early would let a client assume a guarantee it will not get (the item can
   * be consumed, or traded away, between the SetProperty and the Submit).
   *
   * Note what a batch does not carry: an account. Handles are engine-wide, and
   * the account is supplied at submit, so the same batch cannot be aimed at
   * two players.
   */
  startUpdateProperties() {
    const handle = this._nextUpdateHandle++;
    this._updates.set(handle, { handle, edits: new Map(), lastError: null });
    return handle;
  }

  /** The staged batch, or null once it has been submitted. */
  _update(handle) {
    return this._updates.get(handle) || null;
  }

  /**
   * Stage one edit. Last write wins per (item, name) within a batch: staging
   * `kills` twice is one property, and a remove after a set is a remove.
   */
  _stage(handle, itemId, name, edit) {
    const update = this._update(handle);
    if (!update) return false;
    const id = Number(itemId);
    if (!Number.isInteger(id) || id <= 0) {
      update.lastError = `Invalid item instance id ${JSON.stringify(itemId)}`;
      return false;
    }
    try {
      assertPropertyName(name);
    } catch (err) {
      if (!(err instanceof PropertyError)) throw err;
      update.lastError = err.message;
      return false;
    }
    let perItem = update.edits.get(id);
    if (!perItem) {
      perItem = new Map();
      update.edits.set(id, perItem);
    }
    perItem.set(name, edit);
    return true;
  }

  /**
   * SetProperty with an inferred type — the convenience overload. A whole
   * number infers as int; force the distinction with setPropertyFloat /
   * setPropertyInt when it matters (it does whenever a white-list declares a
   * type). Returns bool, like Valve's; the reason for a `false` is readable
   * via describeUpdate() and is mock-only diagnostics.
   */
  setProperty(handle, itemId, name, value) {
    return this._stageValue(handle, itemId, name, () => inferProperty(value));
  }

  setPropertyString(handle, itemId, name, value) {
    return this._stageValue(handle, itemId, name, () => makeProperty('string', value));
  }

  setPropertyInt(handle, itemId, name, value) {
    return this._stageValue(handle, itemId, name, () => makeProperty('int', value));
  }

  setPropertyBool(handle, itemId, name, value) {
    return this._stageValue(handle, itemId, name, () => makeProperty('bool', value));
  }

  setPropertyFloat(handle, itemId, name, value) {
    return this._stageValue(handle, itemId, name, () => makeProperty('float', value));
  }

  /**
   * Value construction is the one thing checked at stage time rather than at
   * submit: an unrepresentable value (NaN, a non-integer int, an object) is a
   * caller bug that no amount of server state could make valid, and there is
   * nowhere to report it later — Valve's SetProperty returns bool right here.
   */
  _stageValue(handle, itemId, name, build) {
    const update = this._update(handle);
    if (!update) return false;
    let prop;
    try {
      prop = build();
    } catch (err) {
      if (!(err instanceof PropertyError)) throw err;
      update.lastError = err.message;
      return false;
    }
    return this._stage(handle, itemId, name, { op: 'set', prop });
  }

  /** RemoveProperty. Removing a name the item does not carry is a no-op, not a failure. */
  removeProperty(handle, itemId, name) {
    return this._stage(handle, itemId, name, { op: 'remove' });
  }

  /** Mock-only diagnostics on a staged batch; real Steam gives you the bool and nothing else. */
  describeUpdate(handle) {
    const update = this._update(handle);
    if (!update) return null;
    let edits = 0;
    for (const perItem of update.edits.values()) edits += perItem.size;
    return { handle, itemCount: update.edits.size, editCount: edits, lastError: update.lastError };
  }

  /**
   * SubmitUpdateProperties. Applies the whole batch to `account` inside one
   * transaction, so a rejection — an unknown item, a white-list refusal, an
   * over-size payload — leaves every item in the batch exactly as it was.
   * Half-applying would be worse here than anywhere else in this engine: the
   * caller is told "no" and has no way to discover which of its edits
   * nevertheless landed.
   *
   * The handle is consumed before any work happens, so it is spent whether the
   * batch succeeds or fails. That mirrors a real one-shot server call: the
   * batch was sent, and re-submitting the same handle after a failure would
   * replay edits against state that has since moved.
   *
   * Deliberately NOT enforced: Valve's per-user rate limit. It is a
   * time-based partner-side policy with no documented window or quota, so any
   * number here would be invented, and a client tuned against an invented
   * limit is worse off than one that knows to batch. The two limits Valve does
   * quantify — 100 items per call, 1024 bytes of JSON per item — are enforced
   * below.
   */
  submitUpdateProperties(account, handle) {
    const update = this._update(handle);
    if (!update) {
      return this._fail(
        RESULT.INVALID_STATE,
        `Update handle ${handle} is not open — it was already submitted, or never started`
      );
    }
    this._updates.delete(handle);

    if (update.edits.size > MAX_ITEMS_PER_UPDATE) {
      return this._fail(
        RESULT.LIMIT_EXCEEDED,
        `Update touches ${update.edits.size} items; Steam allows ${MAX_ITEMS_PER_UPDATE} per call`
      );
    }

    return this._transact(account, () => {
      const touched = [];
      for (const [itemId, perItem] of update.edits) {
        const instance = account.get(itemId);
        if (!instance) return this._fail(RESULT.INVALID_PARAM, `Item instance ${itemId} not in inventory`);

        // Merge onto a copy: the account journal restores the whole previous
        // set on rollback, and nothing observes a partially merged one.
        const merged = { ...instance.dynamicProps };
        for (const [name, edit] of perItem) {
          const refusal = this._checkWhitelist(instance, name, edit);
          if (refusal) return this._fail(RESULT.INVALID_PARAM, refusal);
          if (edit.op === 'remove') delete merged[name];
          else merged[name] = edit.prop;
        }

        // The cap is on the item's resulting payload, not on the delta: a
        // one-byte edit that pushes an already-large property set over the
        // line is the case that matters, and measuring the delta would miss
        // exactly that.
        const bytes = propsByteLength(merged);
        if (bytes > MAX_PROPERTY_BYTES) {
          return this._fail(
            RESULT.LIMIT_EXCEEDED,
            `Item instance ${itemId} would hold ${bytes} bytes of dynamic_props JSON; the limit is ${MAX_PROPERTY_BYTES}`
          );
        }

        account.setDynamicProps(instance, merged);
        touched.push(instance);
      }
      // No flags: a property edit neither removes nor consumes anything, so
      // every row here reports 0 and means it.
      return this._ok(touched.map(i => i.toResult()));
    });
  }

  /**
   * The partner-site restriction, evaluated per edit. Returns a refusal string
   * or null.
   *
   * A remove is checked against the name and tag restriction but not the type:
   * removing a property is still "modifying a property from the client", which
   * is what the white-list governs, but there is no incoming value to type.
   */
  _checkWhitelist(instance, name, edit) {
    const whitelist = this.options.propertyWhitelist;
    if (whitelist == null) return null;

    const entry = whitelist.find(e => e && e.name === name);
    if (!entry) return `Dynamic property "${name}" is not white-listed for client-side modification`;

    if (edit.op === 'set' && entry.type != null && entry.type !== edit.prop.type) {
      return `Dynamic property "${name}" is white-listed as ${entry.type}, got ${edit.prop.type}`;
    }

    if (entry.requiredTag != null && entry.requiredTag !== '') {
      const tokens = this.effectiveTags(instance);
      const required = String(entry.requiredTag);
      const satisfied = required.includes(':')
        ? tokens.has(required)
        : [...tokens].some(token => token.slice(0, token.indexOf(':')) === required);
      if (!satisfied) {
        return (
          `Dynamic property "${name}" requires tag "${required}" on item instance ${instance.itemId} ` +
          `or its item definition`
        );
      }
    }
    return null;
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

/** Per-item tags as a readable token list, for failure reasons. */
function tagText(instance) {
  return instance.tags.map(t => `${t.key}:${t.value}`).join(';');
}

module.exports = {
  Engine,
  RESULT,
  ITEM_FLAGS,
  DEFAULT_OPTIONS,
  MAX_DROPS_PER_WINDOW,
  MAX_ITEMS_PER_UPDATE,
  k_SteamItemInstanceIDInvalid,
  mergeTags,
};
