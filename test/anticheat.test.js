'use strict';

/**
 * Focused anti-cheat assertions at the ENGINE/SERVER projection level.
 * Verifies that `publicStateFor(slot)` never carries the opponent's fleet, across
 * many randomized matches. Run: `npm run test:anticheat`.
 */

const { GameEngine } = require('../server/game-engine');
const { VIEW } = require('../server/constants');
const H = require('./helpers');
const { assert, assertEq, section, idx } = H;

function buildBattle() {
  const eng = new GameEngine();
  eng.startPlacement();
  eng.setFleet(1, eng.randomPlacements());
  eng.setFleet(2, eng.randomPlacements());
  eng.confirm(1);
  eng.confirm(2);
  return eng;
}

function trueShipCells(eng, slot) {
  const s = new Set();
  for (const ship of eng.players[slot].fleet) {
    for (const cell of ship.cells) s.add(idx(cell.r, cell.c));
  }
  return s;
}

function scanForLeak(eng, viewerSlot) {
  const enemySlot = viewerSlot === 1 ? 2 : 1;
  const state = eng.publicStateFor(viewerSlot);

  // No enemy fleet container of any name.
  assertEq(state.enemy.fleet, undefined, `[P${viewerSlot}] enemy.fleet ausente`);
  assertEq(state.enemy.ships, undefined, `[P${viewerSlot}] enemy.ships ausente`);
  assertEq(state.enemy.grid, undefined, `[P${viewerSlot}] enemy.grid ausente`);

  // Discovered (hit/sunk) cells must be a SUBSET of the true enemy ship cells.
  const ship = trueShipCells(eng, enemySlot);
  state.enemy.view.forEach((v, i) => {
    if (v === VIEW.HIT || v === VIEW.SUNK) {
      assert(ship.has(i), `[P${viewerSlot}] célula descoberta ${i} corresponde a um navio real`);
    }
  });

  // No undiscovered enemy ship cell may read as anything but 'unknown'.
  const discovered = new Set();
  state.enemy.view.forEach((v, i) => { if (v === VIEW.HIT || v === VIEW.SUNK) discovered.add(i); });
  let leaked = 0;
  for (const cell of ship) {
    if (!discovered.has(cell) && state.enemy.view[cell] !== VIEW.UNKNOWN) leaked += 1;
  }
  assertEq(leaked, 0, `[P${viewerSlot}] zero células de navio não-descobertas vazadas`);
}

function run() {
  console.log('Anti-trapaça — varredura do payload em partidas aleatórias');
  section('Estado autoritativo sanitizado');

  for (let m = 0; m < 50; m++) {
    const eng = buildBattle();
    // Random legal play for a while.
    for (let t = 0; t < 40 && eng.phase === 'battle'; t++) {
      const slot = eng.currentTurn;
      const me = eng.players[slot];
      // Pick a random unknown enemy cell.
      let r, c, tries = 0;
      do { r = Math.floor(Math.random() * 10); c = Math.floor(Math.random() * 10); tries++; }
      while (me.view[idx(r, c)] !== VIEW.UNKNOWN && tries < 100);
      eng.performAction(slot, { type: 'shoot', cell: { r, c } });
      // After every action, neither client payload may leak.
      scanForLeak(eng, 1);
      scanForLeak(eng, 2);
    }
  }

  const ok = H.summary();
  process.exit(ok ? 0 : 1);
}

run();
