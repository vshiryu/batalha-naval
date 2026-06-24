// Procedural top-down warship silhouettes. Each class has a distinct hull and
// superstructure (turrets, towers, funnels), drawn centered at the local origin
// with the long axis along X. The board rotates the container for vertical ships.

import { COLORS } from '../constants.js';
import { buildTextures } from './textures.js';

const PIXI = window.PIXI;

function turret(g, x, s, color, dark) {
  // barrel
  g.beginFill(dark);
  g.drawRoundedRect(x - s * 0.1, -s * 0.12, s * 1.0, s * 0.24, s * 0.1);
  g.endFill();
  // base
  g.beginFill(color);
  g.drawCircle(x, 0, s * 0.42);
  g.endFill();
  g.beginFill(dark, 0.5);
  g.drawCircle(x, 0, s * 0.22);
  g.endFill();
}

function box(g, x, w, h, color, dark) {
  g.beginFill(color);
  g.drawRoundedRect(x - w / 2, -h / 2, w, h, Math.min(w, h) * 0.2);
  g.endFill();
  g.lineStyle(1, dark, 0.6);
  g.drawRoundedRect(x - w / 2, -h / 2, w, h, Math.min(w, h) * 0.2);
  g.lineStyle(0);
}

function hullPath(g, L, H, fill, outline) {
  const bx = L / 2;
  const bow = L * 0.22;
  g.lineStyle(2, outline, 0.9);
  g.beginFill(fill);
  g.moveTo(-bx, -H * 0.34);
  g.lineTo(bx - bow, -H * 0.5);
  g.quadraticCurveTo(bx, -H * 0.5, bx, 0); // bow tip
  g.quadraticCurveTo(bx, H * 0.5, bx - bow, H * 0.5);
  g.lineTo(-bx, H * 0.34);
  g.quadraticCurveTo(-bx - H * 0.12, 0, -bx, -H * 0.34);
  g.closePath();
  g.endFill();
  g.lineStyle(0);
}

// Draw a ship of `type` into a fresh Graphics, sized L x H (centered at origin).
export function drawShip(type, L, H, opts = {}) {
  const g = new PIXI.Graphics();
  const steel = opts.sunk ? 0x33414f : COLORS.steel;
  const dark = COLORS.steelDark;
  const deck = opts.sunk ? 0x3c4a59 : COLORS.hullDeck;
  const light = COLORS.steelLight;

  // Hull + a lighter deck inset for a faked gradient.
  hullPath(g, L, H, steel, dark);
  g.beginFill(deck, 0.55);
  g.drawRoundedRect(-L / 2 + H * 0.18, -H * 0.26, L - H * 0.5, H * 0.52, H * 0.2);
  g.endFill();
  // specular keel highlight
  g.lineStyle(1.5, light, 0.35);
  g.moveTo(-L / 2 + H * 0.2, -H * 0.05);
  g.lineTo(L / 2 - H * 0.2, -H * 0.05);
  g.lineStyle(0);

  const s = H * 0.6;
  switch (type) {
    case 'carrier': {
      // Full flight deck.
      box(g, 0, L * 0.92, H * 0.66, 0x46566a, dark);
      // angled deck stripe + centerline
      g.lineStyle(2, COLORS.ember, 0.5);
      g.moveTo(-L * 0.4, 0); g.lineTo(L * 0.42, 0);
      g.lineStyle(1.5, light, 0.4);
      g.moveTo(-L * 0.36, -H * 0.18); g.lineTo(L * 0.30, H * 0.1);
      g.lineStyle(0);
      // island tower (off to one side)
      box(g, L * 0.12, H * 0.5, H * 0.34, light, dark);
      g.beginFill(COLORS.ember, 0.9); g.drawCircle(L * 0.12, 0, H * 0.05); g.endFill();
      break;
    }
    case 'battleship': {
      turret(g, -L * 0.3, s, light, dark);
      turret(g, -L * 0.06, s, light, dark);
      turret(g, L * 0.26, s, light, dark);
      box(g, 0, H * 0.5, H * 0.42, light, dark); // bridge
      box(g, -L * 0.18, H * 0.34, H * 0.3, deck, dark); // funnel
      break;
    }
    case 'cruiser': {
      turret(g, -L * 0.28, s * 0.92, light, dark);
      turret(g, L * 0.3, s * 0.92, light, dark);
      box(g, -L * 0.02, H * 0.44, H * 0.4, light, dark); // bridge
      box(g, L * 0.06, H * 0.28, H * 0.26, deck, dark); // funnel
      break;
    }
    case 'submarine': {
      // Lower, rounded cylinder look.
      g.beginFill(0x2a3947);
      g.drawEllipse(0, 0, L * 0.46, H * 0.3);
      g.endFill();
      box(g, 0, H * 0.42, H * 0.36, light, dark); // conning tower
      g.lineStyle(1.5, light, 0.5); // periscope
      g.moveTo(0, -H * 0.18); g.lineTo(H * 0.18, -H * 0.34);
      g.lineStyle(0);
      break;
    }
    case 'destroyer':
    default: {
      turret(g, -L * 0.2, s * 0.85, light, dark);
      box(g, L * 0.06, H * 0.4, H * 0.36, light, dark); // bridge
      box(g, L * 0.24, H * 0.22, H * 0.22, deck, dark); // funnel
      break;
    }
  }

  if (opts.sunk) {
    // Scorch + listing look for revealed wrecks.
    g.beginFill(0x0a0f14, 0.5);
    g.drawCircle(L * 0.1, -H * 0.05, H * 0.3);
    g.drawCircle(-L * 0.2, H * 0.08, H * 0.22);
    g.endFill();
  }
  return g;
}

// A ship container with a soft water shadow underneath.
export function makeShip(type, size, cellSize, opts = {}) {
  const L = size * cellSize - cellSize * 0.16;
  const H = cellSize * 0.82;
  const container = new PIXI.Container();

  const tex = buildTextures();
  const shadow = new PIXI.Sprite(tex.radial);
  shadow.anchor.set(0.5);
  shadow.width = L * 1.1;
  shadow.height = H * 1.5;
  shadow.tint = 0x010912;
  shadow.alpha = 0.4;
  shadow.y = H * 0.28;
  container.addChild(shadow);

  const hull = drawShip(type, L, H, opts);
  container.addChild(hull);

  container.shipL = L;
  container.shipH = H;
  container.hull = hull;
  container.shadow = shadow;
  return container;
}
