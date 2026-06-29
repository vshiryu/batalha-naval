// Net — thin wrapper over the Socket.IO client. Persists a clientId in
// localStorage so a refresh / brief disconnect reattaches to the same slot.

const CLIENT_ID_KEY = 'bn_client_id';

function getClientId() {
  // `?p=N` namespaces the stored id so two tabs/windows on ONE machine attach to
  // DIFFERENT slots (handy for testing both players locally). Without it, a single
  // shared id per origin is reused across tabs (so a refresh keeps the same slot).
  let suffix = '';
  try {
    const p = new URLSearchParams(location.search).get('p');
    if (p) suffix = '_' + String(p).replace(/[^a-zA-Z0-9]/g, '').slice(0, 8);
  } catch (_e) { /* ignore */ }
  const key = CLIENT_ID_KEY + suffix;
  const fresh = () => 'c_' + Math.random().toString(36).slice(2) + Date.now().toString(36);
  let id = null;
  try {
    id = localStorage.getItem(key);
    if (!id) { id = fresh(); localStorage.setItem(key, id); }
  } catch (_e) {
    id = fresh();
  }
  return id;
}

export class Net {
  constructor() {
    this.clientId = getClientId();
    this.handlers = {};
    this.socket = null;
    this.connected = false;
  }

  connect() {
    // `io` is the global from /socket.io/socket.io.js
    this.socket = window.io({
      auth: { clientId: this.clientId },
      transports: ['websocket', 'polling'],
      reconnection: true,
      reconnectionDelay: 600,
      reconnectionDelayMax: 3000,
    });

    this.socket.on('connect', () => { this.connected = true; this._emit('net:connected'); });
    this.socket.on('disconnect', (reason) => { this.connected = false; this._emit('net:disconnected', reason); });
    this.socket.on('connect_error', (err) => this._emit('net:error', err));
    this.socket.io.on('reconnect_attempt', (n) => this._emit('net:reconnecting', n));

    this.socket.on('assigned', (d) => this._emit('assigned', d));
    this.socket.on('state', (d) => this._emit('state', d));
  }

  on(event, fn) {
    (this.handlers[event] = this.handlers[event] || []).push(fn);
  }

  _emit(event, data) {
    (this.handlers[event] || []).forEach((fn) => fn(data));
  }

  // Request/response helpers (Socket.IO acks) returning a Promise.
  request(event, payload) {
    return new Promise((resolve) => {
      if (!this.socket) return resolve({ ok: false, error: 'no_socket' });
      this.socket.emit(event, payload || {}, (res) => resolve(res || { ok: true }));
    });
  }

  setFleet(placements) { return this.request('placement:set', { placements }); }
  randomFleet() { return this.request('placement:random', {}); }
  confirmPlacement() { return this.request('placement:confirm', {}); }
  sendAction(action) { return this.request('action', action); }
  rematch() { return this.request('rematch', {}); }
}
