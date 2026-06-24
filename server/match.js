'use strict';

/**
 * Match — wraps a GameEngine with player sessions, slot assignment, reconnection
 * grace and rematch handling. A single match exists at a time (one board per host).
 *
 * Sessions are keyed by a persistent `clientId` (stored client-side) so a dropped
 * player reattaches to the same slot within the grace window.
 */

const { GameEngine } = require('./game-engine');
const {
  SHIP_TYPES,
  POWER_UPS,
  ENERGY,
  BOARD_SIZE,
  RECONNECT_GRACE_MS,
} = require('./constants');

const SLOT_NAME = { 1: 'Jogador 1', 2: 'Jogador 2' };

class Match {
  constructor(onBroadcast) {
    this.engine = new GameEngine();
    this.sessions = new Map(); // clientId -> session
    this.slots = { 1: null, 2: null }; // clientId | null
    this.spectators = new Set(); // clientId
    this.rematchVotes = { 1: false, 2: false };
    this.onBroadcast = onBroadcast || (() => {});
  }

  config() {
    return {
      boardSize: BOARD_SIZE,
      shipTypes: SHIP_TYPES,
      powerUps: POWER_UPS,
      energy: ENERGY,
      reconnectGraceMs: RECONNECT_GRACE_MS,
    };
  }

  // ----------------------------------------------------------- join / leave

  /**
   * Attach a socket (by clientId) to the match. Reattaches to an existing slot
   * if the clientId is known, otherwise takes a free slot, otherwise spectates.
   * @returns {{ role:'player'|'spectator', slot:number|null }}
   */
  join(clientId, socketId) {
    let session = this.sessions.get(clientId);

    if (session && session.slot) {
      // Reconnection to an existing slot.
      session.socketId = socketId;
      session.connected = true;
      if (session.disconnectTimer) {
        clearTimeout(session.disconnectTimer);
        session.disconnectTimer = null;
      }
      return { role: 'player', slot: session.slot };
    }

    // New player: take a free slot if available.
    const freeSlot = !this.slots[1] ? 1 : !this.slots[2] ? 2 : null;
    if (freeSlot) {
      session = {
        clientId,
        socketId,
        slot: freeSlot,
        connected: true,
        disconnectTimer: null,
        name: SLOT_NAME[freeSlot],
      };
      this.sessions.set(clientId, session);
      this.slots[freeSlot] = clientId;
      this.spectators.delete(clientId);

      // Both slots filled → leave the lobby and start placement.
      if (this.slots[1] && this.slots[2] && this.engine.phase === 'lobby') {
        this.engine.startPlacement();
      }
      return { role: 'player', slot: freeSlot };
    }

    // Otherwise: spectator.
    this.spectators.add(clientId);
    if (!session) {
      this.sessions.set(clientId, { clientId, socketId, slot: null, connected: true, name: 'Espectador' });
    } else {
      session.socketId = socketId;
      session.connected = true;
    }
    return { role: 'spectator', slot: null };
  }

  /** Handle a socket disconnect — keep the slot reserved during the grace window. */
  disconnect(clientId) {
    const session = this.sessions.get(clientId);
    if (!session) return;
    session.connected = false;
    session.socketId = null;

    if (!session.slot) {
      // Spectator: drop immediately.
      this.spectators.delete(clientId);
      this.sessions.delete(clientId);
      return;
    }

    // Player: reserve the slot for the grace window, then forfeit/reset.
    session.disconnectTimer = setTimeout(() => {
      this._expireSlot(clientId);
    }, RECONNECT_GRACE_MS);
    this.broadcast();
  }

  _expireSlot(clientId) {
    const session = this.sessions.get(clientId);
    if (!session || session.connected) return;
    const slot = session.slot;
    this.slots[slot] = null;
    this.sessions.delete(clientId);
    // If the match was live, reset to a clean lobby for whoever remains.
    // Stays in 'lobby' until a second player joins (join() promotes to placement).
    if (this.engine.phase !== 'lobby') {
      this.engine.reset();
      this.rematchVotes = { 1: false, 2: false };
    }
    this.broadcast();
  }

  slotOf(clientId) {
    const s = this.sessions.get(clientId);
    return s ? s.slot : null;
  }

  isConnected(slot) {
    const id = this.slots[slot];
    if (!id) return false;
    const s = this.sessions.get(id);
    return !!(s && s.connected);
  }

  // ------------------------------------------------------------- game actions

  setFleet(slot, placements) {
    return this.engine.setFleet(slot, placements);
  }

  randomFleet(slot) {
    const placements = this.engine.randomPlacements();
    const res = this.engine.setFleet(slot, placements);
    return res.ok ? { ok: true, placements } : res;
  }

  confirm(slot) {
    const res = this.engine.confirm(slot);
    return res;
  }

  performAction(slot, action) {
    return this.engine.performAction(slot, action);
  }

  /** Register a rematch vote; when both players agree, reset to placement. */
  rematch(slot) {
    if (this.engine.phase !== 'finished') return { ok: false, error: 'not_finished' };
    this.rematchVotes[slot] = true;
    if (this.rematchVotes[1] && this.rematchVotes[2]) {
      this.engine.reset();
      this.engine.startPlacement();
      this.rematchVotes = { 1: false, 2: false };
    }
    return { ok: true };
  }

  // --------------------------------------------------------------- broadcast

  /** Per-player tail of match-level metadata layered onto the engine state. */
  stateForSlot(slot) {
    const state = this.engine.publicStateFor(slot);
    const otherSlot = slot === 1 ? 2 : 1;
    state.you.name = SLOT_NAME[slot];
    state.enemy.name = SLOT_NAME[otherSlot];
    state.enemy.connected = this.isConnected(otherSlot);
    state.enemy.present = !!this.slots[otherSlot];
    state.rematch = { you: this.rematchVotes[slot], opponent: this.rematchVotes[otherSlot] };
    state.bothPresent = !!(this.slots[1] && this.slots[2]);
    state.role = 'player';
    return state;
  }

  spectatorState() {
    const eng = this.engine;
    return {
      role: 'spectator',
      phase: eng.phase,
      currentTurn: eng.currentTurn,
      turnNumber: eng.turnNumber,
      winner: eng.winner,
      bothPresent: !!(this.slots[1] && this.slots[2]),
      players: {
        1: { present: !!this.slots[1], connected: this.isConnected(1), ready: eng.players[1].ready, shipsRemaining: eng.players[1].fleet.filter((s) => !s.sunk).length, shipsTotal: eng.players[1].fleet.length },
        2: { present: !!this.slots[2], connected: this.isConnected(2), ready: eng.players[2].ready, shipsRemaining: eng.players[2].fleet.filter((s) => !s.sunk).length, shipsTotal: eng.players[2].fleet.length },
      },
      events: eng.events.slice(-40),
    };
  }

  broadcast() {
    this.onBroadcast();
  }
}

module.exports = { Match };
