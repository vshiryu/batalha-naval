'use strict';

/**
 * Shared, authoritative game constants.
 * These are the single source of truth and are also forwarded to the client
 * (via a `config` payload) so costs/fleet never drift between server and UI.
 */

const BOARD_SIZE = 10;

/** Fleet composition (size in cells). Names are pt-BR (player-facing content). */
const SHIP_TYPES = [
  { id: 'carrier', name: 'Porta-aviões', size: 5 },
  { id: 'battleship', name: 'Encouraçado', size: 4 },
  { id: 'cruiser', name: 'Cruzador', size: 3 },
  { id: 'submarine', name: 'Submarino', size: 3 },
  { id: 'destroyer', name: 'Destróier', size: 2 },
];

/** Power-up catalogue with exact energy costs. */
const POWER_UPS = {
  shoot: { id: 'shoot', name: 'Tiro Normal', cost: 0, desc: 'Atira em 1 célula.' },
  sonar: { id: 'sonar', name: 'Sonar', cost: 2, desc: 'Revela navios numa área 3x3.' },
  triple: { id: 'triple', name: 'Salva Tripla', cost: 3, desc: '3 tiros num único turno.' },
  torpedo: { id: 'torpedo', name: 'Torpedo de Linha', cost: 4, desc: 'Atinge o 1º navio da linha.' },
  bombard: { id: 'bombard', name: 'Bombardeio 3x3', cost: 4, desc: 'Atinge uma área 3x3 inteira.' },
  repair: { id: 'repair', name: 'Reparo', cost: 4, desc: 'Restaura 1 célula de um navio seu.' },
};

/** Energy economy. */
const ENERGY = {
  start: 0,
  perTurn: 1, // gained at the start of each of your turns
  perSink: 2, // gained when you sink an enemy ship
};

/** Reconnection grace window (ms) before a dropped player forfeits the match. */
const RECONNECT_GRACE_MS = 60000;

/** Cell state on a player's OWN board (what the enemy did to them). */
const CELL = {
  NONE: 'none',
  MISS: 'miss',
  HIT: 'hit',
};

/** Cell state in a player's VIEW of the enemy board (what they've discovered). */
const VIEW = {
  UNKNOWN: 'unknown',
  MISS: 'miss',
  HIT: 'hit',
  SUNK: 'sunk',
};

module.exports = {
  BOARD_SIZE,
  SHIP_TYPES,
  POWER_UPS,
  ENERGY,
  RECONNECT_GRACE_MS,
  CELL,
  VIEW,
};
