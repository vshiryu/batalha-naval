'use strict';

/**
 * Batalha Naval — single-port host server.
 *
 * Serves the static client AND the Socket.IO endpoint on one HTTP port bound to
 * 0.0.0.0, so phones on the same Wi-Fi reach everything at http://<LAN-IP>:<PORT>.
 * No build step, no separate dev server, no CORS to configure.
 */

const os = require('os');
const path = require('path');
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');

const { Match } = require('./match');

const PORT = parseInt(process.env.PORT, 10) || 5180;
const HOST = '0.0.0.0';

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  // Generous timeouts so brief mobile network blips don't drop the socket.
  pingTimeout: 20000,
  pingInterval: 10000,
});

// ---------------------------------------------------------------- static files
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
// No-store on the client code: this is a LAN game served fresh from the notebook,
// and aggressive mobile caching was leaving a phone on an OLD client build (e.g.
// after a fix), so a simple reload now always picks up the latest JS/CSS/HTML.
app.use(express.static(PUBLIC_DIR, {
  extensions: ['html'],
  etag: false,
  lastModified: false,
  setHeaders: (res) => res.setHeader('Cache-Control', 'no-store, must-revalidate'),
}));

// Serve the PixiJS UMD build straight from node_modules (no copy/build step).
app.use(
  '/vendor/pixi',
  express.static(path.join(__dirname, '..', 'node_modules', 'pixi.js', 'dist'))
);

app.get('/health', (_req, res) => res.json({ ok: true }));

// ----------------------------------------------------------------- the match
const match = new Match(broadcastState);

/** Push the authoritative, per-perspective state to everyone connected. */
function broadcastState() {
  for (const [, session] of match.sessions) {
    if (!session.socketId) continue;
    const sock = io.sockets.sockets.get(session.socketId);
    if (!sock) continue;
    const payload = session.slot ? match.stateForSlot(session.slot) : match.spectatorState();
    sock.emit('state', payload);
  }
}

io.on('connection', (socket) => {
  const clientId = (socket.handshake.auth && socket.handshake.auth.clientId) || socket.id;
  const { role, slot } = match.join(clientId, socket.id);
  socket.data.clientId = clientId;
  socket.data.slot = slot;

  socket.emit('assigned', { role, slot, clientId, config: match.config() });
  broadcastState();

  // ---- placement ----
  socket.on('placement:set', (payload, ack) => {
    const s = match.slotOf(clientId);
    if (!s) return ack && ack({ ok: false, error: 'not_a_player' });
    const res = match.setFleet(s, payload && payload.placements);
    if (ack) ack(res);
    if (res.ok) broadcastState();
  });

  socket.on('placement:random', (_payload, ack) => {
    const s = match.slotOf(clientId);
    if (!s) return ack && ack({ ok: false, error: 'not_a_player' });
    const res = match.randomFleet(s);
    if (ack) ack(res);
    if (res.ok) broadcastState();
  });

  socket.on('placement:confirm', (_payload, ack) => {
    const s = match.slotOf(clientId);
    if (!s) return ack && ack({ ok: false, error: 'not_a_player' });
    const res = match.confirm(s);
    if (ack) ack(res);
    if (res.ok) broadcastState();
  });

  // ---- battle action ----
  socket.on('action', (action, ack) => {
    const s = match.slotOf(clientId);
    if (!s) return ack && ack({ ok: false, error: 'not_a_player' });
    const res = match.performAction(s, action);
    if (ack) ack(res);
    if (res.ok) broadcastState();
  });

  // ---- rematch ----
  socket.on('rematch', (_payload, ack) => {
    const s = match.slotOf(clientId);
    if (!s) return ack && ack({ ok: false, error: 'not_a_player' });
    const res = match.rematch(s);
    if (ack) ack(res);
    broadcastState();
  });

  socket.on('disconnect', () => {
    match.disconnect(clientId);
  });
});

// --------------------------------------------------------- LAN URL detection
/**
 * Return likely LAN URLs, best guess first. Real NICs (en, eth, wl prefixes) on
 * 192.168 / 10.x rank above docker/bridge/virtual interfaces (br-, veth, 172.x).
 */
function getLanUrls(port) {
  const ifaces = os.networkInterfaces();
  const candidates = [];
  for (const [name, addrs] of Object.entries(ifaces)) {
    for (const addr of addrs || []) {
      if (addr.family !== 'IPv4' || addr.internal) continue;
      let score = 0;
      if (/^(en|eth|wl|wlp|enp)/i.test(name)) score += 4;
      if (/^(br-|docker|veth|virbr|vmnet|tun|tap)/i.test(name)) score -= 5;
      if (addr.address.startsWith('192.168.')) score += 3;
      else if (addr.address.startsWith('10.')) score += 2;
      else if (/^172\.(1[6-9]|2\d|3[01])\./.test(addr.address)) score += 0;
      candidates.push({ name, address: addr.address, score });
    }
  }
  candidates.sort((a, b) => b.score - a.score);
  return candidates.map((c) => ({ url: `http://${c.address}:${port}`, iface: c.name }));
}

server.listen(PORT, HOST, () => {
  const urls = getLanUrls(PORT);
  const line = '═'.repeat(54);
  console.log(`\n${line}`);
  console.log('  ⚓  BATALHA NAVAL — servidor no ar');
  console.log(line);
  console.log(`  Local:     http://localhost:${PORT}`);
  if (urls.length) {
    console.log(`  Rede (LAN): ${urls[0].url}   ◄ abra este no celular`);
    for (let i = 1; i < urls.length; i++) {
      console.log(`              ${urls[i].url}  (${urls[i].iface})`);
    }
  } else {
    console.log('  Rede (LAN): nenhuma interface de rede externa detectada.');
  }
  console.log(line);
  console.log('  Conecte os dois celulares na MESMA rede Wi-Fi e abra a URL acima.');
  console.log(`${line}\n`);
});

module.exports = { app, server, io, match, getLanUrls };
