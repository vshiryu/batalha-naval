// PlacementController — drag/rotate/randomize ships on the OWN board during the
// placement phase. Keeps an authoritative-mirror `placements` array, validates
// moves locally for instant feedback (overlap/bounds), and commits to the server
// only on confirm. The ship under the finger snaps to the grid with a ghost.

import { makeShip } from './gfx/ships.js';
import { COLORS } from './constants.js';

const PIXI = window.PIXI;

export class PlacementController {
  constructor(scene, config, audio) {
    this.scene = scene;
    this.config = config;
    this.audio = audio;
    this.N = config.boardSize;
    this.shipTypes = config.shipTypes;
    this.placements = this._defaultLayout();
    this.sprites = new Map(); // id -> ship container
    this.selected = this.shipTypes[0].id;
    this.drag = null;
    this.active = false;
    this._bound = {
      move: (e) => this._onMove(e),
      up: (e) => this._onUp(e),
    };
  }

  _defaultLayout() {
    // Guaranteed-valid starting layout (each ship on its own even row).
    return this.shipTypes.map((t, i) => ({ id: t.id, r: i * 2, c: 0, orientation: 'h', size: t.size }));
  }

  get board() { return this.scene.ownBoard; }

  enter() {
    this.active = true;
    this.board.clearShips();
    this.sprites.clear();
    for (const p of this.placements) this._makeSprite(p);
    this._refreshAll();
    const stage = this.scene.stage.app.stage;
    stage.on('pointermove', this._bound.move);
    stage.on('pointerup', this._bound.up);
    stage.on('pointerupoutside', this._bound.up);
  }

  exit() {
    this.active = false;
    const stage = this.scene.stage.app.stage;
    stage.off('pointermove', this._bound.move);
    stage.off('pointerup', this._bound.up);
    stage.off('pointerupoutside', this._bound.up);
    this.board.clearAim();
    for (const [, sc] of this.sprites) this.board.shipLayer.removeChild(sc);
    this.sprites.clear();
    this.board.clearShips();
  }

  _makeSprite(p) {
    const sc = makeShip(p.id, p.size, this.board.cell);
    sc.eventMode = 'static';
    sc.cursor = 'grab';
    sc.on('pointerdown', (e) => this._onDown(p.id, e));
    this.board.shipLayer.addChild(sc);
    this.sprites.set(p.id, sc);
    return sc;
  }

  _cellsFor(r0, c0, orientation, size) {
    const cells = [];
    for (let i = 0; i < size; i++) {
      const r = orientation === 'v' ? r0 + i : r0;
      const c = orientation === 'h' ? c0 + i : c0;
      cells.push({ r, c });
    }
    return cells;
  }

  _inBounds(cells) { return cells.every((c) => c.r >= 0 && c.c >= 0 && c.r < this.N && c.c < this.N); }

  _occupiedByOthers(exceptId) {
    const set = new Set();
    for (const p of this.placements) {
      if (p.id === exceptId) continue;
      for (const cell of this._cellsFor(p.r, p.c, p.orientation, p.size)) set.add(`${cell.r},${cell.c}`);
    }
    return set;
  }

  _isValid(id, r0, c0, orientation, size) {
    const cells = this._cellsFor(r0, c0, orientation, size);
    if (!this._inBounds(cells)) return false;
    const occ = this._occupiedByOthers(id);
    return cells.every((c) => !occ.has(`${c.r},${c.c}`));
  }

  _place(p) {
    const sc = this.sprites.get(p.id);
    if (!sc) return;
    const cc = this.board.shipCenter(p.r, p.c, p.orientation, p.size);
    sc.x = cc.x; sc.y = cc.y; sc.rotation = cc.rotation;
    sc.baseX = cc.x; sc.baseY = cc.y; sc.rotBase = cc.rotation;
    sc.bobSeed = p.r * 7 + p.c * 13;
  }

  _refreshAll() {
    for (const p of this.placements) this._place(p);
    this._highlightSelected();
  }

  _highlightSelected() {
    const p = this.placements.find((x) => x.id === this.selected);
    if (!p) { this.board.clearAim(); return; }
    this.board.setAim(this._cellsFor(p.r, p.c, p.orientation, p.size), 'valid');
    for (const [id, sc] of this.sprites) sc.scale.set(id === this.selected ? 1.06 : 1);
  }

  _onDown(id, e) {
    if (!this.active) return;
    this.selected = id;
    const p = this.placements.find((x) => x.id === id);
    const lp = e.getLocalPosition(this.board.container);
    const grabCell = this.board.localToCell(lp.x, lp.y) || { r: p.r, c: p.c };
    this.drag = { id, dr: grabCell.r - p.r, dc: grabCell.c - p.c, last: { r: p.r, c: p.c } };
    const sc = this.sprites.get(id);
    if (sc) { sc.scale.set(1.12); if (sc.shadow) sc.shadow.alpha = 0.6; }
    this.audio && this.audio.uiClick();
    this._highlightSelected();
    e.stopPropagation && e.stopPropagation();
  }

  _onMove(e) {
    if (!this.drag) return;
    const p = this.placements.find((x) => x.id === this.drag.id);
    const lp = e.getLocalPosition(this.board.container);
    const cell = this.board.localToCell(lp.x, lp.y);
    if (!cell) return;
    let r0 = cell.r - this.drag.dr;
    let c0 = cell.c - this.drag.dc;
    // clamp to bounds
    if (p.orientation === 'h') c0 = Math.max(0, Math.min(this.N - p.size, c0)), r0 = Math.max(0, Math.min(this.N - 1, r0));
    else r0 = Math.max(0, Math.min(this.N - p.size, r0)), c0 = Math.max(0, Math.min(this.N - 1, c0));
    const cells = this._cellsFor(r0, c0, p.orientation, p.size);
    const valid = this._isValid(p.id, r0, c0, p.orientation, p.size);
    this.drag.candidate = { r0, c0, valid };
    // move sprite to snapped center, show ghost
    const cc = this.board.shipCenter(r0, c0, p.orientation, p.size);
    const sc = this.sprites.get(p.id);
    if (sc) { sc.x = cc.x; sc.y = cc.y; sc.rotation = cc.rotation; }
    this.board.setAim(cells, valid ? 'valid' : 'invalid');
  }

  _onUp() {
    if (!this.drag) return;
    const p = this.placements.find((x) => x.id === this.drag.id);
    const cand = this.drag.candidate;
    const sc = this.sprites.get(this.drag.id);
    if (sc) { sc.scale.set(1.06); if (sc.shadow) sc.shadow.alpha = 0.4; }
    if (cand && cand.valid) {
      p.r = cand.r0; p.c = cand.c0;
      this.audio && this.audio.place();
    }
    this.drag = null;
    this._refreshAll();
  }

  rotateSelected() {
    if (!this.active) return;
    const p = this.placements.find((x) => x.id === this.selected);
    if (!p) return;
    const next = p.orientation === 'h' ? 'v' : 'h';
    let r0 = p.r, c0 = p.c;
    // pull back into bounds after rotating
    if (next === 'v') r0 = Math.min(r0, this.N - p.size);
    else c0 = Math.min(c0, this.N - p.size);
    r0 = Math.max(0, r0); c0 = Math.max(0, c0);
    if (this._isValid(p.id, r0, c0, next, p.size)) {
      p.orientation = next; p.r = r0; p.c = c0;
      this.audio && this.audio.rotate();
    } else {
      // try a few nudges
      let placed = false;
      for (let dr = -p.size; dr <= p.size && !placed; dr++) {
        for (let dc = -p.size; dc <= p.size && !placed; dc++) {
          const nr = Math.max(0, Math.min(this.N - 1, r0 + dr));
          const nc = Math.max(0, Math.min(this.N - 1, c0 + dc));
          if (this._isValid(p.id, nr, nc, next, p.size)) { p.orientation = next; p.r = nr; p.c = nc; placed = true; }
        }
      }
      if (placed) this.audio && this.audio.rotate();
      else this._flashInvalid(p);
    }
    this._refreshAll();
  }

  _flashInvalid(p) {
    this.board.setAim(this._cellsFor(p.r, p.c, p.orientation, p.size), 'invalid');
    setTimeout(() => this._highlightSelected(), 250);
  }

  randomize() {
    if (!this.active) return;
    const placements = this._randomLayout();
    if (placements) {
      this.placements = placements;
      this.exit(); this.enter();
      this.audio && this.audio.place();
    }
  }

  _randomLayout() {
    for (let attempt = 0; attempt < 400; attempt++) {
      const occ = new Set();
      const out = [];
      let ok = true;
      for (const t of this.shipTypes) {
        let placed = false;
        for (let tries = 0; tries < 120 && !placed; tries++) {
          const orientation = Math.random() < 0.5 ? 'h' : 'v';
          const maxR = orientation === 'v' ? this.N - t.size : this.N - 1;
          const maxC = orientation === 'h' ? this.N - t.size : this.N - 1;
          const r0 = Math.floor(Math.random() * (maxR + 1));
          const c0 = Math.floor(Math.random() * (maxC + 1));
          const cells = this._cellsFor(r0, c0, orientation, t.size);
          if (cells.some((c) => occ.has(`${c.r},${c.c}`))) continue;
          cells.forEach((c) => occ.add(`${c.r},${c.c}`));
          out.push({ id: t.id, r: r0, c: c0, orientation, size: t.size });
          placed = true;
        }
        if (!placed) { ok = false; break; }
      }
      if (ok) return out;
    }
    return null;
  }

  selectShip(id) { this.selected = id; this._highlightSelected(); }

  getPlacements() {
    return this.placements.map((p) => ({ id: p.id, r: p.r, c: p.c, orientation: p.orientation }));
  }
}
