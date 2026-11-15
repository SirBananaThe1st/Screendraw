// Shared code: signalling client, drawing board, pen input, and the
// sharer/viewer WebRTC logic. Loaded by the web pages and the desktop app.

const ICE_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
  // Add a TURN server here for viewers behind strict NATs / corporate firewalls:
  // { urls: 'turn:turn.example.com:3478', username: 'user', credential: 'pass' },
];

const PALETTE = ['#ff3b30', '#ff9500', '#ffcc00', '#34c759', '#00c7be', '#007aff', '#af52de', '#ff2d92', '#ffffff', '#000000'];
const COLOR_RE = /^#[0-9a-f]{6}$/i;

function uid(n = 8) {
  const chars = 'abcdefghijkmnpqrstuvwxyz23456789';
  return Array.from(crypto.getRandomValues(new Uint8Array(n)), (b) => chars[b % chars.length]).join('');
}

/* ---------------------------------------------------------------- signalling */

class Signaling {
  constructor(base, room, role) {
    this.base = base.replace(/\/+$/, '');
    this.room = room;
    this.role = role;
    this.id = uid(10);
    this.handlers = {};
    this.queue = Promise.resolve(); // keeps messages in order
  }
  on(type, fn) { this.handlers[type] = fn; return this; }
  connect() {
    const q = new URLSearchParams({ room: this.room, id: this.id, role: this.role });
    this.es = new EventSource(`${this.base}/events?${q}`);
    this.es.onmessage = (e) => {
      const msg = JSON.parse(e.data);
      if (msg.type === 'error') this.close();
      this.handlers[msg.type]?.(msg);
    };
    this.es.onerror = () => this.handlers.disconnected?.();
    this.es.onopen = () => this.handlers.reconnected?.();
  }
  send(to, type, payload) {
    const body = JSON.stringify({ room: this.room, from: this.id, to, type, payload });
    this.queue = this.queue
      .then(() => fetch(`${this.base}/signal`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body }))
      .catch((err) => console.warn('signal failed', err));
    return this.queue;
  }
  close() { this.es?.close(); }
}

function iceQueue(pc) {
  const pending = [];
  return {
    add(c) { pc.remoteDescription ? pc.addIceCandidate(c).catch(console.warn) : pending.push(c); },
    flush() { while (pending.length) pc.addIceCandidate(pending.shift()).catch(console.warn); },
  };
}

/* --------------------------------------------------------------------- board */
// All coordinates are normalised 0..1 relative to the shared frame, and pen
// width is a fraction of frame height, so drawings line up at any resolution.

class Board {
  constructor() { this.strokes = new Map(); this.dirty = true; }

  apply(m) {
    switch (m.type) {
      case 'start':
        this.strokes.set(m.id, { id: m.id, author: m.author, color: m.color, width: m.width, points: [[m.x, m.y]] });
        break;
      case 'point': {
        const s = this.strokes.get(m.id);
        if (!s) return false;
        for (const p of m.pts) s.points.push(p);
        break;
      }
      case 'end':
        return false;
      case 'undo': {
        let last = null;
        for (const s of this.strokes.values()) if (s.author === m.author) last = s.id;
        if (last) this.strokes.delete(last);
        break;
      }
      case 'clear':
        if (m.author) { for (const [id, s] of this.strokes) if (s.author === m.author) this.strokes.delete(id); }
        else this.strokes.clear();
        break;
      case 'sync':
        if (!m.append) this.strokes.clear();
        for (const s of m.strokes) this.strokes.set(s.id, s);
        break;
      default:
        return false;
    }
    this.dirty = true;
    return true;
  }

  // Split into chunks so large boards fit within data-channel message limits.
  syncMessages(maxBytes = 60000) {
    const out = [];
    let batch = [], size = 0;
    for (const s of this.strokes.values()) {
      const len = JSON.stringify(s).length;
      if (batch.length && size + len > maxBytes) { out.push(batch); batch = []; size = 0; }
      batch.push(s); size += len;
    }
    out.push(batch);
    return out.map((strokes, i) => ({ type: 'sync', append: i > 0, strokes }));
  }

  draw(ctx, w, h) {
    ctx.clearRect(0, 0, w, h);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    for (const s of this.strokes.values()) {
      const p = s.points;
      ctx.strokeStyle = s.color;
      ctx.lineWidth = Math.max(1, s.width * h);
      ctx.beginPath();
      ctx.moveTo(p[0][0] * w, p[0][1] * h);
      if (p.length === 1) ctx.lineTo(p[0][0] * w + 0.01, p[0][1] * h);
      for (let i = 1; i < p.length - 1; i++) {
        // smooth with quadratic curves through midpoints
        const mx = ((p[i][0] + p[i + 1][0]) / 2) * w, my = ((p[i][1] + p[i + 1][1]) / 2) * h;
        ctx.quadraticCurveTo(p[i][0] * w, p[i][1] * h, mx, my);
      }
      if (p.length > 1) ctx.lineTo(p[p.length - 1][0] * w, p[p.length - 1][1] * h);
      ctx.stroke();
    }
    this.dirty = false;
  }
}

// Only accept well-formed messages from a remote viewer, and force authorship
// to that viewer so nobody can erase or edit someone else's strokes.
function sanitize(m, from, board) {
  if (!m || typeof m !== 'object') return null;
  const num = (v) => typeof v === 'number' && Number.isFinite(v);
  const clamp = (v) => Math.min(1, Math.max(0, v));
  switch (m.type) {
    case 'start':
      if (typeof m.id !== 'string' || m.id.length > 80 || !m.id.startsWith(from + '-') || board.strokes.has(m.id)) return null;
      if (!COLOR_RE.test(m.color) || !num(m.x) || !num(m.y) || !num(m.width)) return null;
      return { type: 'start', id: m.id, author: from, color: m.color, width: Math.min(0.05, Math.max(0.0005, m.width)), x: clamp(m.x), y: clamp(m.y) };
    case 'point': {
      const s = board.strokes.get(m.id);
      if (!s || s.author !== from || !Array.isArray(m.pts) || m.pts.length > 500 || s.points.length > 20000) return null;
      const pts = m.pts.filter((p) => Array.isArray(p) && num(p[0]) && num(p[1])).map((p) => [clamp(p[0]), clamp(p[1])]);
      return pts.length ? { type: 'point', id: m.id, pts } : null;
    }
    case 'end': return null;
    case 'undo': return { type: 'undo', author: from };
    case 'clear': return { type: 'clear', author: from };
    default: return null;
  }
}

/* ------------------------------------------------------------------ canvases */

function fitCanvas(canvas, board, x, y, w, h) {
  const dpr = window.devicePixelRatio || 1;
  Object.assign(canvas.style, { left: `${x}px`, top: `${y}px`, width: `${w}px`, height: `${h}px` });
  canvas.width = Math.max(1, Math.round(w * dpr));
  canvas.height = Math.max(1, Math.round(h * dpr));
  canvas._css = { w, h, dpr };
  board.dirty = true;
}

function startRendering(canvas, board) {
  const ctx = canvas.getContext('2d');
  (function frame() {
    if (board.dirty && canvas._css) {
      const { w, h, dpr } = canvas._css;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      board.draw(ctx, w, h);
    }
    requestAnimationFrame(frame);
  })();
}

// Places a canvas exactly over the visible picture of a <video> (object-fit: contain).
function trackVideoRect(video, stage, canvas, board) {
  const layout = () => {
    const r = stage.getBoundingClientRect();
    const vw = video.videoWidth || 16, vh = video.videoHeight || 9;
    const s = Math.min(r.width / vw, r.height / vh);
    const w = vw * s, h = vh * s;
    fitCanvas(canvas, board, (r.width - w) / 2, (r.height - h) / 2, w, h);
  };
  new ResizeObserver(layout).observe(stage);
  video.addEventListener('resize', layout);
  video.addEventListener('loadedmetadata', layout);
  layout();
}

// Pointer/pen/touch input → stroke messages. Points are batched once per frame.
function attachPen(canvas, { author, color, width, emit }) {
  let current = null, buffer = [], scheduled = false, seq = 0;
  const round = (v) => Math.round(Math.min(1, Math.max(0, v)) * 10000) / 10000;
  const norm = (e) => {
    const r = canvas.getBoundingClientRect();
    return [round((e.clientX - r.left) / r.width), round((e.clientY - r.top) / r.height)];
  };
  const flush = () => {
    scheduled = false;
    if (current && buffer.length) emit({ type: 'point', id: current, pts: buffer });
    buffer = [];
  };
  canvas.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    canvas.setPointerCapture(e.pointerId);
    const [x, y] = norm(e);
    current = `${author()}-${(seq++).toString(36)}${uid(3)}`;
    emit({ type: 'start', id: current, author: author(), color: color(), width: width(), x, y });
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!current) return;
    const events = e.getCoalescedEvents?.() || [];
    for (const ev of events.length ? events : [e]) buffer.push(norm(ev));
    if (!scheduled) { scheduled = true; requestAnimationFrame(flush); }
  });
  const end = () => {
    if (!current) return;
    flush();
    emit({ type: 'end', id: current });
    current = null;
  };
  canvas.addEventListener('pointerup', end);
  canvas.addEventListener('pointercancel', end);
  canvas.addEventListener('lostpointercapture', end);
}

/* -------------------------------------------------------------------- sharer */
// The sharer opens one peer connection per viewer (a small mesh), holds the
// authoritative board, and relays each viewer's strokes to everyone else.

function createSharerHub({ sig, stream, board, onBoard = () => {}, onChange = () => {} }) {
  const peers = new Map();

  const broadcast = (msg, except) => {
    const data = JSON.stringify(msg);
    for (const [id, p] of peers) if (id !== except && p.dc.readyState === 'open') p.dc.send(data);
  };

  const drop = (id) => {
    const p = peers.get(id);
    if (!p) return;
    peers.delete(id);
    p.pc.close();
    onChange();
  };

  sig.on('peer-joined', async ({ from }) => {
    drop(from);
    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    const dc = pc.createDataChannel('draw', { ordered: true });
    const peer = { pc, dc, ice: iceQueue(pc) };
    peers.set(from, peer);

    for (const track of stream.getTracks()) pc.addTrack(track, stream);

    dc.onopen = () => {
      for (const m of board.syncMessages()) dc.send(JSON.stringify(m));
      onChange();
    };
    dc.onmessage = (e) => {
      let m;
      try { m = JSON.parse(e.data); } catch { return; }
      if (m?.type === 'end') return;
      m = sanitize(m, from, board);
      if (!m || !board.apply(m)) return;
      broadcast(m, from);
      onBoard(m);
    };
    pc.onicecandidate = (e) => e.candidate && sig.send(from, 'ice', e.candidate);
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'failed' || pc.connectionState === 'closed') drop(from);
      onChange();
    };

    await pc.setLocalDescription(await pc.createOffer());
    sig.send(from, 'offer', pc.localDescription);
  });

  sig.on('answer', async ({ from, payload }) => {
    const p = peers.get(from);
    if (!p) return;
    await p.pc.setRemoteDescription(payload);
    p.ice.flush();
  });
  sig.on('ice', ({ from, payload }) => peers.get(from)?.ice.add(payload));
  sig.on('peer-left', ({ from }) => drop(from));

  return {
    // A board action by the sharer themself (e.g. "clear all").
    local(msg) {
      if (!board.apply(msg)) return;
      broadcast(msg);
      onBoard(msg);
    },
    viewerCount: () => [...peers.values()].filter((p) => p.dc.readyState === 'open').length,
    stop() { for (const id of [...peers.keys()]) drop(id); },
  };
}

/* -------------------------------------------------------------------- viewer */

function createViewer({ sig, board, onStream = () => {}, onState = () => {} }) {
  let pc = null, dc = null, ice = null, sharerId = null;

  sig.on('welcome', ({ sharer }) => { sharerId = sharer; onState(sharer ? 'connecting' : 'waiting'); });
  sig.on('sharer-joined', ({ from }) => { sharerId = from; onState('connecting'); });

  sig.on('offer', async ({ from, payload }) => {
    sharerId = from;
    pc?.close();
    pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    ice = iceQueue(pc);
    const thisPc = pc;
    pc.ontrack = (e) => onStream(e.streams[0]);
    pc.ondatachannel = (e) => {
      dc = e.channel;
      dc.onopen = () => onState('connected');
      dc.onclose = () => thisPc === pc && onState('waiting');
      dc.onmessage = (ev) => {
        try { board.apply(JSON.parse(ev.data)); } catch { /* ignore */ }
      };
    };
    pc.onicecandidate = (e) => e.candidate && sig.send(from, 'ice', e.candidate);
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'failed') onState('failed');
    };
    await pc.setRemoteDescription(payload);
    ice.flush();
    await pc.setLocalDescription(await pc.createAnswer());
    sig.send(from, 'answer', pc.localDescription);
  });

  sig.on('ice', ({ payload }) => ice?.add(payload));
  sig.on('peer-left', ({ from }) => {
    if (from !== sharerId) return;
    pc?.close(); pc = null; dc = null;
    board.apply({ type: 'clear' });
    onStream(null);
    onState('waiting');
  });

  return {
    send(msg) {
      board.apply(msg);
      if (dc?.readyState === 'open') dc.send(JSON.stringify(msg));
    },
  };
}
