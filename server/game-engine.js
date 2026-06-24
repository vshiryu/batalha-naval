'use strict';

/**
 * GameEngine — pure, authoritative Battleship logic with power-ups.
 *
 * No I/O, no sockets: deterministic and fully unit-testable. The server (match.js)
 * wraps an instance per match; the headless simulation (test/) drives it directly.
 *
 * Coordinate system: row r (0..9, shown 1..10) and column c (0..9, shown A..J).
 * A cell index is `r * BOARD_SIZE + c`.
 *
 * ANTI-CHEAT: the full fleet of a player lives only inside that player's private
 * state here on the server. `publicStateFor(slot)` returns a payload that contains
 * the requester's own fleet but only the *discovered* projection of the enemy board
 * (unknown / miss / hit / sunk) — never the enemy's undiscovered ship positions.
 */

const {
  BOARD_SIZE,
  SHIP_TYPES,
  POWER_UPS,
  ENERGY,
  CELL,
  VIEW,
} = require('./constants');

const CELLS = BOARD_SIZE * BOARD_SIZE;
const idx = (r, c) => r * BOARD_SIZE + c;
const inBounds = (r, c) => r >= 0 && r < BOARD_SIZE && c >= 0 && c < BOARD_SIZE;

/** Build a fresh, empty private board state for one player. */
function makePlayerState() {
  return {
    fleet: [], // [{ id, name, size, orientation, r, c, cells:[{r,c}], hits:[bool], sunk }]
    grid: new Array(CELLS).fill(null), // shipId | null (own ship occupancy)
    incoming: new Array(CELLS).fill(CELL.NONE), // what the enemy did to MY board
    view: new Array(CELLS).fill(VIEW.UNKNOWN), // what I have discovered about the ENEMY board
    energy: ENERGY.start,
    ready: false,
    sonarReveals: [], // [{ createdTurn, cells:[{r,c,hasShip}] }]
  };
}

class GameEngine {
  /**
   * @param {() => number} [rng] random source in [0,1), injectable for deterministic tests.
   */
  constructor(rng = Math.random) {
    this.rng = rng;
    this.reset();
  }

  reset() {
    this.phase = 'lobby'; // 'lobby' | 'placement' | 'battle' | 'finished'
    this.players = { 1: makePlayerState(), 2: makePlayerState() };
    this.currentTurn = 1;
    this.turnNumber = 0;
    this.winner = null;
    this.events = [];
    this.lastAction = null;
    this._eventSeq = 0;
    this._actionSeq = 0;
  }

  /** Begin the placement phase (called when both players are present). */
  startPlacement() {
    if (this.phase !== 'lobby') return;
    this.phase = 'placement';
  }

  // ---------------------------------------------------------------- placement

  /**
   * Validate a fleet layout. Returns { valid, error, cells } where cells maps
   * shipId -> [{r,c}]. Adjacent ships are allowed (classic rules).
   */
  validatePlacement(placements) {
    if (!Array.isArray(placements)) return { valid: false, error: 'invalid_payload' };
    const wantIds = SHIP_TYPES.map((s) => s.id).sort();
    const gotIds = placements.map((p) => p && p.id).sort();
    if (wantIds.length !== gotIds.length || wantIds.some((v, i) => v !== gotIds[i])) {
      return { valid: false, error: 'fleet_mismatch' };
    }

    const occupied = new Array(CELLS).fill(false);
    const cellsByShip = {};
    for (const p of placements) {
      const type = SHIP_TYPES.find((s) => s.id === p.id);
      if (!type) return { valid: false, error: 'unknown_ship' };
      const orientation = p.orientation === 'v' ? 'v' : 'h';
      const r0 = p.r | 0;
      const c0 = p.c | 0;
      const cells = [];
      for (let i = 0; i < type.size; i++) {
        const r = orientation === 'v' ? r0 + i : r0;
        const c = orientation === 'h' ? c0 + i : c0;
        if (!inBounds(r, c)) return { valid: false, error: 'out_of_bounds', shipId: p.id };
        const k = idx(r, c);
        if (occupied[k]) return { valid: false, error: 'overlap', shipId: p.id };
        occupied[k] = true;
        cells.push({ r, c });
      }
      cellsByShip[p.id] = cells;
    }
    return { valid: true, cells: cellsByShip };
  }

  /**
   * Commit a fleet for a slot during placement. Returns { ok, error }.
   * Does NOT mark the player ready (that is `confirm`).
   */
  setFleet(slot, placements) {
    if (this.phase !== 'placement') return { ok: false, error: 'wrong_phase' };
    const v = this.validatePlacement(placements);
    if (!v.valid) return { ok: false, error: v.error, shipId: v.shipId };

    const player = this.players[slot];
    player.fleet = [];
    player.grid = new Array(CELLS).fill(null);
    for (const p of placements) {
      const type = SHIP_TYPES.find((s) => s.id === p.id);
      const cells = v.cells[p.id];
      const ship = {
        id: type.id,
        name: type.name,
        size: type.size,
        orientation: p.orientation === 'v' ? 'v' : 'h',
        r: cells[0].r,
        c: cells[0].c,
        cells,
        hits: new Array(type.size).fill(false),
        sunk: false,
      };
      player.fleet.push(ship);
      for (const cell of cells) player.grid[idx(cell.r, cell.c)] = type.id;
    }
    player.ready = false;
    return { ok: true };
  }

  /** Generate a valid random fleet layout (does not commit it). */
  randomPlacements() {
    for (let attempt = 0; attempt < 500; attempt++) {
      const occupied = new Array(CELLS).fill(false);
      const placements = [];
      let ok = true;
      for (const type of SHIP_TYPES) {
        let placed = false;
        for (let tries = 0; tries < 200 && !placed; tries++) {
          const orientation = this.rng() < 0.5 ? 'h' : 'v';
          const maxR = orientation === 'v' ? BOARD_SIZE - type.size : BOARD_SIZE - 1;
          const maxC = orientation === 'h' ? BOARD_SIZE - type.size : BOARD_SIZE - 1;
          const r0 = Math.floor(this.rng() * (maxR + 1));
          const c0 = Math.floor(this.rng() * (maxC + 1));
          const cells = [];
          let fits = true;
          for (let i = 0; i < type.size; i++) {
            const r = orientation === 'v' ? r0 + i : r0;
            const c = orientation === 'h' ? c0 + i : c0;
            if (occupied[idx(r, c)]) { fits = false; break; }
            cells.push({ r, c, k: idx(r, c) });
          }
          if (!fits) continue;
          for (const cell of cells) occupied[cell.k] = true;
          placements.push({ id: type.id, r: r0, c: c0, orientation });
          placed = true;
        }
        if (!placed) { ok = false; break; }
      }
      if (ok) return placements;
    }
    // Fallback: deterministic non-overlapping rows (always valid on a 10x10).
    return SHIP_TYPES.map((type, i) => ({ id: type.id, r: i * 2, c: 0, orientation: 'h' }));
  }

  /** Mark a slot ready (placement confirmed). Returns { ok, error }. */
  confirm(slot) {
    if (this.phase !== 'placement') return { ok: false, error: 'wrong_phase' };
    const player = this.players[slot];
    if (player.fleet.length !== SHIP_TYPES.length) return { ok: false, error: 'fleet_incomplete' };
    player.ready = true;
    if (this.players[1].ready && this.players[2].ready) this.startBattle();
    return { ok: true };
  }

  bothReady() {
    return this.players[1].ready && this.players[2].ready;
  }

  /** Transition to battle. Player 1 moves first and gains the per-turn energy. */
  startBattle() {
    this.phase = 'battle';
    this.currentTurn = 1;
    this.turnNumber = 1;
    this.winner = null;
    this.players[1].energy = ENERGY.start;
    this.players[2].energy = ENERGY.start;
    // The first player's turn begins now → per-turn energy.
    this.players[1].energy += ENERGY.perTurn;
    this._pushEvent({ type: 'battle_start' });
  }

  // ------------------------------------------------------------------ battle

  other(slot) {
    return slot === 1 ? 2 : 1;
  }

  /**
   * Apply a single shot to the defender at (r,c).
   * Updates the defender board only. Returns
   * { result:'hit'|'miss', shipId?, shipName?, sunk, sunkShip? }.
   * `alreadyHit` flags a wasted re-hit on a known cell.
   */
  _resolveShot(defender, r, c) {
    const k = idx(r, c);
    const shipId = defender.grid[k];
    if (!shipId) {
      if (defender.incoming[k] === CELL.NONE) defender.incoming[k] = CELL.MISS;
      return { result: 'miss', sunk: false };
    }
    const ship = defender.fleet.find((s) => s.id === shipId);
    const cellIndex = ship.cells.findIndex((cell) => cell.r === r && cell.c === c);
    const alreadyHit = ship.hits[cellIndex];
    ship.hits[cellIndex] = true;
    defender.incoming[k] = CELL.HIT;
    let sunk = false;
    let sunkShip = null;
    if (!ship.sunk && ship.hits.every(Boolean)) {
      ship.sunk = true;
      sunk = true;
      sunkShip = ship;
    }
    return { result: 'hit', shipId, shipName: ship.name, sunk, sunkShip, alreadyHit };
  }

  /**
   * Record a resolved shot into the attacker's discovered view.
   * Ship identity is only revealed to the attacker on a SINK (anti info-leak).
   */
  _recordView(attacker, r, c, shot) {
    const k = idx(r, c);
    if (shot.result === 'miss') {
      if (attacker.view[k] === VIEW.UNKNOWN) attacker.view[k] = VIEW.MISS;
    } else {
      attacker.view[k] = VIEW.HIT;
    }
    if (shot.sunk && shot.sunkShip) {
      for (const cell of shot.sunkShip.cells) attacker.view[idx(cell.r, cell.c)] = VIEW.SUNK;
    }
  }

  /**
   * Perform a player's action for the current turn.
   * @returns {{ ok:true, result:object } | { ok:false, error:string }}
   */
  performAction(slot, action) {
    if (this.phase !== 'battle') return { ok: false, error: 'wrong_phase' };
    if (this.currentTurn !== slot) return { ok: false, error: 'not_your_turn' };
    if (!action || typeof action.type !== 'string') return { ok: false, error: 'invalid_action' };

    const power = POWER_UPS[action.type];
    if (!power) return { ok: false, error: 'unknown_action' };

    const attacker = this.players[slot];
    const defender = this.players[this.other(slot)];
    if (attacker.energy < power.cost) return { ok: false, error: 'insufficient_energy' };

    // Clear this player's stale sonar reveals once they take their next action.
    attacker.sonarReveals = attacker.sonarReveals.filter(
      (rev) => this.turnNumber - rev.createdTurn < 2
    );

    let handler;
    switch (action.type) {
      case 'shoot': handler = this._actShoot; break;
      case 'sonar': handler = this._actSonar; break;
      case 'triple': handler = this._actTriple; break;
      case 'torpedo': handler = this._actTorpedo; break;
      case 'bombard': handler = this._actBombard; break;
      case 'repair': handler = this._actRepair; break;
      default: return { ok: false, error: 'unknown_action' };
    }

    const outcome = handler.call(this, attacker, defender, action);
    if (!outcome.ok) return outcome;

    // Pay the cost and bank sink bonuses.
    attacker.energy -= power.cost;
    const sunkCount = outcome.result.sunkShips ? outcome.result.sunkShips.length : 0;
    attacker.energy += sunkCount * ENERGY.perSink;

    outcome.result.action = action.type;
    outcome.result.attacker = slot;
    outcome.result.energyCost = power.cost;
    outcome.result.energyAfter = attacker.energy;
    outcome.result.seq = ++this._actionSeq; // monotonic id so clients animate each action once
    this.lastAction = outcome.result;

    // Win check: defender lost their whole fleet?
    if (defender.fleet.length && defender.fleet.every((s) => s.sunk)) {
      this.phase = 'finished';
      this.winner = slot;
      this._pushEvent({ type: 'win', winner: slot });
    } else {
      // Hand the turn to the opponent; their turn begins → per-turn energy.
      this.currentTurn = this.other(slot);
      this.turnNumber += 1;
      this.players[this.currentTurn].energy += ENERGY.perTurn;
    }

    return { ok: true, result: outcome.result };
  }

  // --- action handlers (each returns { ok, error? , result? }) ---------------

  _actShoot(attacker, defender, action) {
    const { r, c } = action.cell || {};
    if (!inBounds(r, c)) return { ok: false, error: 'out_of_bounds' };
    if (attacker.view[idx(r, c)] !== VIEW.UNKNOWN) return { ok: false, error: 'already_targeted' };

    const shot = this._resolveShot(defender, r, c);
    this._recordView(attacker, r, c, shot);
    const shots = [{ r, c, result: shot.result, sunk: shot.sunk, shipName: shot.sunk ? shot.shipName : undefined }];
    const sunkShips = shot.sunkShip ? [this._sunkInfo(shot.sunkShip)] : [];
    this._emitShotEvents(attacker, shots, sunkShips);
    return { ok: true, result: { shots, sunkShips } };
  }

  _actSonar(attacker, defender, action) {
    const { r, c } = action.cell || {};
    if (!inBounds(r, c)) return { ok: false, error: 'out_of_bounds' };
    const cells = [];
    for (let dr = -1; dr <= 1; dr++) {
      for (let dc = -1; dc <= 1; dc++) {
        const rr = r + dr;
        const cc = c + dc;
        if (!inBounds(rr, cc)) continue;
        cells.push({ r: rr, c: cc, hasShip: defender.grid[idx(rr, cc)] != null });
      }
    }
    // Recon only: store as a temporary reveal for the attacker. No board mutation.
    attacker.sonarReveals.push({ createdTurn: this.turnNumber, cells });
    const found = cells.filter((cell) => cell.hasShip).length;
    this._pushEvent({ type: 'sonar', attacker: this.currentTurn, center: { r, c }, found });
    return { ok: true, result: { sonar: { center: { r, c }, cells }, shots: [], sunkShips: [] } };
  }

  _actTriple(attacker, defender, action) {
    const cells = Array.isArray(action.cells) ? action.cells : [];
    if (cells.length !== 3) return { ok: false, error: 'need_three_cells' };
    const seen = new Set();
    for (const cell of cells) {
      if (!cell || !inBounds(cell.r, cell.c)) return { ok: false, error: 'out_of_bounds' };
      const k = idx(cell.r, cell.c);
      if (seen.has(k)) return { ok: false, error: 'duplicate_cell' };
      if (attacker.view[k] !== VIEW.UNKNOWN) return { ok: false, error: 'already_targeted' };
      seen.add(k);
    }
    const shots = [];
    const sunkShips = [];
    for (const cell of cells) {
      const shot = this._resolveShot(defender, cell.r, cell.c);
      this._recordView(attacker, cell.r, cell.c, shot);
      shots.push({ r: cell.r, c: cell.c, result: shot.result, sunk: shot.sunk, shipName: shot.sunk ? shot.shipName : undefined });
      if (shot.sunkShip) sunkShips.push(this._sunkInfo(shot.sunkShip));
    }
    this._emitShotEvents(attacker, shots, sunkShips);
    return { ok: true, result: { shots, sunkShips } };
  }

  _actTorpedo(attacker, defender, action) {
    const line = action.line || {};
    const orientation = line.orientation === 'col' ? 'col' : 'row';
    const index = line.index | 0;
    const direction = line.direction === 'backward' ? 'backward' : 'forward';
    if (index < 0 || index >= BOARD_SIZE) return { ok: false, error: 'out_of_bounds' };

    // Build the traversal path.
    const path = [];
    for (let i = 0; i < BOARD_SIZE; i++) {
      const pos = direction === 'forward' ? i : BOARD_SIZE - 1 - i;
      const r = orientation === 'row' ? index : pos;
      const c = orientation === 'row' ? pos : index;
      path.push({ r, c });
    }

    // Impact = first not-yet-hit ship cell along the path.
    let impact = null;
    let shot = null;
    for (const cell of path) {
      const k = idx(cell.r, cell.c);
      const shipId = defender.grid[k];
      if (shipId) {
        const ship = defender.fleet.find((s) => s.id === shipId);
        const ci = ship.cells.findIndex((x) => x.r === cell.r && x.c === cell.c);
        if (!ship.hits[ci]) {
          impact = cell;
          shot = this._resolveShot(defender, cell.r, cell.c);
          break;
        }
      }
    }

    const shots = [];
    const sunkShips = [];
    if (impact && shot) {
      this._recordView(attacker, impact.r, impact.c, shot);
      shots.push({ r: impact.r, c: impact.c, result: 'hit', sunk: shot.sunk, shipName: shot.sunk ? shot.shipName : undefined });
      if (shot.sunkShip) sunkShips.push(this._sunkInfo(shot.sunkShip));
      this._emitShotEvents(attacker, shots, sunkShips);
    } else {
      this._pushEvent({ type: 'torpedo_miss', attacker: this.currentTurn });
    }
    return {
      ok: true,
      result: { shots, sunkShips, torpedo: { orientation, index, direction, path, impact } },
    };
  }

  _actBombard(attacker, defender, action) {
    const { r, c } = action.cell || {};
    if (!inBounds(r, c)) return { ok: false, error: 'out_of_bounds' };
    const shots = [];
    const sunkShips = [];
    for (let dr = -1; dr <= 1; dr++) {
      for (let dc = -1; dc <= 1; dc++) {
        const rr = r + dr;
        const cc = c + dc;
        if (!inBounds(rr, cc)) continue;
        const k = idx(rr, cc);
        // Bombard splashes every cell in the 3x3, even already-known ones,
        // but only records *new* discoveries / hits.
        const wasUnknown = attacker.view[k] === VIEW.UNKNOWN;
        const shot = this._resolveShot(defender, rr, cc);
        this._recordView(attacker, rr, cc, shot);
        if (wasUnknown || shot.result === 'hit') {
          shots.push({ r: rr, c: cc, result: shot.result, sunk: shot.sunk, shipName: shot.sunk ? shot.shipName : undefined });
        }
        if (shot.sunkShip) sunkShips.push(this._sunkInfo(shot.sunkShip));
      }
    }
    this._emitShotEvents(attacker, shots, sunkShips);
    return { ok: true, result: { shots, sunkShips, bombard: { center: { r, c } } } };
  }

  _actRepair(attacker, defender, action) {
    const { r, c } = action.cell || {};
    if (!inBounds(r, c)) return { ok: false, error: 'out_of_bounds' };
    const k = idx(r, c);
    const shipId = attacker.grid[k];
    if (!shipId) return { ok: false, error: 'no_own_ship' };
    const ship = attacker.fleet.find((s) => s.id === shipId);
    if (ship.sunk) return { ok: false, error: 'ship_sunk' };
    const ci = ship.cells.findIndex((x) => x.r === r && x.c === c);
    if (!ship.hits[ci]) return { ok: false, error: 'cell_not_hit' };

    ship.hits[ci] = false;
    attacker.incoming[k] = CELL.NONE;
    // The opponent loses their confirmed hit at this cell (it is whole again).
    if (defender.view[k] === VIEW.HIT) defender.view[k] = VIEW.UNKNOWN;

    this._pushEvent({ type: 'repair', attacker: this.currentTurn });
    return { ok: true, result: { shots: [], sunkShips: [], repair: { cell: { r, c }, shipId } } };
  }

  // --- helpers ---------------------------------------------------------------

  _sunkInfo(ship) {
    return { id: ship.id, name: ship.name, size: ship.size, cells: ship.cells.map((x) => ({ r: x.r, c: x.c })) };
  }

  _emitShotEvents(attacker, shots, sunkShips) {
    const slot = this.currentTurn;
    const hits = shots.filter((s) => s.result === 'hit').length;
    const misses = shots.filter((s) => s.result === 'miss').length;
    if (hits) this._pushEvent({ type: 'hit', attacker: slot, count: hits });
    if (misses) this._pushEvent({ type: 'miss', attacker: slot, count: misses });
    for (const sunk of sunkShips) {
      this._pushEvent({ type: 'sunk', attacker: slot, shipId: sunk.id, shipName: sunk.name });
    }
  }

  _pushEvent(ev) {
    ev.id = ++this._eventSeq;
    ev.turn = this.turnNumber;
    this.events.push(ev);
    if (this.events.length > 60) this.events.shift();
  }

  // --------------------------------------------------------------- projection

  /** Count of an opponent's ships still afloat. */
  _shipsRemaining(slot) {
    return this.players[slot].fleet.filter((s) => !s.sunk).length;
  }

  /** Enemy ships that `slot` has sunk (safe to reveal — they are fully discovered). */
  _sunkEnemyShips(slot) {
    const enemy = this.players[this.other(slot)];
    return enemy.fleet.filter((s) => s.sunk).map((s) => this._sunkInfo(s));
  }

  /**
   * Build the sanitized state for one player. Contains the requester's OWN fleet
   * in full, but only the discovered projection of the enemy board.
   */
  publicStateFor(slot) {
    const me = this.players[slot];
    const enemySlot = this.other(slot);
    const enemy = this.players[enemySlot];

    return {
      phase: this.phase,
      turnNumber: this.turnNumber,
      currentTurn: this.currentTurn,
      yourTurn: this.phase === 'battle' && this.currentTurn === slot,
      winner: this.winner,
      slot,
      you: {
        slot,
        energy: me.energy,
        ready: me.ready,
        // Your own fleet, in full — this is your data.
        fleet: me.fleet.map((s) => ({
          id: s.id,
          name: s.name,
          size: s.size,
          orientation: s.orientation,
          cells: s.cells.map((x) => ({ r: x.r, c: x.c })),
          hits: s.hits.slice(),
          sunk: s.sunk,
        })),
        incoming: me.incoming.slice(),
        sonar: me.sonarReveals.map((rev) => ({ cells: rev.cells.map((x) => ({ r: x.r, c: x.c, hasShip: x.hasShip })) })),
      },
      enemy: {
        ready: enemy.ready,
        // Only discovered cells. NO undiscovered ship positions ever leave here.
        view: me.view.slice(),
        shipsTotal: enemy.fleet.length,
        shipsRemaining: this._shipsRemaining(enemySlot),
        sunkShips: this._sunkEnemyShips(slot),
      },
      events: this.events.slice(-40),
      lastAction: this._lastActionFor(slot),
    };
  }

  /**
   * Tailor `lastAction` per perspective. The attacker gets full detail (sonar
   * reveals, the repaired cell). The defender/observer gets a redacted version:
   * shots/sinks that touch their OWN board are fine to show, but sonar reveals and
   * the exact repaired cell are withheld so nothing extra about a fleet leaks.
   */
  _lastActionFor(slot) {
    const la = this.lastAction;
    if (!la) return null;
    const isAttacker = la.attacker === slot;
    const base = {
      action: la.action,
      attacker: la.attacker,
      seq: la.seq,
      shots: la.shots || [],
      sunkShips: la.sunkShips || [],
      energyCost: la.energyCost,
    };
    if (la.torpedo) base.torpedo = la.torpedo;
    if (la.bombard) base.bombard = la.bombard;
    if (isAttacker) {
      if (la.sonar) base.sonar = la.sonar;
      if (la.repair) base.repair = la.repair;
    } else {
      // Defender: show only that a sonar/repair happened, not the revealed/exact cells.
      if (la.sonar) base.sonar = { center: la.sonar.center };
      if (la.repair) base.repair = {};
    }
    return base;
  }
}

module.exports = { GameEngine, idx, inBounds, BOARD_SIZE };
