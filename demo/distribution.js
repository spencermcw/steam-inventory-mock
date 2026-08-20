'use strict';

/**
 * demo/distribution.js
 *
 * Roll a real generator from dist/itemdefs.json many times under a fixed seed
 * and print the observed yield distribution against the declared weights.
 *
 *   node mock/demo/distribution.js [cls] [rolls] [seed]
 *   node mock/demo/distribution.js exec_op_harvest_102 20000 alpha
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

// ─── Arguments ────────────────────────────────────────────────────────────────

const cls = process.argv[2] || 'exec_operation_101';
const rolls = Number(process.argv[3] || 20000);
const seed = process.argv[4] || 'distribution';

// ─── Roll ─────────────────────────────────────────────────────────────────────

function run(engineSeed) {
  const engine = new Engine({ seed: engineSeed });
  const generator = engine.schema.requireCls(cls);
  if (generator.bundle.length === 0) {
    throw new Error(`itemdef "${cls}" (${generator.type}) has no weighted bundle`);
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

console.log(`Generator: ${generator.name}  [${generator.cls}]  type=${generator.type}`);
console.log(`Wire bundle: ${generator.raw.bundle}`);
console.log(`Rolls: ${rolls}   seed: "${seed}"\n`);

console.log('Outcome                              weight   expected   observed    error');
console.log('─'.repeat(78));
for (const entry of generator.bundle) {
  const def = engine.schema.get(entry.itemdefid);
  const expected = entry.quantity / totalWeight;
  const observed = (outcomes.get(entry.itemdefid) || 0) / rolls;
  console.log(
    `${(def.cls || def.name).slice(0, 34).padEnd(36)} ${String(entry.quantity).padStart(6)}   ` +
      `${(expected * 100).toFixed(2).padStart(7)}%   ${(observed * 100).toFixed(2).padStart(7)}%   ` +
      `${((observed - expected) * 100).toFixed(3).padStart(7)}pp`
  );
}

console.log('\nItems granted (per 100 rolls)');
console.log('─'.repeat(78));
for (const [itemdefid, quantity] of [...items].sort((a, b) => b[1] - a[1])) {
  const def = engine.schema.get(itemdefid);
  console.log(`  ${(def.cls || def.name).padEnd(36)} ${((quantity / rolls) * 100).toFixed(2).padStart(8)}`);
}

// ─── Reproducibility ──────────────────────────────────────────────────────────

const repeat = run(seed);
const different = run(`${seed}-other`);
const fingerprint = r => JSON.stringify([...r.outcomes].sort());

console.log('\nReproducibility');
console.log('─'.repeat(78));
console.log(`  same seed  → identical distribution: ${fingerprint(repeat) === fingerprint({ outcomes }) ? 'yes' : 'NO'}`);
console.log(`  other seed → different distribution: ${fingerprint(different) !== fingerprint({ outcomes }) ? 'yes' : 'no'}`);
