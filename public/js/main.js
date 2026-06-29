// main — the client brain. Wires Net <-> UI <-> Scene <-> Audio, runs the phase
// state machine, the per-tool aim controller, and the action-animation pipeline.

import { Net } from './net.js';
import { UI, formatEvent } from './ui.js';
import { AudioEngine } from './audio.js';
import { Scene } from './scene.js';
import { PlacementController } from './placement.js';
import { POWERUP_META } from './constants.js';

const ERR_PT = {
  not_your_turn: 'Não é a sua vez.',
  insufficient_energy: 'Energia insuficiente.',
  already_targeted: 'Você já atacou essa célula.',
  need_three_cells: 'Selecione 3 células.',
  duplicate_cell: 'Células repetidas.',
  out_of_bounds: 'Fora do tabuleiro.',
  no_own_ship: 'Toque numa célula danificada de um navio seu.',
  cell_not_hit: 'Essa célula não está danificada.',
  ship_sunk: 'Esse navio já afundou.',
  wrong_phase: 'Ação indisponível agora.',
  fleet_incomplete: 'Posicione todos os navios.',
};

// One-line "what do I do now" hint shown when a power-up tool is selected, so it's
// obvious the next step is to tap the board to aim (then press the fire button).
const TOOL_HINT = {
  sonar: 'Toque numa célula para varrer a área 3×3.',
  triple: 'Toque em 3 células para a salva tripla.',
  torpedo: 'Escolha linha/coluna e toque para mirar.',
  bombard: 'Toque numa célula — atinge a área 3×3.',
  repair: 'Toque numa célula danificada de um navio seu.',
};

class Game {
  constructor() {
    this.net = new Net();
    this.ui = new UI();
    this.audio = new AudioEngine();
    this.scene = new Scene(document.getElementById('game-canvas'), this.audio);

    this.config = null;
    this.role = null;
    this.mySlot = null;
    this.state = null;
    this.prevPhase = null;
    this.lastSeq = 0;
    this.animating = false;
    this.pendingFire = false;

    this.tool = 'shoot';
    this.aim = this._freshAim();
    this.peeking = false;
    this.placement = null;

    this._initMute();
    this._wireUI();
    this._wireNet();
    this._initAudioGesture();
  }

  _freshAim() { return { cell: null, cells: [], orient: 'row', index: null, dir: 'forward' }; }

  _initMute() {
    let muted = false;
    try { muted = localStorage.getItem('bn_muted') === '1'; } catch (_e) {}
    this.muted = muted;
    this.audio.muted = muted;
    this.ui.setMute(muted);
  }

  _initAudioGesture() {
    const start = () => {
      this.audio.ensure();
      if (!this.muted) this.audio.startAmbient();
      window.removeEventListener('pointerdown', start);
      window.removeEventListener('keydown', start);
    };
    window.addEventListener('pointerdown', start);
    window.addEventListener('keydown', start);
  }

  // ----------------------------------------------------------------- wiring
  _wireUI() {
    const ui = this.ui;
    ui.on.mute = () => {
      this.muted = !this.muted;
      this.audio.setMuted(this.muted);
      if (!this.muted) this.audio.startAmbient();
      this.ui.setMute(this.muted);
      try { localStorage.setItem('bn_muted', this.muted ? '1' : '0'); } catch (_e) {}
    };
    ui.on.random = () => { this.audio.uiClick(); this.placement && this.placement.randomize(); };
    ui.on.rotate = () => { this.audio.uiClick(); this.placement && this.placement.rotateSelected(); };
    ui.on.selectShip = (id) => { this.placement && this.placement.selectShip(id); this.ui.setSelectedShip(id); };
    ui.on.confirm = () => this._confirmPlacement();
    ui.on.selectTool = (tool) => this._selectTool(tool);
    ui.on.fire = () => this._fire();
    ui.on.peek = () => this._togglePeek();
    ui.on.rematch = () => { this.audio.uiClick(); this.net.rematch(); this.ui.setRematchStatus('Aguardando o oponente aceitar…'); };
    ui.on.torpedoOrient = (o) => { this.aim.orient = o; this.aim.index = null; this._refreshAim(); };
    ui.on.torpedoDir = () => { this.aim.dir = this.aim.dir === 'forward' ? 'backward' : 'forward'; this._refreshAim(); };
  }

  _wireNet() {
    this.net.on('net:connected', () => this.ui.toast('Conectado'));
    this.net.on('net:disconnected', () => this.ui.toast('Conexão perdida — reconectando…', true));
    this.net.on('net:reconnecting', () => this.ui.toast('Reconectando…', true));
    this.net.on('assigned', (d) => this._onAssigned(d));
    this.net.on('state', (s) => this._onState(s));
    this.net.connect();
  }

  // ----------------------------------------------------------------- assign
  _onAssigned(d) {
    this.role = d.role;
    this.mySlot = d.slot;
    if (!this.config) {
      this.config = d.config;
      this.scene.build(d.config);
      this.ui.buildPowerups(d.config.powerUps);
      this.ui.buildShipTray(d.config.shipTypes, this.config.shipTypes[0].id);
      this.scene.enemyBoard.onTap = (cell) => this._onBoardTap(this.scene.enemyBoard, cell);
      this.scene.ownBoard.onTap = (cell) => this._onBoardTap(this.scene.ownBoard, cell);
      // Manual effects override: ?fx=low forces reduced; ?fx=high forces full
      // (and disables auto-degrade — handy for capturing the full look).
      try {
        const fx = new URLSearchParams(location.search).get('fx');
        if (fx === 'low') { this.scene.stage._degraded = true; this.scene.stage.setQuality('reduced'); }
        else if (fx === 'high') { this.scene.stage._degraded = true; this.scene.stage.setQuality('full'); }
      } catch (_e) { /* ignore */ }
    }
    if (d.role === 'spectator') {
      this.ui.showScreen('lobby');
      this.ui.setLobby('Partida cheia.', 'Você está como espectador');
    }
  }

  // ----------------------------------------------------------------- state
  _onState(state) {
    this.state = state;
    if (this.role === 'spectator') return this._renderSpectator(state);

    const phaseChanged = state.phase !== this.prevPhase;
    if (phaseChanged) this._onPhaseChange(state);

    const newAction = state.lastAction && state.lastAction.seq > this.lastSeq;

    if (state.phase === 'battle') {
      this._renderBattleHud(state);
      if (newAction) {
        this.lastSeq = state.lastAction.seq;
        this._animateAndRender(state);
      } else {
        this.scene.renderState(state);
        this._refreshAim();
      }
    } else if (state.phase === 'placement') {
      this._renderPlacementHud(state);
    } else if (state.phase === 'finished') {
      if (newAction) { this.lastSeq = state.lastAction.seq; this._animateAndRender(state); }
      else this.scene.renderState(state);
      this._renderEnd(state);
    } else {
      // lobby
      this.scene.renderState(state);
      this._renderLobby(state);
    }
    this.prevPhase = state.phase;
  }

  _onPhaseChange(state) {
    // Cancel any pending end-screen reveal: a rematch can reset to placement
    // within the end-screen delay, and a stale timer would cover the new screen.
    clearTimeout(this._endTimer);
    if (state.phase === 'placement') {
      this.lastSeq = 0;
      this.ui.showScreen('placement');
      this.scene.setPhaseView('placement');
      if (this.placement) this.placement.exit();
      this.placement = new PlacementController(this.scene, this.config, this.audio);
      this.placement.enter();
      this.ui.setSelectedShip(this.config.shipTypes[0].id);
      this.tool = 'shoot'; this.aim = this._freshAim(); this.peeking = false;
    } else if (state.phase === 'battle') {
      if (this.placement) { this.placement.exit(); this.placement = null; }
      this.ui.showScreen('battle');
      this.ui.setSelectedTool('shoot');
      this.tool = 'shoot'; this.aim = this._freshAim(); this.peeking = false;
      this.scene.setPhaseView('battle');
      this.scene.renderState(state);
    } else if (state.phase === 'finished') {
      this.ui.setRematchStatus('');
      // Reveal the end screen ONCE, after the final sinking animation breathes.
      const win = state.winner === this.mySlot;
      this._endTimer = setTimeout(() => {
        if (!this.state || this.state.phase !== 'finished') return; // rematch happened first
        this.ui.showScreen('end');
        this.ui.setEnd(win, win ? 'Frota inimiga destruída!' : 'Sua frota foi afundada.', '');
        if (win) this.scene.victory(); else this.scene.defeat();
      }, 1400);
    } else if (state.phase === 'lobby') {
      this.ui.showScreen('lobby');
    }
  }

  // ----------------------------------------------------------------- lobby
  _renderLobby(state) {
    this.ui.showScreen('lobby');
    const roleTxt = this.mySlot ? `Você é o Jogador ${this.mySlot}` : '';
    this.ui.setLobby('Aguardando o oponente…', roleTxt);
  }
  _renderSpectator(state) {
    this.ui.showScreen('lobby');
    const map = { lobby: 'Aguardando jogadores…', placement: 'Jogadores posicionando a frota…', battle: 'Batalha em andamento…', finished: 'Partida encerrada.' };
    this.ui.setLobby(map[state.phase] || 'Partida em andamento…', 'Espectador');
  }

  // ----------------------------------------------------------------- placement
  _renderPlacementHud(state) {
    const opp = state.enemy;
    let txt = 'Oponente: posicionando…';
    if (!opp.present) txt = 'Aguardando oponente conectar…';
    else if (opp.ready) txt = 'Oponente: pronto ✓';
    this.ui.setOpponentStatus(txt);
    // keep my own fleet visible while placing (placement controller owns sprites)
  }

  async _confirmPlacement() {
    if (!this.placement) return;
    this.audio.uiClick();
    const placements = this.placement.getPlacements();
    const setRes = await this.net.setFleet(placements);
    if (!setRes.ok) { this.ui.toast(ERR_PT[setRes.error] || 'Posicionamento inválido.', true); return; }
    const res = await this.net.confirmPlacement();
    if (!res.ok) { this.ui.toast(ERR_PT[res.error] || 'Não foi possível confirmar.', true); return; }
    this.ui.setOpponentStatus('Você está pronto. Aguardando oponente…');
    this.ui.el['btn-confirm'].disabled = true;
    setTimeout(() => { if (this.ui.el['btn-confirm']) this.ui.el['btn-confirm'].disabled = false; }, 100);
  }

  // ----------------------------------------------------------------- battle HUD
  _renderBattleHud(state) {
    const yours = state.yourTurn;
    this.ui.setTurnBanner(yours ? 'SUA VEZ' : 'VEZ DO OPONENTE', yours ? 'you' : 'enemy');
    this.ui.setEnergy(state.you.energy, 12);
    this.ui.setFleetStrips(state);
    this.ui.setPowerupAvailability(state.you.energy, yours, this.config.powerUps);
    // latest event ticker
    const ev = state.events && state.events[state.events.length - 1];
    if (ev && ev.id !== this._lastEventId) { this._lastEventId = ev.id; this.ui.pushTicker(formatEvent(ev, this.mySlot)); }
    if (state._justBecameMyTurn) this.audio.powerSelect();
    this._updateFireButton();
  }

  _selectTool(tool) {
    if (!this.state || this.state.phase !== 'battle') return;
    // Tappable-when-disabled: explain WHY instead of silently doing nothing.
    if (!this.state.yourTurn) { this.ui.toast('Aguarde a sua vez.', true); return; }
    const pu = this.config.powerUps[tool] || { cost: 0, name: tool };
    if (this.state.you.energy < pu.cost) {
      this.ui.toast(`Energia insuficiente: ${pu.name} custa ⚡${pu.cost} (você tem ⚡${this.state.you.energy}).`, true);
      return;
    }
    this.audio.powerSelect();
    this.tool = tool;
    this.aim = this._freshAim();
    this.peeking = false; // selecting a tool always returns to its own board focus
    this.ui.setSelectedTool(tool);
    // repair aims at your own board; everything else at the enemy board
    this.scene.setFocus(tool === 'repair' ? 'own' : 'enemy');
    this.scene.renderState(this.state);
    this.ui.setTorpedoControls(tool === 'torpedo', this.aim.orient, this._dirLabel());
    this._refreshAim();
    if (TOOL_HINT[tool]) this.ui.toast(TOOL_HINT[tool]);
  }

  _togglePeek() {
    if (this.tool === 'repair') return;
    this.audio.uiClick();
    this.peeking = !this.peeking;
    this.scene.setFocus(this.peeking ? 'own' : 'enemy');
    this.scene.renderState(this.state);
    this._refreshAim();
  }

  _dirLabel() {
    if (this.aim.orient === 'row') return this.aim.dir === 'forward' ? 'Sentido →' : 'Sentido ←';
    return this.aim.dir === 'forward' ? 'Sentido ↓' : 'Sentido ↑';
  }

  _onBoardTap(board, cell) {
    if (!this.state || this.state.phase !== 'battle' || !this.state.yourTurn || this.animating) {
      if (this.state && !this.state.yourTurn) this.ui.toast('Aguarde a sua vez.');
      return;
    }
    const view = this.state.enemy.view;
    const k = cell.r * this.config.boardSize + cell.c;

    if (this.tool === 'repair') {
      if (board.side !== 'own') return;
      // must be a hit cell of a non-sunk own ship
      const ship = this.state.you.fleet.find((s) => !s.sunk && s.cells.some((c2, i) => c2.r === cell.r && c2.c === cell.c && s.hits[i]));
      if (!ship) { this.ui.toast('Toque numa célula danificada de um navio seu.'); return; }
      this.aim.cell = cell;
    } else {
      if (board.side !== 'enemy') return;
      if (this.tool === 'shoot') {
        if (view[k] !== 'unknown') { this.ui.toast('Você já atacou aí.'); return; }
        this.aim.cell = cell;
      } else if (this.tool === 'sonar' || this.tool === 'bombard') {
        this.aim.cell = cell;
      } else if (this.tool === 'triple') {
        const exists = this.aim.cells.findIndex((c2) => c2.r === cell.r && c2.c === cell.c);
        if (exists >= 0) this.aim.cells.splice(exists, 1);
        else {
          if (view[k] !== 'unknown') { this.ui.toast('Você já atacou aí.'); return; }
          if (this.aim.cells.length >= 3) { this.ui.toast('Máximo de 3 células.'); return; }
          this.aim.cells.push(cell);
        }
      } else if (this.tool === 'torpedo') {
        this.aim.index = this.aim.orient === 'row' ? cell.r : cell.c;
      }
    }
    this.audio.uiClick();
    this._refreshAim();
  }

  _aimCells() {
    const N = this.config.boardSize;
    const clampC = (v) => Math.max(0, Math.min(N - 1, v));
    if (this.tool === 'repair' || this.tool === 'shoot') return this.aim.cell ? [this.aim.cell] : [];
    if (this.tool === 'triple') return this.aim.cells.slice();
    if (this.tool === 'sonar' || this.tool === 'bombard') {
      if (!this.aim.cell) return [];
      const out = [];
      for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) {
        const r = this.aim.cell.r + dr, c = this.aim.cell.c + dc;
        if (r >= 0 && c >= 0 && r < N && c < N) out.push({ r, c });
      }
      return out;
    }
    if (this.tool === 'torpedo') {
      if (this.aim.index == null) return [];
      const out = [];
      for (let i = 0; i < N; i++) out.push(this.aim.orient === 'row' ? { r: this.aim.index, c: i } : { r: i, c: this.aim.index });
      return out;
    }
    return [];
  }

  _refreshAim() {
    if (!this.state || this.state.phase !== 'battle') return;
    const board = this.tool === 'repair' ? this.scene.ownBoard : this.scene.enemyBoard;
    const other = this.tool === 'repair' ? this.scene.enemyBoard : this.scene.ownBoard;
    other.clearAim && other.clearAim();
    board.clearAim();
    if (this.peeking && this.tool !== 'repair') { this._updateFireButton(); return; }
    const cells = this._aimCells();
    const kind = this.tool === 'repair' ? 'repair'
      : this.tool === 'triple' ? 'multi'
      : (this.tool === 'sonar' || this.tool === 'bombard') ? 'area'
      : this.tool === 'torpedo' ? 'line' : 'target';
    board.setAim(cells, kind);
    if ((this.tool === 'shoot' || this.tool === 'repair') && this.aim.cell) board.setCrosshair(this.aim.cell, this.tool === 'repair' ? 'repair' : 'target');
    if (this.tool === 'torpedo') this.ui.setTorpedoControls(true, this.aim.orient, this._dirLabel());
    else this.ui.setTorpedoControls(false);
    this._updateFireButton();
  }

  _readyToFire() {
    if (!this.state || !this.state.yourTurn || this.pendingFire) return false;
    const cost = this.config.powerUps[this.tool].cost;
    if (this.state.you.energy < cost) return false;
    switch (this.tool) {
      case 'shoot': case 'sonar': case 'bombard': case 'repair': return !!this.aim.cell;
      case 'triple': return this.aim.cells.length === 3;
      case 'torpedo': return this.aim.index != null;
      default: return false;
    }
  }

  _updateFireButton() {
    const label = (POWERUP_META[this.tool] || {}).fire || 'FOGO!';
    const ready = this._readyToFire();
    this.ui.setFireButton(label, ready, ready);
  }

  async _fire() {
    if (!this._readyToFire()) return;
    this.pendingFire = true;
    this._updateFireButton();
    const action = this._buildAction();
    this.audio.uiClick();
    const res = await this.net.sendAction(action);
    this.pendingFire = false;
    if (!res.ok) {
      this.ui.toast(ERR_PT[res.error] || 'Ação inválida.', true);
      this._updateFireButton();
      return;
    }
    // success: reset aim; the broadcast state drives the animation.
    this.aim = this._freshAim();
    if (this.tool === 'repair') { this.tool = 'shoot'; this.ui.setSelectedTool('shoot'); this.scene.setFocus('enemy'); }
  }

  _buildAction() {
    switch (this.tool) {
      case 'shoot': return { type: 'shoot', cell: this.aim.cell };
      case 'sonar': return { type: 'sonar', cell: this.aim.cell };
      case 'bombard': return { type: 'bombard', cell: this.aim.cell };
      case 'repair': return { type: 'repair', cell: this.aim.cell };
      case 'triple': return { type: 'triple', cells: this.aim.cells };
      case 'torpedo': return { type: 'torpedo', line: { orientation: this.aim.orient, index: this.aim.index, direction: this.aim.dir } };
      default: return { type: 'shoot', cell: this.aim.cell };
    }
  }

  // ----------------------------------------------------------------- animation
  async _animateAndRender(state) {
    this.animating = true;
    this._updateFireButton();
    // render everything except the cells the action is about to reveal
    const suppress = this._pendingCells(state.lastAction);
    this.scene.renderState(state, { suppress });
    try {
      // Safety race: the choreography is a web of setTimeout + effect callbacks.
      // If one effect ever fails to call its `done`, that Promise never resolves
      // and `animating` would stay true forever — freezing all board input. Cap
      // the wait so the board always becomes interactive again.
      await Promise.race([
        this.scene.animateAction(state, this.mySlot),
        new Promise((res) => setTimeout(res, 5000)),
      ]);
    } catch (_e) { /* ignore */ }
    finally {
      this.scene.renderState(state); // reconcile (wrecks, sonar, etc.)
      this.animating = false;
      if (state.phase === 'battle') this._refreshAim();
    }
  }

  _pendingCells(la) {
    const set = new Set();
    if (!la) return set;
    for (const s of la.shots || []) set.add(`${s.r},${s.c}`);
    if (la.torpedo && la.torpedo.impact) set.add(`${la.torpedo.impact.r},${la.torpedo.impact.c}`);
    return set;
  }

  // ----------------------------------------------------------------- end
  _renderEnd(state) {
    // The end screen + victory/defeat FX are armed once in _onPhaseChange.
    // Here we only keep the rematch-vote status text fresh on each broadcast.
    const r = state.rematch || {};
    let msg = '';
    if (r.you && !r.opponent) msg = 'Aguardando o oponente aceitar a revanche…';
    else if (!r.you && r.opponent) msg = 'O oponente quer revanche!';
    else if (r.you && r.opponent) msg = 'Iniciando revanche…';
    this.ui.setRematchStatus(msg);
  }
}

window.addEventListener('DOMContentLoaded', () => { window.__game = new Game(); });
