'use strict';

/** Tiny assertion harness shared by the engine tests. */

const { BOARD_SIZE } = require('../server/constants');

let passed = 0;
let failed = 0;
const failures = [];

function assert(cond, msg) {
  if (cond) {
    passed += 1;
  } else {
    failed += 1;
    failures.push(msg);
    console.error(`  ❌ ${msg}`);
  }
}

function assertEq(actual, expected, msg) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  assert(a === e, `${msg} (esperado ${e}, obtido ${a})`);
}

function section(title) {
  console.log(`\n── ${title}`);
}

function summary() {
  console.log(`\n${'═'.repeat(50)}`);
  console.log(`Resultado: ${passed} PASS / ${failed} FAIL`);
  if (failed) {
    console.log('\nFalhas:');
    for (const f of failures) console.log(`  • ${f}`);
  }
  console.log(`VEREDITO: ${failed === 0 ? 'PASS ✅' : 'FAIL ❌'}`);
  return failed === 0;
}

/** Default deterministic fleet layout (all horizontal, even rows). */
const DEFAULT_LAYOUT = [
  { id: 'carrier', r: 0, c: 0, orientation: 'h' }, // (0,0)-(0,4)
  { id: 'battleship', r: 2, c: 0, orientation: 'h' }, // (2,0)-(2,3)
  { id: 'cruiser', r: 4, c: 0, orientation: 'h' }, // (4,0)-(4,2)
  { id: 'submarine', r: 6, c: 0, orientation: 'h' }, // (6,0)-(6,2)
  { id: 'destroyer', r: 8, c: 0, orientation: 'h' }, // (8,0)-(8,1)
];

/**
 * Alternate layout (all vertical, distinct columns) — used so an opponent's fleet
 * coordinates never coincide with the requester's own fleet during anti-cheat
 * payload scans (otherwise identical layouts cause false-positive substring hits).
 */
const ALT_LAYOUT = [
  { id: 'carrier', r: 0, c: 9, orientation: 'v' }, // (0,9)-(4,9)
  { id: 'battleship', r: 0, c: 7, orientation: 'v' }, // (0,7)-(3,7)
  { id: 'cruiser', r: 0, c: 5, orientation: 'v' }, // (0,5)-(2,5)
  { id: 'submarine', r: 5, c: 3, orientation: 'v' }, // (5,3)-(7,3)
  { id: 'destroyer', r: 5, c: 1, orientation: 'v' }, // (5,1)-(6,1)
];

/** Index helper mirroring the engine. */
const idx = (r, c) => r * BOARD_SIZE + c;

/**
 * Reference energy tracker — an INDEPENDENT re-derivation of the energy economy,
 * used to cross-check the engine after every action. If both agree across an
 * entire match (including sinks), the +1/turn and +2/sink rules are verified.
 */
function makeEnergyTracker(ENERGY) {
  const e = { 1: 0, 2: 0 };
  return {
    energy: e,
    battleStart(firstSlot) {
      e[1] = ENERGY.start;
      e[2] = ENERGY.start;
      e[firstSlot] += ENERGY.perTurn;
    },
    afterAction(slot, cost, sinks, gameOver) {
      e[slot] -= cost;
      e[slot] += sinks * ENERGY.perSink;
      if (!gameOver) e[slot === 1 ? 2 : 1] += ENERGY.perTurn;
    },
  };
}

/** All empty cells for a given layout (used to feed guaranteed-miss shots). */
function emptyCellsFor(layout) {
  const occupied = new Set();
  const SHIP_SIZE = { carrier: 5, battleship: 4, cruiser: 3, submarine: 3, destroyer: 2 };
  for (const s of layout) {
    for (let i = 0; i < SHIP_SIZE[s.id]; i++) {
      const r = s.orientation === 'v' ? s.r + i : s.r;
      const c = s.orientation === 'h' ? s.c + i : s.c;
      occupied.add(idx(r, c));
    }
  }
  const empty = [];
  for (let r = 0; r < BOARD_SIZE; r++) {
    for (let c = 0; c < BOARD_SIZE; c++) {
      if (!occupied.has(idx(r, c))) empty.push({ r, c });
    }
  }
  return empty;
}

module.exports = {
  assert,
  assertEq,
  section,
  summary,
  DEFAULT_LAYOUT,
  ALT_LAYOUT,
  idx,
  makeEnergyTracker,
  emptyCellsFor,
  get passed() { return passed; },
  get failed() { return failed; },
};
