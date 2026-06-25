// Scene — bridges the game to the WebGL layer. Owns the Pixi stage, ocean,
// effects and the two boards, and turns an authoritative `lastAction` into a
// choreographed sequence of projectiles, explosions, splashes, sonar, torpedo,
// bombardment, repair and sinking.

import { Stage } from './gfx/app.js';
import { Water } from './gfx/water.js';
import { Effects } from './gfx/effects.js';
import { Board } from './gfx/board.js';
import { TIMING } from './constants.js';

const PIXI = window.PIXI;

export class Scene {
  constructor(mountEl, audio) {
    this.stage = new Stage(mountEl);
    this.audio = audio;
    this.water = new Water(this.stage);
    this.effects = new Effects(this.stage);
    this.enemyBoard = null;
    this.ownBoard = null;
    this.focus = 'enemy';
    this.boardSize = 10;
    this.stage.onResize(() => this.layout());
    this._initHeat();
  }

  // Subtle screen-space heat refraction on the FX layer while cells burn.
  _initHeat() {
    this._heatSprite = new PIXI.Sprite(this.effects.tex.noise);
    this._heatSprite.renderable = false;
    this._heatSprite.scale.set(2);
    this.stage.fxLayer.addChild(this._heatSprite);
    this._heatFilter = new PIXI.DisplacementFilter(this._heatSprite);
    this._heatFilter.scale.set(5);
    this._heatOn = false;
    this.stage.addUpdater((dt) => this._updateHeat(dt));
    this.stage.onQualityChange(() => { /* re-evaluated each frame in _updateHeat */ });
  }

  _updateHeat(dt) {
    const burning = (this.enemyBoard && this.enemyBoard.burning.size) || (this.ownBoard && this.ownBoard.burning.size);
    const want = !!burning && this.stage.quality !== 'reduced';
    if (want !== this._heatOn) {
      this._heatOn = want;
      this.stage.fxLayer.filters = want ? [this._heatFilter] : null;
    }
    if (want) { this._heatSprite.x += dt * 0.03; this._heatSprite.y -= dt * 0.05; }
  }

  build(config) {
    this.boardSize = config.boardSize;
    this.enemyBoard = new Board(this.stage, this.effects, { side: 'enemy', boardSize: config.boardSize });
    this.ownBoard = new Board(this.stage, this.effects, { side: 'own', boardSize: config.boardSize });
    this.layout();
  }

  // --------------------------------------------------------------- layout
  _regions() {
    const W = this.stage.width, H = this.stage.height;
    // Big board sits in the central band; mini board tucks into the top-right.
    const topUI = H * 0.135, bottomUI = H * 0.30;
    const availH = H - topUI - bottomUI;
    const big = Math.min(W * 0.9, availH * 0.98);
    const bigX = (W - big) / 2;
    const bigY = topUI + (availH - big) / 2;
    const mini = Math.min(W * 0.32, 150);
    return {
      big: { x: bigX, y: bigY, size: big },
      mini: { x: W - mini - 12, y: topUI * 0.2 + 8, size: mini },
    };
  }

  layout() {
    if (!this.enemyBoard) return;
    const reg = this._regions();
    const big = this.focus === 'enemy' ? this.enemyBoard : this.ownBoard;
    const small = this.focus === 'enemy' ? this.ownBoard : this.enemyBoard;
    const gutter = Math.max(12, (reg.big.size / this.boardSize) * 0.52);
    big.setLayout(reg.big.x + gutter, reg.big.y + gutter, reg.big.size - gutter);
    const gutterS = Math.max(8, (reg.mini.size / this.boardSize) * 0.5);
    small.setLayout(reg.mini.x + gutterS, reg.mini.y + gutterS, reg.mini.size - gutterS);
    big.container.alpha = 1;
    small.container.alpha = this.phase === 'placement' ? 0 : 0.92;
    big.setInteractive(true);
    small.setInteractive(false);
  }

  setPhaseView(phase) {
    this.phase = phase;
    if (phase === 'placement') this.focus = 'own';
    else if (this.focus !== 'own-peek') this.focus = 'enemy';
    if (this.ownBoard) {
      this.ownBoard.clearAim && this.ownBoard.clearAim();
    }
    this.layout();
  }

  setFocus(which) {
    this.focus = which;
    this.layout();
  }

  get attackBoard() { return this.focus === 'own' ? this.ownBoard : this.enemyBoard; }

  // --------------------------------------------------------------- render
  renderState(state, opts = {}) {
    this.state = state;
    if (this.enemyBoard) this.enemyBoard.render(state, this.focus === 'enemy' ? opts : {});
    if (this.ownBoard) this.ownBoard.render(state, this.focus === 'own' ? opts : {});
  }

  // origin point for a shot fired at `board` cell — off the near edge of the board
  _origin(board) {
    return { x: board.container.x + board.gridPx * 0.5, y: board.container.y + board.gridPx + this.stage.height * 0.18 };
  }

  // --------------------------------------------------------------- animation
  // Returns a Promise resolved when the choreography finishes.
  animateAction(state, mySlot) {
    const la = state.lastAction;
    if (!la) return Promise.resolve();
    const iAttacked = la.attacker === mySlot;
    const board = iAttacked ? this.enemyBoard : this.ownBoard;

    switch (la.action) {
      case 'shoot': return this._animShots(board, la.shots, 0, la);
      case 'triple': return this._animShots(board, la.shots, 130, la);
      case 'bombard': return this._animBombard(board, la, iAttacked);
      case 'sonar': return this._animSonar(board, la, iAttacked);
      case 'torpedo': return this._animTorpedo(board, la, iAttacked);
      case 'repair': return this._animRepair(la, iAttacked);
      default: return Promise.resolve();
    }
  }

  _shipSunkCells(la) {
    const set = new Set();
    for (const s of la.sunkShips || []) for (const c of s.cells) set.add(`${c.r},${c.c}`);
    return set;
  }

  _animShots(board, shots, stagger, la) {
    return new Promise((resolve) => {
      const origin = this._origin(board);
      let done = 0;
      const total = shots.length || 1;
      if (!shots.length) return resolve();
      shots.forEach((shot, i) => {
        setTimeout(() => {
          const to = board.worldCenter(shot.r, shot.c);
          this.audio && this.audio.cannon();
          this.audio && this.audio.whistle();
          this.effects.projectile(origin, to, () => {
            this._impact(board, shot, la);
            done++;
            if (done >= total) setTimeout(resolve, 350);
          }, { dur: TIMING.projectile });
        }, i * stagger);
      });
    });
  }

  _impact(board, shot, la) {
    const to = board.worldCenter(shot.r, shot.c);
    if (shot.result === 'hit') {
      board.revealShot(shot.r, shot.c, 'hit');
      this.effects.explosion(to.x, to.y, shot.sunk ? 1.5 : 1);
      this.audio && this.audio.explosion();
      this.stage.hitStop(shot.sunk ? TIMING.hitStopBig : TIMING.hitStopSmall);
      if (navigator.vibrate) navigator.vibrate(shot.sunk ? [40, 30, 80] : 25);
      if (shot.sunk) this._sink(board, la);
    } else {
      board.revealShot(shot.r, shot.c, 'miss');
      this.effects.splash(to.x, to.y, 1);
      this.audio && this.audio.splash();
      if (navigator.vibrate) navigator.vibrate(12);
    }
  }

  _sink(board, la) {
    // Find the ship that just sank covering this region and play a sink flourish.
    const ship = (la.sunkShips || [])[0];
    if (!ship) return;
    this.audio && this.audio.gurgle();
    this.audio && this.audio.creak();
    for (const c of ship.cells) {
      const w = board.worldCenter(c.r, c.c);
      board.revealShot(c.r, c.c, 'sunk');
      this.effects.bubbles(w.x, w.y, 1);
    }
    const mid = ship.cells[Math.floor(ship.cells.length / 2)];
    const w = board.worldCenter(mid.r, mid.c);
    this.effects.splash(w.x, w.y, 2);
    this.stage.addShake(18);
  }

  _animBombard(board, la, iAttacked) {
    return new Promise((resolve) => {
      const origin = this._origin(board);
      const shots = la.shots || [];
      if (!shots.length) return resolve();
      let done = 0;
      shots.forEach((shot, i) => {
        setTimeout(() => {
          const to = board.worldCenter(shot.r, shot.c);
          this.audio && this.audio.cannon();
          this.effects.projectile(origin, to, () => {
            this._impact(board, shot, la);
            done++;
            if (done >= shots.length) setTimeout(resolve, 400);
          }, { dur: TIMING.projectile * 0.8, arc: 60 });
        }, i * 90);
      });
    });
  }

  _animSonar(board, la, iAttacked) {
    return new Promise((resolve) => {
      const center = la.sonar && la.sonar.center;
      if (!center) return resolve();
      const w = board.worldCenter(center.r, center.c);
      this.audio && this.audio.sonarPing();
      this.effects.sonar(w.x, w.y, (board.cell * 2.2) / 80);
      // pulse detected ship cells (attacker only — cells provided)
      if (la.sonar.cells) {
        la.sonar.cells.forEach((c, i) => {
          if (!c.hasShip) return;
          setTimeout(() => { const p = board.worldCenter(c.r, c.c); this.effects.detect(p.x, p.y); }, 300 + i * 60);
        });
      }
      setTimeout(resolve, TIMING.sonarSweep);
    });
  }

  _animTorpedo(board, la, iAttacked) {
    return new Promise((resolve) => {
      const t = la.torpedo;
      if (!t) return resolve();
      const start = t.path[0];
      const end = t.impact || t.path[t.path.length - 1];
      const from = board.worldCenter(start.r, start.c);
      // launch slightly off the edge
      const launch = { x: from.x, y: from.y };
      const to = board.worldCenter(end.r, end.c);
      this.audio && this.audio.cannon();
      this.effects.torpedo(launch, to, () => {
        if (t.impact && la.shots && la.shots.length) {
          this._impact(board, la.shots[0], la);
        } else {
          this.effects.splash(to.x, to.y, 1.2);
          this.audio && this.audio.splash();
        }
        setTimeout(resolve, 350);
      }, { dur: TIMING.torpedoTravel });
    });
  }

  _animRepair(la, iAttacked) {
    return new Promise((resolve) => {
      this.audio && this.audio.place();
      if (iAttacked && la.repair && la.repair.cell) {
        const w = this.ownBoard.worldCenter(la.repair.cell.r, la.repair.cell.c);
        this.effects.ripple(w.x, w.y, { color: 0x2dd4bf, maxScale: 0.7, life: 700 });
        this.effects.detect(w.x, w.y);
      }
      setTimeout(resolve, 500);
    });
  }

  // --------------------------------------------------------------- end game
  victory() {
    const W = this.stage.width, H = this.stage.height;
    this.audio && this.audio.victory();
    for (let i = 0; i < 6; i++) {
      setTimeout(() => this.effects.flares(W * (0.2 + Math.random() * 0.6), H * 0.62), i * 350);
    }
    if (navigator.vibrate) navigator.vibrate([60, 40, 60, 40, 120]);
  }

  defeat() {
    this.audio && this.audio.defeat();
    // somber smoke drifting up from the player's fleet
    if (this.ownBoard) {
      for (const [, sc] of this.ownBoard.ships) {
        const x = this.ownBoard.container.x + sc.x, y = this.ownBoard.container.y + sc.y;
        for (let i = 0; i < 3; i++) setTimeout(() => this.effects.smokePuff(x, y, 1.2), i * 200);
      }
    }
  }
}
