'use strict';

/**
 * Networked end-to-end flow test using real Socket.IO clients against the real
 * server. Verifies slot assignment, spectator overflow, placement→battle,
 * turn enforcement, over-the-wire anti-cheat, reconnection within grace, and
 * rematch. Run: `npm run test:server`.
 *
 * This is also the reference pattern for scripting a second player headlessly.
 */

process.env.PORT = process.env.PORT || '5199';
const { io: ioClient } = require('socket.io-client');
const { server, io, match } = require('../server/index');
const { VIEW } = require('../server/constants');
const H = require('./helpers');
const { assert, assertEq, section } = H;

const URL = `http://localhost:${process.env.PORT}`;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function connect(clientId) {
  return new Promise((resolve) => {
    const sock = ioClient(URL, { auth: { clientId }, transports: ['websocket'], forceNew: true });
    const c = { sock, clientId, assigned: null, state: null, states: [] };
    sock.on('assigned', (a) => { c.assigned = a; });
    sock.on('state', (s) => { c.state = s; c.states.push(s); });
    sock.on('connect', () => resolve(c));
  });
}
function emit(c, ev, payload) {
  return new Promise((resolve) => c.sock.emit(ev, payload, resolve));
}

async function run() {
  console.log('Fluxo de rede (Socket.IO ponta a ponta)');

  // --- assignment ---------------------------------------------------------
  section('Atribuição de jogadores e espectador');
  const p1 = await connect('alice');
  const p2 = await connect('bob');
  await wait(150);
  assertEq(p1.assigned.role, 'player', 'cliente 1 é jogador');
  assertEq(p1.assigned.slot, 1, 'cliente 1 = slot 1');
  assertEq(p2.assigned.slot, 2, 'cliente 2 = slot 2');
  assert(p1.assigned.config && p1.assigned.config.boardSize === 10, 'config enviado no assigned');
  assertEq(p1.state.phase, 'placement', 'dois presentes → fase de posicionamento');

  const spec = await connect('carol');
  await wait(150);
  assertEq(spec.assigned.role, 'spectator', 'terceiro cliente vira espectador');
  assertEq(spec.assigned.slot, null, 'espectador não tem slot');

  // --- placement → battle -------------------------------------------------
  section('Posicionamento → batalha');
  const r1 = await emit(p1, 'placement:random', {});
  const r2 = await emit(p2, 'placement:random', {});
  assert(r1.ok && r1.placements.length === 5, 'P1 posicionamento aleatório com 5 navios');
  assert(r2.ok, 'P2 posicionamento aleatório');
  await emit(p1, 'placement:confirm', {});
  const conf2 = await emit(p2, 'placement:confirm', {});
  assert(conf2.ok, 'P2 confirma');
  await wait(150);
  assertEq(p1.state.phase, 'battle', 'batalha começa quando ambos confirmam');
  assertEq(p1.state.yourTurn, true, 'P1 começa');
  assertEq(p2.state.yourTurn, false, 'P2 aguarda');
  assertEq(p1.state.you.energy, 1, 'P1 começa com 1 de energia');

  // --- turn enforcement + anti-cheat over the wire ------------------------
  section('Turnos e anti-trapaça pela rede');
  const wrongTurn = await emit(p2, 'action', { type: 'shoot', cell: { r: 0, c: 0 } });
  assertEq(wrongTurn.ok, false, 'P2 não pode agir fora da vez');
  assertEq(wrongTurn.error, 'not_your_turn', 'erro = not_your_turn');

  // Inspect the state P1 received: it must NOT contain the enemy fleet.
  assertEq(p1.state.enemy.fleet, undefined, 'estado recebido por P1 não traz enemy.fleet');
  assert(Array.isArray(p1.state.enemy.view) && p1.state.enemy.view.length === 100, 'P1 recebe apenas a view (10x10)');
  const anyKnown = p1.state.enemy.view.some((v) => v !== VIEW.UNKNOWN);
  assertEq(anyKnown, false, 'no início P1 não conhece nenhuma célula inimiga');
  assert(p1.state.you.fleet.length === 5, 'P1 recebe a PRÓPRIA frota completa');

  const shot = await emit(p1, 'action', { type: 'shoot', cell: { r: 0, c: 0 } });
  assert(shot.ok, 'P1 dispara');
  await wait(150);
  assertEq(p1.state.yourTurn, false, 'vez passa para P2 após o tiro');
  assertEq(p2.state.yourTurn, true, 'agora é a vez de P2');
  assertEq(p2.state.you.energy, 1, 'P2 ganha +1 ao iniciar o turno');

  // --- reconnection within grace -----------------------------------------
  section('Reconexão dentro da carência');
  const energyBefore = p1.state.you.energy;
  p1.sock.disconnect();
  await wait(200);
  assertEq(match.isConnected(1), false, 'servidor marca P1 desconectado');
  assert(match.slots[1] === 'alice', 'slot de P1 fica reservado durante a carência');
  const p1b = await connect('alice'); // same clientId
  await wait(200);
  assertEq(p1b.assigned.slot, 1, 'P1 reconecta no mesmo slot');
  assertEq(match.isConnected(1), true, 'servidor remarca P1 conectado');
  assertEq(p1b.state.phase, 'battle', 'partida retomada de onde parou');
  assertEq(p1b.state.you.energy, energyBefore, 'energia preservada após reconexão');

  // --- finish a game + rematch -------------------------------------------
  section('Vitória + revanche');
  // Drive a quick deterministic finish: P1 already knows nothing, so just let the
  // engine end via the authoritative match object directly (server-side) to test
  // the rematch wire path without scripting 17 shots here.
  match.engine.players[2].fleet.forEach((s) => { s.hits = s.hits.map(() => true); s.sunk = true; });
  match.engine.phase = 'finished';
  match.engine.winner = match.engine.currentTurn;
  match.broadcast();
  await wait(120);
  assert(p1b.state.winner != null, 'estado de vitória propagado');

  const rmA = await emit(p1b, 'rematch', {});
  assert(rmA.ok, 'P1 vota revanche');
  await wait(100);
  assert(p1b.state.rematch.you === true, 'voto de revanche de P1 refletido');
  assert(p1b.state.phase === 'finished', 'ainda aguardando o oponente para revanche');
  const rmB = await emit(p2, 'rematch', {});
  assert(rmB.ok, 'P2 vota revanche');
  await wait(120);
  assertEq(p1b.state.phase, 'placement', 'revanche reinicia para o posicionamento');
  assertEq(p2.state.phase, 'placement', 'ambos voltam ao posicionamento');

  // --- teardown -----------------------------------------------------------
  p1b.sock.close();
  p2.sock.close();
  spec.sock.close();
  io.close();
  server.close();
  const ok = H.summary();
  // Give sockets a tick to close before exiting.
  setTimeout(() => process.exit(ok ? 0 : 1), 100);
}

run().catch((e) => { console.error(e); process.exit(1); });
