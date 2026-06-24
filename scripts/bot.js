'use strict';

/**
 * Scripted Socket.IO player — a headless second player for multiplayer testing
 * and demos. Connects to the server, places a fleet, confirms, and (in --auto
 * mode) plays a normal shot on a random unknown enemy cell each of its turns.
 *
 * It also continuously ASSERTS anti-cheat: if any received state ever contains
 * the enemy fleet, it logs a CHEAT line and exits non-zero.
 *
 * Usage:
 *   node scripts/bot.js --url=http://localhost:5180 [--id=bot2] [--name=Bot]
 *                       [--auto] [--no-confirm] [--quiet]
 *
 * Flags:
 *   --auto        play to the end (normal shots), then idle for rematch
 *   --no-confirm  place a fleet but do not confirm (stay in placement)
 *   --quiet       only print important lines (assigned / cheat / win)
 */

const { io } = require('socket.io-client');

const args = Object.fromEntries(process.argv.slice(2).map((a) => {
  const m = a.match(/^--([^=]+)(?:=(.*))?$/);
  return m ? [m[1], m[2] === undefined ? true : m[2]] : [a, true];
}));

const URL = args.url || 'http://localhost:5180';
const CLIENT_ID = args.id || 'bot_' + Math.random().toString(36).slice(2, 8);
const AUTO = !!args.auto;
const CONFIRM = !args['no-confirm'];
const QUIET = !!args.quiet;
const FIXED = !!args.fixed;

// Deterministic layout (each ship on its own even row) — same shape the engine
// tests use. With --fixed the bot logs every occupied cell so a test driver can
// sink this fleet precisely from the other side (without the client ever seeing it).
const FIXED_LAYOUT = [
  { id: 'carrier', r: 0, c: 0, orientation: 'h', size: 5 },
  { id: 'battleship', r: 2, c: 0, orientation: 'h', size: 4 },
  { id: 'cruiser', r: 4, c: 0, orientation: 'h', size: 3 },
  { id: 'submarine', r: 6, c: 0, orientation: 'h', size: 3 },
  { id: 'destroyer', r: 8, c: 0, orientation: 'h', size: 2 },
];
function fixedCells() {
  const cells = [];
  for (const s of FIXED_LAYOUT) for (let i = 0; i < s.size; i++) cells.push({ r: s.r, c: s.c + i });
  return cells;
}

const log = (...a) => console.log(`[${CLIENT_ID}]`, ...a);
const vlog = (...a) => { if (!QUIET) log(...a); };

let slot = null;
let confirmedOnce = false;
let lastSeq = -1;
let prevPhase = null;

const sock = io(URL, { auth: { clientId: CLIENT_ID }, transports: ['websocket', 'polling'], forceNew: true });

sock.on('connect', () => vlog('socket conectado', sock.id));
sock.on('disconnect', (r) => vlog('socket desconectado', r));

sock.on('assigned', (d) => {
  slot = d.slot;
  log(`assigned role=${d.role} slot=${d.slot}`);
});

function emit(ev, payload) {
  return new Promise((resolve) => sock.emit(ev, payload || {}, resolve));
}

async function place() {
  let res;
  if (FIXED) {
    res = await emit('placement:set', { placements: FIXED_LAYOUT.map(({ id, r, c, orientation }) => ({ id, r, c, orientation })) });
    log('FIXED_CELLS=' + JSON.stringify(fixedCells())); // target list for a test driver
  } else {
    res = await emit('placement:random', {});
  }
  if (res && res.ok) vlog('frota posicionada' + (FIXED ? ' (fixa)' : ' (aleatória)'));
  if (CONFIRM && !confirmedOnce) {
    confirmedOnce = true;
    const c = await emit('placement:confirm', {});
    vlog('confirmado:', c && c.ok);
  }
}

function unknownCells(state) {
  const out = [];
  const N = Math.sqrt(state.enemy.view.length) | 0;
  state.enemy.view.forEach((v, i) => { if (v === 'unknown') out.push({ r: Math.floor(i / N), c: i % N }); });
  return out;
}

async function takeTurn(state) {
  const opts = unknownCells(state);
  if (!opts.length) return;
  const cell = opts[Math.floor(Math.random() * opts.length)];
  const res = await emit('action', { type: 'shoot', cell });
  if (!res || !res.ok) vlog('ação falhou:', res && res.error);
}

sock.on('state', async (state) => {
  // anti-cheat watchdog
  if (state.enemy && (state.enemy.fleet || state.enemy.ships || state.enemy.grid)) {
    log('CHEAT! payload do inimigo contém a frota:', Object.keys(state.enemy));
    process.exit(2);
  }

  // A rematch resets the match to placement — allow the bot to place again.
  if (state.phase === 'placement' && prevPhase && prevPhase !== 'placement') confirmedOnce = false;
  prevPhase = state.phase;

  if (state.phase === 'placement' && !confirmedOnce) {
    await place();
  } else if (state.phase === 'battle' && AUTO && state.yourTurn) {
    if (state.lastAction) lastSeq = state.lastAction.seq;
    setTimeout(() => takeTurn(state), 300); // small delay so animations on the human side breathe
  } else if (state.phase === 'finished') {
    if (state.winner === slot) log('RESULTADO: venci');
    else log('RESULTADO: perdi');
  }
});

process.on('SIGINT', () => { sock.close(); process.exit(0); });
process.on('SIGTERM', () => { sock.close(); process.exit(0); });

log(`conectando a ${URL} …`);
