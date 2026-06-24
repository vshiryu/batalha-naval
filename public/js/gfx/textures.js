// Procedurally generated textures (zero external assets). Everything is drawn to
// an offscreen canvas and wrapped as a PIXI.Texture. Generated once at startup.

const PIXI = window.PIXI;

function canvas(w, h) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  return c;
}

function texFromCanvas(c, { repeat = false } = {}) {
  const tex = PIXI.Texture.from(c);
  if (repeat) tex.baseTexture.wrapMode = PIXI.WRAP_MODES.REPEAT;
  tex.baseTexture.scaleMode = PIXI.SCALE_MODES.LINEAR;
  return tex;
}

// Vertical gradient (array of [offset, '#rrggbb']).
export function gradientTexture(stops, w = 8, h = 512) {
  const c = canvas(w, h);
  const ctx = c.getContext('2d');
  const g = ctx.createLinearGradient(0, 0, 0, h);
  for (const [off, col] of stops) g.addColorStop(off, col);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, h);
  return texFromCanvas(c);
}

// Seamless (tileable) value noise as grayscale, with several octaves.
function valueNoiseField(period, seed = 1) {
  const grid = new Float32Array(period * period);
  let s = seed * 9301 + 49297;
  const rng = () => { s = (s * 9301 + 49297) % 233280; return s / 233280; };
  for (let i = 0; i < grid.length; i++) grid[i] = rng();
  return (x, y) => {
    const xi = Math.floor(x), yi = Math.floor(y);
    const xf = x - xi, yf = y - yi;
    const x0 = ((xi % period) + period) % period;
    const y0 = ((yi % period) + period) % period;
    const x1 = (x0 + 1) % period, y1 = (y0 + 1) % period;
    const v00 = grid[y0 * period + x0], v10 = grid[y0 * period + x1];
    const v01 = grid[y1 * period + x0], v11 = grid[y1 * period + x1];
    const sx = xf * xf * (3 - 2 * xf), sy = yf * yf * (3 - 2 * yf);
    const a = v00 + (v10 - v00) * sx;
    const b = v01 + (v11 - v01) * sx;
    return a + (b - a) * sy;
  };
}

function fbm(noise, x, y, octaves) {
  let amp = 0.5, freq = 1, sum = 0, norm = 0;
  for (let o = 0; o < octaves; o++) {
    sum += amp * noise(x * freq, y * freq);
    norm += amp;
    amp *= 0.5; freq *= 2;
  }
  return sum / norm;
}

// Grayscale displacement map (seamless), used by the water displacement filter.
export function noiseTexture(size = 256) {
  const c = canvas(size, size);
  const ctx = c.getContext('2d');
  const img = ctx.createImageData(size, size);
  const period = 8;
  const nA = valueNoiseField(period, 11);
  const nB = valueNoiseField(period, 47);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = (x / size) * period;
      const v = (y / size) * period;
      const r = fbm(nA, u, v, 4);
      const g = fbm(nB, u, v, 4);
      const i = (y * size + x) * 4;
      img.data[i] = r * 255;
      img.data[i + 1] = g * 255;
      img.data[i + 2] = 128;
      img.data[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return texFromCanvas(c, { repeat: true });
}

// Shimmering caustics-like ridges on a transparent background (additive cyan).
export function causticsTexture(size = 256) {
  const c = canvas(size, size);
  const ctx = c.getContext('2d');
  const img = ctx.createImageData(size, size);
  const period = 6;
  const n = valueNoiseField(period, 23);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = (x / size) * period;
      const v = (y / size) * period;
      let f = fbm(n, u, v, 3);
      // Ridged: bright where noise crosses a band -> web of light.
      let ridge = 1 - Math.abs(f * 2 - 1);
      ridge = Math.pow(ridge, 6);
      const i = (y * size + x) * 4;
      img.data[i] = 165;     // a5
      img.data[i + 1] = 243; // f3
      img.data[i + 2] = 252; // fc
      img.data[i + 3] = ridge * 90;
    }
  }
  ctx.putImageData(img, 0, 0);
  return texFromCanvas(c, { repeat: true });
}

// Soft white radial glow (tint at use).
export function radialTexture(size = 128, falloff = 1.4) {
  const c = canvas(size, size);
  const ctx = c.getContext('2d');
  const r = size / 2;
  const g = ctx.createRadialGradient(r, r, 0, r, r, r);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.4, 'rgba(255,255,255,0.7)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  return texFromCanvas(c);
}

// Soft smoke puff (slightly noisy radial).
export function smokeTexture(size = 128) {
  const c = canvas(size, size);
  const ctx = c.getContext('2d');
  const r = size / 2;
  const g = ctx.createRadialGradient(r, r, 0, r, r, r);
  g.addColorStop(0, 'rgba(255,255,255,0.9)');
  g.addColorStop(0.5, 'rgba(255,255,255,0.45)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  return texFromCanvas(c);
}

// White ring (stroked circle) for ripples / sonar sweeps.
export function ringTexture(size = 128, thickness = 0.08) {
  const c = canvas(size, size);
  const ctx = c.getContext('2d');
  ctx.strokeStyle = 'rgba(255,255,255,1)';
  ctx.lineWidth = size * thickness;
  ctx.beginPath();
  ctx.arc(size / 2, size / 2, size / 2 - ctx.lineWidth, 0, Math.PI * 2);
  ctx.stroke();
  return texFromCanvas(c);
}

// Small elongated droplet.
export function dropletTexture(size = 24) {
  const c = canvas(size, size);
  const ctx = c.getContext('2d');
  const r = size / 2;
  const g = ctx.createRadialGradient(r, r, 0, r, r, r);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.ellipse(r, r, r * 0.55, r, 0, 0, Math.PI * 2);
  ctx.fill();
  return texFromCanvas(c);
}

// A 4-point star spark for muzzle flashes / embers.
export function sparkTexture(size = 48) {
  const c = canvas(size, size);
  const ctx = c.getContext('2d');
  const r = size / 2;
  const g = ctx.createRadialGradient(r, r, 0, r, r, r);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.25, 'rgba(255,255,255,0.8)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.beginPath(); ctx.arc(r, r, r * 0.35, 0, Math.PI * 2); ctx.fill();
  // cross flare
  ctx.strokeStyle = 'rgba(255,255,255,0.85)';
  ctx.lineWidth = size * 0.04;
  ctx.beginPath();
  ctx.moveTo(r, 2); ctx.lineTo(r, size - 2);
  ctx.moveTo(2, r); ctx.lineTo(size - 2, r);
  ctx.stroke();
  return texFromCanvas(c);
}

// Build & cache the shared texture set.
let CACHE = null;
export function buildTextures() {
  if (CACHE) return CACHE;
  CACHE = {
    noise: noiseTexture(256),
    caustics: causticsTexture(256),
    radial: radialTexture(128),
    smoke: smokeTexture(128),
    ring: ringTexture(160, 0.06),
    droplet: dropletTexture(28),
    spark: sparkTexture(48),
  };
  return CACHE;
}
