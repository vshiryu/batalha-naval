// UI — owns all DOM. Renders the lobby/placement/battle/end screens and the HUD
// (turn banner, energy, power-up panel, fleet strips, event ticker). Emits user
// intents through `this.on.*` callbacks set by main; holds no game logic.

import { POWERUP_META } from './constants.js';

const PU_ICONS = {
  crosshair: '<svg viewBox="0 0 24 24" fill="none" stroke="#a5f3fc" stroke-width="1.7"><circle cx="12" cy="12" r="7"/><path d="M12 2v4M12 18v4M2 12h4M18 12h4"/><circle cx="12" cy="12" r="1.6" fill="#a5f3fc"/></svg>',
  sonar: '<svg viewBox="0 0 24 24" fill="none" stroke="#38bdf8" stroke-width="1.7"><path d="M4 18a8 8 0 0 1 16 0"/><path d="M7.5 18a4.5 4.5 0 0 1 9 0"/><circle cx="12" cy="18" r="1.4" fill="#38bdf8"/></svg>',
  triple: '<svg viewBox="0 0 24 24" fill="#2dd4bf"><circle cx="5" cy="12" r="2.4"/><circle cx="12" cy="12" r="2.4"/><circle cx="19" cy="12" r="2.4"/></svg>',
  torpedo: '<svg viewBox="0 0 24 24" fill="none" stroke="#a78bfa" stroke-width="1.7"><path d="M3 12h13"/><path d="M16 9c3 0 5 1.5 5 3s-2 3-5 3z" fill="#a78bfa"/><path d="M5 9v6M8 9.5v5"/></svg>',
  bombard: '<svg viewBox="0 0 24 24" fill="none" stroke="#f59e0b" stroke-width="1.5"><rect x="3" y="3" width="5" height="5"/><rect x="9.5" y="3" width="5" height="5"/><rect x="16" y="3" width="5" height="5"/><rect x="3" y="9.5" width="5" height="5"/><rect x="9.5" y="9.5" width="5" height="5"/><rect x="16" y="9.5" width="5" height="5"/><rect x="3" y="16" width="5" height="5"/><rect x="9.5" y="16" width="5" height="5"/><rect x="16" y="16" width="5" height="5"/></svg>',
  repair: '<svg viewBox="0 0 24 24" fill="none" stroke="#2dd4bf" stroke-width="1.7"><path d="M14 6a3.5 3.5 0 0 0-4.7 4.3l-5 5a1.8 1.8 0 0 0 2.5 2.5l5-5A3.5 3.5 0 0 0 18 10l-2.3 2.3-2-2L16 8"/></svg>',
};

export class UI {
  constructor() {
    this.on = {};
    this.el = {};
    const $ = (id) => document.getElementById(id);
    [
      'topbar', 'btn-mute', 'turn-banner', 'turn-text', 'enemy-fleet', 'event-ticker',
      'screen-lobby', 'lobby-text', 'lobby-role',
      'screen-placement', 'opponent-status', 'placement-tray', 'btn-random', 'btn-rotate', 'btn-confirm',
      'screen-battle', 'energy-wrap', 'energy-fill', 'energy-val', 'powerups',
      'torpedo-controls', 't-dir', 'btn-peek', 'btn-fire', 'your-fleet',
      'screen-end', 'end-title', 'end-sub', 'end-stats', 'btn-rematch', 'rematch-status', 'toast',
    ].forEach((id) => { this.el[id] = $(id); });

    this._tickerTimer = null;
    this._wire();
  }

  _wire() {
    const fire = (name, arg) => () => this.on[name] && this.on[name](arg);
    this.el['btn-random'].addEventListener('click', fire('random'));
    this.el['btn-rotate'].addEventListener('click', fire('rotate'));
    this.el['btn-confirm'].addEventListener('click', fire('confirm'));
    this.el['btn-fire'].addEventListener('click', fire('fire'));
    this.el['btn-peek'].addEventListener('click', fire('peek'));
    this.el['btn-mute'].addEventListener('click', fire('mute'));
    this.el['btn-rematch'].addEventListener('click', fire('rematch'));
    this.el['torpedo-controls'].querySelectorAll('[data-orient]').forEach((b) => {
      b.addEventListener('click', () => this.on.torpedoOrient && this.on.torpedoOrient(b.dataset.orient));
    });
    this.el['t-dir'].addEventListener('click', fire('torpedoDir'));
  }

  showScreen(name) {
    for (const s of ['lobby', 'placement', 'battle', 'end']) {
      this.el[`screen-${s}`].classList.toggle('hidden', s !== name);
    }
    const showTop = name === 'placement' || name === 'battle';
    this.el.topbar.classList.toggle('hidden', !showTop);
    if (name !== 'battle' && name !== 'placement') this.el['event-ticker'].classList.add('hidden');
  }

  // ----- lobby
  setLobby(text, role) {
    this.el['lobby-text'].textContent = text;
    this.el['lobby-role'].textContent = role || '';
  }

  // ----- placement
  buildShipTray(shipTypes, selected) {
    const tray = this.el['placement-tray'];
    tray.innerHTML = '';
    for (const t of shipTypes) {
      const d = document.createElement('div');
      d.className = 'tray-ship' + (t.id === selected ? ' selected' : '');
      d.dataset.id = t.id;
      d.innerHTML = `<div class="bar" style="width:${10 + t.size * 8}px"></div><span>${t.name}</span>`;
      d.addEventListener('click', () => this.on.selectShip && this.on.selectShip(t.id));
      tray.appendChild(d);
    }
  }
  setSelectedShip(id) {
    this.el['placement-tray'].querySelectorAll('.tray-ship').forEach((d) => {
      d.classList.toggle('selected', d.dataset.id === id);
    });
  }
  setOpponentStatus(text) { this.el['opponent-status'].textContent = text; }

  // ----- battle / power-ups
  buildPowerups(powerUps) {
    const wrap = this.el.powerups;
    wrap.innerHTML = '';
    for (const id of Object.keys(powerUps)) {
      const p = powerUps[id];
      const meta = POWERUP_META[id] || { icon: 'crosshair', short: p.name };
      const b = document.createElement('button');
      b.className = 'pu';
      b.dataset.tool = id;
      const costLabel = p.cost === 0 ? 'Grátis' : `⚡${p.cost}`;
      b.innerHTML = `<span class="pu-icon">${PU_ICONS[meta.icon] || ''}</span>` +
        `<span class="pu-name">${meta.short}</span>` +
        `<span class="pu-cost ${p.cost === 0 ? 'free' : ''}">${costLabel}</span>`;
      b.addEventListener('click', () => this.on.selectTool && this.on.selectTool(id));
      wrap.appendChild(b);
    }
  }

  setSelectedTool(tool) {
    this.el.powerups.querySelectorAll('.pu').forEach((b) => b.classList.toggle('selected', b.dataset.tool === tool));
  }

  setPowerupAvailability(energy, yourTurn, powerUps) {
    this.el.powerups.querySelectorAll('.pu').forEach((b) => {
      const cost = powerUps[b.dataset.tool].cost;
      const disabled = !yourTurn || energy < cost;
      b.classList.toggle('disabled', disabled);
    });
  }

  setEnergy(value, max) {
    const pct = Math.max(0, Math.min(100, (value / (max || 12)) * 100));
    this.el['energy-fill'].style.width = pct + '%';
    const prev = this.el['energy-val'].textContent;
    this.el['energy-val'].textContent = value;
    if (String(value) !== prev) {
      this.el['energy-wrap'].classList.remove('bump');
      void this.el['energy-wrap'].offsetWidth;
      this.el['energy-wrap'].classList.add('bump');
    }
  }

  setTurnBanner(text, who) {
    this.el['turn-text'].textContent = text;
    const b = this.el['turn-banner'];
    b.classList.toggle('you', who === 'you');
    b.classList.toggle('enemy', who === 'enemy');
    b.classList.toggle('pulse', who === 'you');
  }

  setFireButton(label, enabled, ready) {
    const b = this.el['btn-fire'];
    b.textContent = label;
    b.disabled = !enabled;
    b.classList.toggle('ready', !!ready && enabled);
  }

  setTorpedoControls(visible, orient, dirLabel) {
    this.el['torpedo-controls'].classList.toggle('hidden', !visible);
    if (visible) {
      this.el['torpedo-controls'].querySelectorAll('[data-orient]').forEach((bn) => {
        bn.classList.toggle('active', bn.dataset.orient === orient);
      });
      this.el['t-dir'].textContent = dirLabel;
    }
  }

  setFleetStrips(state) {
    // enemy: generic pips (count), sunk ones dimmed
    const ef = this.el['enemy-fleet'];
    ef.innerHTML = '';
    const total = state.enemy.shipsTotal || 5;
    const sunk = total - (state.enemy.shipsRemaining != null ? state.enemy.shipsRemaining : total);
    const sunkSizes = (state.enemy.sunkShips || []).map((s) => s.size);
    for (let i = 0; i < total; i++) {
      const pip = document.createElement('div');
      pip.className = 'ship-pip' + (i < sunk ? ' sunk' : '');
      pip.style.width = ((sunkSizes[i] || 3) * 7 + 8) + 'px';
      ef.appendChild(pip);
    }
    const yf = this.el['your-fleet'];
    yf.innerHTML = '';
    for (const s of state.you.fleet) {
      const pip = document.createElement('div');
      pip.className = 'ship-pip' + (s.sunk ? ' sunk' : '');
      pip.style.width = (s.size * 6 + 6) + 'px';
      yf.appendChild(pip);
    }
  }

  pushTicker(text) {
    if (!text) return;
    const t = this.el['event-ticker'];
    t.textContent = text;
    t.classList.remove('hidden');
    t.style.animation = 'none'; void t.offsetWidth; t.style.animation = '';
    clearTimeout(this._tickerTimer);
    this._tickerTimer = setTimeout(() => t.classList.add('hidden'), 4200);
  }

  setMute(muted) { this.el['btn-mute'].classList.toggle('muted-on', muted); }

  toast(text, warn) {
    const t = this.el.toast;
    t.textContent = text;
    t.classList.toggle('warn', !!warn);
    t.classList.remove('hidden');
    clearTimeout(this._toastTimer);
    this._toastTimer = setTimeout(() => t.classList.add('hidden'), 3200);
  }

  setEnd(win, sub, stats) {
    this.el['end-title'].textContent = win ? 'VITÓRIA' : 'DERROTA';
    this.el['end-title'].className = win ? 'win' : 'lose';
    this.el['end-sub'].textContent = sub || '';
    this.el['end-stats'].textContent = stats || '';
  }

  setRematchStatus(text) { this.el['rematch-status'].textContent = text || ''; }
}

// pt-BR formatting for structured engine events.
export function formatEvent(ev, mySlot) {
  if (!ev) return '';
  const mine = ev.attacker === mySlot;
  switch (ev.type) {
    case 'battle_start': return 'A batalha começou!';
    case 'hit': return mine ? 'Acerto em cheio!' : 'O oponente acertou seu navio!';
    case 'miss': return mine ? 'Água.' : 'O oponente errou — água!';
    case 'sunk': return mine ? `Você afundou o ${ev.shipName} inimigo!` : `O oponente afundou seu ${ev.shipName}!`;
    case 'sonar': return mine ? `Sonar: ${ev.found} contato(s) na área.` : 'O oponente varreu uma área com o sonar.';
    case 'repair': return mine ? 'Reparo concluído — casco restaurado.' : 'O oponente reparou um navio.';
    case 'torpedo_miss': return mine ? 'Torpedo não encontrou alvo.' : 'Torpedo inimigo passou batido.';
    case 'win': return ev.winner === mySlot ? 'Vitória! Frota inimiga destruída.' : 'Derrota — sua frota foi afundada.';
    default: return '';
  }
}
