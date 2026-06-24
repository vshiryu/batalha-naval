// Presentation constants (colors, timings, ship icon paths). Game rules/costs
// come from the server `config` payload — this file is purely visual.

export const COLORS = {
  oceanTop: 0x0a1929,
  oceanMid: 0x102a43,
  oceanBottom: 0x0d2238,
  gridCyan: 0x38bdf8,
  gridTeal: 0x2dd4bf,
  player: 0x2dd4bf,
  enemy: 0xf59e0b,
  enemyHot: 0xef4444,
  fire1: 0xff6b35,
  fire2: 0xf7931e,
  ember: 0xffcc33,
  smoke: 0x2d3748,
  splash: 0xa5f3fc,
  energyA: 0x60a5fa,
  energyB: 0xa78bfa,
  victory: 0xfbbf24,
  text: 0xe2e8f0,
  steel: 0x5b6b7d,
  steelLight: 0x8fa3b8,
  steelDark: 0x2b3a4a,
  hullDeck: 0x6b7d8f,
};

// CSS string mirror for DOM usage.
export const CSS = {
  player: '#2dd4bf',
  enemy: '#f59e0b',
  enemyHot: '#ef4444',
  energyA: '#60a5fa',
  energyB: '#a78bfa',
  victory: '#fbbf24',
  text: '#e2e8f0',
  fire: '#ff6b35',
  splash: '#a5f3fc',
};

// Animation timings (ms) and easings.
export const TIMING = {
  projectile: 620,
  splashRing: 900,
  explosion: 1100,
  sinkDuration: 1600,
  sonarSweep: 1300,
  torpedoTravel: 950,
  turnWipe: 900,
  hitStopBig: 90,
  hitStopSmall: 45,
};

// Power-up display metadata (icons drawn procedurally; labels are pt-BR).
export const POWERUP_META = {
  shoot: { icon: 'crosshair', short: 'Tiro', fire: 'FOGO!' },
  sonar: { icon: 'sonar', short: 'Sonar', fire: 'VARRER' },
  triple: { icon: 'triple', short: 'Salva', fire: 'FOGO!' },
  torpedo: { icon: 'torpedo', short: 'Torpedo', fire: 'LANÇAR' },
  bombard: { icon: 'bombard', short: 'Bombardeio', fire: 'BOMBARDEAR' },
  repair: { icon: 'repair', short: 'Reparo', fire: 'REPARAR' },
};

export const easeOutCubic = (t) => 1 - Math.pow(1 - t, 3);
export const easeInCubic = (t) => t * t * t;
export const easeOutQuad = (t) => 1 - (1 - t) * (1 - t);
export const easeInOutQuad = (t) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2);
export const lerp = (a, b, t) => a + (b - a) * t;
export const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
export const rand = (a, b) => a + Math.random() * (b - a);
