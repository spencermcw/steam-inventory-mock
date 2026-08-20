'use strict';

/**
 * demo/save-load.js
 *
 * A save/load round trip against this package's own example economy
 * (examples/economy.js): play a short session, write a save file, build a
 * *fresh* provider with a different seed, load, and compare everything that
 * has to survive an application restart — item instances and their per-item
 * tags, dynamic properties, drop buckets, promo history, the clock, the RNG,
 * and the instance-id watermark.
 *
 * This one stays on the handle-based provider (MockProvider + call(), not
 * init()'s façade): the whole point of the demo is a byte-for-byte compare of
 * plain-JSON state, and the façade's bigint item ids and reject-on-failure
 * idiom would only add conversions to strip back out before comparing.
 *
 *   node demo/save-load.js [seed]
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
const economy = require('../examples/economy');

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

// examples/economy.js itemdefids used below:
//   9060 Starter Kit (promo bundle: 9001x5;9002x2)
//   9011 Tag Recipe   (exchange: rarity:common*3)
//   9050 Daily Drop   (playtimegenerator, drop_interval 30)
//   9041 Tagging Generator (stamps color:red, rolls tag_generator 9040 "quality")
//   9002 Beta         (plain stackable material — the watermark's test subject)

async function inventoryRows(provider) {
  const result = await call(provider, 'getAllItems');
  return result.items
    .map(i => ({ itemId: i.itemId, itemdefid: i.itemdefid, quantity: i.quantity, tags: i.tags, dynamicProps: i.dynamic_props }))
    .sort((a, b) => a.itemId - b.itemId);
}

function printInventory(provider, rows) {
  const nameOf = id => provider.getItemDefinitionProperty(id, 'name') || `#${id}`;
  for (const row of rows) {
    const parts = [];
    if (row.tags) parts.push(`{${row.tags}}`);
    if (row.dynamicProps !== '{}') parts.push(row.dynamicProps);
    console.log(`  #${String(row.itemId).padStart(3)}  ${String(row.quantity).padStart(4)} × ${nameOf(row.itemdefid).padEnd(20)}${parts.length ? `  ${parts.join('  ')}` : ''}`);
  }
}

/** Build ExchangeItems materials ({itemId, quantity}) from what is held, by [itemDefId, wanted] pairs. */
async function materialsFor(provider, pairs) {
  const result = await call(provider, 'getAllItems');
  const out = [];
  for (const [itemDefId, wanted] of pairs) {
    let remaining = wanted;
    for (const item of result.items.filter(i => i.itemdefid === itemDefId)) {
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
  const before = new MockProvider({ schema: economy, seed });
  heading(`1. Play a session (seed "${seed}", ${before.getItemDefinitionIDs().length} itemdefs from examples/economy.js)`);

  const promo = await call(before, 'addPromoItem', 9060);
  console.log(`  addPromoItem(Starter Kit)         granted=${promo.granted}`);

  const exchange = await call(before, 'exchangeItems', 9011, await materialsFor(before, [[9002, 2], [9001, 1]]));
  console.log(`  exchangeItems(Tag Recipe)         ok=${exchange.ok}${exchange.reason ? ` (${exchange.reason})` : ''}`);

  const interval = Number(before.getItemDefinitionProperty(9050, 'drop_interval'));
  before.advanceTime(interval);
  const drop = await call(before, 'triggerItemDrop', 9050);
  console.log(`  triggerItemDrop(Daily Drop)       granted=${drop.granted} after ${interval} min of playtime`);

  // Roll the Tagging Generator (9041) rather than hand-stamping a tag: it
  // applies `color:red` and rolls tag_generator 9040 ("quality"), so the
  // per-item tag on this instance is earned exactly the way a real client's
  // would be, not asserted into existence for the demo's benefit.
  const rolled = await call(before, 'generateItems', [9041], [1]);
  const tagged = rolled.items.find(i => i.itemdefid === 9002);
  console.log(`  generateItems(Tagging Generator)  rolled instance #${tagged.itemId}  {${tagged.tags}}`);

  // A dynamic property too, so the round trip exercises save format v2
  // (dynamicProps) as well as per-item tags.
  const propHandle = before.startUpdateProperties();
  before.setPropertyInt(propHandle, tagged.itemId, 'roll_id', 7);
  const propped = await call(before, 'submitUpdateProperties', propHandle);
  console.log(`  submitUpdateProperties(roll_id=7)  dynamic_props=${propped.items[0].dynamic_props}`);

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
  const after = new MockProvider({ schema: economy, seed: 'a-completely-different-seed' });
  after.loadFromFile(file);
  const afterRows = await inventoryRows(after);
  printInventory(after, afterRows);

  heading('4. Compare');
  check('inventory (ids, itemdefs, quantities, per-item tags)', JSON.stringify(afterRows) === JSON.stringify(beforeRows));
  const taggedBefore = beforeRows.filter(r => r.tags).map(r => `${r.itemId}{${r.tags}}`);
  const taggedAfter = afterRows.filter(r => r.tags).map(r => `${r.itemId}{${r.tags}}`);
  check(`per-item tags specifically (${taggedBefore.length} tagged instance(s))`, JSON.stringify(taggedAfter) === JSON.stringify(taggedBefore));
  const propsBefore = beforeRows.filter(r => r.dynamicProps !== '{}').map(r => `${r.itemId}${r.dynamicProps}`);
  const propsAfter = afterRows.filter(r => r.dynamicProps !== '{}').map(r => `${r.itemId}${r.dynamicProps}`);
  check(`dynamic properties specifically (${propsBefore.length} item(s) with props)`, JSON.stringify(propsAfter) === JSON.stringify(propsBefore));
  check('account payload (buckets, promos, entitlements)', JSON.stringify(after.account.toJSON()) === JSON.stringify(before.account.toJSON()));
  check('clock', after.clock.now() === before.clock.now() && after.clock.playtime() === before.clock.playtime(),
    `nowMs=${after.clock.now()} playtime=${after.clock.playtime()}`);
  check('rng state', after.engine.rng.save() === before.engine.rng.save(), `state=${after.engine.rng.save()}`);

  const bucket = after.account.dropBuckets.get('def:9050');
  check('drop bucket', bucket != null && bucket.grants === 1, bucket ? `grants=${bucket.grants} playtimeAtLastGrant=${bucket.playtimeAtLastGrant}` : 'missing');
  const dropAgain = await call(after, 'triggerItemDrop', 9050);
  check('daily drop is still on cool-down after the reload', dropAgain.granted === false, dropAgain.reason || '');
  after.advanceTime(interval);
  const dropLater = await call(after, 'triggerItemDrop', 9050);
  check(`daily drop is due again ${interval} min later`, dropLater.granted === true);

  const promoAgain = await call(after, 'addPromoItem', 9060);
  check('Starter Kit promo is still spent (once per account)', promoAgain.granted === false, promoAgain.reason || '');

  // ── The watermark ──
  heading('5. Instance-id watermark');
  const restoredIds = beforeRows.map(r => r.itemId);
  console.log(`  restored instance ids: ${restoredIds.join(', ')}`);
  console.log(`  saved nextInstanceId:  ${state.nextInstanceId}`);
  // Beta (9002) was fully spent by the exchange in section 1 — the only Beta
  // instance left after the session is the *tagged* one from the generator
  // roll, a different stack — so a plain grant of 9002 cannot merge into an
  // existing stack; it has to create a brand-new instance with a fresh id.
  const created = await call(after, 'generateItems', [9002], [1]);
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
    const economy = require(${JSON.stringify(path.resolve(__dirname, '../examples/economy.js'))});
    const p = new MockProvider({ schema: economy, seed: 'restarted' });
    p.loadFromFile(${JSON.stringify(file)});
    call(p, 'generateItems', [9002], [1]).then(async () => {
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
