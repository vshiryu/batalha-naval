// Board — a 10x10 tactical grid rendered over the ocean. One instance is the
// large ENEMY board (fog of war, where you attack); another is the small OWN
// board (your fleet + incoming fire). Handles grid glow, ships, hit/miss/sunk
// markers, persistent fire/smoke, sonar reveals, aim previews and touch input.

import { COLORS } from '../constants.js';
import { makeShip } from './ships.js';

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

    this.container = new PIXI.Container();
    this.gridGlow = new PIXI.Graphics();
    this.grid = new PIXI.Graphics();
    this.fillLayer = new PIXI.Graphics();
    this.labelLayer = new PIXI.Container();
    this.shipLayer = new PIXI.Container();
    this.markerLayer = new PIXI.Container();
    this.overlayLayer = new PIXI.Container();
    this.container.addChild(this.fillLayer, this.gridGlow, this.grid, this.labelLayer, this.shipLayer, this.markerLayer, this.overlayLayer);
    stage.boardLayer.addChild(this.container);

    this.gridBlur = new PIXI.BlurFilter(6);
    this.gridBlur.quality = 2;
    this.gridGlow.filters = [this.gridBlur];
    // Drop the grid-glow blur filter when quality is reduced.
    stage.onQualityChange((q) => { this.gridGlow.filters = q === 'reduced' ? [] : [this.gridBlur]; });

    this.ships = new Map(); // key -> ship container
    this.burning = new Set(); // "r,c" cells with fire
    this._burnTimer = 0;
    this._t = 0;
    this.onTap = null;

    this.container.eventMode = 'static';
    this.container.on('pointertap', (e) => {
      const lp = e.getLocalPosition(this.container);
      const c = this.localToCell(lp.x, lp.y);
      if (c && this.onTap) this.onTap(c, e);
    });

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
  }

  cellToLocal(r, c) { return { x: (c + 0.5) * this.cell, y: (r + 0.5) * this.cell }; }
  // Local center + rotation for a ship anchored at (r0,c0).
  shipCenter(r0, c0, orientation, size) {
    const cx = orientation === 'v' ? (c0 + 0.5) * this.cell : (c0 + size / 2) * this.cell;
    const cy = orientation === 'v' ? (r0 + size / 2) * this.cell : (r0 + 0.5) * this.cell;
    return { x: cx, y: cy, rotation: orientation === 'v' ? Math.PI / 2 : 0 };
  }
  worldCenter(r, c) { const p = this.cellToLocal(r, c); return { x: this.container.x + p.x, y: this.container.y + p.y }; }
  localToCell(x, y) {
    const c = Math.floor(x / this.cell), r = Math.floor(y / this.cell);
    if (r < 0 || c < 0 || r >= this.N || c >= this.N) return null;
    return { r, c };
  }

  _drawGrid() {
    const g = this.grid, gg = this.gridGlow, n = this.N, s = this.cell;
    g.clear(); gg.clear();
    this.fillLayer.clear();
    // faint tactical fill so the grid reads over water
    this.fillLayer.beginFill(0x0a1c30, this.side === 'enemy' ? 0.30 : 0.22);
    this.fillLayer.drawRoundedRect(-4, -4, n * s + 8, n * s + 8, 8);
    this.fillLayer.endFill();

    for (let i = 0; i <= n; i++) {
      const a = (i % 5 === 0) ? 0.55 : 0.22;
      gg.lineStyle(3, COLORS.gridTeal, a * 0.8);
      gg.moveTo(i * s, 0); gg.lineTo(i * s, n * s);
      gg.moveTo(0, i * s); gg.lineTo(n * s, i * s);
      g.lineStyle(1, COLORS.gridCyan, a);
      g.moveTo(i * s, 0); g.lineTo(i * s, n * s);
      g.moveTo(0, i * s); g.lineTo(n * s, i * s);
    }
    g.lineStyle(2, COLORS.gridTeal, 0.7);
    g.drawRoundedRect(0, 0, n * s, n * s, 4);
    g.lineStyle(0);
  }

  _drawLabels() {
    this.labelLayer.removeChildren();
    const s = this.cell, fs = Math.max(9, Math.min(16, s * 0.42));
    const style = { fontFamily: 'Rajdhani, Orbitron, system-ui, sans-serif', fontSize: fs, fill: 0x7fb8d8, fontWeight: '600' };
    for (let c = 0; c < this.N; c++) {
      const t = new PIXI.Text(LETTERS[c], style);
      t.anchor.set(0.5); t.x = (c + 0.5) * s; t.y = -this.gutter * 0.55;
      this.labelLayer.addChild(t);
    }
    for (let r = 0; r < this.N; r++) {
      const t = new PIXI.Text(String(r + 1), style);
      t.anchor.set(0.5); t.x = -this.gutter * 0.55; t.y = (r + 0.5) * s;
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
    const orient = ship.orientation;
    const r0 = ship.cells[0].r, c0 = ship.cells[0].c;
    const cx = orient === 'v' ? (c0 + 0.5) * this.cell : (c0 + ship.size / 2) * this.cell;
    const cy = orient === 'v' ? (r0 + ship.size / 2) * this.cell : (r0 + 0.5) * this.cell;
    sc.x = cx; sc.y = cy;
    sc.rotBase = orient === 'v' ? Math.PI / 2 : 0;
    sc.rotation = sc.rotBase;
    sc.baseX = cx; sc.baseY = cy; sc.bobSeed = (r0 * 7 + c0 * 13);
    return sc;
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
        o.drawRoundedRect(cellr.c * this.cell + 2, cellr.r * this.cell + 2, this.cell - 4, this.cell - 4, 4);
        o.endFill();
        if (cellr.hasShip) { o.beginFill(col, 0.9); o.drawCircle(p.x, p.y, this.cell * 0.12); o.endFill(); }
        o._sonar = true;
        this.overlayLayer.addChild(o);
      }
    }
  }

  _cellRect(r, c, inset = 0) {
    return [c * this.cell + inset, r * this.cell + inset, this.cell - inset * 2, this.cell - inset * 2];
  }

  _drawHit(r, c) {
    const g = new PIXI.Graphics();
    const p = this.cellToLocal(r, c);
    g.beginFill(COLORS.fire1, 0.5); g.drawCircle(p.x, p.y, this.cell * 0.4); g.endFill();
    g.beginFill(COLORS.ember, 0.9); g.drawCircle(p.x, p.y, this.cell * 0.18); g.endFill();
    g.lineStyle(2, COLORS.fire2, 0.9); g.drawCircle(p.x, p.y, this.cell * 0.3);
    this.markerLayer.addChild(g);
  }

  _drawMiss(r, c) {
    const g = new PIXI.Graphics();
    const p = this.cellToLocal(r, c);
    g.lineStyle(2, COLORS.splash, 0.7); g.drawCircle(p.x, p.y, this.cell * 0.26);
    g.beginFill(COLORS.gridCyan, 0.35); g.drawCircle(p.x, p.y, this.cell * 0.1); g.endFill();
    this.markerLayer.addChild(g);
  }

  _drawSunkCell(r, c) {
    const g = new PIXI.Graphics();
    g.beginFill(0x10202c, 0.55);
    const [x, y, w, h] = this._cellRect(r, c, 1.5);
    g.drawRoundedRect(x, y, w, h, 3);
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
      const [x, y, w, h] = this._cellRect(c.r, c.c, 2);
      g.drawRoundedRect(x, y, w, h, 4);
      g.endFill();
    }
    this.overlayLayer.addChild(g);
  }

  // crosshair marker on the primary aim cell
  setCrosshair(cell, kind = 'target') {
    const g = new PIXI.Graphics();
    g._aim = true;
    const col = kind === 'repair' ? COLORS.gridTeal : COLORS.player;
    const p = this.cellToLocal(cell.r, cell.c);
    const s = this.cell * 0.4;
    g.lineStyle(2, col, 1);
    g.drawCircle(p.x, p.y, s * 0.7);
    g.moveTo(p.x - s, p.y); g.lineTo(p.x - s * 0.3, p.y);
    g.moveTo(p.x + s * 0.3, p.y); g.lineTo(p.x + s, p.y);
    g.moveTo(p.x, p.y - s); g.lineTo(p.x, p.y - s * 0.3);
    g.moveTo(p.x, p.y + s * 0.3); g.lineTo(p.x, p.y + s);
    this.overlayLayer.addChild(g);
  }

  // ---------------------------------------------------------------- update
  update(dt, time) {
    this._t = time;
    // idle bob + subtle roll for ships
    for (const [, sc] of this.ships) {
      if (sc.baseX == null) continue;
      const ph = (time / 900) + (sc.bobSeed || 0);
      sc.x = sc.baseX + Math.sin(ph) * this.cell * 0.03;
      sc.y = sc.baseY + Math.cos(ph * 0.8) * this.cell * 0.03;
      sc.rotation = (sc.rotBase || 0) + Math.sin(ph * 0.7) * 0.02;
    }
    // persistent fire/smoke on burning cells
    if (this.burning.size && this.effects) {
      this._burnTimer += dt;
      const interval = 110;
      if (this._burnTimer >= interval) {
        this._burnTimer = 0;
        let budget = this.stage.quality === 'reduced' ? 2 : 4;
        for (const key of this.burning) {
          if (budget-- <= 0) break;
          const [r, c] = key.split(',').map(Number);
          const w = this.worldCenter(r, c);
          this.effects.ember(w.x, w.y);
          if (Math.random() < 0.5) this.effects.smokePuff(w.x, w.y - this.cell * 0.1, 0.7);
        }
      }
    }
  }

  setInteractive(on) { this.container.eventMode = on ? 'static' : 'none'; this.container.cursor = on ? 'pointer' : 'default'; }

  destroy() {
    this.stage.boardLayer.removeChild(this.container);
    this.container.destroy({ children: true });
  }
}
