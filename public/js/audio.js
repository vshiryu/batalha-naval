// AudioEngine — fully synthesized SFX + ambient via Web Audio API (no files).
// Lazily resumes on the first user gesture. Everything routes through a master
// gain so a single mute toggle silences all of it.

export class AudioEngine {
  constructor() {
    this.ctx = null;
    this.master = null;
    this.muted = false;
    this.ambientStarted = false;
    this._noiseBuf = null;
  }

  ensure() {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') this.ctx.resume();
      return;
    }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    this.ctx = new AC();
    this.master = this.ctx.createGain();
    this.master.gain.value = this.muted ? 0 : 0.9;
    this.master.connect(this.ctx.destination);
  }

  setMuted(muted) {
    this.muted = muted;
    if (this.master) {
      const now = this.ctx.currentTime;
      this.master.gain.cancelScheduledValues(now);
      this.master.gain.setTargetAtTime(muted ? 0 : 0.9, now, 0.03);
    }
  }

  _noise() {
    if (this._noiseBuf) return this._noiseBuf;
    const len = this.ctx.sampleRate * 2;
    const buf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const data = buf.getChannelData(0);
    let last = 0;
    for (let i = 0; i < len; i++) {
      // Brownish noise (smoother than white) for ocean/wind.
      const white = Math.random() * 2 - 1;
      last = (last + 0.02 * white) / 1.02;
      data[i] = last * 3.0;
    }
    this._noiseBuf = buf;
    return buf;
  }

  _env(node, t0, attack, peak, decay, sustain, dur, release) {
    const g = node.gain;
    g.cancelScheduledValues(t0);
    g.setValueAtTime(0.0001, t0);
    g.exponentialRampToValueAtTime(Math.max(0.0002, peak), t0 + attack);
    g.exponentialRampToValueAtTime(Math.max(0.0002, sustain), t0 + attack + decay);
    g.setValueAtTime(Math.max(0.0002, sustain), t0 + dur);
    g.exponentialRampToValueAtTime(0.0001, t0 + dur + release);
  }

  // ----------------------------------------------------------------- ambient
  startAmbient() {
    this.ensure();
    if (!this.ctx || this.ambientStarted) return;
    this.ambientStarted = true;
    const ctx = this.ctx;

    // Ocean: low-pass brown noise with a slow swelling LFO.
    const oceanSrc = ctx.createBufferSource();
    oceanSrc.buffer = this._noise();
    oceanSrc.loop = true;
    const oceanLp = ctx.createBiquadFilter();
    oceanLp.type = 'lowpass';
    oceanLp.frequency.value = 480;
    const oceanGain = ctx.createGain();
    oceanGain.gain.value = 0.16;
    const lfo = ctx.createOscillator();
    lfo.frequency.value = 0.12;
    const lfoGain = ctx.createGain();
    lfoGain.gain.value = 0.09;
    lfo.connect(lfoGain).connect(oceanGain.gain);
    oceanSrc.connect(oceanLp).connect(oceanGain).connect(this.master);

    // Wind: high-passed noise, gentle.
    const windSrc = ctx.createBufferSource();
    windSrc.buffer = this._noise();
    windSrc.loop = true;
    const windBp = ctx.createBiquadFilter();
    windBp.type = 'bandpass';
    windBp.frequency.value = 900;
    windBp.Q.value = 0.7;
    const windGain = ctx.createGain();
    windGain.gain.value = 0.05;
    const windLfo = ctx.createOscillator();
    windLfo.frequency.value = 0.07;
    const windLfoGain = ctx.createGain();
    windLfoGain.gain.value = 0.03;
    windLfo.connect(windLfoGain).connect(windGain.gain);
    windSrc.connect(windBp).connect(windGain).connect(this.master);

    oceanSrc.start();
    windSrc.start();
    lfo.start();
    windLfo.start();
  }

  // ------------------------------------------------------------------- sfx
  _tone({ freq = 440, type = 'sine', dur = 0.2, gain = 0.3, attack = 0.005, release = 0.08, slideTo = null, detune = 0 }) {
    if (!this.ctx) return;
    const ctx = this.ctx;
    const t0 = ctx.currentTime;
    const osc = ctx.createOscillator();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t0);
    if (detune) osc.detune.value = detune;
    if (slideTo) osc.frequency.exponentialRampToValueAtTime(slideTo, t0 + dur);
    const g = ctx.createGain();
    this._env(g, t0, attack, gain, dur * 0.5, gain * 0.6, dur, release);
    osc.connect(g).connect(this.master);
    osc.start(t0);
    osc.stop(t0 + dur + release + 0.05);
  }

  _noiseBurst({ dur = 0.3, type = 'lowpass', freq = 1000, q = 1, gain = 0.4, slideTo = null }) {
    if (!this.ctx) return;
    const ctx = this.ctx;
    const t0 = ctx.currentTime;
    const src = ctx.createBufferSource();
    src.buffer = this._noise();
    const filt = ctx.createBiquadFilter();
    filt.type = type;
    filt.frequency.setValueAtTime(freq, t0);
    filt.Q.value = q;
    if (slideTo) filt.frequency.exponentialRampToValueAtTime(slideTo, t0 + dur);
    const g = ctx.createGain();
    this._env(g, t0, 0.005, gain, dur * 0.4, gain * 0.3, dur, 0.1);
    src.connect(filt).connect(g).connect(this.master);
    src.start(t0);
    src.stop(t0 + dur + 0.15);
  }

  cannon() {
    this.ensure();
    this._noiseBurst({ dur: 0.18, type: 'lowpass', freq: 1600, slideTo: 300, gain: 0.5, q: 1.2 });
    this._tone({ freq: 140, type: 'square', dur: 0.14, gain: 0.32, slideTo: 60 });
  }

  whistle() {
    this.ensure();
    this._tone({ freq: 1700, type: 'sine', dur: 0.5, gain: 0.12, slideTo: 700, attack: 0.02, release: 0.1 });
  }

  explosion() {
    this.ensure();
    this._noiseBurst({ dur: 0.55, type: 'lowpass', freq: 1200, slideTo: 120, gain: 0.7, q: 0.8 });
    this._tone({ freq: 90, type: 'sawtooth', dur: 0.4, gain: 0.4, slideTo: 40 });
  }

  splash() {
    this.ensure();
    this._noiseBurst({ dur: 0.35, type: 'highpass', freq: 600, slideTo: 2600, gain: 0.32, q: 0.6 });
  }

  creak() {
    this.ensure();
    this._tone({ freq: 320, type: 'sawtooth', dur: 0.5, gain: 0.08, slideTo: 180, attack: 0.04 });
    this._tone({ freq: 90, type: 'square', dur: 0.5, gain: 0.06, slideTo: 70 });
  }

  sonarPing() {
    this.ensure();
    this._tone({ freq: 1320, type: 'sine', dur: 0.5, gain: 0.22, release: 0.5 });
    this._tone({ freq: 1980, type: 'sine', dur: 0.5, gain: 0.08, release: 0.5 });
  }

  gurgle() {
    this.ensure();
    this._noiseBurst({ dur: 0.9, type: 'lowpass', freq: 700, slideTo: 160, gain: 0.3, q: 2 });
    this._tone({ freq: 220, type: 'sine', dur: 0.8, gain: 0.1, slideTo: 70 });
  }

  victory() {
    this.ensure();
    const notes = [392, 523, 659, 784];
    notes.forEach((f, i) => {
      setTimeout(() => {
        this._tone({ freq: f, type: 'sawtooth', dur: 0.35, gain: 0.22, release: 0.2 });
        this._tone({ freq: f * 0.5, type: 'square', dur: 0.35, gain: 0.12 });
      }, i * 130);
    });
  }

  defeat() {
    this.ensure();
    const notes = [392, 311, 262, 196];
    notes.forEach((f, i) => {
      setTimeout(() => this._tone({ freq: f, type: 'triangle', dur: 0.5, gain: 0.18, release: 0.3 }), i * 220);
    });
  }

  uiClick() {
    this.ensure();
    this._tone({ freq: 660, type: 'square', dur: 0.05, gain: 0.12, release: 0.04 });
  }

  powerSelect() {
    this.ensure();
    this._tone({ freq: 520, type: 'sine', dur: 0.12, gain: 0.14, slideTo: 880 });
  }

  place() {
    this.ensure();
    this._tone({ freq: 300, type: 'sine', dur: 0.09, gain: 0.16, slideTo: 200 });
    this._noiseBurst({ dur: 0.08, type: 'lowpass', freq: 800, gain: 0.12 });
  }

  rotate() {
    this.ensure();
    this._tone({ freq: 440, type: 'triangle', dur: 0.07, gain: 0.1, slideTo: 620 });
  }
}
