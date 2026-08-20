'use strict';

/**
 * unit/matching.test.js — the material assignment solver.
 *
 * The cases that matter are the ones a greedy matcher gets wrong, because those
 * are the recipes that would work against real Steam and mysteriously fail here.
 */

const test = require('node:test');
const assert = require('node:assert');

const { assignMaterials } = require('../../lib/matching');

/** offers/operands as plain data, with an explicit match matrix. */
function solve(offers, operands, matrix) {
  return assignMaterials(offers, operands, (i, j) => matrix[i][j]);
}

test('matching: an exact fit is satisfied', () => {
  const plan = solve([{ available: 2 }], [{ quantity: 2 }], [[true]]);
  assert.ok(plan);
  assert.deepEqual(plan.consumed, [2]);
});

test('matching: too few materials is unsatisfiable', () => {
  assert.equal(solve([{ available: 1 }], [{ quantity: 2 }], [[true]]), null);
});

test('matching: surplus is left unallocated', () => {
  const plan = solve([{ available: 5 }], [{ quantity: 2 }], [[true]]);
  assert.deepEqual(plan.consumed, [2]);
});

test('matching: a specific stack is not wasted on a general operand', () => {
  // offer 0 matches both operands; offer 1 only the first.
  // Greedy would spend offer 0 on operand 0 and then fail operand 1.
  const plan = solve(
    [{ available: 1 }, { available: 1 }],
    [{ quantity: 1 }, { quantity: 1 }],
    [
      [true, true],
      [true, false],
    ]
  );
  assert.ok(plan, 'the assignment exists and must be found');
  assert.deepEqual(plan.allocation[0], [0, 1]);
  assert.deepEqual(plan.allocation[1], [1, 0]);
});

test('matching: one stack can be split across several operands', () => {
  const plan = solve([{ available: 5 }], [{ quantity: 2 }, { quantity: 3 }], [[true, true]]);
  assert.ok(plan);
  assert.deepEqual(plan.consumed, [5]);
});

test('matching: demand spread over several stacks is satisfied', () => {
  const plan = solve([{ available: 2 }, { available: 3 }], [{ quantity: 5 }], [[true], [true]]);
  assert.ok(plan);
  assert.deepEqual(plan.consumed, [2, 3]);
});

test('matching: an unmatched operand fails the whole recipe', () => {
  assert.equal(
    solve(
      [{ available: 9 }],
      [{ quantity: 1 }, { quantity: 1 }],
      [[true, false]]
    ),
    null
  );
});
