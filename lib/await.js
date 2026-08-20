'use strict';

/**
 * await.js
 *
 * Promise adapters for the handle-based API, for tests, demos and simulator
 * scripts.
 *
 * These live *outside* the provider on purpose. The provider surface stays
 * exactly as awkward as Steam's, so nobody can accidentally write client code
 * against a synchronous fantasy; anything that wants promises has to reach for
 * this file and thereby admit it.
 */

const { RESULT } = require('./engine');

// ─── awaitResult ──────────────────────────────────────────────────────────────

/**
 * Resolve when the given handle's result arrives.
 *
 * @param {object} provider
 * @param {number} handle
 * @param {object} [options]
 * @param {boolean} [options.destroy=true] call destroyResult() after reading
 * @param {number}  [options.timeoutMs=5000]
 * @returns {Promise<{handle:number, status:number, ok:boolean, items:Array, reason:?string, granted:?boolean}>}
 */
function awaitResult(provider, handle, options = {}) {
  const destroy = options.destroy !== false;
  const timeoutMs = options.timeoutMs != null ? options.timeoutMs : 5000;

  return new Promise((resolve, reject) => {
    let timer = null;

    const finish = () => {
      provider.off('resultReady', onReady);
      if (timer) clearTimeout(timer);

      const status = provider.getResultStatus(handle);
      const items = provider.getResultItems(handle) || [];
      const reason = typeof provider.getResultReason === 'function' ? provider.getResultReason(handle) : null;
      const raw = provider._results ? provider._results.get(handle) : null;
      if (destroy) provider.destroyResult(handle);

      resolve({
        handle,
        status,
        ok: status === RESULT.OK,
        items,
        reason,
        granted: raw ? raw.granted : undefined,
        recipeIndex: raw ? raw.recipeIndex : undefined,
      });
    };

    const onReady = readyHandle => {
      if (readyHandle === handle) finish();
    };

    // The result may already be there if the caller awaited something else first.
    if (provider.getResultStatus(handle) != null) {
      finish();
      return;
    }

    provider.on('resultReady', onReady);
    timer = setTimeout(() => {
      provider.off('resultReady', onReady);
      reject(new Error(`Timed out after ${timeoutMs}ms waiting for result handle ${handle}`));
    }, timeoutMs);
    if (typeof timer.unref === 'function') timer.unref();
  });
}

/** `await call(provider, 'exchangeItems', target, materials)` */
function call(provider, method, ...args) {
  const handle = provider[method](...args);
  if (typeof handle !== 'number') {
    throw new Error(`${method}() must return a handle, got ${typeof handle}`);
  }
  return awaitResult(provider, handle);
}

/** Whole-inventory snapshot as itemdefid → total quantity. */
async function inventoryByDef(provider) {
  const result = await call(provider, 'getAllItems');
  const totals = new Map();
  for (const item of result.items) {
    totals.set(item.itemdefid, (totals.get(item.itemdefid) || 0) + item.quantity);
  }
  return totals;
}

module.exports = { awaitResult, call, inventoryByDef };
