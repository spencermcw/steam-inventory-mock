'use strict';

/**
 * demo/playthrough.js
 *
 * An end-to-end run against the real transpiled itemdefs (dist/itemdefs.json):
 * grant the new-player promo, run a harvest operation, attempt a craft the
 * player cannot afford, take a supply drop off the virtual clock.
 *
 *   node mock/demo/playthrough.js [seed]
 *
 * Everything here goes through the async, handle-based provider — the same
 * calls the Godot client makes — so the printed transcript is what the game
 * would actually observe.
 */

const { MockProvider, call } = require('../index');

// ─── Presentation ─────────────────────────────────────────────────────────────

const seed = process.argv[2] || 'playthrough';
const provider = new MockProvider({ seed });

const nameOf = id => provider.getItemDefinitionProperty(id, 'name') || `#${id}`;
const clsOf = id => provider.getItemDefinitionProperty(id, 'cls') || String(id);
const idOf = cls => {
  for (const id of provider.getItemDefinitionIDs()) {
    if (provider.getItemDefinitionProperty(id, 'cls') === cls) return id;
  }
  throw new Error(`No itemdef with cls "${cls}"`);
};

function heading(text) {
  console.log(`\n\x1b[1m${text}\x1b[0m`);
  console.log('─'.repeat(text.length));
}

async function inventory() {
  const result = await call(provider, 'getAllItems');
  const rows = result.items
    .slice()
    .sort((a, b) => a.itemdefid - b.itemdefid)
    .map(i => `  ${String(i.quantity).padStart(4)} × ${nameOf(i.itemdefid).padEnd(28)} [${clsOf(i.itemdefid)}]${i.tags ? `  {${i.tags}}` : ''}`);
  console.log(rows.length > 0 ? rows.join('\n') : '  (empty)');
  return result.items;
}

/** Build an ExchangeItems material list ({ cls: qty }) from what is held. */
async function materialsFor(spec) {
  const result = await call(provider, 'getAllItems');
  const out = [];
  for (const [cls, wanted] of Object.entries(spec)) {
    const defId = idOf(cls);
    let remaining = wanted;
    for (const item of result.items.filter(i => i.itemdefid === defId)) {
      if (remaining <= 0) break;
      const take = Math.min(remaining, item.quantity);
      out.push({ itemId: item.itemId, quantity: take });
      remaining -= take;
    }
    if (remaining > 0) console.log(`  ! short ${remaining} × ${cls}`);
  }
  return out;
}

function report(label, result) {
  const verdict = result.ok ? '\x1b[32mOK\x1b[0m' : `\x1b[31mFAILED (EResult ${result.status})\x1b[0m`;
  console.log(`  ${label}: ${verdict}${result.reason ? ` — ${result.reason}` : ''}`);
  for (const item of result.items) {
    const change = item.quantity === 0 ? 'spent' : `→ ${item.quantity}`;
    console.log(`    ${nameOf(item.itemdefid).padEnd(28)} ${change}`);
  }
}

// ─── Scenario ─────────────────────────────────────────────────────────────────

async function main() {
  console.log(`Mock Steam Inventory Service — seed "${seed}", ${provider.getItemDefinitionIDs().length} itemdefs from dist/itemdefs.json`);

  heading('1. New player: AddPromoItem(welcome_bundle)');
  report('addPromoItem', await call(provider, 'addPromoItem', idOf('welcome_bundle')));
  await inventory();

  heading('2. Promo is once-per-account');
  report('addPromoItem (again)', await call(provider, 'addPromoItem', idOf('welcome_bundle')));

  heading('3. Harvest: ExchangeItems(exec_operation_101)');
  console.log(`  recipe: ${provider.getItemDefinitionProperty(idOf('exec_operation_101'), 'exchange')}`);
  console.log(`  drop table: ${provider.getItemDefinitionProperty(idOf('exec_operation_101'), 'bundle')}`);
  report(
    'exchangeItems',
    await call(provider, 'exchangeItems', idOf('exec_operation_101'), await materialsFor({ xp: 1, operation_101: 1, employee: 1 }))
  );
  await inventory();

  heading('4. Craft the player cannot afford: ExchangeItems(craft_smelter)');
  console.log(`  recipe: ${provider.getItemDefinitionProperty(idOf('craft_smelter'), 'exchange')}`);
  const before = JSON.stringify((await call(provider, 'getAllItems')).items);
  report('exchangeItems', await call(provider, 'exchangeItems', idOf('craft_smelter'), await materialsFor({ smelter_blueprint: 1, employee: 3, coal: 20, iron_ore: 15 })));
  const after = JSON.stringify((await call(provider, 'getAllItems')).items);
  console.log(`  inventory byte-identical after the failure: ${before === after ? '\x1b[32myes\x1b[0m' : '\x1b[31mNO\x1b[0m'}`);

  heading('5. Playtime drop: TriggerItemDrop(supply_drop)');
  const supplyDrop = idOf('supply_drop');
  const interval = Number(provider.getItemDefinitionProperty(supplyDrop, 'drop_interval'));
  console.log(`  drop_interval: ${interval} min of playtime`);
  report('triggerItemDrop (t+0)', await call(provider, 'triggerItemDrop', supplyDrop));
  provider.advanceTime(interval);
  report(`triggerItemDrop (t+${interval})`, await call(provider, 'triggerItemDrop', supplyDrop));
  report('triggerItemDrop (immediately after)', await call(provider, 'triggerItemDrop', supplyDrop));

  heading('6. Final inventory');
  await inventory();

  const leaked = provider.leakedResults();
  console.log(`\nUndestroyed result handles: ${leaked.length}`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
