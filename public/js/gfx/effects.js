// Effects — pooled particle system + scripted animations (projectiles, torpedo).
// All sprites are recycled to avoid GC pressure on mobile. Particle counts scale
// with stage.quality ('full' | 'reduced').

import { COLORS, lerp, rand, easeOutCubic } from '../constants.js';
import { buildTextures } from './textures.js';

const PIXI = window.PIXI;

export class Effects {
  constructor(stage) {
    this.stage = stage;
    this.layer = stage.fxLayer;
    this.tex = buildTextures();
    this.free = [];
    this.active = [];
    this.anims = [];
    stage.addUpdater((dt) => this.update(dt));
  }

  get q() { return this.stage.quality === 'reduced' ? 0.45 : 1; }
  n(count) { return Math.max(1, Math.round(count * this.q)); }

  _acquire(texture, blend = PIXI.BLEND_MODES.NORMAL) {
    let s = this.free.pop();
    if (!s) { s = new PIXI.Sprite(); s.anchor.set(0.5); }
    s.texture = texture;
    s.blendMode = blend;
    s.visible = true;
    s.rotation = 0;
    this.layer.addChild(s);
    return s;
  }

  _release(p) {
    const s = p.sprite;
    if (s.parent) s.parent.removeChild(s);
    s.visible = false;
    this.free.push(s);
  }

  spawn(p) {
    p.sprite = this._acquire(p.texture, p.blend);
    p.maxLife = p.life;
    p.vx = p.vx || 0; p.vy = p.vy || 0;
    p.gravity = p.gravity || 0; p.drag = p.drag || 0;
    p.rotVel = p.rotVel || 0;
    p.scale0 = p.scale0 != null ? p.scale0 : 1;
    p.scale1 = p.scale1 != null ? p.scale1 : p.scale0;
    p.alpha0 = p.alpha0 != null ? p.alpha0 : 1;
    p.alpha1 = p.alpha1 != null ? p.alpha1 : 0;
    if (p.tint != null) p.sprite.tint = p.tint;
    p.sprite.x = p.x; p.sprite.y = p.y;
    p.sprite.scale.set(p.scale0);
    p.sprite.alpha = p.alpha0;
    if (p.rot != null) p.sprite.rotation = p.rot;
    this.active.push(p);
    return p;
  }

  update(dt) {
    const s = dt / 1000;
    for (let i = this.active.length - 1; i >= 0; i--) {
      const p = this.active[i];
      p.life -= dt;
      const t = 1 - Math.max(0, p.life) / p.maxLife;
      p.vy += p.gravity * s;
      if (p.drag) { p.vx *= 1 - p.drag * s; p.vy *= 1 - p.drag * s; }
      const sp = p.sprite;
      sp.x += p.vx * s; sp.y += p.vy * s;
      sp.rotation += p.rotVel * s;
      const e = p.ease ? p.ease(t) : t;
      sp.scale.set(lerp(p.scale0, p.scale1, e));
      sp.alpha = lerp(p.alpha0, p.alpha1, e);
      if (p.life <= 0) { this._release(p); this.active.splice(i, 1); }
    }
    for (let i = this.anims.length - 1; i >= 0; i--) {
      if (this.anims[i].update(dt)) { this.anims.splice(i, 1); }
    }
  }

  // ---------------------------------------------------------------- primitives
  ripple(x, y, { color = COLORS.splash, maxScale = 0.9, life = 900 } = {}) {
    this.spawn({
      texture: this.tex.ring, x, y, life, tint: color,
      scale0: 0.05, scale1: maxScale, alpha0: 0.7, alpha1: 0, ease: easeOutCubic,
      blend: PIXI.BLEND_MODES.ADD,
    });
  }

  splash(x, y, scale = 1) {
    this.ripple(x, y, { maxScale: 0.8 * scale });
    const drops = this.n(10 * scale);
    for (let i = 0; i < drops; i++) {
      const a = rand(0, Math.PI * 2);
      const sp = rand(60, 180) * scale;
      this.spawn({
        texture: this.tex.droplet, x, y, life: rand(400, 700),
        vx: Math.cos(a) * sp, vy: Math.sin(a) * sp - rand(40, 120),
        gravity: 520, tint: COLORS.splash,
        scale0: rand(0.4, 0.9) * scale, scale1: 0.1, alpha0: 0.95, alpha1: 0,
        rot: a,
      });
    }
  }

  muzzleFlash(x, y, angle = 0) {
    this.spawn({
      texture: this.tex.spark, x, y, life: 180, rot: angle,
      scale0: 0.1, scale1: 1.0 * this.q + 0.4, alpha0: 1, alpha1: 0,
      tint: COLORS.ember, blend: PIXI.BLEND_MODES.ADD, ease: easeOutCubic,
    });
    for (let i = 0; i < this.n(6); i++) {
      const a = angle + rand(-0.5, 0.5);
      this.spawn({
        texture: this.tex.spark, x, y, life: rand(180, 320),
        vx: Math.cos(a) * rand(120, 320), vy: Math.sin(a) * rand(120, 320),
        drag: 3, tint: COLORS.fire1, blend: PIXI.BLEND_MODES.ADD,
        scale0: rand(0.3, 0.6), scale1: 0, alpha0: 1, alpha1: 0,
      });
    }
  }

  explosion(x, y, scale = 1) {
    this.stage.addShake(12 * scale);
    // flash
    this.spawn({
      texture: this.tex.radial, x, y, life: 220, tint: 0xfff1c0,
      scale0: 0.2 * scale, scale1: 2.2 * scale, alpha0: 1, alpha1: 0,
      blend: PIXI.BLEND_MODES.ADD, ease: easeOutCubic,
    });
    // fireball
    for (let i = 0; i < this.n(18 * scale); i++) {
      const a = rand(0, Math.PI * 2), sp = rand(40, 220) * scale;
      this.spawn({
        texture: this.tex.spark, x, y, life: rand(450, 850),
        vx: Math.cos(a) * sp, vy: Math.sin(a) * sp - rand(20, 80),
        drag: 1.6, gravity: 120,
        tint: i % 2 ? COLORS.fire1 : COLORS.ember, blend: PIXI.BLEND_MODES.ADD,
        scale0: rand(0.5, 1.1) * scale, scale1: 0.05, alpha0: 1, alpha1: 0,
      });
    }
    // debris
    for (let i = 0; i < this.n(8 * scale); i++) {
      const a = rand(-Math.PI, 0), sp = rand(120, 300) * scale;
      this.spawn({
        texture: this.tex.droplet, x, y, life: rand(600, 1000),
        vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, gravity: 600, rotVel: rand(-10, 10),
        tint: 0x3b4654, scale0: rand(0.3, 0.7), scale1: 0.2, alpha0: 1, alpha1: 0,
      });
    }
    // smoke
    for (let i = 0; i < this.n(6 * scale); i++) {
      this.smokePuff(x + rand(-12, 12), y + rand(-12, 12), scale);
    }
  }

  smokePuff(x, y, scale = 1) {
    this.spawn({
      texture: this.tex.smoke, x, y, life: rand(1400, 2200),
      vx: rand(-20, 20), vy: rand(-50, -22), drag: 0.6,
      tint: COLORS.smoke, scale0: rand(0.3, 0.5) * scale, scale1: rand(1.2, 1.8) * scale,
      alpha0: 0.55, alpha1: 0, rotVel: rand(-0.6, 0.6),
    });
  }

  ember(x, y) {
    this.spawn({
      texture: this.tex.spark, x: x + rand(-6, 6), y: y + rand(-6, 6), life: rand(500, 900),
      vx: rand(-18, 18), vy: rand(-70, -30), drag: 1,
      tint: Math.random() < 0.5 ? COLORS.ember : COLORS.fire1, blend: PIXI.BLEND_MODES.ADD,
      scale0: rand(0.25, 0.5), scale1: 0, alpha0: 1, alpha1: 0,
    });
  }

  bubbles(x, y, scale = 1) {
    for (let i = 0; i < this.n(16 * scale); i++) {
      setTimeout(() => this.spawn({
        texture: this.tex.radial, x: x + rand(-18, 18) * scale, y: y + rand(-6, 10),
        life: rand(700, 1300), vx: rand(-14, 14), vy: rand(-90, -40),
        tint: 0xa5f3fc, scale0: rand(0.08, 0.22) * scale, scale1: rand(0.02, 0.1),
        alpha0: 0.8, alpha1: 0, blend: PIXI.BLEND_MODES.ADD,
      }), i * 40);
    }
  }

  sonar(x, y, maxScale = 1.4) {
    for (let r = 0; r < 3; r++) {
      setTimeout(() => this.spawn({
        texture: this.tex.ring, x, y, life: 1100, tint: COLORS.gridCyan,
        scale0: 0.05, scale1: maxScale, alpha0: 0.8, alpha1: 0,
        ease: easeOutCubic, blend: PIXI.BLEND_MODES.ADD,
      }), r * 220);
    }
    this.spawn({
      texture: this.tex.radial, x, y, life: 500, tint: COLORS.gridCyan,
      scale0: 0.1, scale1: 1.2, alpha0: 0.5, alpha1: 0, blend: PIXI.BLEND_MODES.ADD,
    });
  }

  detect(x, y) {
    // a pulsing marker on a sonar-detected ship cell
    this.spawn({
      texture: this.tex.radial, x, y, life: 700, tint: COLORS.enemy,
      scale0: 0.1, scale1: 0.7, alpha0: 0.9, alpha1: 0, blend: PIXI.BLEND_MODES.ADD,
    });
  }

  flares(x, y) {
    for (let i = 0; i < this.n(3); i++) {
      setTimeout(() => {
        const vx = rand(-60, 60), vy = -rand(260, 420);
        this.spawn({
          texture: this.tex.spark, x, y, life: 1500, vx, vy, gravity: 180,
          tint: COLORS.victory, blend: PIXI.BLEND_MODES.ADD,
          scale0: 0.8, scale1: 0.2, alpha0: 1, alpha1: 0,
        });
        for (let k = 0; k < this.n(10); k++) {
          const a = rand(0, Math.PI * 2), sp = rand(60, 200);
          this.spawn({
            texture: this.tex.spark, x, y: y - 60, life: rand(700, 1300),
            vx: Math.cos(a) * sp, vy: Math.sin(a) * sp + 40, gravity: 200,
            tint: Math.random() < 0.5 ? COLORS.victory : 0xffe9a8, blend: PIXI.BLEND_MODES.ADD,
            scale0: rand(0.3, 0.6), scale1: 0, alpha0: 1, alpha1: 0,
          });
        }
      }, i * 250);
    }
  }

  // ---------------------------------------------------------------- scripted
  // Arcing cannon shell with a trail. Calls onArrive() at impact.
  projectile(from, to, onArrive, { dur = 600, arc = 90, color = COLORS.ember } = {}) {
    this.muzzleFlash(from.x, from.y, Math.atan2(to.y - from.y, to.x - from.x));
    const head = this._acquire(this.tex.spark, PIXI.BLEND_MODES.ADD);
    head.tint = color; head.scale.set(0.5);
    let t = 0;
    const anim = {
      update: (dt) => {
        t += dt;
        const k = Math.min(1, t / dur);
        const x = lerp(from.x, to.x, k);
        const y = lerp(from.y, to.y, k) - Math.sin(k * Math.PI) * arc;
        head.x = x; head.y = y;
        if (Math.random() < 0.8) {
          this.spawn({
            texture: this.tex.spark, x, y, life: 260, tint: color,
            blend: PIXI.BLEND_MODES.ADD, scale0: 0.35, scale1: 0, alpha0: 0.8, alpha1: 0,
          });
        }
        if (k >= 1) {
          if (head.parent) head.parent.removeChild(head);
          this.free.push(head);
          if (onArrive) onArrive();
          return true;
        }
        return false;
      },
    };
    this.anims.push(anim);
  }

  // Torpedo running along the surface with a foamy wake. Calls onArrive() at end.
  torpedo(from, to, onArrive, { dur = 900 } = {}) {
    const ang = Math.atan2(to.y - from.y, to.x - from.x);
    const body = this._acquire(this.tex.droplet, PIXI.BLEND_MODES.NORMAL);
    body.tint = 0x9fb4c4; body.rotation = ang + Math.PI / 2; body.scale.set(0.9, 1.6);
    let t = 0;
    const anim = {
      update: (dt) => {
        t += dt;
        const k = Math.min(1, t / dur);
        const x = lerp(from.x, to.x, k), y = lerp(from.y, to.y, k);
        body.x = x; body.y = y;
        // wake
        this.spawn({
          texture: this.tex.radial, x, y, life: 700, tint: 0xa5f3fc,
          scale0: 0.18, scale1: 0.5, alpha0: 0.5, alpha1: 0, blend: PIXI.BLEND_MODES.ADD,
        });
        if (Math.random() < 0.5) this.spawn({
          texture: this.tex.droplet, x: x - Math.cos(ang) * 8, y: y - Math.sin(ang) * 8,
          life: 500, vx: rand(-30, 30), vy: rand(-30, 30), tint: 0xa5f3fc,
          scale0: 0.3, scale1: 0, alpha0: 0.7, alpha1: 0,
        });
        if (k >= 1) {
          if (body.parent) body.parent.removeChild(body);
          this.free.push(body);
          if (onArrive) onArrive();
          return true;
        }
        return false;
      },
    };
    this.anims.push(anim);
  }
}
