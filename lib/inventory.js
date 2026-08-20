'use strict';

/**
 * inventory.js
 *
 * The per-account state the engine mutates: item instances, playtime-drop
 * buckets, promo grant history, and the Steam entitlements promo rules read
 * (owned apps, achievements, per-app playtime).
 *
 * Everything mutating goes through a journal so a whole operation can be rolled
 * back. ExchangeItems is atomic on real Steam — materials are consumed and the
 * target granted as one transaction — and that atomicity is what makes the
 * `requires` consume-and-reissue ownership check sound. A mock that could leave
 * half-applied state would silently bless a broken design.
 *
 * Journalling (undo closures) rather than deep-copy snapshots, because the
 * balance simulator runs millions of exchanges and cannot pay to clone an
 * inventory per call.
 *
 * Everything here is serialisable: `Account.toJSON()` / `Account.fromJSON()`
 * round-trip the six collections below, and the module-level instance-id
 * counter is exposed as a watermark so a restored account cannot be handed an
 * id it already owns (see persistence.js, and `reserveInstanceIds` below).
 */

// ─── ItemInstance ─────────────────────────────────────────────────────────────

let nextGlobalInstanceId = 1;

/** The id the next created instance will be given. Read by save. */
function peekNextInstanceId() {
  return nextGlobalInstanceId;
}

/**
 * Raise the instance-id watermark past `throughId`, and never lower it.
 *
 * The counter is module-level, so it is shared by every Account in the process
 * — the Engine deliberately supports several accounts (several players) over
 * one economy. Restoring a save therefore cannot *assign* the counter: account
 * A loaded after account B would rewind it and start reissuing ids B already
 * holds. Collisions of that kind do not crash; they silently merge two items,
 * or let an exchange consume an instance the player never selected. Monotone
 * raising is the only safe operation, which is why this takes a floor rather
 * than a value.
 */
function reserveInstanceIds(throughId) {
  const next = Math.floor(Number(throughId)) + 1;
  if (Number.isFinite(next) && next > nextGlobalInstanceId) nextGlobalInstanceId = next;
  return nextGlobalInstanceId;
}

/** JSON object keys are strings; itemdefids and appids are numbers. */
function numericKey(key) {
  const n = Number(key);
  return Number.isFinite(n) && String(n) === String(key).trim() ? n : key;
}

/**
 * Two grants merge into one stack only if they are the same itemdef AND carry
 * the same per-item tags — differently tagged items are distinguishable and
 * must stay distinguishable.
 */
function stackKeyFor(itemdefid, tags) {
  return `${itemdefid}|${(tags || []).map(t => `${t.key}:${t.value}`).sort().join(';')}`;
}

class ItemInstance {
  constructor({ itemId, itemdefid, quantity, tags, acquiredMs }) {
    this.itemId = itemId;
    this.itemdefid = itemdefid;
    this.quantity = quantity;
    /** Per-item tags: assigned at creation, persist for the item's lifetime. */
    this.tags = tags || [];
    this.acquiredMs = acquiredMs;
  }

  /** Stable identity for stack merging: same itemdef AND same per-item tags. */
  stackKey() {
    return stackKeyFor(this.itemdefid, this.tags);
  }

  /** The shape returned through result sets — mirrors SteamItemDetails_t plus tags. */
  toResult() {
    return {
      itemId: this.itemId,
      itemdefid: this.itemdefid,
      quantity: this.quantity,
      tags: this.tags.map(t => `${t.key}:${t.value}`).join(';'),
    };
  }

  /**
   * Save form. Tags are kept as structured pairs and in their original order:
   * they are rolled once at creation (generator tags, tag_generator rolls) and
   * persist for the item's life on real Steam, so losing them on reload would
   * silently strip cosmetics and faction affiliation from items the player
   * already owns.
   */
  toJSON() {
    return {
      itemId: this.itemId,
      itemdefid: this.itemdefid,
      quantity: this.quantity,
      tags: this.tags.map(t => ({ key: t.key, value: t.value })),
      acquiredMs: this.acquiredMs != null ? this.acquiredMs : null,
    };
  }

  static fromJSON(raw) {
    const itemId = Number(raw && raw.itemId);
    const itemdefid = Number(raw && raw.itemdefid);
    const quantity = Number(raw && raw.quantity);
    if (!Number.isInteger(itemId) || itemId <= 0) {
      throw new Error(`Saved item instance has a bad itemId: ${JSON.stringify(raw && raw.itemId)}`);
    }
    if (!Number.isFinite(itemdefid)) {
      throw new Error(`Saved item instance ${itemId} has a bad itemdefid`);
    }
    if (!Number.isFinite(quantity) || quantity <= 0) {
      throw new Error(`Saved item instance ${itemId} has a bad quantity: ${JSON.stringify(raw.quantity)}`);
    }
    return new ItemInstance({
      itemId,
      itemdefid,
      quantity,
      tags: (raw.tags || []).map(t => ({ key: String(t.key), value: String(t.value) })),
      acquiredMs: raw.acquiredMs != null ? Number(raw.acquiredMs) : undefined,
    });
  }
}

// ─── Account ──────────────────────────────────────────────────────────────────

class Account {
  constructor(id) {
    this.id = id;
    /** @type {Map<number, ItemInstance>} instanceId → instance */
    this.instances = new Map();

    /** Playtime-drop tracking. Key is "def:<id>" or "app" (the shared budget). */
    this.dropBuckets = new Map();
    /** Promo grant history: itemdefid → { count, lastGrantMs }. */
    this.promoGrants = new Map();

    /** Entitlements consulted by promo rules. */
    this.ownedApps = new Set();
    this.achievements = new Set();
    this.playtimeByApp = new Map();

    this._journal = null;
  }

  // ── Transaction ──

  begin() {
    if (this._journal) throw new Error('Nested transactions are not supported');
    this._journal = [];
  }

  commit() {
    this._journal = null;
  }

  rollback() {
    if (!this._journal) return;
    for (let i = this._journal.length - 1; i >= 0; i--) this._journal[i]();
    this._journal = null;
  }

  record(undo) {
    if (this._journal) this._journal.push(undo);
  }

  // ── Instances ──

  get(itemId) {
    return this.instances.get(Number(itemId)) || null;
  }

  list() {
    return [...this.instances.values()];
  }

  /** All instances of an itemdef (there can be several: distinct per-item tags). */
  instancesOf(itemdefid) {
    return this.list().filter(i => i.itemdefid === Number(itemdefid));
  }

  /** Total quantity held of an itemdef, across stacks. */
  countOf(itemdefid) {
    let total = 0;
    for (const inst of this.instances.values()) {
      if (inst.itemdefid === Number(itemdefid)) total += inst.quantity;
    }
    return total;
  }

  add(instance) {
    this.instances.set(instance.itemId, instance);
    this.record(() => this.instances.delete(instance.itemId));
    return instance;
  }

  remove(instance) {
    this.instances.delete(instance.itemId);
    this.record(() => this.instances.set(instance.itemId, instance));
  }

  setQuantity(instance, quantity) {
    const previous = instance.quantity;
    instance.quantity = quantity;
    this.record(() => {
      instance.quantity = previous;
      if (!this.instances.has(instance.itemId)) this.instances.set(instance.itemId, instance);
    });
    if (quantity <= 0) this.remove(instance);
    return instance;
  }

  /** Create a new instance with a fresh, process-unique instance id. */
  createInstance(itemdefid, quantity, tags, acquiredMs) {
    return this.add(
      new ItemInstance({
        itemId: nextGlobalInstanceId++,
        itemdefid: Number(itemdefid),
        quantity,
        tags,
        acquiredMs,
      })
    );
  }

  // ── Drop buckets ──

  dropBucket(key) {
    let bucket = this.dropBuckets.get(key);
    if (!bucket) {
      bucket = { key, grants: 0, playtimeAtLastGrant: 0, windowStartMs: null, windowGrants: 0 };
      this.dropBuckets.set(key, bucket);
      this.record(() => this.dropBuckets.delete(key));
    }
    return bucket;
  }

  updateDropBucket(bucket, changes) {
    const previous = { ...bucket };
    Object.assign(bucket, changes);
    this.record(() => Object.assign(bucket, previous));
  }

  // ── Promo history ──

  promoRecord(itemdefid) {
    let record = this.promoGrants.get(itemdefid);
    if (!record) {
      record = { itemdefid, count: 0, lastGrantMs: null };
      this.promoGrants.set(itemdefid, record);
      this.record(() => this.promoGrants.delete(itemdefid));
    }
    return record;
  }

  updatePromoRecord(record, changes) {
    const previous = { ...record };
    Object.assign(record, changes);
    this.record(() => Object.assign(record, previous));
  }

  // ── Persistence ──

  /**
   * The whole account as plain JSON: instances (with their per-item tags), drop
   * buckets, promo history, and the three entitlement collections promo rules
   * read. Collections are emitted in sorted order so two equal accounts produce
   * byte-identical saves — useful for diffing a save file, and for asserting a
   * round trip changed nothing.
   *
   * The instance-id counter is *not* here: it is process-global, not per
   * account, so it belongs to the envelope (see persistence.js).
   */
  toJSON() {
    if (this._journal) {
      throw new Error('Cannot serialise an account mid-transaction — commit or roll back first');
    }
    return {
      id: this.id,
      instances: this.list()
        .sort((a, b) => a.itemId - b.itemId)
        .map(i => i.toJSON()),
      dropBuckets: [...this.dropBuckets.entries()]
        .sort((a, b) => String(a[0]).localeCompare(String(b[0])))
        .map(([key, bucket]) => ({
          key,
          grants: bucket.grants,
          playtimeAtLastGrant: bucket.playtimeAtLastGrant,
          windowStartMs: bucket.windowStartMs != null ? bucket.windowStartMs : null,
          windowGrants: bucket.windowGrants,
        })),
      promoGrants: [...this.promoGrants.entries()]
        .sort((a, b) => Number(a[0]) - Number(b[0]))
        .map(([itemdefid, record]) => ({
          itemdefid,
          count: record.count,
          lastGrantMs: record.lastGrantMs != null ? record.lastGrantMs : null,
        })),
      ownedApps: [...this.ownedApps].sort((a, b) => Number(a) - Number(b)),
      achievements: [...this.achievements].sort(),
      playtimeByApp: [...this.playtimeByApp.entries()]
        .sort((a, b) => Number(a[0]) - Number(b[0]))
        .map(([appid, minutes]) => ({ appid, minutes })),
    };
  }

  /**
   * Rebuild an account from `toJSON()` output.
   *
   * Restoring instances raises the module-level instance-id watermark past the
   * highest id restored, so the very next createInstance() cannot hand out an
   * id this account already holds. That is done here rather than only in
   * persistence.js so that *any* path back from JSON is safe.
   *
   * @param {object} json
   * @param {object} [options]
   * @param {string} [options.id] load under a different account id
   */
  static fromJSON(json, options = {}) {
    if (!json || typeof json !== 'object') throw new Error('Account.fromJSON needs a saved account object');
    const account = new Account(options.id != null ? options.id : json.id);

    let highestId = 0;
    for (const raw of json.instances || []) {
      const instance = ItemInstance.fromJSON(raw);
      if (account.instances.has(instance.itemId)) {
        throw new Error(`Saved account holds duplicate item instance id ${instance.itemId}`);
      }
      account.instances.set(instance.itemId, instance);
      if (instance.itemId > highestId) highestId = instance.itemId;
    }
    reserveInstanceIds(highestId);

    for (const raw of json.dropBuckets || []) {
      account.dropBuckets.set(String(raw.key), {
        key: String(raw.key),
        grants: Number(raw.grants) || 0,
        playtimeAtLastGrant: Number(raw.playtimeAtLastGrant) || 0,
        windowStartMs: raw.windowStartMs != null ? Number(raw.windowStartMs) : null,
        windowGrants: Number(raw.windowGrants) || 0,
      });
    }

    for (const raw of json.promoGrants || []) {
      const key = numericKey(raw.itemdefid);
      account.promoGrants.set(key, {
        itemdefid: key,
        count: Number(raw.count) || 0,
        lastGrantMs: raw.lastGrantMs != null ? Number(raw.lastGrantMs) : null,
      });
    }

    for (const appid of json.ownedApps || []) account.ownedApps.add(numericKey(appid));
    for (const name of json.achievements || []) account.achievements.add(String(name));
    for (const raw of json.playtimeByApp || []) {
      account.playtimeByApp.set(numericKey(raw.appid), Number(raw.minutes) || 0);
    }

    return account;
  }

  // ── Diagnostics ──

  /**
   * Deterministic, order-independent serialisation of inventory contents.
   * Tests compare these strings to assert an operation left inventory
   * byte-identical.
   *
   * Deliberately lossy: it flattens tag structure and ignores drop buckets,
   * promo history and entitlements entirely. It is a fine assertion that an
   * *operation* changed nothing, and an insufficient one for save/load — a
   * round trip can preserve the fingerprint while dropping every per-item tag.
   * Compare `toJSON()` output for that.
   */
  fingerprint() {
    return JSON.stringify(
      this.list()
        .map(i => [i.itemId, i.itemdefid, i.quantity, i.tags.map(t => `${t.key}:${t.value}`).sort().join(';')])
        .sort((a, b) => a[0] - b[0])
    );
  }
}

module.exports = { Account, ItemInstance, stackKeyFor, peekNextInstanceId, reserveInstanceIds };
