'use strict';

/**
 * persistence.js
 *
 * Saving and restoring a player. The Electron client has to survive being
 * closed, and there is no server behind the mock to hold the state — so the
 * save file *is* the account.
 *
 * A complete save is three things that must move together:
 *   • the account   — instances (with per-item tags), drop buckets, promo
 *                     history, owned apps, achievements, per-app playtime
 *   • the clock     — wall time and accrued playtime (VirtualClock.snapshot)
 *   • the RNG       — one uint32 (Rng.save)
 *
 * Restoring the account without the clock would reset every drop_interval and
 * promo recurrence timer to zero; restoring without the RNG would let a seeded
 * run be replayed with different rolls after a restart. Both snapshot
 * mechanisms already existed for transaction rollback; this composes them
 * rather than inventing a second way to freeze the same state.
 *
 * ── The instance-id watermark ────────────────────────────────────────────────
 *
 * The instance-id counter in inventory.js is module-level: process-global, and
 * not part of the account. Reload without it and ids restart at 1 while the
 * restored inventory already holds 1..N. Nothing throws. Instead two different
 * items answer to the same id, and later an exchange consumes the wrong one, or
 * two stacks merge, or the item the player clicked is not the item that is
 * spent. Silent corruption, discovered long after the save that caused it.
 *
 * So the counter is saved, and on load it is *raised* to the maximum of:
 *   • where it already is (another account may be live in this process),
 *   • the saved counter,
 *   • one past the highest restored instance id.
 *
 * The saved counter matters beyond max+1: ids that were allocated and then
 * consumed are gone from the inventory but are not free. Steam never reissues
 * an item instance id, and anything holding one — a UI selection, an in-flight
 * exchange, a log line — would silently re-point at a different item.
 *
 * ── Not saved ────────────────────────────────────────────────────────────────
 *
 * Result handles (`provider._results`, `_nextHandle`) are per-process by
 * definition: a handle is a pointer into a live result set, meaningless once
 * the process that issued it is gone. Restoring them would resurrect results
 * for operations nobody is waiting on. Real Steam's handles do not survive a
 * restart either.
 */

const fs = require('fs');
const path = require('path');
const { Account, peekNextInstanceId, reserveInstanceIds } = require('./inventory');

// ─── Envelope ─────────────────────────────────────────────────────────────────

/** Marker so a stray JSON file is rejected as a save rather than half-read. */
const SAVE_KIND = 'steam-inventory-mock.save';

/**
 * Bump when the payload shape changes, and add the matching entry to
 * MIGRATIONS. These files live on players' machines: a build that silently
 * mis-reads an old save corrupts an inventory it cannot rebuild, so an
 * unreadable version is a hard, named error rather than a best effort.
 *
 *   1 — instances (with per-item tags), drop buckets, promo history,
 *       entitlements, clock, RNG, instance-id watermark
 *   2 — instances gained `dynamicProps` (see properties.js)
 */
const SAVE_VERSION = 2;

/**
 * version N → N+1 upgrades, applied in sequence on load. Each takes a whole
 * save state and returns a new one; none mutates its input, so a caller that
 * kept a reference to the state it passed in still holds the file it read.
 */
const MIGRATIONS = {
  /**
   * 1 → 2: every instance carries a `dynamicProps` map.
   *
   * This is a normalisation, not a rescue. `ItemInstance.fromJSON` reads a
   * missing `dynamicProps` as an empty set already — the field was designed to
   * be purely additive — so a v1 save loads correctly with or without this
   * step. What the step buys is that exactly one shape reaches Account.fromJSON
   * and everything downstream of it: a migrated v1 save and a native v2 save
   * are the same bytes, which is what makes diffing two saves evidence of
   * anything. The rest of a v1 payload is already what v2 stores, so it is
   * copied through untouched rather than rebuilt — a migration that reformats
   * fields it does not need to touch is a migration that can lose them.
   *
   * A payload with no usable `account` is passed through rather than repaired:
   * migrate() names that failure precisely a few lines below, and a migration
   * that threw on the way there would trade a named error for a stack trace.
   */
  1: state => {
    const account = state.account;
    if (!account || typeof account !== 'object' || !Array.isArray(account.instances)) {
      return { ...state, version: 2 };
    }
    return {
      ...state,
      version: 2,
      account: {
        ...account,
        instances: account.instances.map(instance =>
          instance && typeof instance === 'object' && instance.dynamicProps == null
            ? { ...instance, dynamicProps: {} }
            : instance
        ),
      },
    };
  },
};

function saveError(message) {
  const err = new Error(message);
  err.code = 'SAVE_UNSUPPORTED';
  return err;
}

/**
 * Validate the envelope and bring an older payload up to SAVE_VERSION.
 * A future version is refused outright — this build cannot know what it means,
 * and guessing is how a save gets quietly truncated.
 */
function migrate(state) {
  if (!state || typeof state !== 'object' || Array.isArray(state)) {
    throw saveError('Save state must be an object');
  }
  if (state.kind != null && state.kind !== SAVE_KIND) {
    throw saveError(`Not a ${SAVE_KIND} file (kind: ${JSON.stringify(state.kind)})`);
  }
  const version = state.version;
  if (!Number.isInteger(version) || version < 1) {
    throw saveError(`Save has no usable version field (got ${JSON.stringify(version)})`);
  }
  if (version > SAVE_VERSION) {
    throw saveError(
      `Save version ${version} was written by a newer build; this one reads up to version ${SAVE_VERSION}`
    );
  }

  let current = state;
  for (let v = version; v < SAVE_VERSION; v++) {
    const step = MIGRATIONS[v];
    if (!step) throw saveError(`No migration from save version ${v} to ${v + 1}`);
    current = step(current);
  }

  if (!current.account || typeof current.account !== 'object') {
    throw saveError('Save carries no account payload');
  }
  return current;
}

// ─── Save / load ──────────────────────────────────────────────────────────────

/**
 * Snapshot one account of an engine, plus the engine's clock and RNG.
 *
 * @param {Engine} engine
 * @param {object} [options]
 * @param {string} [options.accountId='player']
 * @returns {object} plain JSON — the caller decides where it goes
 */
function saveState(engine, options = {}) {
  const accountId = options.accountId != null ? options.accountId : 'player';
  const account = engine.accounts.get(accountId);
  if (!account) throw new Error(`No account "${accountId}" on this engine`);

  return {
    kind: SAVE_KIND,
    version: SAVE_VERSION,
    savedAt: new Date().toISOString(),
    /** Process-global, not per account — see the watermark note above. */
    nextInstanceId: peekNextInstanceId(),
    rng: engine.rng.save(),
    clock: engine.clock.snapshot(),
    account: account.toJSON(),
  };
}

/**
 * Restore a save into an engine, replacing that account.
 *
 * Validation happens before anything is mutated, so a bad save leaves the
 * engine exactly as it was rather than half-loaded.
 *
 * @param {Engine} engine
 * @param {object} state output of saveState()
 * @param {object} [options]
 * @param {string} [options.accountId] load under this id (default: the saved id)
 * @param {'error'|'drop'} [options.onUnknownItemdef='error'] what to do with a
 *   saved item whose itemdef no longer exists in the loaded schema — a real
 *   possibility once content ships and an itemdef is deprecated
 * @returns {{account: Account, version: number, dropped: Array, nextInstanceId: number}}
 */
function loadState(engine, state, options = {}) {
  const migrated = migrate(state);
  const onUnknownItemdef = options.onUnknownItemdef || 'error';
  const accountId = options.accountId != null ? options.accountId : migrated.account.id;

  const account = Account.fromJSON(migrated.account, { id: accountId });

  const dropped = [];
  for (const instance of account.list()) {
    if (engine.schema.get(instance.itemdefid)) continue;
    if (onUnknownItemdef === 'drop') {
      account.instances.delete(instance.itemId);
      dropped.push({ itemId: instance.itemId, itemdefid: instance.itemdefid, quantity: instance.quantity });
      continue;
    }
    throw saveError(
      `Save holds item instance ${instance.itemId} of itemdef ${instance.itemdefid}, which is not in the loaded schema`
    );
  }

  // Watermark: raise, never assign. Account.fromJSON already covered the
  // restored ids; this additionally honours ids that were issued and then
  // consumed before the save.
  const nextInstanceId = reserveInstanceIds((Number(migrated.nextInstanceId) || 0) - 1);

  if (migrated.rng != null) engine.rng.restore(migrated.rng);
  if (migrated.clock) engine.clock.restore(migrated.clock);
  engine.accounts.set(accountId, account);

  return { account, version: migrated.version, dropped, nextInstanceId };
}

// ─── Files ────────────────────────────────────────────────────────────────────

/**
 * Write a save atomically: a full write to a sibling temp file, then a rename.
 * A crash mid-write then loses the new save rather than shredding the old one,
 * which on a player's machine is the difference between "lost this session" and
 * "lost this account".
 */
function writeSave(file, state) {
  const target = path.resolve(file);
  const dir = path.dirname(target);
  fs.mkdirSync(dir, { recursive: true });
  const temp = `${target}.tmp-${process.pid}`;
  fs.writeFileSync(temp, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  fs.renameSync(temp, target);
  return target;
}

function readSave(file) {
  const target = path.resolve(file);
  let text;
  try {
    text = fs.readFileSync(target, 'utf8');
  } catch (err) {
    throw new Error(`Cannot read save file ${target}: ${err.message}`);
  }
  try {
    return JSON.parse(text);
  } catch (err) {
    throw saveError(`Save file ${target} is not valid JSON: ${err.message}`);
  }
}

module.exports = { saveState, loadState, writeSave, readSave, migrate, MIGRATIONS, SAVE_VERSION, SAVE_KIND };
