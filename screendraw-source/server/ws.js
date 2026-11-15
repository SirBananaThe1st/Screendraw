// Minimal dependency-free WebSocket server side (RFC 6455): text + binary
// messages, fragmentation, ping/pong keep-alive, close. No compression.
const crypto = require('crypto');
const { EventEmitter } = require('events');

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

class WebSocketConnection extends EventEmitter {
  constructor(socket, head, { maxPayload }) {
    super();
    this.socket = socket;
    this.maxPayload = maxPayload;
    this.buffer = head && head.length ? Buffer.from(head) : Buffer.alloc(0);
    this.fragments = null;
    this.fragmentOpcode = 0;
    this.closed = false;
    this.alive = true;

    socket.setNoDelay(true);
    socket.on('data', (chunk) => {
      this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk;
      try { this._parse(); } catch (err) { this._fail(1002, err.message); }
    });
    socket.on('close', () => this._closed());
    socket.on('error', () => this._closed());

    this.heartbeat = setInterval(() => {
      if (!this.alive) return this.terminate();
      this.alive = false;
      this._frame(0x9, Buffer.alloc(0));
    }, 25000);
    if (this.buffer.length) setImmediate(() => this._parse());
  }

  get bufferedAmount() { return this.socket.writableLength; }

  send(data) {
    if (this.closed) return;
    if (typeof data === 'string') this._frame(0x1, Buffer.from(data));
    else this._frame(0x2, Buffer.isBuffer(data) ? data : Buffer.from(data));
  }

  close(code = 1000, reason = '') {
    if (this.closed) return;
    const r = Buffer.from(reason).subarray(0, 120);
    const payload = Buffer.alloc(2 + r.length);
    payload.writeUInt16BE(code, 0);
    r.copy(payload, 2);
    this._frame(0x8, payload);
    this.socket.end();
    this._closed();
  }

  terminate() { this.socket.destroy(); this._closed(); }

  _closed() {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.heartbeat);
    this.emit('close');
  }

  _fail(code, reason) { this.close(code, reason); }

  _frame(opcode, payload) {
    if (this.socket.destroyed) return;
    const len = payload.length;
    let header;
    if (len < 126) { header = Buffer.alloc(2); header[1] = len; }
    else if (len < 65536) { header = Buffer.alloc(4); header[1] = 126; header.writeUInt16BE(len, 2); }
    else { header = Buffer.alloc(10); header[1] = 127; header.writeBigUInt64BE(BigInt(len), 2); }
    header[0] = 0x80 | opcode;
    this.socket.write(header);
    if (len) this.socket.write(payload);
  }

  _parse() {
    while (!this.closed) {
      const b = this.buffer;
      if (b.length < 2) return;
      const fin = (b[0] & 0x80) !== 0;
      const opcode = b[0] & 0x0f;
      const masked = (b[1] & 0x80) !== 0;
      let len = b[1] & 0x7f;
      let off = 2;
      if (len === 126) { if (b.length < 4) return; len = b.readUInt16BE(2); off = 4; }
      else if (len === 127) {
        if (b.length < 10) return;
        const big = b.readBigUInt64BE(2);
        if (big > BigInt(this.maxPayload)) throw new Error('message too big');
        len = Number(big); off = 10;
      }
      if (!masked) throw new Error('client frames must be masked');
      if (len > this.maxPayload) throw new Error('message too big');
      if (b.length < off + 4 + len) return;
      const mask = b.subarray(off, off + 4);
      const payload = Buffer.from(b.subarray(off + 4, off + 4 + len));
      for (let i = 0; i < len; i++) payload[i] ^= mask[i & 3];
      this.buffer = b.subarray(off + 4 + len);
      this.alive = true;

      if (opcode >= 0x8) { // control frames
        if (opcode === 0x8) { this.close(); return; }
        if (opcode === 0x9) this._frame(0xA, payload);
        continue;
      }
      if (opcode !== 0) { // first frame of a message
        if (this.fragments) throw new Error('unexpected new message');
        if (fin) { this._emitMessage(opcode, payload); continue; }
        this.fragments = [payload];
        this.fragmentOpcode = opcode;
        this.fragmentSize = len;
      } else { // continuation
        if (!this.fragments) throw new Error('unexpected continuation');
        this.fragments.push(payload);
        this.fragmentSize += len;
        if (this.fragmentSize > this.maxPayload) throw new Error('message too big');
        if (fin) {
          const all = Buffer.concat(this.fragments);
          const op = this.fragmentOpcode;
          this.fragments = null;
          this._emitMessage(op, all);
        }
      }
    }
  }

  _emitMessage(opcode, payload) {
    if (opcode === 0x1) this.emit('message', payload.toString('utf8'), false);
    else if (opcode === 0x2) this.emit('message', payload, true);
  }
}

// Completes the HTTP upgrade handshake; returns a connection, or null if invalid.
function acceptUpgrade(req, socket, head, { maxPayload = 8 * 1024 * 1024 } = {}) {
  const key = req.headers['sec-websocket-key'];
  if (!key || String(req.headers.upgrade).toLowerCase() !== 'websocket') {
    socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
    return null;
  }
  const accept = crypto.createHash('sha1').update(key + GUID).digest('base64');
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
    `Sec-WebSocket-Accept: ${accept}\r\n\r\n`
  );
  return new WebSocketConnection(socket, head, { maxPayload });
}

module.exports = { acceptUpgrade };
