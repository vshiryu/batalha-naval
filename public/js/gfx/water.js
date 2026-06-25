// Water — the animated deep-ocean background. Layers: a vertical gradient base,
// two scrolling caustics sheets, drifting specular highlights, soft fog puffs,
// and a displacement filter (rolling procedural noise) that warps the surface.

import { COLORS } from '../constants.js';
import { buildTextures, gradientTexture } from './textures.js';

const PIXI = window.PIXI;

export class Water {
  constructor(stage) {
    this.stage = stage;
    const tex = buildTextures();
    const layer = stage.oceanLayer;

    // Base gradient.
    this.gradient = new PIXI.Sprite(gradientTexture([
      [0, '#0a1929'], [0.45, '#102a43'], [1, '#0d2238'],
    ]));
    layer.addChild(this.gradient);

    // Surface container (gets the displacement wobble).
    this.surface = new PIXI.Container();
    layer.addChild(this.surface);

    // Two caustics sheets scrolling in different directions.
    this.caustics1 = new PIXI.TilingSprite(tex.caustics, 1024, 1024);
    this.caustics1.tileScale.set(1.1);
    this.caustics1.blendMode = PIXI.BLEND_MODES.ADD;
    this.caustics1.alpha = 0.5;
    this.caustics2 = new PIXI.TilingSprite(tex.caustics, 1024, 1024);
    this.caustics2.tileScale.set(1.8);
    this.caustics2.blendMode = PIXI.BLEND_MODES.ADD;
    this.caustics2.alpha = 0.28;
    this.surface.addChild(this.caustics1, this.caustics2);

    // Drifting specular highlight.
    this.spec = new PIXI.Sprite(tex.radial);
    this.spec.anchor.set(0.5);
    this.spec.tint = 0x9fd8ff;
    this.spec.alpha = 0.10;
    this.spec.blendMode = PIXI.BLEND_MODES.ADD;
    this.surface.addChild(this.spec);

    // Fog puffs.
    this.fog = [];
    for (let i = 0; i < 4; i++) {
      const f = new PIXI.Sprite(tex.radial);
      f.anchor.set(0.5);
      f.tint = 0x16304a;
      f.alpha = 0.18;
      f.fseed = Math.random() * 1000;
      this.fog.push(f);
      this.surface.addChild(f);
    }

    // Bright specular glints (reflective sparkle on the surface).
    this.glints = [];
    for (let i = 0; i < 5; i++) {
      const gl = new PIXI.Sprite(tex.radial);
      gl.anchor.set(0.5);
      gl.tint = 0xdff3ff;
      gl.blendMode = PIXI.BLEND_MODES.ADD;
      gl.gseed = Math.random() * 1000;
      this.glints.push(gl);
      this.surface.addChild(gl);
    }

    // Displacement wobble.
    this.dispSprite = new PIXI.Sprite(tex.noise);
    this.dispSprite.renderable = false; // used only as a displacement map
    layer.addChild(this.dispSprite);
    this.dispFilter = new PIXI.DisplacementFilter(this.dispSprite);
    this.dispFilter.scale.set(18);
    this.surface.filters = [this.dispFilter];

    this._layout(stage.width, stage.height);
    stage.onResize((w, h) => this._layout(w, h));
    stage.addUpdater((dt, time) => this._update(dt, time));
    stage.onQualityChange((q) => this._setQuality(q));
  }

  // Drop the displacement filter and a caustics sheet on reduced quality.
  _setQuality(q) {
    if (q === 'reduced') {
      this.surface.filters = [];
      this.caustics2.visible = false;
    } else {
      this.surface.filters = [this.dispFilter];
      this.caustics2.visible = true;
    }
  }

  _layout(w, h) {
    this.gradient.width = w;
    this.gradient.height = h;
    for (const cs of [this.caustics1, this.caustics2]) {
      cs.width = w + 200; cs.height = h + 200;
      cs.x = -100; cs.y = -100;
    }
    this.spec.x = w * 0.5; this.spec.y = h * 0.32;
    this.spec.width = w * 1.1; this.spec.height = h * 0.7;
    this.fog.forEach((f, i) => {
      f.baseX = (i % 2 === 0 ? 0.25 : 0.75) * w;
      f.baseY = (i < 2 ? 0.3 : 0.75) * h;
      f.width = w * 0.9; f.height = h * 0.5;
    });
    this.glints.forEach((gl, i) => {
      gl.baseX = (0.12 + 0.76 * ((i + 0.5) / this.glints.length)) * w;
      gl.baseY = (0.2 + 0.6 * ((i * 7 % 5) / 5)) * h;
      gl.width = gl.height = Math.max(40, w * 0.10);
    });
    this.w = w; this.h = h;
  }

  _update(dt, time) {
    const s = dt / 16.67;
    this.caustics1.tilePosition.x += 0.18 * s;
    this.caustics1.tilePosition.y += 0.12 * s;
    this.caustics2.tilePosition.x -= 0.10 * s;
    this.caustics2.tilePosition.y += 0.20 * s;
    this.caustics1.alpha = 0.42 + Math.sin(time / 1400) * 0.12;

    // Roll the displacement map.
    this.dispSprite.x += 0.30 * s;
    this.dispSprite.y += 0.20 * s;

    // Drift the specular and fog.
    this.spec.x = this.w * 0.5 + Math.sin(time / 5200) * this.w * 0.12;
    this.spec.alpha = 0.12 + Math.sin(time / 2600) * 0.05;
    for (const f of this.fog) {
      f.x = f.baseX + Math.sin(time / 7000 + f.fseed) * this.w * 0.07;
      f.y = f.baseY + Math.cos(time / 9000 + f.fseed) * this.h * 0.04;
    }
    // twinkling, slowly drifting specular glints
    for (const gl of this.glints) {
      const tw = Math.sin(time / 520 + gl.gseed) * 0.5 + 0.5;
      gl.alpha = 0.04 + tw * tw * 0.16;
      gl.x = gl.baseX + Math.sin(time / 6000 + gl.gseed) * this.w * 0.05;
      gl.y = gl.baseY + Math.cos(time / 8000 + gl.gseed) * this.h * 0.03;
    }
  }
}
