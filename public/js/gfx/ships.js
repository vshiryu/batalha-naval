// Procedural warships in 2.5D, baked to a cached PIXI texture PER ORIENTATION.
//
// THE FIX: depth is FIXED IN SCREEN SPACE, not baked-then-rotated. Every ship is
// drawn in ship-local coords (t = along length, b = across beam, z = height) and
// projected so height (z) always goes UP on screen, the hull side wall always
// extrudes DOWN (toward the near/camera edge), the shadows always fall DOWN, and
// the light always comes from the TOP. Only the silhouette + deck details follow
// the orientation (we choose which screen axis the length maps to). So a vertical
// ship reads with the SAME depth and lighting as a horizontal one — a genuinely
// different drawing, never a rotated bitmap.
//
// The texture has a generous MARGIN on all sides so the extrusion + soft shadows
// never clip, and the sprite is anchored at the hull footprint CENTER so the
// board places it without rotation while it overflows the cells visually
// (footprint/collision/damage stay cell-aligned).
//
// Interface preserved: makeShip(type,size,cellSize,opts) -> Container with
// { hull, foam, shipL, shipH, applyOrientation(orientation) }.

import { buildTextures } from './textures.js';

const PIXI = window.PIXI;
const UNIT = 96;
const FY_H = 0.62; // horizontal: beam (near-far) foreshorten -> oblique deck
const FY_V = 0.86; // vertical: length foreshorten -> mild, spans its cells
const ZS = 0.6;    // height -> screen-up

function cv(w, h) { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; }
function fillP(ctx, pts, fill) {
  ctx.beginPath(); ctx.moveTo(pts[0].x, pts[0].y);
  for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
  ctx.closePath(); ctx.fillStyle = fill; ctx.fill();
}
function strokeP(ctx, pts, style, w, close) {
  ctx.beginPath(); ctx.moveTo(pts[0].x, pts[0].y);
  for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
  if (close) ctx.closePath();
  ctx.strokeStyle = style; ctx.lineWidth = w; ctx.stroke();
}
function ell(ctx, x, y, rx, ry, fill) { ctx.beginPath(); ctx.ellipse(x, y, rx, ry, 0, 0, Math.PI * 2); ctx.fillStyle = fill; ctx.fill(); }

function makeProj(orientation) {
  if (orientation === 'v') return { pp: (t, b, z) => ({ x: b, y: -t * FY_V - z * ZS }), cfy: FY_V };
  return { pp: (t, b, z) => ({ x: t, y: -b * FY_H - z * ZS }), cfy: FY_H };
}

function halfBeam(type, t, L, Bh) {
  const f = t / (L / 2);
  if (type === 'submarine') return Bh * Math.sqrt(Math.max(0, 1 - f * f * 0.9));
  const bowStart = 0.42;
  if (f <= bowStart) return Bh;
  const k = (f - bowStart) / (1 - bowStart);
  return Bh * Math.cos(k * Math.PI / 2);
}
function nearEdge(pp, type, L, Bh, z) {
  const N = 24, pts = [];
  for (let i = 0; i <= N; i++) { const t = -L / 2 + (i / N) * L; pts.push(pp(t, -halfBeam(type, t, L, Bh), z)); }
  return pts;
}
function farEdge(pp, type, L, Bh, z) {
  const N = 24, pts = [];
  for (let i = 0; i <= N; i++) { const t = -L / 2 + (i / N) * L; pts.push(pp(t, halfBeam(type, t, L, Bh), z)); }
  return pts;
}

// ---- shaded solids -------------------------------------------------------
const P_BOX = { topHi: '#cdd9e8', topLo: '#8497ab', wallHi: '#5a6a7c', wallLo: '#222d37' };
const P_BARREL = { topHi: '#6a7886', topLo: '#465260', wallHi: '#2b343d', wallLo: '#10171d' };
const P_SAIL = { topHi: '#9fb0c2', topLo: '#65737f', wallHi: '#46545f', wallLo: '#1a232b' };
const P_DECKSLAB = { topHi: '#4a586a', topLo: '#34414f', wallHi: '#2f3c4a', wallLo: '#1a232c' };
const P_FUNNEL = { topHi: '#d6e2ee', topLo: '#9fb0c2', sideHi: '#8fa1b4', sideMid: '#5c6a78', sideLo: '#333d47' };
const P_TURRET = { topHi: '#dbe6f1', topLo: '#aebccb', sideHi: '#97a8ba', sideMid: '#64727f', sideLo: '#39444f' };

function boxSolid(pp, ctx, t0, t1, b0, b1, zb, h, pal) {
  const corners = [[t0, b0], [t1, b0], [t1, b1], [t0, b1]];
  const T = corners.map(([t, b]) => pp(t, b, zb + h));
  const B = corners.map(([t, b]) => pp(t, b, zb));
  const walls = [];
  for (let i = 0; i < 4; i++) { const j = (i + 1) % 4; walls.push({ pts: [T[i], T[j], B[j], B[i]], depth: (B[i].y + B[j].y) / 2 }); }
  walls.sort((a, b) => a.depth - b.depth);
  for (const w of walls) {
    const ys = w.pts.map((p) => p.y), yt = Math.min(...ys), yb = Math.max(...ys);
    const g = ctx.createLinearGradient(0, yt, 0, yb); g.addColorStop(0, pal.wallHi); g.addColorStop(1, pal.wallLo);
    fillP(ctx, w.pts, g);
  }
  const ga = pp((t0 + t1) / 2, b0, zb + h), gb = pp((t0 + t1) / 2, b1, zb + h);
  const tg = ctx.createLinearGradient(ga.x, ga.y, gb.x, gb.y); tg.addColorStop(0, pal.topLo); tg.addColorStop(1, pal.topHi);
  fillP(ctx, T, tg);
  strokeP(ctx, T, 'rgba(216,232,246,0.45)', 1.2, true);
}

function cylSolid(pp, ctx, t, b, r, zb, h, cfy, pal) {
  const ry = r * cfy;
  const tp = pp(t, b, zb + h), bp = pp(t, b, zb);
  const g = ctx.createLinearGradient(tp.x - r, 0, tp.x + r, 0);
  g.addColorStop(0, pal.sideHi); g.addColorStop(0.5, pal.sideMid); g.addColorStop(1, pal.sideLo);
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.moveTo(tp.x - r, tp.y); ctx.lineTo(bp.x - r, bp.y);
  ctx.ellipse(bp.x, bp.y, r, ry, 0, Math.PI, 0, true);
  ctx.lineTo(tp.x + r, tp.y);
  ctx.ellipse(tp.x, tp.y, r, ry, 0, 0, Math.PI, true);
  ctx.closePath(); ctx.fill();
  ell(ctx, tp.x, tp.y, r, ry, pal.topLo);
  const rg = ctx.createRadialGradient(tp.x - r * 0.35, tp.y - ry * 0.4, 0, tp.x, tp.y, r);
  rg.addColorStop(0, pal.topHi); rg.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = rg; ctx.beginPath(); ctx.ellipse(tp.x, tp.y, r, ry, 0, 0, Math.PI * 2); ctx.fill();
}

function turret(pp, ctx, t, b, r, cfy, barrels, dir) {
  cylSolid(pp, ctx, t, b, r, 0, r * 0.5, cfy, P_TURRET);
  const bl = r * 1.7, bw = r * 0.2, gap = r * 0.42, zc = r * 0.46;
  const t0 = dir > 0 ? t + r * 0.15 : t - r * 0.15 - bl;
  for (let i = 0; i < barrels; i++) {
    const bb = b - ((barrels - 1) * gap) / 2 + i * gap;
    boxSolid(pp, ctx, t0, t0 + bl, bb - bw / 2, bb + bw / 2, zc, bw, P_BARREL);
    const m = pp(t0 + bl, bb, zc + bw); ell(ctx, m.x, m.y, bw * 0.5, bw * 0.5 * cfy, '#0c1116');
  }
}

function funnelCap(pp, ctx, t, b, r, ztop, cfy) { const p = pp(t, b, ztop); ell(ctx, p.x, p.y, r * 0.72, r * 0.72 * cfy, '#171e25'); }

// ---- the ship ------------------------------------------------------------
function renderShipCanvas(type, size, opts) {
  const sunk = !!opts.sunk;
  const accent = opts.accent || (sunk ? '#f59e0b' : '#2dd4bf');
  const orientation = opts.orientation === 'v' ? 'v' : 'h';
  const sub = type === 'submarine';
  const { pp, cfy } = makeProj(orientation);
  const L = size * UNIT;
  const Bh = UNIT * ({ carrier: 0.36, battleship: 0.37, cruiser: 0.29, submarine: 0.26, destroyer: 0.25 }[type] || 0.3);
  const zDeck = UNIT * (sub ? 0.1 : type === 'carrier' ? 0.16 : 0.18);
  const maxZ = UNIT * 0.95; // tallest structure headroom (for bounds)

  // --- bounds (so nothing clips) ---
  const pts = [];
  nearEdge(pp, type, L, Bh, 0).forEach((p) => pts.push(p));
  nearEdge(pp, type, L, Bh, zDeck).forEach((p) => pts.push(p));
  farEdge(pp, type, L, Bh, 0).forEach((p) => pts.push(p));
  farEdge(pp, type, L, Bh, zDeck).forEach((p) => pts.push(p));
  for (const tt of [-L / 2, L / 2]) for (const bb of [-Bh, Bh]) pts.push(pp(tt, bb, maxZ));
  // hull contact-shadow extent (offset down + right)
  const sCx = 0, sCy = (Bh * cfy) + UNIT * 0.12, sRx = L * 0.55, sRy = Bh * cfy * 1.7 + UNIT * 0.12;
  pts.push({ x: -sRx, y: sCy + sRy }, { x: sRx, y: sCy + sRy });
  let minX = 1e9, minY = 1e9, maxX = -1e9, maxY = -1e9;
  for (const p of pts) { if (p.x < minX) minX = p.x; if (p.x > maxX) maxX = p.x; if (p.y < minY) minY = p.y; if (p.y > maxY) maxY = p.y; }
  const M = UNIT * 0.3;
  const w = Math.ceil(maxX - minX + 2 * M), h = Math.ceil(maxY - minY + 2 * M);
  const ox = -minX + M, oy = -minY + M;
  const c = cv(w, h);
  const ctx = c.getContext('2d');
  ctx.lineJoin = 'round';
  ctx.translate(ox, oy);
  if (sunk) ctx.globalAlpha = 0.95;

  // --- baked shadows (fixed screen direction: down) ---
  const drawShadow = (cx, cy, rx, ry, a) => {
    ctx.save(); ctx.translate(cx, cy); ctx.scale(1, ry / rx);
    const g = ctx.createRadialGradient(0, 0, 0, 0, 0, rx);
    g.addColorStop(0, `rgba(2,6,10,${a})`); g.addColorStop(0.65, `rgba(2,6,10,${a * 0.4})`); g.addColorStop(1, 'rgba(2,6,10,0)');
    ctx.fillStyle = g; ctx.beginPath(); ctx.arc(0, 0, rx, 0, Math.PI * 2); ctx.fill(); ctx.restore();
  };
  // Seat the ship on the water: a soft projected shadow + a strong, tight contact
  // shadow + a dark core right at the waterline (kept subtle, not a halo).
  drawShadow(UNIT * 0.14, sCy + UNIT * 0.05, sRx * 1.06, sRy * 1.15, 0.32); // soft projected
  drawShadow(0, (Bh * cfy) + UNIT * 0.04, sRx * 0.85, Bh * cfy * 1.35, 0.55); // contact
  drawShadow(0, (Bh * cfy) - UNIT * 0.01, sRx * 0.6, Bh * cfy * 0.95, 0.5); // tight waterline core

  // --- hull: side wall (extruded DOWN) then lit deck ---
  const wallPts = nearEdge(pp, type, L, Bh, zDeck).concat(nearEdge(pp, type, L, Bh, 0).reverse());
  const wg = ctx.createLinearGradient(0, pp(0, -Bh, zDeck).y, 0, pp(0, -Bh, 0).y);
  wg.addColorStop(0, sunk ? '#1b252e' : '#33424f'); wg.addColorStop(1, sunk ? '#05080b' : '#0d141b');
  fillP(ctx, wallPts, wg);
  strokeP(ctx, nearEdge(pp, type, L, Bh, 0), sunk ? 'rgba(120,150,170,0.25)' : 'rgba(150,200,230,0.4)', 2, false);

  const deck = nearEdge(pp, type, L, Bh, zDeck).concat(farEdge(pp, type, L, Bh, zDeck).reverse());
  const eA = pp(0, -Bh, zDeck), eB = pp(0, Bh, zDeck);
  // cross-beam curvature: dark edges -> bright crest -> dark edges
  const dg = ctx.createLinearGradient(eA.x, eA.y, eB.x, eB.y);
  dg.addColorStop(0, sunk ? '#3a4651' : '#54626f');
  dg.addColorStop(0.5, sunk ? '#586573' : '#b6c6d6');
  dg.addColorStop(1, sunk ? '#3a4651' : '#54626f');
  fillP(ctx, deck, dg);

  // panel lines + railing (clipped to deck)
  ctx.save(); ctx.beginPath();
  ctx.moveTo(deck[0].x, deck[0].y); for (let i = 1; i < deck.length; i++) ctx.lineTo(deck[i].x, deck[i].y);
  ctx.closePath(); ctx.clip();
  ctx.strokeStyle = 'rgba(18,26,34,0.22)'; ctx.lineWidth = 1;
  for (let i = 1; i < 6; i++) { const t = -L / 2 + (i / 6) * L; const a = pp(t, -Bh, zDeck), b2 = pp(t, Bh, zDeck); ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b2.x, b2.y); ctx.stroke(); }
  const cl0 = pp(-L / 2, 0, zDeck), cl1 = pp(L / 2, 0, zDeck);
  ctx.strokeStyle = 'rgba(180,200,218,0.22)'; ctx.beginPath(); ctx.moveTo(cl0.x, cl0.y); ctx.lineTo(cl1.x, cl1.y); ctx.stroke();
  ctx.restore();

  strokeP(ctx, deck, '#10171e', 1.6, true); // dark gunwale outline
  const ne = nearEdge(pp, type, L, Bh, zDeck);
  ctx.fillStyle = 'rgba(206,222,238,0.5)';
  for (let i = 2; i < ne.length - 1; i += 2) { ctx.beginPath(); ctx.arc(ne[i].x, ne[i].y, 1.1, 0, Math.PI * 2); ctx.fill(); }
  strokeP(ctx, farEdge(pp, type, L, Bh, zDeck), accent, 1.6, false); // cool team rim on far edge
  ctx.globalAlpha = sunk ? 0.95 : 1;

  // --- superstructure per class ---
  const A = (f) => f * L, D = zDeck;
  if (type === 'carrier') {
    boxSolid(pp, ctx, -L / 2 + UNIT * 0.1, L / 2 - UNIT * 0.06, -UNIT * 0.32, UNIT * 0.32, D, UNIT * 0.06, P_DECKSLAB);
    const fdz = D + UNIT * 0.06;
    ctx.strokeStyle = 'rgba(244,250,255,0.55)'; ctx.lineWidth = 2.2; ctx.setLineDash([UNIT * 0.18, UNIT * 0.13]);
    const r0 = pp(-L * 0.42, 0, fdz), r1 = pp(L * 0.44, 0, fdz); ctx.beginPath(); ctx.moveTo(r0.x, r0.y); ctx.lineTo(r1.x, r1.y); ctx.stroke(); ctx.setLineDash([]);
    ctx.strokeStyle = 'rgba(255,204,51,0.6)'; ctx.lineWidth = 2;
    const a0 = pp(-L * 0.36, -UNIT * 0.18, fdz), a1 = pp(L * 0.28, UNIT * 0.1, fdz); ctx.beginPath(); ctx.moveTo(a0.x, a0.y); ctx.lineTo(a1.x, a1.y); ctx.stroke();
    boxSolid(pp, ctx, A(0.1), A(0.2), -UNIT * 0.3, -UNIT * 0.16, fdz, UNIT * 0.34, P_BOX);
    const mb = pp(A(0.15), -UNIT * 0.23, fdz + UNIT * 0.34), mt = pp(A(0.15), -UNIT * 0.23, fdz + UNIT * 0.62);
    ctx.strokeStyle = '#cdd9e6'; ctx.lineWidth = 1.6; ctx.beginPath(); ctx.moveTo(mb.x, mb.y); ctx.lineTo(mt.x, mt.y); ctx.stroke();
  } else if (type === 'battleship') {
    turret(pp, ctx, A(-0.34), 0, UNIT * 0.16, cfy, 3, 1);
    turret(pp, ctx, A(-0.21), 0, UNIT * 0.16, cfy, 3, 1);
    boxSolid(pp, ctx, A(-0.1), A(0.0), -UNIT * 0.17, UNIT * 0.17, D, UNIT * 0.34, P_BOX);
    boxSolid(pp, ctx, A(-0.07), A(-0.02), -UNIT * 0.12, UNIT * 0.12, D + UNIT * 0.34, UNIT * 0.2, P_BOX);
    cylSolid(pp, ctx, A(0.11), 0, UNIT * 0.11, D, UNIT * 0.32, cfy, P_FUNNEL); funnelCap(pp, ctx, A(0.11), 0, UNIT * 0.11, D + UNIT * 0.32, cfy);
    cylSolid(pp, ctx, A(0.22), 0, UNIT * 0.09, D, UNIT * 0.26, cfy, P_FUNNEL); funnelCap(pp, ctx, A(0.22), 0, UNIT * 0.09, D + UNIT * 0.26, cfy);
    turret(pp, ctx, A(0.34), 0, UNIT * 0.16, cfy, 3, -1);
  } else if (type === 'cruiser') {
    turret(pp, ctx, A(-0.32), 0, UNIT * 0.14, cfy, 2, 1);
    boxSolid(pp, ctx, A(-0.12), A(-0.02), -UNIT * 0.13, UNIT * 0.13, D, UNIT * 0.32, P_BOX);
    cylSolid(pp, ctx, A(0.1), 0, UNIT * 0.1, D, UNIT * 0.28, cfy, P_FUNNEL); funnelCap(pp, ctx, A(0.1), 0, UNIT * 0.1, D + UNIT * 0.28, cfy);
    turret(pp, ctx, A(0.34), 0, UNIT * 0.14, cfy, 2, -1);
  } else if (sub) {
    boxSolid(pp, ctx, A(-0.05), A(0.07), -UNIT * 0.09, UNIT * 0.09, D, UNIT * 0.26, P_SAIL);
    const pb = pp(A(0.0), 0, D + UNIT * 0.26), ptp = pp(A(0.03), 0, D + UNIT * 0.46);
    ctx.strokeStyle = '#cdd9e6'; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(pb.x, pb.y); ctx.lineTo(ptp.x, ptp.y); ctx.stroke();
  } else {
    turret(pp, ctx, A(-0.26), 0, UNIT * 0.13, cfy, 2, 1);
    boxSolid(pp, ctx, A(-0.04), A(0.06), -UNIT * 0.12, UNIT * 0.12, D, UNIT * 0.28, P_BOX);
    cylSolid(pp, ctx, A(0.22), 0, UNIT * 0.08, D, UNIT * 0.24, cfy, P_FUNNEL); funnelCap(pp, ctx, A(0.22), 0, UNIT * 0.08, D + UNIT * 0.24, cfy);
  }

  if (sunk) { ctx.globalAlpha = 1; const s = pp(A(0.05), 0, D); ell(ctx, s.x, s.y, UNIT * 0.3, UNIT * 0.17, 'rgba(8,12,16,0.5)'); }

  return { canvas: c, ax: ox / w, ay: oy / h };
}

const TEX_CACHE = new Map();
function shipTexture(type, size, opts) {
  const key = `${type}|${opts.accent || 'p'}|${opts.sunk ? 1 : 0}|${opts.orientation === 'v' ? 'v' : 'h'}`;
  let entry = TEX_CACHE.get(key);
  if (!entry) {
    const r = renderShipCanvas(type, size, opts);
    const texture = PIXI.Texture.from(r.canvas);
    texture.baseTexture.scaleMode = PIXI.SCALE_MODES.LINEAR;
    entry = { texture, ax: r.ax, ay: r.ay };
    TEX_CACHE.set(key, entry);
  }
  return entry;
}

// Container: animated foam + the orientation-specific 2.5D hull sprite (shadows baked).
export function makeShip(type, size, cellSize, opts = {}) {
  const container = new PIXI.Container();

  const foam = new PIXI.Sprite(buildTextures().foam);
  foam.anchor.set(0.5); foam.alpha = 0; foam.blendMode = PIXI.BLEND_MODES.ADD;
  container.addChild(foam);

  const sprite = new PIXI.Sprite(PIXI.Texture.EMPTY);
  sprite.scale.set(1 / UNIT); // texture px -> cell units (board applies cell*rowScale)
  container.addChild(sprite);

  container.hull = sprite; container.foam = foam;
  container.shipL = size * cellSize; container.shipH = cellSize * 0.86;
  container._orientation = null;
  container.applyOrientation = function (orientation) {
    const o = orientation === 'v' ? 'v' : 'h';
    if (container._orientation === o) return;
    container._orientation = o;
    const t = shipTexture(type, size, { ...opts, orientation: o });
    sprite.texture = t.texture; sprite.anchor.set(t.ax, t.ay);
    if (o === 'v') { foam.width = 1.0; foam.height = size * 0.8; } else { foam.width = size * 0.9; foam.height = 1.0; }
    foam.y = 0.12;
  };
  container.applyOrientation(opts.orientation || 'h');
  return container;
}
