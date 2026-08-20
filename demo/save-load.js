'use strict';

/**
 * demo/save-load.js
 *
 * A save/load round trip against the real transpiled itemdefs
 * (dist/itemdefs.json): play a short session, write a save file, build a
 * *fresh* provider with a different seed, load, and compare everything that
 * has to survive an application restart — item instances and their per-item
 * tags, drop buckets, promo history, the clock, the RNG, and the instance-id
 * watermark.
 *
 *   node mock/demo/save-load.js [seed]
 *
 * The last section is the one that matters most: it creates a new item after
 * the reload and shows its instance id does not collide with any restored id.
 * That failure would not throw — it would quietly give two items one identity.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { MockProvider, call } = require('../index');

// ─── Presentation ─────────────────────────────────────────────────────────────

const seed = process.argv[2] || 'save-load';
const green = t => `\x1b[32m${t}\x1b[0m`;
const red = t => `\x1b[31m${t}\x1b[0m`;

function heading(text) {
  console.log(`\n\x1b[1m${text}\x1b[0m`);
  console.log('─'.repeat(text.length));
}

let failures = 0;
function check(label, ok, detail) {
  if (!ok) failures++;
  console.log(`  ${ok ? green('match') : red('MISMATCH')}  ${label}${detail ? `  ${detail}` : ''}`);
}

const idOf = (provider, cls) => {
  for (const id of provider.getItemDefinitionIDs()) {
    if (provider.getItemDefinitionProperty(id, 'cls') === cls) return id;
  }
  throw new Error(`No itemdef with cls "${cls}"`);
};

async function inventoryRows(provider) {
  const result = await call(provider, 'getAllItems');
  return result.items
    .map(i => ({ itemId: i.itemId, itemdefid: i.itemdefid, quantity: i.quantity, tags: i.tags }))
    .sort((a, b) => a.itemId - b.itemId);
}

function printInventory(provider, rows) {
  const clsOf = id => provider.getItemDefinitionProperty(id, 'cls') || String(id);
  for (const row of rows) {
    console.log(
      `  #${String(row.itemId).padStart(3)}  ${String(row.quantity).padStart(4)} × ${clsOf(row.itemdefid).padEnd(24)}${row.tags ? `  {${row.tags}}` : ''}`
    );
  }
}

async function materialsFor(provider, spec) {
  const result = await call(provider, 'getAllItems');
  const out = [];
  for (const [cls, wanted] of Object.entries(spec)) {
    const defId = idOf(provider, cls);
    let remaining = wanted;
    for (const item of result.items.filter(i => i.itemdefid === defId)) {
      if (remaining <= 0) break;
      const take = Math.min(remaining, item.quantity);
      out.push({ itemId: item.itemId, quantity: take });
      remaining -= take;
    }
  }
  return out;
}

// ─── Scenario ─────────────────────────────────────────────────────────────────

async function main() {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'steam-inventory-mock-save-')), 'player.json');

  // ── Session ──
  const before = new MockProvider({ seed });
  heading(`1. Play a session (seed "${seed}", ${before.getItemDefinitionIDs().length} itemdefs from dist/itemdefs.json)`);

  const welcome = idOf(before, 'welcome_bundle');
  const promo = await call(before, 'addPromoItem', welcome);
  console.log(`  addPromoItem(welcome_bundle)      granted=${promo.granted}`);

  const harvest = await call(
    before,
    'exchangeItems',
    idOf(before, 'exec_operation_101'),
    await materialsFor(before, { xp: 1, operation_101: 1, employee: 1 })
  );
  console.log(`  exchangeItems(exec_operation_101) ok=${harvest.ok}${harvest.reason ? ` (${harvest.reason})` : ''}`);

  const supplyDrop = idOf(before, 'supply_drop');
  const interval = Number(before.getItemDefinitionProperty(supplyDrop, 'drop_interval'));
  before.advanceTime(interval);
  const drop = await call(before, 'triggerItemDrop', supplyDrop);
  console.log(`  triggerItemDrop(supply_drop)      granted=${drop.granted} after ${interval} min of playtime`);

  // The shipped content set currently puts `tags` only on plain `item` defs, so
  // nothing in this session acquires a *per-item* tag on its own. Stamp one the
  // way a tag_generator would, so the round trip is actually made to carry
  // instance tags rather than trivially having none to lose.
  const stamped = before.account.list().find(i => i.itemdefid === idOf(before, 'coal'));
  stamped.tags = [{ key: 'quality', value: 'pristine' }, { key: 'faction', value: 'corp' }];
  console.log(`  (stamped per-item tags on instance #${stamped.itemId}: quality:pristine;faction:corp)`);

  const beforeRows = await inventoryRows(before);
  printInventory(before, beforeRows);

  // ── Save ──
  heading('2. Save');
  const state = before.saveToFile(file);
  console.log(`  ${file}  (${fs.statSync(file).size} bytes)`);
  console.log(`  kind=${state.kind} version=${state.version} rng=${state.rng} nextInstanceId=${state.nextInstanceId}`);
  console.log(`  clock: nowMs=${state.clock.nowMs} playtimeMinutes=${state.clock.playtimeMinutes}`);
  console.log(
    `  account: ${state.account.instances.length} instances, ${state.account.dropBuckets.length} drop bucket(s), ${state.account.promoGrants.length} promo record(s)`
  );

  // ── Reload into a fresh provider ──
  heading('3. Fresh provider, different seed, load');
  const after = new MockProvider({ seed: 'a-completely-different-seed' });
  after.loadFromFile(file);
  const afterRows = await inventoryRows(after);
  printInventory(after, afterRows);

  heading('4. Compare');
  check('inventory (ids, itemdefs, quantities, per-item tags)', JSON.stringify(afterRows) === JSON.stringify(beforeRows));
  const taggedBefore = beforeRows.filter(r => r.tags).map(r => `${r.itemId}{${r.tags}}`);
  const taggedAfter = afterRows.filter(r => r.tags).map(r => `${r.itemId}{${r.tags}}`);
  check(`per-item tags specifically (${taggedBefore.length} tagged instance(s))`, JSON.stringify(taggedAfter) === JSON.stringify(taggedBefore));
  check('account payload (buckets, promos, entitlements)', JSON.stringify(after.account.toJSON()) === JSON.stringify(before.account.toJSON()));
  check('clock', after.clock.now() === before.clock.now() && after.clock.playtime() === before.clock.playtime(),
    `nowMs=${after.clock.now()} playtime=${after.clock.playtime()}`);
  check('rng state', after.engine.rng.save() === before.engine.rng.save(), `state=${after.engine.rng.save()}`);

  const bucket = after.account.dropBuckets.get(`def:${supplyDrop}`);
  check('drop bucket', bucket != null && bucket.grants === 1, bucket ? `grants=${bucket.grants} playtimeAtLastGrant=${bucket.playtimeAtLastGrant}` : 'missing');
  const dropAgain = await call(after, 'triggerItemDrop', supplyDrop);
  check('supply drop is still on cool-down after the reload', dropAgain.granted === false, dropAgain.reason || '');
  after.advanceTime(interval);
  const dropLater = await call(after, 'triggerItemDrop', supplyDrop);
  check(`supply drop is due again ${interval} min later`, dropLater.granted === true);

  const promoAgain = await call(after, 'addPromoItem', welcome);
  check('welcome promo is still spent (once per account)', promoAgain.granted === false, promoAgain.reason || '');

  // ── The watermark ──
  heading('5. Instance-id watermark');
  const restoredIds = beforeRows.map(r => r.itemId);
  console.log(`  restored instance ids: ${restoredIds.join(', ')}`);
  console.log(`  saved nextInstanceId:  ${state.nextInstanceId}`);
  // operation_101 was spent by the harvest, so this grant cannot merge into an
  // existing stack — it has to create a brand-new instance with a fresh id.
  const created = await call(after, 'generateItems', [idOf(after, 'operation_101')], [1]);
  const newIds = (await inventoryRows(after)).map(r => r.itemId).filter(id => !restoredIds.includes(id));
  console.log(`  new instance ids after the reload: ${newIds.length > 0 ? newIds.join(', ') : '(all grants merged into restored stacks)'}`);
  check(
    'no new instance id collides with a restored id',
    newIds.every(id => !restoredIds.includes(id)) && newIds.every(id => id >= state.nextInstanceId),
    `granted ${created.items.length} item(s)`
  );
  const allIds = (await inventoryRows(after)).map(r => r.itemId);
  check('every instance id in the reloaded inventory is unique', new Set(allIds).size === allIds.length);

  // The checks above run in the process that issued those ids, where the
  // counter was never going to restart anyway. A real restart is a new process
  // with the counter back at 1 — which is the case the watermark exists for, so
  // load the same save file in a child and look at the id it hands out.
  heading('6. Cold restart (a child process, counter starting from 1)');
  const child = `
    const { MockProvider, call } = require(${JSON.stringify(path.resolve(__dirname, '../index.js'))});
    const p = new MockProvider({ seed: 'restarted' });
    p.loadFromFile(${JSON.stringify(file)});
    call(p, 'generateItems', [${idOf(after, 'operation_101')}], [1]).then(async () => {
      const all = await call(p, 'getAllItems');
      console.log(JSON.stringify(all.items.map(i => i.itemId).sort((a, b) => a - b)));
    });
  `;
  const coldIds = JSON.parse(execFileSync(process.execPath, ['-e', child], { encoding: 'utf8' }));
  const coldNew = coldIds.filter(id => !restoredIds.includes(id));
  console.log(`  inventory ids after a cold load: ${coldIds.join(', ')}`);
  console.log(`  id issued to the item created after the cold load: ${coldNew.join(', ')}`);
  check('no id issued after a cold restart collides with a restored id', coldNew.every(id => !restoredIds.includes(id)));
  check(`every id after a cold restart is at or above the saved watermark (${state.nextInstanceId})`, coldNew.every(id => id >= state.nextInstanceId));
  check('the cold-loaded inventory still has one instance per id', new Set(coldIds).size === coldIds.length);

  fs.rmSync(path.dirname(file), { recursive: true, force: true });
  console.log(`\n${failures === 0 ? green('All checks matched.') : red(`${failures} check(s) failed.`)}`);
  if (failures > 0) process.exitCode = 1;
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
