'use strict';

/**
 * demo/playthrough.js
 *
 * An end-to-end run against this package's own example economy
 * (examples/economy.js), through the steamworks.js-shaped façade (init(), see
 * lib/steamworks.js): namespaced calls, promises, bigint item ids,
 * callback.register(). This file doubles as this package's worked API
 * example — everything below is meant to be copy-pasteable against a real
 * client, which is also why it is the one demo required to go through the
 * façade rather than the handle-based provider underneath it.
 *
 *   node demo/playthrough.js [seed]
 *
 * The story: claim a promo (and watch a second claim grant nothing — it is
 * once per account), run a successful exchange, watch an underfunded one fail
 * with the inventory left byte-identical, paint an item with a tag tool, read
 * the resulting per-item tag back, stamp a dynamic property and read that
 * back too, then take a playtime drop through the virtual clock — refused at
 * t+0, granted at t+drop_interval, refused again immediately after.
 */

const { init, SteamCallback, SteamInventoryError } = require('../index');
const economy = require('../examples/economy');

// ─── Presentation ─────────────────────────────────────────────────────────────

const seed = process.argv[2] || 'playthrough';
const client = init({ schema: economy, seed });
const { inventory, callback, mock } = client;

const green = t => `\x1b[32m${t}\x1b[0m`;
const red = t => `\x1b[31m${t}\x1b[0m`;

function heading(text) {
  console.log(`\n\x1b[1m${text}\x1b[0m`);
  console.log('─'.repeat(text.length));
}

/** Display by itemdef `name` — the property Steam actually defines, not an authoring convention. */
const nameOf = id => inventory.getItemDefinitionProperty(id, 'name') || `#${id}`;

function printInventory(items) {
  const rows = items
    .slice()
    .sort((a, b) => a.itemDefId - b.itemDefId)
    .map(i => `  ${String(i.quantity).padStart(4)} × ${nameOf(i.itemDefId).padEnd(24)}${i.tags.length ? `  {${i.tags.join(';')}}` : ''}`);
  console.log(rows.length > 0 ? rows.join('\n') : '  (empty)');
}

/**
 * Build an ExchangeItems material list ({itemId, quantity}) from what the
 * account currently holds, by itemdefid — `pairs` is [itemDefId, wanted][]
 * rather than an object, so a small id requested after a large one is not
 * silently reordered by JS's integer-key iteration rules.
 */
async function materialsFor(pairs) {
  const held = await inventory.getAllItems();
  const out = [];
  for (const [itemDefId, wanted] of pairs) {
    let remaining = wanted;
    for (const item of held.filter(i => i.itemDefId === itemDefId)) {
      if (remaining <= 0) break;
      const take = Math.min(remaining, item.quantity);
      out.push({ itemId: item.itemId, quantity: take });
      remaining -= take;
    }
    if (remaining > 0) console.log(`  ! short ${remaining} × ${nameOf(itemDefId)}`);
  }
  return out;
}

/** A comparable snapshot of the whole inventory — bigint ids stringified, order-independent. */
function snapshot(items) {
  return JSON.stringify(
    items
      .map(i => ({ itemId: i.itemId.toString(), itemDefId: i.itemDefId, quantity: i.quantity, tags: i.tags, dynamicProps: i.dynamicProps }))
      .sort((a, b) => a.itemId.localeCompare(b.itemId))
  );
}

/**
 * Run a promise-returning inventory call and print the outcome. The façade
 * reports failure by rejecting (SteamInventoryError) rather than by handing
 * back a status code — this is the one place that idiom is caught and turned
 * into a printed line instead of an uncaught rejection.
 */
async function attempt(label, promise) {
  try {
    const items = await promise;
    console.log(`  ${label}: ${green('OK')}${items.length === 0 ? ' (nothing)' : ''}`);
    for (const item of items) {
      console.log(`    ${nameOf(item.itemDefId).padEnd(24)} → ${item.quantity}${item.tags.length ? `  {${item.tags.join(';')}}` : ''}`);
    }
    return items;
  } catch (err) {
    if (!(err instanceof SteamInventoryError)) throw err;
    console.log(`  ${label}: ${red('FAILED')} — ${err.message}`);
    return null;
  }
}

// ─── Scenario ─────────────────────────────────────────────────────────────────

async function main() {
  console.log(`Mock Steam Inventory Service — seed "${seed}", ${inventory.getItemDefinitionIDs().length} itemdefs from examples/economy.js`);

  // callback.register() in action: count every SteamInventoryResultReady this
  // session raises, the same event a real napi binding would deliver.
  let resultsSeen = 0;
  const subscription = callback.register(SteamCallback.SteamInventoryResultReady, () => {
    resultsSeen++;
  });

  heading('1. New player: AddPromoItem(Starter Kit)');
  await attempt('addPromoItem(9060)', inventory.addPromoItem(9060));
  printInventory(await inventory.getAllItems());

  heading('2. Promo is once-per-account');
  await attempt('addPromoItem(9060) again', inventory.addPromoItem(9060));

  heading('3. Exchange: ExchangeItems(Tag Recipe) — rarity:common*3');
  console.log(`  recipe: ${inventory.getItemDefinitionProperty(9011, 'exchange')}`);
  await attempt('exchangeItems(9011)', inventory.exchangeItems(9011, await materialsFor([[9001, 1], [9002, 2]])));
  printInventory(await inventory.getAllItems());

  heading('4. Underfunded exchange: ExchangeItems(Bundle Recipe) — no Gamma on hand');
  console.log(`  recipe: ${inventory.getItemDefinitionProperty(9022, 'exchange')}`);
  const before = snapshot(await inventory.getAllItems());
  await attempt('exchangeItems(9022)', inventory.exchangeItems(9022, await materialsFor([[9003, 1]])));
  const after = snapshot(await inventory.getAllItems());
  console.log(`  inventory byte-identical after the failure: ${before === after ? green('yes') : red('NO')}`);

  heading('5. Tag tool: paint the Hat with the Red Paint Can');
  // Nothing in the economy grants a Red Paint Can or a Hat outright, so
  // GenerateItems (sandbox-only on real Steam, genuine ISteamInventory)
  // conjures the pair. ExchangeItems then applies the tool: the target's own
  // itemdefid (9101) plus a material list of [tool, subject] is Valve's shape
  // for a tag_tool application, not a recipe.
  const conjured = await attempt('generateItems(Red Paint Can, Hat)', inventory.generateItems([9100, 9101], [1, 1]));
  const tool = conjured.find(i => i.itemDefId === 9100);
  const hat = conjured.find(i => i.itemDefId === 9101);
  // toolResultPolicy is 'new-instance' by default: the target is destroyed and
  // a fresh instance issued, so the touched set below includes the spent tool,
  // the spent old Hat, and the new painted Hat — find it by what is left holding it.
  const painted = await attempt('exchangeItems(Hat, [tool, hat])', inventory.exchangeItems(9101, [tool.itemId, hat.itemId]));
  const paintedHat = painted.find(i => i.itemDefId === 9101 && i.quantity > 0);
  console.log(`  Hat's per-item tags after painting: {${paintedHat.tags.join(';')}}`);

  heading('6. Dynamic property: stamp and read back');
  const handle = inventory.startUpdateProperties();
  inventory.setPropertyInt(handle, paintedHat.itemId, 'enchant_level', 3);
  const updated = await attempt('submitUpdateProperties', inventory.submitUpdateProperties(handle));
  console.log(`  dynamicProps on the painted Hat: ${JSON.stringify(updated[0].dynamicProps)}`);

  heading('7. Virtual clock: TriggerItemDrop(Daily Drop)');
  const interval = Number(inventory.getItemDefinitionProperty(9050, 'drop_interval'));
  console.log(`  drop_interval: ${interval} min of playtime`);
  await attempt('triggerItemDrop (t+0)', inventory.triggerItemDrop(9050));
  mock.advanceTime(interval);
  await attempt(`triggerItemDrop (t+${interval})`, inventory.triggerItemDrop(9050));
  await attempt('triggerItemDrop (immediately after)', inventory.triggerItemDrop(9050));

  heading('8. Final inventory');
  printInventory(await inventory.getAllItems());

  subscription.disconnect();
  // runCallbacks() exists for shape parity with steamworks.js's host loop; it
  // is not needed here (every await above already let pending work land), but
  // one call demonstrates it costs nothing to include in a real client's loop.
  await client.runCallbacks();
  console.log(`\nSteamInventoryResultReady callbacks observed: ${resultsSeen}`);
  console.log(`Undestroyed result handles: ${mock.leakedResults().length}`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
