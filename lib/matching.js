'use strict';

/**
 * matching.js
 *
 * Deciding whether a set of offered material stacks satisfies a recipe is an
 * assignment problem, not a greedy walk: one stack can satisfy several operands
 * (an item tagged `rarity:common` also satisfies `band:1`), and a greedy pass
 * can spend a stack on an operand that another stack could have covered, then
 * wrongly report the recipe unsatisfiable.
 *
 * So we solve it exactly, as max-flow on a tiny bipartite graph:
 *
 *   source → offer_i   (capacity = quantity offered)
 *   offer_i → operand_j (capacity = min(offer, demand), only if the stack matches)
 *   operand_j → sink   (capacity = required quantity)
 *
 * The recipe is satisfied iff max flow saturates total demand, and the flow on
 * the middle edges *is* the consumption plan.
 *
 * Graphs here are a handful of nodes (recipes top out at ~8 operands), so plain
 * Edmonds–Karp is more than fast enough.
 */

// ─── Max flow (Edmonds–Karp) ──────────────────────────────────────────────────

function maxFlow(capacity, source, sink) {
  const n = capacity.length;
  let total = 0;

  for (;;) {
    // BFS for a shortest augmenting path in the residual graph.
    const parent = new Array(n).fill(-1);
    parent[source] = source;
    const queue = [source];
    while (queue.length > 0 && parent[sink] === -1) {
      const u = queue.shift();
      for (let v = 0; v < n; v++) {
        if (parent[v] === -1 && capacity[u][v] > 0) {
          parent[v] = u;
          queue.push(v);
        }
      }
    }
    if (parent[sink] === -1) return total;

    let bottleneck = Infinity;
    for (let v = sink; v !== source; v = parent[v]) {
      bottleneck = Math.min(bottleneck, capacity[parent[v]][v]);
    }
    for (let v = sink; v !== source; v = parent[v]) {
      capacity[parent[v]][v] -= bottleneck;
      capacity[v][parent[v]] += bottleneck;
    }
    total += bottleneck;
  }
}

// ─── Material assignment ──────────────────────────────────────────────────────

/**
 * @param {Array<{available:number}>} offers   material stacks the caller passed
 * @param {Array<{quantity:number}>} operands  the recipe's required materials
 * @param {(offerIndex:number, operandIndex:number) => boolean} matches
 * @returns {null | { allocation: number[][], consumed: number[] }}
 *   null when the recipe cannot be satisfied by these offers.
 */
function assignMaterials(offers, operands, matches) {
  const O = offers.length;
  const P = operands.length;
  const n = O + P + 2;
  const source = 0;
  const sink = n - 1;

  const capacity = Array.from({ length: n }, () => new Array(n).fill(0));
  const initial = Array.from({ length: O }, () => new Array(P).fill(0));

  let demand = 0;
  for (let i = 0; i < O; i++) capacity[source][1 + i] = offers[i].available;
  for (let j = 0; j < P; j++) {
    capacity[1 + O + j][sink] = operands[j].quantity;
    demand += operands[j].quantity;
  }
  for (let i = 0; i < O; i++) {
    for (let j = 0; j < P; j++) {
      if (matches(i, j)) {
        const cap = Math.min(offers[i].available, operands[j].quantity);
        capacity[1 + i][1 + O + j] = cap;
        initial[i][j] = cap;
      }
    }
  }

  const flow = maxFlow(capacity, source, sink);
  if (flow < demand) return null;

  const allocation = Array.from({ length: O }, () => new Array(P).fill(0));
  const consumed = new Array(O).fill(0);
  for (let i = 0; i < O; i++) {
    for (let j = 0; j < P; j++) {
      if (initial[i][j] === 0) continue;
      const used = initial[i][j] - capacity[1 + i][1 + O + j];
      if (used > 0) {
        allocation[i][j] = used;
        consumed[i] += used;
      }
    }
  }
  return { allocation, consumed };
}

module.exports = { assignMaterials, maxFlow };
