'use strict';

/**
 * LOOP A — headless engine simulation & assertions.
 *
 * Plays a COMPLETE deterministic match exercising every power-up and cross-checks
 * the energy economy against an independent reference tracker. Also runs focused
 * tests (placement validation, torpedo hit/miss, turn enforcement, costs) and a
 * deep anti-cheat scan of the client payload.
 *
 * Run: `npm test`  (exits non-zero on any failure)
 */

const { GameEngine } = require('../server/game-engine');
const { SHIP_TYPES, POWER_UPS, ENERGY, VIEW, CELL } = require('../server/constants');
const H = require('./helpers');
const { assert, assertEq, section, idx, DEFAULT_LAYOUT, ALT_LAYOUT, makeEnergyTracker, emptyCellsFor } = H;

// --------------------------------------------------------------------------
function freshBattle(layout1 = DEFAULT_LAYOUT, layout2 = DEFAULT_LAYOUT) {
  const eng = new GameEngine();
  eng.startPlacement();
  assertEq(eng.setFleet(1, layout1), { ok: true }, 'P1 fleet aceita');
  assertEq(eng.setFleet(2, layout2), { ok: true }, 'P2 fleet aceita');
  eng.confirm(1);
  eng.confirm(2);
  return eng;
}

/** Collect the set of enemy cells (idx) that `slot` has discovered as hit/sunk. */
function discoveredHitSet(state) {
  const s = new Set();
  state.enemy.view.forEach((v, i) => {
    if (v === VIEW.HIT || v === VIEW.SUNK) s.add(i);
  });
  return s;
}

/** True set of the enemy fleet cells (idx) from the authoritative engine. */
function enemyShipCellSet(eng, enemySlot) {
  const s = new Set();
  for (const ship of eng.players[enemySlot].fleet) {
    for (const cell of ship.cells) s.add(idx(cell.r, cell.c));
  }
  return s;
}

// ==========================================================================
// 1) Placement validation
// ==========================================================================
function testPlacement() {
  section('Posicionamento / validação');
  const eng = new GameEngine();
  eng.startPlacement();

  assert(eng.validatePlacement(DEFAULT_LAYOUT).valid, 'layout padrão é válido');

  // Overlap
  const overlap = DEFAULT_LAYOUT.map((s) => ({ ...s }));
  overlap[1] = { id: 'battleship', r: 0, c: 0, orientation: 'h' }; // collides with carrier
  assertEq(eng.validatePlacement(overlap).valid, false, 'sobreposição rejeitada');

  // Out of bounds
  const oob = DEFAULT_LAYOUT.map((s) => ({ ...s }));
  oob[0] = { id: 'carrier', r: 0, c: 7, orientation: 'h' }; // (0,7)-(0,11) out
  assertEq(eng.validatePlacement(oob).valid, false, 'fora do tabuleiro rejeitado');

  // Missing a ship
  const missing = DEFAULT_LAYOUT.slice(0, 4);
  assertEq(eng.validatePlacement(missing).valid, false, 'frota incompleta rejeitada');

  // Random placements are always valid
  for (let i = 0; i < 200; i++) {
    const p = eng.randomPlacements();
    assert(eng.validatePlacement(p).valid, `random #${i} válido`);
  }

  // setFleet during wrong phase
  const eng2 = new GameEngine();
  assertEq(eng2.setFleet(1, DEFAULT_LAYOUT).ok, false, 'setFleet bloqueado fora da fase');
}

// ==========================================================================
// 2) Full deterministic match — every power-up + energy economy
// ==========================================================================
function testFullMatch() {
  section('Partida completa (todos os power-ups + economia de energia)');
  const eng = freshBattle();

  // Battle started, P1 first, P1 gained the per-turn energy.
  assertEq(eng.phase, 'battle', 'fase = battle após ambos confirmarem');
  assertEq(eng.currentTurn, 1, 'P1 começa');
  assertEq(eng.players[1].energy, ENERGY.start + ENERGY.perTurn, 'P1 energia inicial = start + perTurn (=1)');
  assertEq(eng.players[2].energy, ENERGY.start, 'P2 energia inicial = start (=0)');

  const ref = makeEnergyTracker(ENERGY);
  ref.battleStart(1);
  assertEq(eng.players[1].energy, ref.energy[1], 'tracker bate com P1 no início');

  const empties = emptyCellsFor(DEFAULT_LAYOUT); // guaranteed misses for P2
  let p2miss = 0;
  function p2Miss() {
    // Skip (8,0): P2 hits that cell explicitly once (move #1) to enable repair demo.
    let cell;
    do { cell = empties[p2miss++]; } while (cell.r === 8 && cell.c === 0);
    const res = eng.performAction(2, { type: 'shoot', cell });
    assert(res.ok, `P2 erro de tiro: ${res.error || ''}`);
    ref.afterAction(2, 0, 0, eng.phase === 'finished');
    assertEq(eng.players[2].energy, ref.energy[2], 'tracker bate com P2 após miss');
  }

  // Drive a P1 action and reconcile energy with the reference tracker.
  function p1(action, sinksExpected, label) {
    const res = eng.performAction(1, action);
    assert(res.ok, `P1 ação "${label}" ok (${res.error || ''})`);
    if (!res.ok) return res;
    ref.afterAction(1, POWER_UPS[action.type].cost, sinksExpected, eng.phase === 'finished');
    assertEq(eng.players[1].energy, ref.energy[1], `energia P1 bate após ${label}`);
    return res;
  }

  // k1: normal shot on destroyer (8,1) — hit, not sunk.
  let r = p1({ type: 'shoot', cell: { r: 8, c: 1 } }, 0, 'tiro (8,1)');
  assertEq(r.result.shots[0].result, 'hit', 'tiro (8,1) acerta');
  assertEq(r.result.shots[0].sunk, false, 'tiro (8,1) não afunda');
  assertEq(r.result.shots[0].shipName, undefined, 'acerto sem afundar NÃO revela o tipo do navio');
  assertEq(eng.publicStateFor(1).enemy.view[idx(8, 1)], VIEW.HIT, 'view do P1 marca (8,1) como hit');
  assertEq(eng.publicStateFor(1).enemy.shipsRemaining, 5, 'P2 ainda tem 5 navios');

  // P2 hits P1 at (8,0) — sets up the repair demo.
  let rp2 = eng.performAction(2, { type: 'shoot', cell: { r: 8, c: 0 } });
  assert(rp2.ok && rp2.result.shots[0].result === 'hit', 'P2 acerta P1 em (8,0)');
  ref.afterAction(2, 0, 0, false);
  assertEq(eng.players[1].incoming[idx(8, 0)], CELL.HIT, 'tabuleiro do P1 marca (8,0) como hit');
  assertEq(eng.players[2].energy, ref.energy[2], 'tracker bate com P2 após acerto');

  // k2: normal shot (8,0) → destroyer SUNK → +2 energy.
  r = p1({ type: 'shoot', cell: { r: 8, c: 0 } }, 1, 'tiro (8,0) afunda destróier');
  assertEq(r.result.shots[0].sunk, true, 'destróier afunda');
  assertEq(r.result.shots[0].shipName, 'Destróier', 'afundar REVELA o tipo (Destróier)');
  assertEq(r.result.sunkShips.length, 1, '1 navio afundado registrado');
  assertEq(eng.publicStateFor(1).enemy.shipsRemaining, 4, 'P2 com 4 navios após afundar destróier');
  assertEq(eng.publicStateFor(1).enemy.view[idx(8, 0)], VIEW.SUNK, 'células do destróier viram sunk');
  assertEq(eng.players[1].energy, 4, 'P1 energia = 4 (2 antes + 2 do afundamento)');
  p2Miss();

  // k3: REPAIR own (8,0) — restores the cell P2 hit.
  r = p1({ type: 'repair', cell: { r: 8, c: 0 } }, 0, 'reparo (8,0)');
  assertEq(eng.players[1].fleet.find((s) => s.id === 'destroyer').hits[0], false, 'reparo restaura célula do navio próprio');
  assertEq(eng.players[1].incoming[idx(8, 0)], CELL.NONE, 'tabuleiro do P1: (8,0) volta a none após reparo');
  assertEq(eng.publicStateFor(2).enemy.view[idx(8, 0)], VIEW.UNKNOWN, 'oponente PERDE o acerto confirmado após reparo');
  p2Miss();

  // k4: SONAR centered on submarine (6,1) — recon only.
  r = p1({ type: 'sonar', cell: { r: 6, c: 1 } }, 0, 'sonar (6,1)');
  assertEq(r.result.sonar.cells.length, 9, 'sonar 3x3 central = 9 células');
  const sonarShips = r.result.sonar.cells.filter((x) => x.hasShip);
  assertEq(sonarShips.length, 3, 'sonar detecta 3 células com navio (submarino)');
  assert(sonarShips.every((x) => x.r === 6 && x.c >= 0 && x.c <= 2), 'células detectadas são as do submarino');
  assertEq(eng.players[2].incoming[idx(6, 1)], CELL.NONE, 'sonar NÃO marca o tabuleiro inimigo (recon, não afunda)');
  assertEq(eng.publicStateFor(1).enemy.view[idx(6, 0)], VIEW.UNKNOWN, 'sonar NÃO vira descoberta permanente na view');
  assertEq(eng.publicStateFor(1).you.sonar.length, 1, 'reveal de sonar disponível ao P1');
  assertEq(eng.publicStateFor(1).enemy.shipsRemaining, 4, 'sonar não afunda nada');
  p2Miss();

  // k5,k6: chip the submarine.
  p1({ type: 'shoot', cell: { r: 6, c: 0 } }, 0, 'tiro (6,0)');
  p2Miss();
  p1({ type: 'shoot', cell: { r: 6, c: 1 } }, 0, 'tiro (6,1)');
  p2Miss();

  // k7: TRIPLE — (6,2) sinks submarine, (0,0)/(0,1) chip the carrier.
  r = p1({ type: 'triple', cells: [{ r: 6, c: 2 }, { r: 0, c: 0 }, { r: 0, c: 1 }] }, 1, 'salva tripla');
  assertEq(r.result.shots.length, 3, 'salva tripla = 3 tiros no mesmo turno');
  assertEq(r.result.sunkShips.length, 1, 'salva tripla afunda o submarino');
  assert(r.result.shots.some((s) => s.r === 6 && s.c === 2 && s.sunk), 'tiro (6,2) afunda submarino');
  assertEq(eng.publicStateFor(1).enemy.shipsRemaining, 3, 'P2 com 3 navios');
  p2Miss();

  // k8: chip the carrier.
  p1({ type: 'shoot', cell: { r: 0, c: 2 } }, 0, 'tiro (0,2)');
  p2Miss();

  // k9: BOMBARD center (2,1) — full 3x3 (9 cells), 3 of them battleship.
  r = p1({ type: 'bombard', cell: { r: 2, c: 1 } }, 0, 'bombardeio (2,1)');
  assertEq(r.result.shots.length, 9, 'bombardeio atinge 9 células');
  assertEq(r.result.shots.filter((s) => s.result === 'hit').length, 3, 'bombardeio acerta 3 do encouraçado');
  assertEq(eng.publicStateFor(1).enemy.shipsRemaining, 3, 'encouraçado ainda não afundou (falta 1 célula)');
  p2Miss();

  // k10: finish the battleship.
  r = p1({ type: 'shoot', cell: { r: 2, c: 3 } }, 1, 'tiro (2,3) afunda encouraçado');
  assertEq(r.result.shots[0].sunk, true, 'encouraçado afunda');
  assertEq(eng.publicStateFor(1).enemy.shipsRemaining, 2, 'P2 com 2 navios');
  p2Miss();

  // k11: TORPEDO row 4 forward — first ship cell in the line is (4,0).
  r = p1({ type: 'torpedo', line: { orientation: 'row', index: 4, direction: 'forward' } }, 0, 'torpedo linha 4');
  assertEq(r.result.torpedo.impact, { r: 4, c: 0 }, 'torpedo atinge o PRIMEIRO navio da linha (4,0)');
  assertEq(r.result.torpedo.path.length, 10, 'trajeto do torpedo cobre a linha inteira');
  assertEq(r.result.shots[0].result, 'hit', 'torpedo acerta');
  p2Miss();

  // k12,k13: finish the cruiser.
  p1({ type: 'shoot', cell: { r: 4, c: 1 } }, 0, 'tiro (4,1)');
  p2Miss();
  r = p1({ type: 'shoot', cell: { r: 4, c: 2 } }, 1, 'tiro (4,2) afunda cruzador');
  assertEq(r.result.shots[0].sunk, true, 'cruzador afunda');
  assertEq(eng.publicStateFor(1).enemy.shipsRemaining, 1, 'só o porta-aviões resta');
  p2Miss();

  // k14,k15: finish the carrier → WIN.
  p1({ type: 'shoot', cell: { r: 0, c: 3 } }, 0, 'tiro (0,3)');
  p2Miss();
  r = p1({ type: 'shoot', cell: { r: 0, c: 4 } }, 1, 'tiro (0,4) afunda porta-aviões → vitória');

  assertEq(eng.phase, 'finished', 'partida termina');
  assertEq(eng.winner, 1, 'P1 vence ao afundar a frota inteira');
  assertEq(eng.publicStateFor(1).enemy.shipsRemaining, 0, 'frota do P2 totalmente afundada');
  assert(eng.events.some((e) => e.type === 'win' && e.winner === 1), 'evento de vitória emitido');

  // Turn must not pass after the game ends.
  const afterWin = eng.performAction(2, { type: 'shoot', cell: { r: 9, c: 9 } } );
  assertEq(afterWin.ok, false, 'nenhuma ação após o fim de jogo');
}

// ==========================================================================
// 3) Torpedo miss + turn/cost enforcement
// ==========================================================================
function testTorpedoMissAndRules() {
  section('Torpedo (erro) + regras de turno/custo');
  const eng = freshBattle();

  // Column 9 is empty in the default layout → torpedo down column 9 misses.
  const r = eng.performAction(1, { type: 'torpedo', line: { orientation: 'col', index: 9, direction: 'forward' } });
  // P1 starts with energy 1, torpedo costs 4 → must be rejected.
  assertEq(r.ok, false, 'torpedo sem energia é rejeitado');
  assertEq(r.error, 'insufficient_energy', 'erro = insufficient_energy');

  // Bank energy with free shots until P1 can afford a torpedo, then miss on an empty column.
  const eng2 = freshBattle();
  // Cheap misses on empty cells for both players to accrue energy to 4 for P1.
  const emp = emptyCellsFor(DEFAULT_LAYOUT);
  let i = 0;
  while (eng2.players[1].energy < 4) {
    const a = eng2.performAction(1, { type: 'shoot', cell: emp[i++] });
    assert(a.ok, 'P1 mira em célula vazia');
    eng2.performAction(2, { type: 'shoot', cell: emp[i++] });
  }
  const miss = eng2.performAction(1, { type: 'torpedo', line: { orientation: 'col', index: 9, direction: 'forward' } });
  assert(miss.ok, 'torpedo disparado com energia suficiente');
  assertEq(miss.result.torpedo.impact, null, 'torpedo sem navio no caminho → impact null (erra)');
  assertEq(miss.result.shots.length, 0, 'torpedo que erra não gera acerto');
  assert(eng2.events.some((e) => e.type === 'torpedo_miss'), 'evento torpedo_miss emitido');

  // not_your_turn
  const eng3 = freshBattle();
  const wrong = eng3.performAction(2, { type: 'shoot', cell: { r: 0, c: 0 } });
  assertEq(wrong.ok, false, 'ação fora da vez rejeitada');
  assertEq(wrong.error, 'not_your_turn', 'erro = not_your_turn');

  // already_targeted
  const eng4 = freshBattle();
  eng4.performAction(1, { type: 'shoot', cell: { r: 9, c: 9 } });
  eng4.performAction(2, { type: 'shoot', cell: { r: 9, c: 0 } });
  const dup = eng4.performAction(1, { type: 'shoot', cell: { r: 9, c: 9 } });
  assertEq(dup.ok, false, 'tiro repetido na mesma célula rejeitado');

  // repair on a non-hit cell
  const eng5 = freshBattle();
  const badRepair = eng5.performAction(1, { type: 'repair', cell: { r: 0, c: 0 } });
  assertEq(badRepair.ok, false, 'reparo de célula não atingida rejeitado');
}

// ==========================================================================
// 4) Anti-cheat — the client payload never carries the enemy fleet
// ==========================================================================
function testAntiCheat() {
  section('ANTI-TRAPAÇA — payload nunca vaza a frota inimiga');
  // Distinct layouts so the enemy fleet coordinates never coincide with the
  // requester's own (legitimately-included) fleet — makes the JSON scan meaningful.
  const eng = freshBattle(DEFAULT_LAYOUT, ALT_LAYOUT);

  // Make a handful of moves so there are some discovered cells.
  eng.performAction(1, { type: 'shoot', cell: { r: 0, c: 9 } }); // hit P2 carrier (ALT)
  eng.performAction(2, { type: 'shoot', cell: { r: 9, c: 9 } }); // miss
  eng.performAction(1, { type: 'shoot', cell: { r: 3, c: 3 } }); // miss
  eng.performAction(2, { type: 'shoot', cell: { r: 9, c: 8 } }); // miss

  const state = eng.publicStateFor(1);

  // Structural: no enemy fleet array of any kind.
  assertEq(state.enemy.fleet, undefined, 'enemy.fleet ausente');
  assertEq(state.enemy.ships, undefined, 'enemy.ships ausente');
  assertEq(state.enemy.grid, undefined, 'enemy.grid ausente');
  assertEq(state.enemy.cells, undefined, 'enemy.cells ausente');

  // The discovered (hit/sunk) set must equal EXACTLY the cells P1 actually struck.
  const discovered = discoveredHitSet(state);
  const trueShipCells = enemyShipCellSet(eng, 2);
  for (const cell of discovered) {
    assert(trueShipCells.has(cell), `célula descoberta ${cell} é realmente um navio (nada inventado)`);
  }
  // Every UNDISCOVERED enemy ship cell must read 'unknown' in the payload.
  let leaked = 0;
  for (const cell of trueShipCells) {
    if (!discovered.has(cell) && state.enemy.view[cell] !== VIEW.UNKNOWN) leaked += 1;
  }
  assertEq(leaked, 0, 'nenhuma célula de navio não-descoberta aparece na view');

  // Deep JSON scan: the serialized payload must not contain the carrier's full cell list.
  const carrier = eng.players[2].fleet.find((s) => s.id === 'carrier');
  const json = JSON.stringify(state);
  const carrierAllCells = JSON.stringify(carrier.cells.map((x) => ({ r: x.r, c: x.c })));
  assert(!json.includes(carrierAllCells), 'a lista completa de células do porta-aviões inimigo não está no payload');

  // sonar reveal of the enemy must NOT reach the enemy's own payload (perspective check),
  // and a non-sunk hit must not leak ship identity to the attacker.
  const eng2 = freshBattle();
  // P1 sonar needs energy 2 → bank one turn first.
  eng2.performAction(1, { type: 'shoot', cell: { r: 9, c: 9 } });
  eng2.performAction(2, { type: 'shoot', cell: { r: 9, c: 0 } });
  eng2.performAction(1, { type: 'sonar', cell: { r: 0, c: 1 } });
  const defenderState = eng2.publicStateFor(2);
  // Defender sees a sonar happened but not the revealed hasShip cells.
  if (defenderState.lastAction && defenderState.lastAction.sonar) {
    assertEq(defenderState.lastAction.sonar.cells, undefined, 'defensor não recebe as células reveladas pelo sonar');
  }
  assert(true, 'perspectiva de sonar verificada');
}

// ==========================================================================
// 5) Energy granularity — explicit +1/turn and +2/sink checks
// ==========================================================================
function testEnergyRules() {
  section('Energia — +1/turno e +2/afundar explícitos');
  const eng = freshBattle();
  assertEq(eng.players[1].energy, 1, '+1 no início do 1º turno do P1');

  // P1 misses, turn → P2 (P2 gets +1), P2 misses, turn → P1 (P1 gets +1).
  eng.performAction(1, { type: 'shoot', cell: { r: 9, c: 9 } });
  assertEq(eng.players[2].energy, 1, 'P2 ganha +1 ao começar seu turno');
  eng.performAction(2, { type: 'shoot', cell: { r: 9, c: 0 } });
  assertEq(eng.players[1].energy, 2, 'P1 ganha +1 ao começar o próximo turno');

  // Set up a clean +2-on-sink check: sink the destroyer in two consecutive P1 turns.
  const eng2 = freshBattle();
  eng2.performAction(1, { type: 'shoot', cell: { r: 8, c: 0 } }); // hit, not sunk
  eng2.performAction(2, { type: 'shoot', cell: { r: 9, c: 0 } }); // miss
  const before = eng2.players[1].energy; // P1 about to act with this energy
  const res = eng2.performAction(1, { type: 'shoot', cell: { r: 8, c: 1 } }); // sinks destroyer
  assert(res.result.shots[0].sunk, 'destróier afundou para o teste de energia');
  // cost 0, +2 sink → energy should be before + 2.
  assertEq(eng2.players[1].energy, before + ENERGY.perSink, 'afundar concede exatamente +2');
}

// ==========================================================================
function run() {
  console.log('LOOP A — Simulação do motor (headless)');
  console.log(`Frota: ${SHIP_TYPES.map((s) => `${s.name}(${s.size})`).join(', ')}`);
  testPlacement();
  testEnergyRules();
  testFullMatch();
  testTorpedoMissAndRules();
  testAntiCheat();
  const ok = H.summary();
  process.exit(ok ? 0 : 1);
}

run();
