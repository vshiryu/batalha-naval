// Board — a 10x10 tactical grid rendered over the ocean. One instance is the
// large ENEMY board (fog of war, where you attack); another is the small OWN
// board (your fleet + incoming fire). Handles grid glow, ships, hit/miss/sunk
// markers, persistent fire/smoke, sonar reveals, aim previews and touch input.

import { COLORS } from '../constants.js';
import { makeShip } from './ships.js';
import { buildTextures } from './textures.js';

const PIXI = window.PIXI;
const LETTERS = 'ABCDEFGHIJ';

export class Board {
  constructor(stage, effects, { side = 'enemy', boardSize = 10 } = {}) {
    this.stage = stage;
    this.effects = effects;
    this.side = side;
    this.N = boardSize;
    this.cell = 30;
    this.gutter = 16;
    this.persp = 0.82; // subtle board tilt (this looked right). 1 = flat top-down.
    this.depth = 1.0; // no vertical compression — keep the board near its top-down height.
    this.foreshorten = 1.0; // no squash; ship 3D volume is baked into the oblique sprite.

    this.container = new PIXI.Container();
    this.gridGlow = new PIXI.Graphics();
    this.grid = new PIXI.Graphics();
    this.fillLayer = new PIXI.Graphics();
    this.radarLayer = new PIXI.Container();
    this.radarMask = new PIXI.Graphics();
    this.labelLayer = new PIXI.Container();
    this.shipLayer = new PIXI.Container();
    this.markerLayer = new PIXI.Container();
    this.overlayLayer = new PIXI.Container();
    this.container.addChild(this.fillLayer, this.gridGlow, this.grid, this.radarLayer, this.radarMask, this.labelLayer, this.shipLayer, this.markerLayer, this.overlayLayer);
    stage.boardLayer.addChild(this.container);

    // Rotating radar sweep on the ENEMY board (command-room feel).
    if (side === 'enemy') {
      const tex = buildTextures();
      this.radar = new PIXI.Sprite(tex.radar);
      this.radar.anchor.set(0.5);
      this.radar.blendMode = PIXI.BLEND_MODES.ADD;
      this.radar.alpha = 0.5;
      this.radarLayer.addChild(this.radar);
      this.radarLayer.mask = this.radarMask;
    }

    this.gridBlur = new PIXI.BlurFilter(6);
    this.gridBlur.quality = 2;
    this.gridGlow.filters = [this.gridBlur];
    // Drop the grid-glow blur filter when quality is reduced.
    stage.onQualityChange((q) => { this.gridGlow.filters = q === 'reduced' ? [] : [this.gridBlur]; });

    this.ships = new Map(); // key -> ship container
    this.burning = new Set(); // "r,c" cells with fire
    this._burnTimer = 0;
    this._foamTimer = 0;
    this._t = 0;
    this.onTap = null;

    // Robust tap handling. PixiJS's `pointertap` needs a clean down+up on the same
    // target with no `pointercancel` in between — under frame jank or an iOS
    // pointer-cancel it simply never fires ("clicking like crazy" to register one
    // shot). Instead we track pointerdown locally and treat a low-movement release
    // as a tap, deriving the cell from the RELEASE position. An explicit hitArea
    // (set in _drawGrid) makes the whole board trapezoid reliably interactive.
    this.container.eventMode = 'static';
    // Treat the board as a SINGLE tap surface: only the container's hitArea is a
    // pointer target, never its children. Otherwise a grid line, a hit/miss marker,
    // an aim overlay or a ship sprite sitting on top of a cell would swallow the tap
    // — a hit marker over a damaged cell made Repair impossible, for instance. The
    // PlacementController flips this back on while dragging ships into position.
    this.container.interactiveChildren = false;
    this._downPt = null;
    this.container.on('pointerdown', (e) => {
      const lp = e.getLocalPosition(this.container);
      this._downPt = { x: lp.x, y: lp.y };
    });
    const tryTap = (e) => {
      if (!this._downPt) return;
      const lp = e.getLocalPosition(this.container);
      const moved = Math.hypot(lp.x - this._downPt.x, lp.y - this._downPt.y);
      this._downPt = null;
      // A phone tap is rarely pixel-perfect; tolerate up to ~1.2 cells of travel.
      if (moved > this.cell * 1.2) return;
      const c = this.localToCell(lp.x, lp.y);
      if (c && this.onTap) this.onTap(c, e);
    };
    this.container.on('pointerup', tryTap);
    this.container.on('pointerupoutside', tryTap);
    // PixiJS doesn't surface pointercancel, which real mobile browsers can fire on a
    // legit tap — that tap would be lost. Treat a cancel as a tap at the press cell.
    this._onPointerCancel = () => {
      if (!this._downPt) return;
      const lp = this._downPt; this._downPt = null;
      const c = this.localToCell(lp.x, lp.y);
      if (c && this.onTap) this.onTap(c);
    };
    const view = stage.app.view;
    if (view && view.addEventListener) view.addEventListener('pointercancel', this._onPointerCancel);

    stage.addUpdater((dt, time) => this.update(dt, time));
  }

  get gridPx() { return this.cell * this.N; }

  // Position the board so its grid occupies (x,y) with the given grid pixel size.
  setLayout(x, y, gridPx) {
    this.cell = gridPx / this.N;
    this.gutter = Math.max(12, this.cell * 0.52);
    this.container.x = x;
    this.container.y = y;
    this._drawGrid();
    this._drawLabels();
    this._layoutRadar();
  }

  _layoutRadar() {
    if (this.side !== 'enemy') return;
    // mask = the board trapezoid; radar centered on the board centroid
    const TL = this._project(0, 0), TR = this._project(1, 0), BR = this._project(1, 1), BL = this._project(0, 1);
    this.radarMask.clear();
    this.radarMask.beginFill(0xffffff, 1);
    this.radarMask.moveTo(TL.x, TL.y); this.radarMask.lineTo(TR.x, TR.y);
    this.radarMask.lineTo(BR.x, BR.y); this.radarMask.lineTo(BL.x, BL.y);
    this.radarMask.closePath(); this.radarMask.endFill();
    const cen = this._project(0.5, 0.5);
    this.radar.x = cen.x; this.radar.y = cen.y;
    this.radar.width = this.radar.height = this.gridPx * 1.5;
  }

  // --- subtle perspective projection (ocean stays flat; taps stay precise) ---
  _rowScale(v) { const s = this.persp; return s + (1 - s) * v; }
  // normalized board (u,v) in [0,1]^2 -> local px { x, y, scale }
  _project(u, v) {
    const s = this.persp, g = this.gridPx, hf = this.depth;
    const rs = s + (1 - s) * v;
    const yFrac = (s * v + (1 - s) * v * v / 2) / ((1 + s) / 2);
    const offY = g * (1 - hf) / 2; // keep the board vertically centred in its square
    return { x: g / 2 + (u - 0.5) * g * rs, y: offY + g * hf * yFrac, scale: rs };
  }
  // inverse of _project (local px -> normalized u,v)
  _unproject(x, y) {
    const s = this.persp, g = this.gridPx, hf = this.depth;
    const offY = g * (1 - hf) / 2;
    const Y = ((y - offY) / (g * hf)) * ((1 + s) / 2);
    const a = (1 - s) / 2;
    const v = a < 1e-6 ? Y / s : (-s + Math.sqrt(s * s + 4 * a * Y)) / (2 * a);
    const rs = s + (1 - s) * v;
    return { u: (x - g / 2) / (g * rs) + 0.5, v };
  }

  cellToLocal(r, c) { return this._project((c + 0.5) / this.N, (r + 0.5) / this.N); }
  cellScale(r) { return this._rowScale((r + 0.5) / this.N); }
  // 4 projected corners of a cell (for quad markers / overlays)
  _cellCorners(r, c, insetPx = 0) {
    const N = this.N, e = insetPx / this.gridPx;
    const u0 = c / N + e, u1 = (c + 1) / N - e, v0 = r / N + e, v1 = (r + 1) / N - e;
    return [this._project(u0, v0), this._project(u1, v0), this._project(u1, v1), this._project(u0, v1)];
  }

  // Center, rotation and perspective scale for a ship anchored at (r0,c0).
  shipCenter(r0, c0, orientation, size) {
    const u = orientation === 'v' ? (c0 + 0.5) / this.N : (c0 + size / 2) / this.N;
    const v = orientation === 'v' ? (r0 + size / 2) / this.N : (r0 + 0.5) / this.N;
    const p = this._project(u, v);
    return { x: p.x, y: p.y, rotation: orientation === 'v' ? Math.PI / 2 : 0, scale: p.scale };
  }
  worldCenter(r, c) { const p = this.cellToLocal(r, c); return { x: this.container.x + p.x, y: this.container.y + p.y }; }
  localToCell(x, y) {
    const { u, v } = this._unproject(x, y);
    const c = Math.floor(u * this.N), r = Math.floor(v * this.N);
    if (r < 0 || c < 0 || r >= this.N || c >= this.N) return null;
    return { r, c };
  }

  _drawGrid() {
    const g = this.grid, gg = this.gridGlow, n = this.N;
    g.clear(); gg.clear(); this.fillLayer.clear();
    const TL = this._project(0, 0), TR = this._project(1, 0), BR = this._project(1, 1), BL = this._project(0, 1);
    // Explicit, cheap hit-test region = the board trapezoid (independent of how the
    // fill graphics are drawn), so every tap over the board reliably reaches onTap.
    this.container.hitArea = new PIXI.Polygon([TL.x, TL.y, TR.x, TR.y, BR.x, BR.y, BL.x, BL.y]);
    // faint tactical fill (trapezoid) so the grid reads over the water
    this.fillLayer.beginFill(0x0a1c30, this.side === 'enemy' ? 0.32 : 0.24);
    this.fillLayer.moveTo(TL.x, TL.y); this.fillLayer.lineTo(TR.x, TR.y);
    this.fillLayer.lineTo(BR.x, BR.y); this.fillLayer.lineTo(BL.x, BL.y);
    this.fillLayer.closePath(); this.fillLayer.endFill();

    for (let i = 0; i <= n; i++) {
      const a = (i % 5 === 0) ? 0.55 : 0.22;
      const hl = this._project(0, i / n), hr = this._project(1, i / n); // horizontal
      const vt = this._project(i / n, 0), vb = this._project(i / n, 1); // converging vertical
      gg.lineStyle(3, COLORS.gridTeal, a * 0.8);
      gg.moveTo(hl.x, hl.y); gg.lineTo(hr.x, hr.y);
      gg.moveTo(vt.x, vt.y); gg.lineTo(vb.x, vb.y);
      g.lineStyle(1, COLORS.gridCyan, a);
      g.moveTo(hl.x, hl.y); g.lineTo(hr.x, hr.y);
      g.moveTo(vt.x, vt.y); g.lineTo(vb.x, vb.y);
    }
    g.lineStyle(2, COLORS.gridTeal, 0.7);
    g.moveTo(TL.x, TL.y); g.lineTo(TR.x, TR.y); g.lineTo(BR.x, BR.y); g.lineTo(BL.x, BL.y); g.closePath();
    g.lineStyle(0);
  }

  _drawLabels() {
    this.labelLayer.removeChildren();
    const fs = Math.max(9, Math.min(16, this.cell * 0.42));
    const style = { fontFamily: 'Rajdhani, Orbitron, system-ui, sans-serif', fontSize: fs, fill: 0x7fb8d8, fontWeight: '600' };
    for (let c = 0; c < this.N; c++) {
      const p = this._project((c + 0.5) / this.N, 0);
      const t = new PIXI.Text(LETTERS[c], style);
      t.anchor.set(0.5); t.x = p.x; t.y = p.y - this.gutter * 0.5; t.scale.set(p.scale);
      this.labelLayer.addChild(t);
    }
    for (let r = 0; r < this.N; r++) {
      const p = this._project(0, (r + 0.5) / this.N);
      const t = new PIXI.Text(String(r + 1), style);
      t.anchor.set(0.5); t.x = p.x - this.gutter * 0.5 * p.scale; t.y = p.y; t.scale.set(p.scale);
      this.labelLayer.addChild(t);
    }
  }

  // ---------------------------------------------------------------- ships
  _shipKey(ship) { return ship.id; }

  placeShipContainer(ship) {
    const key = this._shipKey(ship);
    let sc = this.ships.get(key);
    if (!sc) {
      sc = makeShip(ship.id, ship.size, this.cell, { sunk: ship.sunk });
      this.ships.set(key, sc);
      this.shipLayer.addChild(sc);
    }
    this.applyShipTransform(sc, ship.cells[0].r, ship.cells[0].c, ship.orientation, ship.size);
    return sc;
  }

  // Ship transform: projected footprint CENTER + a uniform scale that converts the
  // ship's cell-unit sprite to screen px with the board's perspective narrowing.
  // The 3D orientation is baked into the orientation-specific texture (chosen via
  // sc.applyOrientation), so the container is NOT rotated.
  shipTransform(r0, c0, orientation, size) {
    const u = orientation === 'v' ? (c0 + 0.5) / this.N : (c0 + size / 2) / this.N;
    const v = orientation === 'v' ? (r0 + size / 2) / this.N : (r0 + 0.5) / this.N;
    const p = this._project(u, v);
    // shear slope = the screen tilt of this column's grid line (dx/dy), so the ship
    // leans to follow the converging columns near the edges. Measured from the SAME
    // board projection the grid uses, so it matches exactly.
    const e = 0.0015;
    const pA = this._project(u, Math.max(0, v - e)), pB = this._project(u, Math.min(1, v + e));
    const dy = pB.y - pA.y;
    const m = Math.abs(dy) > 1e-6 ? (pB.x - pA.x) / dy : 0;
    return { x: p.x, y: p.y, scale: this.cell * p.scale, m };
  }

  // Position/scale/shear a ship container for a cell anchor (shared with placement).
  // The shear (skew.x) aligns the ship's long axis with the board's perspective; the
  // baked texture keeps the screen-fixed light/shadow.
  applyShipTransform(sc, r0, c0, orientation, size) {
    const t = this.shipTransform(r0, c0, orientation, size);
    if (sc.applyOrientation) sc.applyOrientation(orientation);
    const S = t.scale, sy = S * Math.sqrt(1 + t.m * t.m), sk = Math.atan(t.m);
    sc.x = t.x; sc.y = t.y;
    sc.rotation = 0; sc.skew.set(sk, 0);
    sc.scale.set(S, sy);
    sc.baseX = t.x; sc.baseY = t.y;
    sc.baseScale = S; sc.baseScaleX = S; sc.baseScaleY = sy; sc.baseSkew = sk;
    sc.bobSeed = r0 * 7 + c0 * 13;
  }

  setOwnFleet(fleet) {
    // Rebuild only when the set of ship ids changes.
    const ids = new Set(fleet.map((s) => s.id));
    for (const [k, sc] of this.ships) {
      if (!ids.has(k)) { this.shipLayer.removeChild(sc); this.ships.delete(k); }
    }
    for (const ship of fleet) this.placeShipContainer(ship);
  }

  clearShips() {
    for (const [, sc] of this.ships) this.shipLayer.removeChild(sc);
    this.ships.clear();
  }

  // Wipe all transient combat marks (hit/miss/sunk, sonar/aim overlays, burning
  // cells, lock-on reticle). Used on rematch so last match's marks don't linger.
  clearMarkers() {
    this.markerLayer.removeChildren();
    this.overlayLayer.removeChildren();
    this.burning.clear();
    this._reticleGfx = null;
    this._burnTimer = 0;
  }

  // --------------------------------------------------------------- rendering
  render(state, opts = {}) {
    this._suppress = opts.suppress || null;
    if (this.side === 'own') this._renderOwn(state);
    else this._renderEnemy(state);
    this._suppress = null;
  }

  _isSuppressed(r, c) { return this._suppress && this._suppress.has(`${r},${c}`); }

  // Draw a single shot result immediately (used as a projectile lands).
  revealShot(r, c, result) {
    if (result === 'hit') { this._drawHit(r, c); this.burning.add(`${r},${c}`); }
    else if (result === 'miss') this._drawMiss(r, c);
    else if (result === 'sunk') this._drawSunkCell(r, c);
  }

  _renderOwn(state) {
    this.setOwnFleet(state.you.fleet);
    this.markerLayer.removeChildren();
    this.burning.clear();
    const inc = state.you.incoming;
    for (let r = 0; r < this.N; r++) {
      for (let c = 0; c < this.N; c++) {
        if (this._isSuppressed(r, c)) continue;
        const v = inc[r * this.N + c];
        if (v === 'hit') { this._drawHit(r, c); this.burning.add(`${r},${c}`); }
        else if (v === 'miss') this._drawMiss(r, c);
      }
    }
    // dim sunk ships
    for (const ship of state.you.fleet) {
      const sc = this.ships.get(ship.id);
      if (sc) sc.alpha = ship.sunk ? 0.55 : 1;
    }
  }

  _renderEnemy(state) {
    this.markerLayer.removeChildren();
    this.overlayLayer.removeChildren();
    this.burning.clear();
    const view = state.enemy.view;
    for (let r = 0; r < this.N; r++) {
      for (let c = 0; c < this.N; c++) {
        if (this._isSuppressed(r, c)) continue;
        const v = view[r * this.N + c];
        if (v === 'hit') { this._drawHit(r, c); this.burning.add(`${r},${c}`); }
        else if (v === 'miss') this._drawMiss(r, c);
        else if (v === 'sunk') this._drawSunkCell(r, c);
      }
    }
    // reveal wrecks for sunk enemy ships
    const sunkIds = new Set((state.enemy.sunkShips || []).map((s) => s.id));
    for (const [k, sc] of this.ships) { if (!sunkIds.has(k)) { this.shipLayer.removeChild(sc); this.ships.delete(k); } }
    for (const s of state.enemy.sunkShips || []) {
      const cells = s.cells;
      const horizontal = cells.length > 1 ? cells[0].r === cells[1].r : true;
      const ship = { id: s.id, size: s.size, orientation: horizontal ? 'h' : 'v', cells, sunk: true };
      const sc = this.ships.get(s.id);
      if (!sc) { const nc = makeShip(s.id, s.size, this.cell, { sunk: true }); this.ships.set(s.id, nc); this.shipLayer.addChild(nc); }
      this.placeShipContainer(ship);
      this.ships.get(s.id).alpha = 0.85;
    }
    // sonar reveals (temporary)
    for (const rev of state.you.sonar || []) {
      for (const cellr of rev.cells) {
        const o = new PIXI.Graphics();
        const p = this.cellToLocal(cellr.r, cellr.c);
        const col = cellr.hasShip ? COLORS.enemy : COLORS.gridCyan;
        o.lineStyle(2, col, 0.9);
        o.beginFill(col, cellr.hasShip ? 0.22 : 0.06);
        this._poly(o, this._cellCorners(cellr.r, cellr.c, 2));
        o.endFill();
        if (cellr.hasShip) { o.beginFill(col, 0.9); o.drawCircle(p.x, p.y, this.cell * p.scale * 0.12); o.endFill(); }
        o._sonar = true;
        this.overlayLayer.addChild(o);
      }
    }
  }

  _poly(g, corners) {
    g.moveTo(corners[0].x, corners[0].y);
    for (let i = 1; i < corners.length; i++) g.lineTo(corners[i].x, corners[i].y);
    g.closePath();
  }

  _drawHit(r, c) {
    const g = new PIXI.Graphics();
    const p = this.cellToLocal(r, c);
    const rad = this.cell * p.scale;
    g.beginFill(COLORS.fire1, 0.5); g.drawCircle(p.x, p.y, rad * 0.4); g.endFill();
    g.beginFill(COLORS.ember, 0.9); g.drawCircle(p.x, p.y, rad * 0.18); g.endFill();
    g.lineStyle(2, COLORS.fire2, 0.9); g.drawCircle(p.x, p.y, rad * 0.3);
    this.markerLayer.addChild(g);
  }

  _drawMiss(r, c) {
    const g = new PIXI.Graphics();
    const p = this.cellToLocal(r, c);
    const rad = this.cell * p.scale;
    g.lineStyle(2, COLORS.splash, 0.7); g.drawCircle(p.x, p.y, rad * 0.26);
    g.beginFill(COLORS.gridCyan, 0.35); g.drawCircle(p.x, p.y, rad * 0.1); g.endFill();
    this.markerLayer.addChild(g);
  }

  _drawSunkCell(r, c) {
    const g = new PIXI.Graphics();
    g.beginFill(0x10202c, 0.55);
    this._poly(g, this._cellCorners(r, c, 1.5));
    g.endFill();
    this.markerLayer.addChild(g);
  }

  // ---------------------------------------------------------------- aim
  clearAim() { for (let i = this.overlayLayer.children.length - 1; i >= 0; i--) { const ch = this.overlayLayer.children[i]; if (!ch._sonar) this.overlayLayer.removeChild(ch); } }

  setAim(cells, kind = 'target') {
    this.clearAim();
    if (!cells || !cells.length) return;
    const colorByKind = { target: COLORS.player, area: COLORS.enemy, line: COLORS.energyB, multi: COLORS.player, repair: COLORS.gridTeal, invalid: COLORS.enemyHot, valid: COLORS.player };
    const col = colorByKind[kind] || COLORS.player;
    const g = new PIXI.Graphics();
    g._aim = true;
    for (const c of cells) {
      g.lineStyle(2.5, col, 0.95);
      g.beginFill(col, 0.18);
      this._poly(g, this._cellCorners(c.r, c.c, 2));
      g.endFill();
    }
    this.overlayLayer.addChild(g);
  }

  // animated lock-on reticle on the primary aim cell
  setCrosshair(cell, kind = 'target') {
    const g = new PIXI.Graphics();
    g._aim = true;
    g._reticle = { cell, kind, t: 0, col: kind === 'repair' ? COLORS.gridTeal : COLORS.player };
    this.overlayLayer.addChild(g);
    this._reticleGfx = g;
    this._drawReticle(g, 0);
  }

  _drawReticle(g, lockT) {
    const r = g._reticle; if (!r) return;
    const p = this.cellToLocal(r.cell.r, r.cell.c);
    const s = this.cell * p.scale * 0.5;
    // brackets ease in from larger to snug ("lock on")
    const spread = s * (1 + (1 - lockT) * 0.9);
    const len = s * 0.45;
    const pulse = 0.7 + Math.sin(this._t / 180) * 0.3;
    g.clear();
    g.lineStyle(2.4, r.col, pulse);
    const corners = [[-1, -1], [1, -1], [1, 1], [-1, 1]];
    for (const [sx, sy] of corners) {
      const cx = p.x + sx * spread, cy = p.y + sy * spread;
      g.moveTo(cx, cy); g.lineTo(cx - sx * len, cy);
      g.moveTo(cx, cy); g.lineTo(cx, cy - sy * len);
    }
    g.lineStyle(1.5, r.col, pulse * 0.8);
    g.drawCircle(p.x, p.y, s * 0.34 * (0.6 + lockT * 0.4));
    g.moveTo(p.x - s * 0.18, p.y); g.lineTo(p.x + s * 0.18, p.y);
    g.moveTo(p.x, p.y - s * 0.18); g.lineTo(p.x, p.y + s * 0.18);
  }

  // ---------------------------------------------------------------- update
  update(dt, time) {
    this._t = time;
    // rotating radar sweep (enemy board), paused when quality is reduced
    if (this.radar) {
      this.radar.visible = this.stage.quality !== 'reduced';
      if (this.radar.visible) this.radar.rotation += dt * 0.0009;
    }
    // animated lock-on reticle
    if (this._reticleGfx && this._reticleGfx.parent && this._reticleGfx._reticle) {
      const ret = this._reticleGfx._reticle;
      ret.t = Math.min(1, ret.t + dt / 180);
      this._drawReticle(this._reticleGfx, ret.t);
    }
    // idle bob + subtle roll + foam for ships
    for (const [, sc] of this.ships) {
      if (sc.baseX == null) continue;
      const ph = (time / 900) + (sc.bobSeed || 0);
      // position-only bob: the perspective shear lives in skew/scale and must not be overwritten
      sc.x = sc.baseX + Math.sin(ph) * this.cell * 0.03;
      sc.y = sc.baseY + Math.cos(ph * 0.8) * this.cell * 0.03;
      if (sc.foam) sc.foam.alpha = Math.max(0, 0.12 + Math.sin(ph * 1.3) * 0.1);
    }
    // persistent fire/smoke/heat-haze on burning cells
    const reduced = this.stage.quality === 'reduced';
    if (this.burning.size && this.effects) {
      this._burnTimer += dt;
      const interval = reduced ? 150 : 95;
      if (this._burnTimer >= interval) {
        this._burnTimer = 0;
        let budget = reduced ? 2 : 4;
        for (const key of this.burning) {
          if (budget-- <= 0) break;
          const [r, c] = key.split(',').map(Number);
          const w = this.worldCenter(r, c);
          const sc = this.cellScale(r);
          this.effects.ember(w.x, w.y);
          this.effects.smokePuff(w.x, w.y - this.cell * 0.12 * sc, 0.7 * sc);
          if (!reduced) this.effects.heatHaze(w.x, w.y - this.cell * 0.2 * sc, sc);
        }
      }
    }
    // foam wake around idle ships (own/wreck boards), low rate
    if (!reduced && this.effects && this.ships.size) {
      this._foamTimer += dt;
      if (this._foamTimer >= 520) {
        this._foamTimer = 0;
        const arr = [...this.ships.values()];
        const sc = arr[Math.floor(Math.random() * arr.length)];
        if (sc && sc.baseX != null) {
          const ox = (Math.random() - 0.5) * sc.shipL * 0.7;
          this.effects.foam(this.container.x + sc.baseX + ox, this.container.y + sc.baseY + sc.shipH * 0.2, (sc.baseScale || 1));
        }
      }
    }
  }

  setInteractive(on) { this.container.eventMode = on ? 'static' : 'none'; this.container.cursor = on ? 'pointer' : 'default'; }

  destroy() {
    const view = this.stage.app.view;
    if (view && view.removeEventListener && this._onPointerCancel) view.removeEventListener('pointercancel', this._onPointerCancel);
    this.stage.boardLayer.removeChild(this.container);
    this.container.destroy({ children: true });
  }
}
