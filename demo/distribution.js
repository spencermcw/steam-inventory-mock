'use strict';

/**
 * demo/distribution.js
 *
 * Roll a generator from this package's own example economy
 * (examples/economy.js) many times under a fixed seed and print the observed
 * yield distribution against the declared weights.
 *
 *   node demo/distribution.js [itemdefid] [rolls] [seed]
 *   node demo/distribution.js 9030 20000 alpha
 *
 * The default, 9030 "Weighted Generator", exists in the economy for exactly
 * this: its bundle is `9001x70;9002x20;9003x10`, so the expected percentages
 * are exact round numbers (70% / 20% / 10%) and the printed error column
 * means something at a glance.
 *
 * Two things this demonstrates, both preconditions for the balance simulator:
 * the roll is unbiased with respect to the declared weights, and it is exactly
 * reproducible from the seed.
 *
 * This uses the synchronous Engine rather than the async provider — the same
 * engine the provider wraps. Monte Carlo runs need the throughput, and sharing
 * the engine is what keeps the simulated economy identical to the shipped one.
 */

const { Engine } = require('../index');
const economy = require('../examples/economy');

// ─── Arguments ────────────────────────────────────────────────────────────────

const itemdefid = Number(process.argv[2] || 9030);
const rolls = Number(process.argv[3] || 20000);
const seed = process.argv[4] || 'distribution';

// ─── Roll ─────────────────────────────────────────────────────────────────────

function run(engineSeed) {
  const engine = new Engine({ schema: economy, seed: engineSeed });
  const generator = engine.schema.get(itemdefid);
  if (!generator) {
    throw new Error(`Unknown itemdefid ${itemdefid}`);
  }
  if (generator.bundle.length === 0) {
    throw new Error(`itemdef ${itemdefid} "${generator.name}" (${generator.type}) has no weighted bundle`);
  }

  const account = engine.createAccount('sim');
  const outcomes = new Map(); // synthetic yield bundle → times selected
  const items = new Map(); // concrete itemdef → total quantity granted

  for (let i = 0; i < rolls; i++) {
    // Roll the generator's own weighted table, then expand the chosen entry.
    const pick = engine.rng.pickWeighted(generator.bundle, e => e.quantity);
    outcomes.set(pick.itemdefid, (outcomes.get(pick.itemdefid) || 0) + 1);

    const before = new Map([...account.instances.values()].map(inst => [inst.itemId, inst.quantity]));
    engine.generateItems(account, [pick.itemdefid], [1]);
    for (const inst of account.instances.values()) {
      const delta = inst.quantity - (before.get(inst.itemId) || 0);
      if (delta > 0) items.set(inst.itemdefid, (items.get(inst.itemdefid) || 0) + delta);
    }
  }

  return { engine, generator, outcomes, items };
}

const { engine, generator, outcomes, items } = run(seed);
const totalWeight = generator.bundle.reduce((sum, e) => sum + e.quantity, 0);

console.log(`Generator: ${generator.name}  [itemdefid ${generator.itemdefid}]  type=${generator.type}`);
console.log(`Wire bundle: ${generator.raw.bundle}`);
console.log(`Rolls: ${rolls}   seed: "${seed}"\n`);

console.log('Outcome                              weight   expected   observed    error');
console.log('─'.repeat(78));
for (const entry of generator.bundle) {
  const def = engine.schema.get(entry.itemdefid);
  const expected = entry.quantity / totalWeight;
  const observed = (outcomes.get(entry.itemdefid) || 0) / rolls;
  console.log(
    `${def.name.slice(0, 34).padEnd(36)} ${String(entry.quantity).padStart(6)}   ` +
      `${(expected * 100).toFixed(2).padStart(7)}%   ${(observed * 100).toFixed(2).padStart(7)}%   ` +
      `${((observed - expected) * 100).toFixed(3).padStart(7)}pp`
  );
}

console.log('\nItems granted (per 100 rolls)');
console.log('─'.repeat(78));
for (const [grantedId, quantity] of [...items].sort((a, b) => b[1] - a[1])) {
  const def = engine.schema.get(grantedId);
  console.log(`  ${def.name.padEnd(36)} ${((quantity / rolls) * 100).toFixed(2).padStart(8)}`);
}

// ─── Reproducibility ──────────────────────────────────────────────────────────

const repeat = run(seed);
const different = run(`${seed}-other`);
const fingerprint = r => JSON.stringify([...r.outcomes].sort());

console.log('\nReproducibility');
console.log('─'.repeat(78));
console.log(`  same seed  → identical distribution: ${fingerprint(repeat) === fingerprint({ outcomes }) ? 'yes' : 'NO'}`);
console.log(`  other seed → different distribution: ${fingerprint(different) !== fingerprint({ outcomes }) ? 'yes' : 'no'}`);
