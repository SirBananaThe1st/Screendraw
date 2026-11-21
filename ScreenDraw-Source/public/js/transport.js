// Connection to the ScreenDraw server. Uses a WebSocket; if WebSockets are
// blocked on this network it falls back to long-polling (no relayed video then).
// Reconnects automatically. Messages are JSON objects with a `type`.
(() => {
  const FATAL = new Set(['version', 'password', 'room', 'full', 'busy']);

  class Connection {
    constructor(server, hello) {
      this.server = server.replace(/\/+$/, '');
      this.hello = { ...hello, v: SD.VERSION };
      this.handlers = new Map();
      this.mode = null; // 'ws' | 'poll'
      this.closed = false;
      this.everOpened = false;
      this.retry = 0;
    }

    on(type, fn) {
      if (!this.handlers.has(type)) this.handlers.set(type, []);
      this.handlers.get(type).push(fn);
      return this;
    }

    emit(type, arg) {
      for (const fn of this.handlers.get(type) || []) { try { fn(arg); } catch (err) { console.error(err); } }
    }

    connect() { this._connectWs(); }

    get open() { return this.mode === 'ws' ? this.ws?.readyState === 1 : this.mode === 'poll' && !!this.sid; }
    get bufferedAmount() { return this.mode === 'ws' && this.ws ? this.ws.bufferedAmount : 0; }
    get canBinary() { return this.mode === 'ws'; }

    send(msg) {
      if (this.mode === 'ws') { if (this.ws?.readyState === 1) this.ws.send(JSON.stringify(msg)); }
      else if (this.mode === 'poll') { this.outbox.push(msg); this._schedulePollSend(); }
    }
    sendBinary(buf) { if (this.mode === 'ws' && this.ws?.readyState === 1) this.ws.send(buf); }

    updateHello(fields) { Object.assign(this.hello, fields); }

    close() {
      this.closed = true;
      clearTimeout(this.retryTimer);
      try { this.ws?.close(); } catch { /* ignore */ }
      if (this.mode === 'poll') this._pollLeave();
    }

    _dispatch(msg) {
      if (msg.type === 'welcome') { this.retry = 0; this.emit('state', 'connected'); }
      if (msg.type === 'error' && FATAL.has(msg.code)) this.fatal = msg;
      this.emit(msg.type, msg);
      this.emit('*', msg);
    }

    _scheduleReconnect() {
      if (this.closed || this.fatal) { this.emit('state', 'closed'); return; }
      this.emit('state', 'reconnecting');
      const delay = Math.min(10000, 1000 * 2 ** this.retry++);
      this.retryTimer = setTimeout(() => (this.mode === 'poll' ? this._connectPoll() : this._connectWs()), delay);
    }

    /* ----------------------------------------------------------- WebSocket */
    _connectWs() {
      const url = this.server.replace(/^http/i, 'ws') + '/ws';
      let ws;
      try { ws = new WebSocket(url); } catch { return this._connectPoll(); }
      ws.binaryType = 'arraybuffer';
      this.ws = ws;
      this.mode = 'ws';
      let opened = false;
      const giveUp = setTimeout(() => { if (!opened) { ws.onclose = null; try { ws.close(); } catch { /* */ } this._wsFailed(); } }, 6000);
      ws.onopen = () => {
        opened = true; this.everOpened = true;
        clearTimeout(giveUp);
        ws.send(JSON.stringify(this.hello));
      };
      ws.onmessage = (e) => {
        if (typeof e.data === 'string') { let m; try { m = JSON.parse(e.data); } catch { return; } this._dispatch(m); }
        else this.emit('binary', e.data);
      };
      ws.onclose = () => {
        clearTimeout(giveUp);
        if (this.ws !== ws) return;
        if (!opened && !this.everOpened) return this._wsFailed();
        this._scheduleReconnect();
      };
    }

    _wsFailed() {
      if (this.closed) return;
      console.warn('WebSocket unavailable, falling back to long-polling');
      this._connectPoll();
    }

    /* -------------------------------------------------------- long-polling */
    _connectPoll() {
      if (this.closed) return;
      this.mode = 'poll';
      this.sid = SD.uid(24);
      this.after = 0; this.epoch = null; this.outbox = [this.hello];
      this._schedulePollSend();
      this._pollLoop(this.sid);
    }

    _schedulePollSend() {
      if (this.sendTimer) return;
      this.sendTimer = setTimeout(async () => {
        this.sendTimer = null;
        if (!this.outbox.length || !this.sid) return;
        const batch = this.outbox.splice(0, 200);
        try {
          await fetch(`${this.server}/rt/send?sid=${this.sid}`, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: JSON.stringify(batch) });
        } catch { this.outbox.unshift(...batch); }
        if (this.outbox.length) this._schedulePollSend();
      }, 40);
    }

    async _pollLoop(sid) {
      let failures = 0;
      while (!this.closed && this.sid === sid) {
        try {
          const q = new URLSearchParams({ sid, after: this.after, epoch: this.epoch || '', t: Date.now() });
          const res = await fetch(`${this.server}/rt/poll?${q}`, { cache: 'no-store' });
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const data = await res.json();
          if (failures) { failures = 0; this.emit('state', 'connected'); }
          if (data.epoch !== this.epoch) { this.epoch = data.epoch; this.after = 0; }
          for (const msg of data.messages) {
            if (msg.seq <= this.after) continue;
            this.after = msg.seq;
            if (msg.type === 'error' && msg.code === 'session') { this.sid = null; return this._scheduleReconnect(); }
            this._dispatch(msg);
          }
        } catch {
          if (this.closed) return;
          if (!failures++) this.emit('state', 'reconnecting');
          await new Promise((r) => setTimeout(r, 2000));
        }
      }
    }

    _pollLeave() {
      try { navigator.sendBeacon(`${this.server}/rt/leave?sid=${this.sid}`, ''); } catch { /* best effort */ }
    }
  }

  SD.Connection = Connection;
})();
