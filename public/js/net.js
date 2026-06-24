// Net — thin wrapper over the Socket.IO client. Persists a clientId in
// localStorage so a refresh / brief disconnect reattaches to the same slot.

const CLIENT_ID_KEY = 'bn_client_id';

function getClientId() {
  let id = null;
  try {
    id = localStorage.getItem(CLIENT_ID_KEY);
    if (!id) {
      id = 'c_' + Math.random().toString(36).slice(2) + Date.now().toString(36);
      localStorage.setItem(CLIENT_ID_KEY, id);
    }
  } catch (_e) {
    id = 'c_' + Math.random().toString(36).slice(2) + Date.now().toString(36);
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
