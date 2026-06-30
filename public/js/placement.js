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
      down: (e) => this._onBoardDown(e),
      move: (e) => this._onMove(e),
      up: (e) => this._onUp(e),
      cancel: () => this._onCancel(),
    };
    this._captured = null;
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
    // Grab ships by CELL, not by sprite. The board is a single tap surface whose
    // cell mapping is exact; the 2.5D ship sprites have tall, offset texture bounds
    // that don't reliably cover their footprint cell, so per-sprite hit-testing let
    // taps fall through to the board and a ship (e.g. the carrier) wouldn't pick up.
    this.board.container.on('pointerdown', this._bound.down);
    stage.on('pointermove', this._bound.move);
    stage.on('pointerup', this._bound.up);
    stage.on('pointerupoutside', this._bound.up);
    // iOS may fire pointercancel mid-gesture; PixiJS doesn't surface it, so listen
    // at the DOM level to end a drag cleanly instead of leaving it dangling.
    const view = this.scene.stage.app.view;
    if (view && view.addEventListener) view.addEventListener('pointercancel', this._bound.cancel);
  }

  exit() {
    this.active = false;
    this._releaseCapture();
    this.drag = null;
    const stage = this.scene.stage.app.stage;
    this.board.container.off('pointerdown', this._bound.down);
    stage.off('pointermove', this._bound.move);
    stage.off('pointerup', this._bound.up);
    stage.off('pointerupoutside', this._bound.up);
    const view = this.scene.stage.app.view;
    if (view && view.removeEventListener) view.removeEventListener('pointercancel', this._bound.cancel);
    this.board.clearAim();
    for (const [, sc] of this.sprites) this.board.shipLayer.removeChild(sc);
    this.sprites.clear();
    this.board.clearShips();
  }

  _makeSprite(p) {
    // Purely visual — grabbing is handled at the board/cell level (see _onBoardDown).
    const sc = makeShip(p.id, p.size, this.board.cell);
    this.board.shipLayer.addChild(sc);
    this.sprites.set(p.id, sc);
    return sc;
  }

  // Which placed ship (if any) covers a board cell.
  _shipAtCell(cell) {
    return this.placements.find((p) => this._cellsFor(p.r, p.c, p.orientation, p.size)
      .some((c) => c.r === cell.r && c.c === cell.c));
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
    this.board.applyShipTransform(sc, p.r, p.c, p.orientation, p.size);
  }

  _refreshAll() {
    for (const p of this.placements) this._place(p);
    this._highlightSelected();
  }

  _highlightSelected() {
    const p = this.placements.find((x) => x.id === this.selected);
    if (!p) { this.board.clearAim(); return; }
    this.board.setAim(this._cellsFor(p.r, p.c, p.orientation, p.size), 'valid');
    for (const [id, sc] of this.sprites) { const f = id === this.selected ? 1.08 : 1; sc.scale.set((sc.baseScaleX || 1) * f, (sc.baseScaleY || 1) * f); }
  }

  // Pointer capture routes ALL subsequent move/up/cancel events for this pointer to
  // the canvas, so a drag keeps tracking even if the finger outruns the sprite.
  _capture(e) {
    const view = this.scene.stage.app.view;
    const id = e && e.pointerId;
    if (view && view.setPointerCapture && id != null) {
      try { view.setPointerCapture(id); this._captured = id; } catch (_e) { /* ignore */ }
    }
  }

  _releaseCapture() {
    const view = this.scene.stage.app.view;
    if (view && view.releasePointerCapture && this._captured != null) {
      try { view.releasePointerCapture(this._captured); } catch (_e) { /* ignore */ }
    }
    this._captured = null;
  }

  // Snap a board-local point to a clamped, validated candidate placement.
  _candidateFromLocal(p, lp) {
    const cell = this.board.localToCell(lp.x, lp.y);
    if (!cell) return null;
    let r0 = cell.r - this.drag.dr;
    let c0 = cell.c - this.drag.dc;
    if (p.orientation === 'h') { c0 = Math.max(0, Math.min(this.N - p.size, c0)); r0 = Math.max(0, Math.min(this.N - 1, r0)); }
    else { r0 = Math.max(0, Math.min(this.N - p.size, r0)); c0 = Math.max(0, Math.min(this.N - 1, c0)); }
    return { r0, c0, valid: this._isValid(p.id, r0, c0, p.orientation, p.size) };
  }

  _applyDragSprite(p, r0, c0) {
    const cc = this.board.shipTransform(r0, c0, p.orientation, p.size);
    const sc = this.sprites.get(p.id);
    if (!sc) return;
    if (sc.applyOrientation) sc.applyOrientation(p.orientation);
    const S = cc.scale, sy = S * Math.sqrt(1 + cc.m * cc.m), sk = Math.atan(cc.m);
    sc.x = cc.x; sc.y = cc.y; sc.rotation = 0; sc.skew.set(sk, 0);
    sc.baseScale = S; sc.baseScaleX = S; sc.baseScaleY = sy; sc.baseSkew = sk;
    sc.scale.set(S * 1.14, sy * 1.14);
  }

  // Pointerdown anywhere on the board: if it lands on a ship's footprint, grab it.
  _onBoardDown(e) {
    if (!this.active || this.drag) return;
    const lp = e.getLocalPosition(this.board.container);
    const cell = this.board.localToCell(lp.x, lp.y);
    if (!cell) return;
    const p = this._shipAtCell(cell);
    if (!p) return; // tapped open water — nothing to grab
    this._beginDrag(p.id, cell, e);
  }

  _beginDrag(id, grabCell, e) {
    this.selected = id;
    const p = this.placements.find((x) => x.id === id);
    // dr/dc = where on the ship it was grabbed, so it tracks the finger naturally.
    // Seed candidate with the CURRENT (valid) position so a release with no
    // pointermove in between commits where the ship already is — never reverts.
    this.drag = { id, dr: grabCell.r - p.r, dc: grabCell.c - p.c, candidate: { r0: p.r, c0: p.c, valid: true } };
    this._capture(e);
    const sc = this.sprites.get(id);
    if (sc) { sc.scale.set((sc.baseScaleX || 1) * 1.14, (sc.baseScaleY || 1) * 1.14); if (sc.shadow) sc.shadow.alpha = 0.6; }
    this.audio && this.audio.uiClick();
    this._highlightSelected();
  }

  _onMove(e) {
    if (!this.drag) return;
    const p = this.placements.find((x) => x.id === this.drag.id);
    const lp = e.getLocalPosition(this.board.container);
    const cand = this._candidateFromLocal(p, lp);
    if (!cand) return;
    this.drag.candidate = cand;
    this._applyDragSprite(p, cand.r0, cand.c0);
    this.board.setAim(this._cellsFor(cand.r0, cand.c0, p.orientation, p.size), cand.valid ? 'valid' : 'invalid');
  }

  _onUp(e) {
    if (!this.drag) return;
    const p = this.placements.find((x) => x.id === this.drag.id);
    // Prefer the actual RELEASE position. This is the core fix: if pointermove
    // events were dropped (jank) the candidate would be stale/initial and the ship
    // would snap back — recomputing from the release point commits where it landed.
    let cand = this.drag.candidate;
    if (e && typeof e.getLocalPosition === 'function') {
      const lp = e.getLocalPosition(this.board.container);
      const fromUp = this._candidateFromLocal(p, lp);
      if (fromUp) cand = fromUp; // null only when released off-board → keep last candidate
    }
    this._releaseCapture();
    const sc = this.sprites.get(this.drag.id);
    if (sc) { sc.scale.set((sc.baseScaleX || 1) * 1.06, (sc.baseScaleY || 1) * 1.06); if (sc.shadow) sc.shadow.alpha = 0.4; }
    if (cand && cand.valid) {
      p.r = cand.r0; p.c = cand.c0;
      this.audio && this.audio.place();
    }
    this.drag = null;
    this._refreshAll();
  }

  _onCancel() {
    if (!this.drag) return;
    // pointercancel gives no usable position — commit the best-effort candidate
    // (last valid spot under the finger) and never leave a dangling drag.
    const p = this.placements.find((x) => x.id === this.drag.id);
    const cand = this.drag.candidate;
    this._releaseCapture();
    if (cand && cand.valid) { p.r = cand.r0; p.c = cand.c0; }
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
