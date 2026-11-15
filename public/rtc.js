// Shared code: signalling client, drawing board, pen input, and the
// sharer/viewer WebRTC logic. Loaded by the web pages and the desktop app.

const ICE_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
  // Add a TURN server here for viewers behind strict NATs / corporate firewalls:
  // { urls: 'turn:turn.example.com:3478', username: 'user', credential: 'pass' },
];

// Some privacy extensions delete only the standard name, so check the old
// prefixed ones too. Firefox with WebRTC disabled still has a prefixed name
// that throws when used, so actually try creating a connection.
const PeerConnection = window.RTCPeerConnection || window.webkitRTCPeerConnection || window.mozRTCPeerConnection;
let webrtcOk = null;
function webrtcSupported() {
  if (webrtcOk === null) {
    try { new PeerConnection().close(); webrtcOk = true; } catch { webrtcOk = false; }
  }
  return webrtcOk;
}
const IS_FIREFOX = /Firefox\//.test(navigator.userAgent);
const WEBRTC_MISSING = IS_FIREFOX
  ? 'WebRTC is switched off in this Firefox, and ScreenDraw needs it to send the video. ' +
    'To turn it back on: type about:config in the address bar, search for media.peerconnection.enabled ' +
    'and set it to true (a privacy add-on or hardened setup may have changed it). Or use Chrome or Edge.'
  : 'WebRTC is switched off in this browser, and ScreenDraw needs it to send the video. ' +
    'This is usually caused by a privacy or VPN extension ("WebRTC leak" protection), a privacy setting, ' +
    'or a browser that disables it (LibreWolf, Tor, Mullvad Browser). ' +
    'Turn that off for this site, or use Chrome, Edge or Firefox.';

function browserName() {
  const ua = navigator.userAgent;
  const m = /(Electron|Edg|OPR|Firefox|Chrome|Version)\/([\d.]+)/.exec(ua);
  if (!m) return ua.slice(0, 80);
  const names = { Edg: 'Edge', OPR: 'Opera', Version: 'Safari' };
  return `${names[m[1]] || m[1]} ${m[2].split('.')[0]}${webrtcSupported() ? '' : ' (WebRTC disabled!)'}`;
}

const PALETTE = ['#ff3b30', '#ff9500', '#ffcc00', '#34c759', '#00c7be', '#007aff', '#af52de', '#ff2d92', '#ffffff', '#000000'];
const COLOR_RE = /^#[0-9a-f]{6}$/i;

function uid(n = 8) {
  const chars = 'abcdefghijkmnpqrstuvwxyz23456789';
  return Array.from(crypto.getRandomValues(new Uint8Array(n)), (b) => chars[b % chars.length]).join('');
}

/* ------------------------------------------------------------ saved room code */
// The sharer keeps the same room code between sessions so friends' links keep
// working. A private key proves this computer owns the room, so the sharer can
// reclaim it after a restart but a viewer who knows the code can't take over.
function storedValue(key, make, valid) {
  let v = null;
  try { v = localStorage.getItem(key); } catch { /* storage unavailable */ }
  if (!valid(v)) {
    v = make();
    try { localStorage.setItem(key, v); } catch { /* ignore */ }
  }
  return v;
}
const ROOM_RE = /^[a-z0-9]{6}$/;
function savedRoomCode() { return storedValue('screendraw.room', () => uid(6), (v) => ROOM_RE.test(v || '')); }
function newRoomCode() {
  const v = uid(6);
  try { localStorage.setItem('screendraw.room', v); } catch { /* ignore */ }
  return v;
}
function sharerKey() { return storedValue('screendraw.sharerKey', () => uid(24), (v) => /^[a-z0-9]{24}$/.test(v || '')); }

/* ---------------------------------------------------------------- signalling */

// Talks to the server by long-polling (see server.js for why not a stream).
class Signaling {
  constructor(base, room, role, key = '') {
    this.base = base.replace(/\/+$/, '');
    this.room = room;
    this.role = role;
    this.key = key;
    this.id = uid(10);
    this.handlers = {};
    this.queue = Promise.resolve(); // keeps outgoing messages in order
    this.after = 0;
    this.epoch = null;
    this.closed = true;
  }
  on(type, fn) { this.handlers[type] = fn; return this; }

  connect() {
    this.closed = false;
    this._leave = () => this.leave();
    window.addEventListener('pagehide', this._leave);
    this.loop();
  }

  async loop() {
    let failing = false;
    while (!this.closed) {
      this.ctrl = new AbortController();
      try {
        const q = new URLSearchParams({ room: this.room, id: this.id, role: this.role, after: this.after, epoch: this.epoch || '', t: Date.now() });
        if (this.key) q.set('key', this.key);
        const res = await fetch(`${this.base}/poll?${q}`, { cache: 'no-store', signal: this.ctrl.signal });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        if (failing) { failing = false; this.handlers.reconnected?.(); }
        if (data.epoch !== this.epoch) { this.epoch = data.epoch; this.after = 0; }
        for (const msg of data.messages) {
          if (msg.seq <= this.after) continue; // already handled
          this.after = msg.seq;
          if (msg.type === 'error') this.close();
          try { this.handlers[msg.type]?.(msg); } catch (err) { console.error(err); }
        }
      } catch (err) {
        if (this.closed) break;
        if (!failing) { failing = true; this.handlers.disconnected?.(); }
        await new Promise((r) => setTimeout(r, 2000));
      }
    }
  }

  send(to, type, payload) {
    const body = JSON.stringify({ room: this.room, from: this.id, to, type, payload });
    this.queue = this.queue
      .then(() => fetch(`${this.base}/signal`, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body }))
      .then((res) => { if (!res.ok) this.log(`server rejected ${type} (HTTP ${res.status})`); })
      .catch((err) => console.warn(`sending ${type} failed`, err));
    return this.queue;
  }

  // Progress/diagnostics: shown in the browser console AND the server window,
  // so problems on a friend's machine are visible to the person hosting.
  log(text) {
    console.log(`[ScreenDraw] ${text}`);
    this.handlers.log?.(text);
    const body = JSON.stringify({ room: this.room, id: this.id, text: String(text).slice(0, 300) });
    fetch(`${this.base}/log`, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body }).catch(() => {});
  }

  leave() {
    try { navigator.sendBeacon(`${this.base}/leave`, JSON.stringify({ room: this.room, id: this.id })); } catch { /* best effort */ }
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.ctrl?.abort();
    this.leave();
    window.removeEventListener('pagehide', this._leave);
  }
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

/* ---------------------------------------------------------------- video stats */
// Periodically sends a one-line summary of the video flow to the log, e.g.
// "video out: 1920x1080 @ 2 fps, 120 kbps, held back by: bandwidth, route: srflx->srflx".
// This shows at a glance whether frames are being sent/received and why not.
function reportVideoStats(pc, direction, log) {
  const delays = [3000, 5000, 7000, 15000, 30000];
  let prev = null, i = 0;
  const tick = async () => {
    if (pc.connectionState === 'closed') return;
    try {
      const stats = await pc.getStats();
      const byId = new Map();
      let rtp = null, pair = null;
      stats.forEach((r) => {
        byId.set(r.id, r);
        if (r.type === (direction === 'send' ? 'outbound-rtp' : 'inbound-rtp') && (r.kind || r.mediaType) === 'video') rtp = r;
        if (r.type === 'candidate-pair' && (r.selected || r.nominated) && r.state === 'succeeded') pair = pair || r;
      });
      stats.forEach((r) => { if (r.type === 'transport' && r.selectedCandidatePairId) pair = byId.get(r.selectedCandidatePairId) || pair; });
      const route = pair
        ? `${byId.get(pair.localCandidateId)?.candidateType || '?'}->${byId.get(pair.remoteCandidateId)?.candidateType || '?'}`
        : 'none yet';
      if (!rtp) { log(`video ${direction === 'send' ? 'out' : 'in'}: no video flowing yet (connection ${pc.connectionState}, route ${route})`); }
      else {
        const frames = direction === 'send' ? (rtp.framesEncoded ?? rtp.framesSent ?? 0) : (rtp.framesDecoded ?? 0);
        const bytes = direction === 'send' ? rtp.bytesSent : rtp.bytesReceived;
        let fps = rtp.framesPerSecond, kbps = null;
        if (prev) {
          const dt = (rtp.timestamp - prev.timestamp) / 1000;
          if (dt > 0) { fps = Math.round((frames - prev.frames) / dt); kbps = Math.round(((bytes - prev.bytes) * 8) / dt / 1000); }
        }
        prev = { timestamp: rtp.timestamp, frames, bytes };
        const size = rtp.frameWidth ? `${rtp.frameWidth}x${rtp.frameHeight}` : 'size unknown';
        const parts = [`${size} @ ${fps ?? '?'} fps`, kbps !== null ? `${kbps} kbps` : null];
        if (direction === 'send') {
          parts.push(`held back by: ${rtp.qualityLimitationReason || 'n/a'}`);
        } else {
          parts.push(`${frames} frames shown`);
          if (rtp.freezeCount) parts.push(`${rtp.freezeCount} freezes`);
          const lost = rtp.packetsLost || 0, got = rtp.packetsReceived || 0;
          if (got) parts.push(`${((100 * lost) / (lost + got)).toFixed(1)}% packets lost`);
        }
        parts.push(`route ${route}`);
        log(`video ${direction === 'send' ? 'out' : 'in'}: ${parts.filter(Boolean).join(', ')}`);
      }
    } catch (err) { log(`could not read video stats: ${err.message}`); }
    setTimeout(tick, delays[i++] ?? 60000);
  };
  setTimeout(tick, delays[i++]);
}

/* -------------------------------------------------------------------- sharer */
// The sharer opens one peer connection per viewer (a small mesh), holds the
// authoritative board, and relays each viewer's strokes to everyone else.

function createSharerHub({ sig, stream, board, onBoard = () => {}, onChange = () => {} }) {
  const peers = new Map();

  for (const t of stream.getVideoTracks()) {
    t.addEventListener('mute', () => sig.log('screen capture paused by the browser: no new frames (if you shared a single window, is it minimised?)'));
    t.addEventListener('unmute', () => sig.log('screen capture producing frames again'));
    t.addEventListener('ended', () => sig.log('screen capture stopped'));
  }

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

  sig.on('welcome', () => sig.log(`sharing from ${browserName()}`));
  sig.on('peer-joined', async ({ from }) => {
    try { await connectViewer(from); }
    catch (err) { sig.log(`could not start connection to viewer ${from.slice(0, 4)}: ${err.name}: ${err.message}`); }
  });

  async function connectViewer(from) {
    const who = `viewer ${from.slice(0, 4)}`;
    sig.log(`${who} joined; preparing the video connection`);
    drop(from);
    const pc = new PeerConnection({ iceServers: ICE_SERVERS });
    const dc = pc.createDataChannel('draw', { ordered: true });
    const peer = { pc, dc, ice: iceQueue(pc) };
    peers.set(from, peer);

    const tracks = stream.getTracks().filter((t) => t.readyState === 'live');
    if (!tracks.length) throw new Error('the screen capture has stopped (no live video track)');
    for (const track of tracks) pc.addTrack(track, stream);

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
    pc.oniceconnectionstatechange = () => sig.log(`${who}: network path ${pc.iceConnectionState}`);
    pc.onconnectionstatechange = () => {
      sig.log(`${who}: connection ${pc.connectionState}`);
      if (pc.connectionState === 'failed' || pc.connectionState === 'closed') drop(from);
      onChange();
    };

    await pc.setLocalDescription(await pc.createOffer());

    // By default browsers keep screen shares sharp and drop the frame rate when
    // bandwidth is tight, sometimes to almost nothing, which looks frozen.
    // "balanced" lowers resolution a bit instead, so the picture keeps moving.
    for (const sender of pc.getSenders()) {
      if (sender.track?.kind !== 'video') continue;
      try {
        const params = sender.getParameters();
        params.degradationPreference = 'balanced';
        await sender.setParameters(params);
      } catch (err) { console.warn('could not set degradationPreference', err); }
    }

    await sig.send(from, 'offer', pc.localDescription);
    sig.log(`offer sent to ${who}`);
    reportVideoStats(pc, 'send', (t) => sig.log(`${who}: ${t}`));
  }

  sig.on('answer', async ({ from, payload }) => {
    const p = peers.get(from);
    if (!p) return sig.log(`answer from unknown viewer ${from.slice(0, 4)} ignored`);
    try {
      await p.pc.setRemoteDescription(payload);
      p.ice.flush();
      sig.log(`answer from viewer ${from.slice(0, 4)} accepted`);
    } catch (err) {
      sig.log(`answer from viewer ${from.slice(0, 4)} rejected: ${err.name}: ${err.message}`);
    }
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

  // Close any connection to a sharer who has since gone (e.g. after a server restart).
  const resetIfNewSharer = (sharer) => {
    if (pc && sharer !== sharerId) {
      pc.close(); pc = null; dc = null;
      board.apply({ type: 'clear' });
      onStream(null);
    }
  };

  sig.on('welcome', ({ sharer }) => {
    sig.log(`joined from ${browserName()}`);
    resetIfNewSharer(sharer);
    sharerId = sharer;
    onState(sharer ? 'connecting' : 'waiting');
  });
  sig.on('sharer-joined', ({ from }) => { resetIfNewSharer(from); sharerId = from; onState('connecting'); });

  sig.on('offer', async (msg) => {
    try { await acceptOffer(msg); }
    catch (err) { sig.log(`could not accept the offer: ${err.name}: ${err.message}`); onState('failed', `Connection error: ${err.message}`); }
  });

  async function acceptOffer({ from, payload }) {
    sig.log('offer received from sharer');
    sharerId = from;
    pc?.close();
    pc = new PeerConnection({ iceServers: ICE_SERVERS });
    ice = iceQueue(pc);
    const thisPc = pc;
    pc.ontrack = (e) => {
      sig.log(`video track received (${e.track.kind})`);
      e.track.addEventListener('mute', () => sig.log('no video frames arriving from the sharer'));
      e.track.addEventListener('unmute', () => sig.log('video frames arriving'));
      if (e.track.kind === 'video') onStream(e.streams[0] || new MediaStream([e.track]));
    };
    pc.ondatachannel = (e) => {
      dc = e.channel;
      dc.onopen = () => onState('connected');
      dc.onclose = () => thisPc === pc && onState('waiting');
      dc.onmessage = (ev) => {
        try { board.apply(JSON.parse(ev.data)); } catch { /* ignore */ }
      };
    };
    pc.onicecandidate = (e) => e.candidate && sig.send(from, 'ice', e.candidate);
    pc.oniceconnectionstatechange = () => sig.log(`network path ${thisPc.iceConnectionState}`);
    pc.onconnectionstatechange = () => {
      sig.log(`connection ${thisPc.connectionState}`);
      if (thisPc === pc && thisPc.connectionState === 'failed') onState('failed');
    };
    await pc.setRemoteDescription(payload);
    ice.flush();
    await pc.setLocalDescription(await pc.createAnswer());
    await sig.send(from, 'answer', pc.localDescription);
    sig.log('answer sent to sharer');
    reportVideoStats(pc, 'receive', (t) => sig.log(t));
  }

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

/* ------------------------------------------------------------- viewer links */
// Asks the server which address friends should use (it works out the public
// IP and router port forwarding). Waits briefly while that check finishes.
async function getNetworkInfo(server) {
  const isLocal = /\/\/(localhost|127\.|\[::1\])/.test(server);
  let info = null;
  for (let i = 0; i < 15; i++) {
    try { info = await (await fetch(`${server}/info`, { cache: 'no-store' })).json(); } catch { break; }
    if (info.forwarding !== 'pending') break;
    await new Promise((r) => setTimeout(r, 1000));
  }
  const lan = info?.lanUrls?.[0] || null;
  // If the sharer typed a non-local server address, trust it as the public one.
  const base = !isLocal ? server : info?.publicUrl || lan || server;
  return { base, lan: lan && lan !== base ? lan : null, info };
}
