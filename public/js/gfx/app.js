// Stage — owns the PIXI.Application, the layer tree, the master ticker, screen
// shake and hit-stop. Other modules register per-frame updaters and resize hooks.

import { clamp } from '../constants.js';

const PIXI = window.PIXI;

export class Stage {
  constructor(mountEl) {
    // Touch devices (coarse pointer) are the real target and the most likely to be
    // GPU-bound. Cap the render resolution there (a DPR-3 phone would otherwise
    // render at 2x) — a big fill-rate win that barely shows at phone pixel density.
    const coarse = !!(window.matchMedia && window.matchMedia('(pointer: coarse)').matches);
    const maxRes = coarse ? 1.5 : 2;
    this.app = new PIXI.Application({
      backgroundColor: 0x081320,
      antialias: true,
      resolution: Math.min(window.devicePixelRatio || 1, maxRes),
      autoDensity: true,
      powerPreference: 'high-performance',
      width: mountEl.clientWidth || window.innerWidth,
      height: mountEl.clientHeight || window.innerHeight,
    });
    this.mountEl = mountEl;
    mountEl.appendChild(this.app.view);
    this.app.view.style.width = '100%';
    this.app.view.style.height = '100%';
    this.app.view.style.display = 'block';

    // Layer tree. `world` is the shake target; everything visible lives under it.
    this.world = new PIXI.Container();
    this.oceanLayer = new PIXI.Container();
    this.boardLayer = new PIXI.Container();
    this.fxLayer = new PIXI.Container(); // transient particles above boards
    this.topLayer = new PIXI.Container(); // banners/flares above everything
    this.world.addChild(this.oceanLayer, this.boardLayer, this.fxLayer, this.topLayer);
    this.app.stage.addChild(this.world);

    // Decorative layers must NEVER intercept pointer events. Critically, applying a
    // filter to a container (the heat DisplacementFilter on fxLayer) makes it
    // participate in hit-testing and swallow taps meant for the board beneath — that
    // was the "can only tap the bottom rows once ships are burning" bug. Marking
    // them 'none' removes them (and their filters) from hit-testing entirely; only
    // boardLayer stays interactive.
    this.oceanLayer.eventMode = 'none';
    this.fxLayer.eventMode = 'none';
    this.topLayer.eventMode = 'none';

    // Make the root interactive so global pointer drags (placement) work.
    this.app.stage.eventMode = 'static';
    this.app.stage.hitArea = this.app.screen;

    this.updaters = [];
    this.resizeHooks = [];
    this.qualityHooks = [];
    this.shake = 0;
    this.shakeDecay = 0.86;
    this.hitStopUntil = 0;
    this.quality = 'full'; // 'full' | 'reduced'
    this.time = 0;
    // Adaptive quality: if sustained FPS drops, degrade once (no flapping).
    this._fpsElapsed = 0;
    this._fpsFrames = 0;
    this._degraded = false;

    this._onResize = this._onResize.bind(this);
    window.addEventListener('resize', this._onResize);
    window.addEventListener('orientationchange', this._onResize);
    // On real mobile, showing/hiding the address bar changes the VISIBLE viewport
    // without always firing window 'resize'. If the renderer keeps a stale size, the
    // board is drawn at one scale but taps map at another → cells stop responding
    // (you can end up only able to hit the bottom row). Relayout on visualViewport
    // changes too so the board and the hit-test always agree.
    if (window.visualViewport) {
      window.visualViewport.addEventListener('resize', this._onResize);
      window.visualViewport.addEventListener('scroll', this._onResize);
    }

    this.app.ticker.add(this._tick, this);
  }

  get width() { return this.app.renderer.width / this.app.renderer.resolution; }
  get height() { return this.app.renderer.height / this.app.renderer.resolution; }

  addUpdater(fn) { this.updaters.push(fn); return () => this.removeUpdater(fn); }
  removeUpdater(fn) { const i = this.updaters.indexOf(fn); if (i >= 0) this.updaters.splice(i, 1); }
  onResize(fn) { this.resizeHooks.push(fn); }
  onQualityChange(fn) { this.qualityHooks.push(fn); }

  addShake(amount) { this.shake = Math.min(this.shake + amount, 60); }
  hitStop(ms) { this.hitStopUntil = Math.max(this.hitStopUntil, performance.now() + ms); }

  setQuality(q) {
    if (q === this.quality) return;
    this.quality = q;
    for (const fn of this.qualityHooks) fn(q);
  }

  _tick() {
    const rawDt = clamp(this.app.ticker.deltaMS, 0, 50);
    this.time += rawDt;

    // Adaptive quality monitor: after a short warm-up, if FPS stays low, degrade
    // once. Tuned to react fast (placement happens in the first seconds) so a weak
    // phone sheds the expensive filters/particles before the player feels lag.
    if (!this._degraded) {
      this._fpsElapsed += rawDt;
      this._fpsFrames += 1;
      if (this._fpsElapsed >= 1200) {
        const fps = (this._fpsFrames * 1000) / this._fpsElapsed;
        this._fpsElapsed = 0;
        this._fpsFrames = 0;
        if (this.time > 2500 && fps < 50) {
          this._degraded = true;
          this.setQuality('reduced');
        }
      }
    }

    const frozen = performance.now() < this.hitStopUntil;
    const dt = frozen ? 0 : rawDt;

    // Screen shake (uses real time so the punch reads even during hit-stop).
    if (this.shake > 0.2) {
      const a = this.shake;
      this.world.x = (Math.random() * 2 - 1) * a;
      this.world.y = (Math.random() * 2 - 1) * a;
      this.world.rotation = (Math.random() * 2 - 1) * a * 0.0008;
      this.shake *= Math.pow(this.shakeDecay, rawDt / 16.67);
    } else if (this.shake !== 0) {
      this.shake = 0;
      this.world.x = 0; this.world.y = 0; this.world.rotation = 0;
    }

    for (const fn of this.updaters) fn(dt, this.time, rawDt);
  }

  _onResize() {
    const w = this.mountEl.clientWidth || window.innerWidth;
    const h = this.mountEl.clientHeight || window.innerHeight;
    this.app.renderer.resize(w, h);
    for (const fn of this.resizeHooks) fn(w, h);
  }

  resize() { this._onResize(); }
}
