// ScreenDraw server: rooms, members, drawings, cursors, who's sharing, WebRTC
// signalling for direct (P2P) shares, and fan-out of video/audio for shares
// sent "through the server" (relay). Zero dependencies.
//
// Settings come from .env (see .env.example).
const http = require('http');
const https = require('https');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { acceptUpgrade } = require('./ws');
const { mapPort } = require('./upnp');
const env = require('./env');

const VERSION = 2;
const config = env.load();
const PUBLIC = path.join(__dirname, '..', 'public');
const ROOM_RE = /^[a-z0-9][a-z0-9-]{2,31}$/;
const COLOR_RE = /^#[0-9a-f]{6}$/i;
const MEMBER_COLORS = ['#ff5a5f', '#ffb020', '#2ecc71', '#00bcd4', '#5b8cff', '#a66bff', '#ff4fa3', '#8bc34a', '#ff7f50', '#26c6da', '#c0ca33', '#ec407a'];
const RELAY_HIGH_WATER = 1.5 * 1024 * 1024;

const rooms = new Map(); // code -> Room
const pollSessions = new Map(); // sid -> Member (poll transport)
const time = () => new Date().toLocaleTimeString();
const rid = (n = 8) => crypto.randomBytes(n).toString('base64url').replace(/[-_]/g, '').slice(0, n).toLowerCase().padEnd(n, '0');

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Private-Network': 'true',
};
const JSON_HEADERS = { ...CORS, 'Content-Type': 'application/json', 'Cache-Control': 'no-store, no-transform' };

/* ===================================================================== members */

class Member {
  constructor(transport) {
    this.id = rid(8);
    this.transport = transport; // 'ws' | 'poll'
    this.ws = null;
    this.room = null;
    this.name = 'Guest';
    this.color = MEMBER_COLORS[0];
    this.quality = 'auto';
    this.layer = 0;
    this.needsKey = true;
    this.drops = [];
    this.lastDrop = 0;
    // poll transport state
    this.queue = []; this.seq = 0; this.epoch = rid(6); this.waiter = null; this.lastSeen = Date.now();
  }

  send(msg) {
    if (this.transport === 'ws') { this.ws?.send(JSON.stringify(msg)); return; }
    this.queue.push({ ...msg, seq: ++this.seq });
    if (this.queue.length > 2000) this.queue.splice(0, this.queue.length - 2000);
    flushPoll(this);
  }

  sendBinary(buf) { if (this.transport === 'ws') this.ws?.send(buf); }
  get canBinary() { return this.transport === 'ws'; }
  get bufferedAmount() { return this.ws ? this.ws.bufferedAmount : 0; }
  get publicInfo() { return { id: this.id, name: this.name, color: this.color }; }
}

/* ======================================================================= rooms */

class Room {
  constructor(code) {
    this.code = code;
    this.members = new Map();
    this.presenter = null; // { id, name, mode, label, width, height, audio, since }
    this.strokes = new Map();
    this.stickers = new Map();
    this.relayConfigs = new Map(); // 'video:0' | 'video:1' | 'audio:0' -> config message
    this.layersSent = '';
    this.keyRequested = [0, 0];
  }

  broadcast(msg, except) {
    const data = JSON.stringify(msg);
    for (const m of this.members.values()) {
      if (m === except) continue;
      if (m.transport === 'ws') m.ws?.send(data); else m.send(msg);
    }
  }

  get presenterMember() { return this.presenter ? this.members.get(this.presenter.id) : null; }

  clearBoard() { this.strokes.clear(); this.stickers.clear(); }

  boardSnapshot() {
    return { strokes: [...this.strokes.values()].map(strokeOut), stickers: [...this.stickers.values()] };
  }

  // Which relay layers (0 = full quality, 1 = low) someone is watching.
  updateLayers() {
    const p = this.presenterMember;
    if (!p || this.presenter.mode !== 'relay') return;
    const layers = new Set();
    for (const m of this.members.values()) if (m !== p && m.canBinary) layers.add(m.layer);
    const key = [...layers].sort().join(',');
    if (key === this.layersSent) return;
    this.layersSent = key;
    p.send({ type: 'relay-layers', layers: [...layers] });
  }

  requestKey(layer) {
    const p = this.presenterMember;
    if (!p || this.presenter.mode !== 'relay') return;
    const now = Date.now();
    if (now - this.keyRequested[layer] < 300) return;
    this.keyRequested[layer] = now;
    p.send({ type: 'keyframe', layer });
  }
}

const strokeOut = (s) => ({ id: s.id, author: s.author, color: s.color, width: s.width, fade: s.fade, points: s.points, done: s.done });

function pickColor(room) {
  const used = new Set([...room.members.values()].map((m) => m.color));
  return MEMBER_COLORS.find((c) => !used.has(c)) || MEMBER_COLORS[room.members.size % MEMBER_COLORS.length];
}

function cleanName(name) {
  const n = String(name || '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 24);
  return n || 'Guest';
}

/* ================================================================ join / leave */

function join(member, hello) {
  if (hello.v !== VERSION) return fail(member, 'version', 'This ScreenDraw version doesn\'t match the server. Please update the app.');
  if (config.password && hello.password !== config.password) return fail(member, 'password', 'Wrong or missing server password.');
  const code = String(hello.room || '').toLowerCase();
  if (!ROOM_RE.test(code)) return fail(member, 'room', 'Room codes are 3–32 letters, numbers or dashes.');
  if (!rooms.has(code) && rooms.size >= config.maxRooms) return fail(member, 'busy', 'The server is busy. Try again later.');
  const room = rooms.get(code) || new Room(code);
  if (room.members.size >= config.maxPerRoom) return fail(member, 'full', 'This room is full.');
  rooms.set(code, room);

  member.room = room;
  member.name = cleanName(hello.name);
  member.color = COLOR_RE.test(hello.color || '') ? hello.color.toLowerCase() : pickColor(room);
  room.members.set(member.id, member);

  member.send({
    type: 'welcome',
    you: member.publicInfo,
    room: code,
    members: [...room.members.values()].map((m) => m.publicInfo),
    presenter: room.presenter,
    board: room.boardSnapshot(),
    config: {
      iceServers: config.iceServers,
      allowRelay: config.allowRelay,
      defaultMode: config.defaultMode,
      maxStickerKB: config.maxStickerKB,
      publicUrl: info.publicUrl,
      transport: member.transport,
    },
  });
  room.broadcast({ type: 'member-joined', member: member.publicInfo }, member);
  console.log(`[${time()}] ${member.name} joined room ${code} (${room.members.size} in room, ${member.transport})`);

  if (room.presenter?.mode === 'relay') subscribeRelay(room, member);
  return true;
}

function fail(member, code, message) {
  member.send({ type: 'error', code, message });
  setTimeout(() => member.ws?.close(4000, code), 50);
  return false;
}

function leave(member) {
  const room = member.room;
  if (!room || room.members.get(member.id) !== member) return;
  room.members.delete(member.id);
  member.room = null;
  console.log(`[${time()}] ${member.name} left room ${room.code}`);
  room.broadcast({ type: 'member-left', id: member.id });
  if (room.presenter?.id === member.id) stopPresenting(room, null);
  if (!room.members.size) rooms.delete(room.code);
  else room.updateLayers();
}

/* =================================================================== presenting */

function startPresenting(room, member, msg) {
  const old = room.presenterMember;
  if (old && old !== member) {
    old.send({ type: 'share-stopped', by: member.name });
    console.log(`[${time()}] ${member.name} took over sharing from ${old.name} in room ${room.code}`);
  } else {
    console.log(`[${time()}] ${member.name} started sharing in room ${room.code}`);
  }
  const mode = msg.mode === 'relay' && config.allowRelay ? 'relay' : 'p2p';
  room.presenter = {
    id: member.id,
    name: member.name,
    mode,
    label: String(msg.label || 'Screen').slice(0, 80),
    width: Math.max(0, Math.min(16384, Number(msg.width) || 0)),
    height: Math.max(0, Math.min(16384, Number(msg.height) || 0)),
    audio: !!msg.audio,
    since: Date.now(),
  };
  room.clearBoard();
  room.relayConfigs.clear();
  room.layersSent = '';
  room.broadcast({ type: 'presenter', presenter: room.presenter, board: room.boardSnapshot() });
  if (mode === 'relay') {
    for (const m of room.members.values()) if (m !== member) subscribeRelay(room, m, true);
    room.updateLayers();
  }
}

function stopPresenting(room, member) {
  if (!room.presenter || (member && room.presenter.id !== member.id)) return;
  console.log(`[${time()}] Sharing stopped in room ${room.code}`);
  room.presenter = null;
  room.clearBoard();
  room.relayConfigs.clear();
  room.layersSent = '';
  room.broadcast({ type: 'presenter', presenter: null, board: room.boardSnapshot() });
}

/* ======================================================================== relay */

function subscribeRelay(room, member, quiet) {
  if (!member.canBinary) {
    member.send({ type: 'relay-unavailable', message: 'Your connection to the server can\'t carry relayed video (WebSockets are blocked on this network).' });
    return;
  }
  member.layer = member.quality === 'low' ? 1 : 0;
  member.needsKey = true;
  for (const [key, cfg] of room.relayConfigs) {
    const [kind, layer] = key.split(':');
    if (kind === 'audio' || Number(layer) === member.layer) member.send(cfg);
  }
  if (!quiet) room.updateLayers();
  room.requestKey(member.layer);
}

function setLayer(room, member, layer) {
  if (member.layer === layer) return;
  member.layer = layer;
  member.needsKey = true;
  const cfg = room.relayConfigs.get(`video:${layer}`);
  if (cfg) member.send(cfg);
  member.send({ type: 'relay-layer', layer });
  room.updateLayers();
  room.requestKey(layer);
}

// Binary media packet from the presenter: 16-byte header, then encoded data.
// [0] kind (1 video, 2 audio) [1] layer [2] flags (1 = keyframe)
function forwardMedia(room, from, buf) {
  if (buf.length < 16 || room.presenter?.id !== from.id || room.presenter.mode !== 'relay') return;
  const kind = buf[0], layer = buf[1], key = (buf[2] & 1) === 1;
  const now = Date.now();
  for (const m of room.members.values()) {
    if (m === from || !m.canBinary) continue;
    if (kind === 2) { // audio: tiny, always send unless badly backed up
      if (m.bufferedAmount < RELAY_HIGH_WATER * 3) m.sendBinary(buf);
      continue;
    }
    if (m.layer !== layer) continue;
    if (m.needsKey) {
      if (!key || m.bufferedAmount > RELAY_HIGH_WATER / 2) continue;
      m.needsKey = false;
    } else if (m.bufferedAmount > RELAY_HIGH_WATER) {
      // This viewer can't keep up: skip until the next keyframe, and on "Auto"
      // quality switch them to the low layer if it keeps happening.
      m.needsKey = true;
      m.lastDrop = now;
      m.drops = m.drops.filter((t) => now - t < 15000);
      m.drops.push(now);
      if (m.quality === 'auto' && m.layer === 0 && m.drops.length >= 3) setLayer(room, m, 1);
      else room.requestKey(m.layer);
      continue;
    }
    m.sendBinary(buf);
  }
}

// Try moving "Auto" viewers back up to full quality after a calm minute.
setInterval(() => {
  const now = Date.now();
  for (const room of rooms.values()) {
    if (room.presenter?.mode !== 'relay') continue;
    for (const m of room.members.values()) {
      if (m.quality === 'auto' && m.layer === 1 && now - m.lastDrop > 60000) { m.drops = []; setLayer(room, m, 0); }
    }
  }
}, 10000).unref();

/* ================================================================== drawing ops */

const num = (v) => typeof v === 'number' && Number.isFinite(v);
const clamp01 = (v) => Math.min(1, Math.max(0, v));
const canEdit = (room, member, author) => author === member.id || room.presenter?.id === member.id;

function handleBoard(room, m, msg) {
  switch (msg.type) {
    case 'stroke-start': {
      if (typeof msg.id !== 'string' || msg.id.length > 64 || !msg.id.startsWith(m.id + '-') || room.strokes.has(msg.id)) return;
      if (!COLOR_RE.test(msg.color) || !num(msg.x) || !num(msg.y) || !num(msg.width)) return;
      if (room.strokes.size >= 3000) return;
      const fade = num(msg.fade) ? Math.min(30000, Math.max(0, Math.round(msg.fade))) : 0;
      const s = { id: msg.id, author: m.id, color: msg.color, width: Math.min(0.05, Math.max(0.0005, msg.width)), fade, points: [[clamp01(msg.x), clamp01(msg.y)]], done: false };
      room.strokes.set(s.id, s);
      room.broadcast({ type: 'stroke-start', ...strokeOut(s), x: s.points[0][0], y: s.points[0][1] }, m);
      return;
    }
    case 'stroke-points': {
      const s = room.strokes.get(msg.id);
      if (!s || s.author !== m.id || s.done || !Array.isArray(msg.pts) || msg.pts.length > 500 || s.points.length > 20000) return;
      const pts = msg.pts.filter((p) => Array.isArray(p) && num(p[0]) && num(p[1])).map((p) => [clamp01(p[0]), clamp01(p[1])]);
      if (!pts.length) return;
      s.points.push(...pts);
      room.broadcast({ type: 'stroke-points', id: s.id, pts }, m);
      return;
    }
    case 'stroke-end': {
      const s = room.strokes.get(msg.id);
      if (!s || s.author !== m.id || s.done) return;
      s.done = true;
      if (s.fade) setTimeout(() => room.strokes.delete(s.id), s.fade + 1500);
      room.broadcast({ type: 'stroke-end', id: s.id }, m);
      return;
    }
    case 'undo': {
      let last = null;
      for (const s of room.strokes.values()) if (s.author === m.id) last = s;
      if (!last) return;
      room.strokes.delete(last.id);
      room.broadcast({ type: 'remove', ids: [last.id] });
      return;
    }
    case 'clear': {
      const all = msg.all && room.presenter?.id === m.id;
      const ids = [];
      for (const [id, s] of room.strokes) if (all || s.author === m.id) { room.strokes.delete(id); ids.push(id); }
      for (const [id, s] of room.stickers) if (all || s.author === m.id) { room.stickers.delete(id); ids.push(id); }
      if (ids.length) room.broadcast({ type: 'remove', ids });
      return;
    }
    case 'sticker-add': {
      if (typeof msg.id !== 'string' || msg.id.length > 64 || !msg.id.startsWith(m.id + '-') || room.stickers.has(msg.id)) return;
      if (typeof msg.src !== 'string' || !/^data:image\/(png|jpeg|webp|gif);base64,[A-Za-z0-9+/=]+$/.test(msg.src)) return;
      if (msg.src.length > config.maxStickerKB * 1024 * 1.37 + 64 || room.stickers.size >= 40) {
        m.send({ type: 'notice', message: 'That sticker is too big, or the room has too many stickers.' });
        return;
      }
      if (![msg.x, msg.y, msg.w, msg.h].every(num)) return;
      const st = { id: msg.id, author: m.id, src: msg.src, x: clamp01(msg.x), y: clamp01(msg.y), w: Math.min(1, Math.max(0.01, msg.w)), h: Math.min(1, Math.max(0.01, msg.h)) };
      room.stickers.set(st.id, st);
      room.broadcast({ type: 'sticker-add', ...st }, m);
      return;
    }
    case 'sticker-update': {
      const st = room.stickers.get(msg.id);
      if (!st || !canEdit(room, m, st.author) || ![msg.x, msg.y, msg.w, msg.h].every(num)) return;
      Object.assign(st, { x: Math.min(1, Math.max(-0.5, msg.x)), y: Math.min(1, Math.max(-0.5, msg.y)), w: Math.min(2, Math.max(0.01, msg.w)), h: Math.min(2, Math.max(0.01, msg.h)) });
      room.broadcast({ type: 'sticker-update', id: st.id, x: st.x, y: st.y, w: st.w, h: st.h }, m);
      return;
    }
    case 'sticker-remove': {
      const st = room.stickers.get(msg.id);
      if (!st || !canEdit(room, m, st.author)) return;
      room.stickers.delete(st.id);
      room.broadcast({ type: 'remove', ids: [st.id] });
      return;
    }
  }
}

/* ============================================================ message handling */

function handleMessage(m, msg) {
  if (!msg || typeof msg !== 'object' || typeof msg.type !== 'string') return;
  if (!m.room) {
    if (msg.type === 'hello') join(m, msg);
    return;
  }
  const room = m.room;
  const isPresenter = room.presenter?.id === m.id;

  switch (msg.type) {
    case 'name':
    case 'profile': {
      if (typeof msg.name === 'string') m.name = cleanName(msg.name);
      if (COLOR_RE.test(msg.color || '')) m.color = msg.color.toLowerCase();
      if (isPresenter) room.presenter.name = m.name;
      room.broadcast({ type: 'member-updated', member: m.publicInfo });
      return;
    }
    case 'cursor': {
      const out = msg.x === null || !num(msg.x) || !num(msg.y)
        ? { type: 'cursor', id: m.id, x: null }
        : { type: 'cursor', id: m.id, x: Math.round(clamp01(msg.x) * 1e4) / 1e4, y: Math.round(clamp01(msg.y) * 1e4) / 1e4 };
      room.broadcast(out, m);
      return;
    }
    case 'share-start': return startPresenting(room, m, msg);
    case 'share-update': {
      if (!isPresenter) return;
      const p = room.presenter;
      if (num(msg.width)) p.width = Math.max(0, Math.min(16384, msg.width));
      if (num(msg.height)) p.height = Math.max(0, Math.min(16384, msg.height));
      if (typeof msg.label === 'string') p.label = msg.label.slice(0, 80);
      if (typeof msg.audio === 'boolean') p.audio = msg.audio;
      room.broadcast({ type: 'presenter-updated', presenter: p });
      return;
    }
    case 'share-stop': return stopPresenting(room, m);
    case 'signal': {
      const to = room.members.get(msg.to);
      if (!to || !['offer', 'answer', 'ice', 'renegotiate'].includes(msg.kind)) return;
      if (!isPresenter && to.id !== room.presenter?.id) return; // only presenter <-> viewer
      to.send({ type: 'signal', from: m.id, kind: msg.kind, payload: msg.payload, share: msg.share });
      return;
    }
    case 'quality': {
      if (!['auto', 'high', 'low'].includes(msg.value)) return;
      m.quality = msg.value;
      if (room.presenter?.mode === 'relay' && !isPresenter) setLayer(room, m, msg.value === 'low' ? 1 : 0);
      else room.presenterMember?.send({ type: 'viewer-quality', id: m.id, value: msg.value });
      return;
    }
    case 'relay-config': {
      if (!isPresenter || room.presenter.mode !== 'relay') return;
      const kind = msg.kind === 'audio' ? 'audio' : 'video';
      const layer = kind === 'audio' ? 0 : msg.layer === 1 ? 1 : 0;
      const cfg = { type: 'relay-config', kind, layer, codec: String(msg.codec).slice(0, 64), width: msg.width, height: msg.height, sampleRate: msg.sampleRate, channels: msg.channels, description: typeof msg.description === 'string' ? msg.description.slice(0, 4096) : undefined };
      room.relayConfigs.set(`${kind}:${layer}`, cfg);
      for (const v of room.members.values()) if (v !== m && v.canBinary && (kind === 'audio' || v.layer === layer)) v.send(cfg);
      return;
    }
    case 'relay-resync': { // viewer pressed Reload
      if (!isPresenter && room.presenter?.mode === 'relay') subscribeRelay(room, m, true);
      return;
    }
    case 'keyframe-request': {
      if (!isPresenter && room.presenter?.mode === 'relay') { m.needsKey = true; room.requestKey(m.layer); }
      return;
    }
    case 'log': {
      if (typeof msg.text === 'string') console.log(`[${time()}]   ${m.name}: ${msg.text.replace(/[\r\n]+/g, ' ').slice(0, 300)}`);
      return;
    }
    default:
      handleBoard(room, m, msg);
  }
}

/* ============================================================ WebSocket transport */

function onUpgrade(req, socket, head) {
  if (new URL(req.url, 'http://x').pathname !== '/ws') return socket.destroy();
  const ws = acceptUpgrade(req, socket, head, { maxPayload: Math.max(4, config.maxStickerKB / 1024 * 2) * 1024 * 1024 });
  if (!ws) return;
  const m = new Member('ws');
  m.ws = ws;
  ws.on('message', (data, binary) => {
    if (binary) { if (m.room) forwardMedia(m.room, m, data); return; }
    let msg;
    try { msg = JSON.parse(data); } catch { return; }
    handleMessage(m, msg);
  });
  ws.on('close', () => leave(m));
}

/* ============================================================ long-poll transport */
// Fallback for networks that block WebSockets. Same messages; no relayed media.

function json(res, body, status = 200) { res.writeHead(status, JSON_HEADERS); res.end(JSON.stringify(body)); }

function flushPoll(m) {
  if (!m.waiter || !m.queue.length) return;
  const res = m.waiter;
  m.waiter = null;
  clearTimeout(m.waitTimer);
  json(res, { epoch: m.epoch, messages: m.queue });
}

function readBody(req, limit, cb) {
  let body = '';
  req.on('data', (c) => { body += c; if (body.length > limit) req.destroy(); });
  req.on('end', () => { try { cb(JSON.parse(body)); } catch { cb(null); } });
}

function pollSend(req, res, url) {
  const sid = url.searchParams.get('sid') || '';
  if (!/^[a-z0-9]{16,40}$/.test(sid)) return json(res, {}, 400);
  readBody(req, config.maxStickerKB * 1024 * 1.5 + 65536, (msgs) => {
    if (!Array.isArray(msgs)) return json(res, {}, 400);
    let m = pollSessions.get(sid);
    if (!m) { m = new Member('poll'); pollSessions.set(sid, m); }
    m.lastSeen = Date.now();
    for (const msg of msgs.slice(0, 200)) handleMessage(m, msg);
    res.writeHead(204, CORS); res.end();
  });
}

function pollReceive(req, res, url) {
  const sid = url.searchParams.get('sid') || '';
  if (!/^[a-z0-9]{16,40}$/.test(sid)) return json(res, {}, 400);
  let m = pollSessions.get(sid);
  if (!m) {
    // A client that already had a session (it sends its epoch) must start over;
    // a brand-new client may poll before its first message arrives.
    if (url.searchParams.get('epoch')) return json(res, { epoch: null, messages: [{ type: 'error', code: 'session', message: 'Session expired.', seq: 1 }] });
    m = new Member('poll');
    pollSessions.set(sid, m);
  }
  let after = Number(url.searchParams.get('after')) || 0;
  if (url.searchParams.get('epoch') !== m.epoch) after = 0;
  m.lastSeen = Date.now();
  m.queue = m.queue.filter((q) => q.seq > after);
  if (m.waiter) { const old = m.waiter; m.waiter = null; clearTimeout(m.waitTimer); json(old, { epoch: m.epoch, messages: [] }); }
  if (m.queue.length) return json(res, { epoch: m.epoch, messages: m.queue });
  m.waiter = res;
  m.waitTimer = setTimeout(() => {
    if (m.waiter !== res) return;
    m.waiter = null; m.lastSeen = Date.now();
    json(res, { epoch: m.epoch, messages: [] });
  }, config.pollHoldMs);
  res.on('close', () => { if (m.waiter === res) { m.waiter = null; clearTimeout(m.waitTimer); m.lastSeen = Date.now(); } });
}

function pollLeave(req, res, url) {
  const sid = url.searchParams.get('sid') || '';
  const m = pollSessions.get(sid);
  if (m) { pollSessions.delete(sid); leave(m); }
  res.writeHead(204, CORS); res.end();
}

setInterval(() => {
  const now = Date.now();
  for (const [sid, m] of pollSessions) {
    if (!m.waiter && now - m.lastSeen > config.memberTimeoutMs) { pollSessions.delete(sid); leave(m); }
  }
}, 5000).unref();

/* ================================================================ http server */

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json',
};

function serveStatic(res, url) {
  let rel;
  try { rel = url.pathname === '/' ? '/index.html' : decodeURIComponent(url.pathname); } catch { res.writeHead(400); return res.end(); }
  const file = path.normalize(path.join(PUBLIC, rel));
  if (!file.startsWith(PUBLIC + path.sep)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(data);
  });
}

const info = {
  app: 'screendraw',
  version: VERSION,
  port: config.port,
  localUrl: `http://localhost:${config.port}`,
  lanUrls: [],
  publicUrl: config.publicUrl,
  passwordRequired: !!config.password,
  allowRelay: config.allowRelay,
  defaultMode: config.defaultMode,
  forwarding: 'pending',
  message: 'Checking network…',
};

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (req.method === 'OPTIONS') { res.writeHead(204, CORS); return res.end(); }
  if (url.pathname === '/info') return json(res, info);
  if (url.pathname === '/rt/send' && req.method === 'POST') return pollSend(req, res, url);
  if (url.pathname === '/rt/poll') return pollReceive(req, res, url);
  if (url.pathname === '/rt/leave' && req.method === 'POST') return pollLeave(req, res, url);
  if (req.method === 'GET') return serveStatic(res, url);
  res.writeHead(405); res.end();
});
server.on('upgrade', onUpgrade);

/* ==================================================================== network */

function lanAddresses() {
  const out = [];
  for (const nets of Object.values(os.networkInterfaces())) for (const n of nets || []) if (n.family === 'IPv4' && !n.internal) out.push(n.address);
  return out;
}
function isPrivateIp(ip) {
  const [a, b] = ip.split('.').map(Number);
  return a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254);
}
function fetchPublicIp() {
  return new Promise((resolve) => {
    const req = https.get('https://api.ipify.org', { timeout: 5000 }, (res) => {
      let d = ''; res.on('data', (c) => (d += c));
      res.on('end', () => resolve(/^\d+\.\d+\.\d+\.\d+$/.test(d.trim()) ? d.trim() : null));
    });
    req.on('timeout', () => req.destroy()); req.on('error', () => resolve(null));
  });
}

let mapping = null;
async function setUpNetwork() {
  info.lanUrls = lanAddresses().map((ip) => `http://${ip}:${config.port}`);
  const [webIp, upnp] = await Promise.all([
    config.publicUrl ? Promise.resolve(null) : fetchPublicIp(),
    config.upnp ? mapPort(config.port).catch((err) => ({ error: err.message })) : Promise.resolve({ off: true }),
  ]);
  if (typeof upnp.close === 'function') mapping = upnp;
  if (!config.publicUrl) {
    const ip = webIp || (upnp.externalIp && !isPrivateIp(upnp.externalIp) ? upnp.externalIp : null);
    info.publicUrl = ip ? `http://${ip}:${config.port}` : null;
  }
  if (mapping && mapping.externalIp && (isPrivateIp(mapping.externalIp) || (webIp && webIp !== mapping.externalIp))) {
    info.forwarding = 'blocked';
    info.message = `Your router forwarded port ${config.port}, but your internet provider puts your router behind another network (carrier-grade NAT), so friends outside your home probably can't reach it. See the README.`;
  } else if (mapping) {
    info.forwarding = 'upnp';
    info.message = `Port ${config.port} was forwarded automatically to this computer (${mapping.internalIp}).`;
  } else if (upnp.off) {
    info.forwarding = config.publicUrl ? 'custom' : 'off';
    info.message = config.publicUrl ? `Using PUBLIC_URL from your settings.` : `Automatic port forwarding is off. Make sure port ${config.port} (TCP) is forwarded to this computer.`;
  } else {
    info.forwarding = 'manual';
    info.message = `Couldn't forward the port automatically: ${upnp.error} If you've already forwarded port ${config.port} (TCP) to ${lanAddresses()[0] || 'this computer'}, you're fine.`;
  }
  if (!info.publicUrl) info.message += ' Could not detect your public IP address.';
}

function printBanner() {
  const line = '─'.repeat(66);
  const mask = (v) => (v ? '(set)' : '(none)');
  console.log(`\n${line}\n  ScreenDraw server is running\n${line}`);
  console.log(`  This computer:   ${info.localUrl}`);
  for (const u of info.lanUrls) console.log(`  Same Wi-Fi/LAN:  ${u}`);
  if (info.publicUrl) console.log(`  Friends online:  ${info.publicUrl}   <-- friends enter this as the server`);
  console.log(`\n  ${info.message}`);
  console.log(`\n  Settings: ${config.envFile ? '.env loaded' : 'no .env file (using defaults)'} | password ${mask(config.password)} | ` +
    `default video route: ${config.defaultMode === 'relay' ? 'through server' : 'direct (P2P)'}${config.allowRelay ? '' : ' (relay disabled)'} | ` +
    `TURN ${config.iceServers.length > 1 ? 'configured' : 'none'}`);
  console.log(`  Close this window (or press Ctrl+C) to stop the server.\n${line}\n`);
}

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') console.error(`\nPort ${config.port} is already in use. Is ScreenDraw already running? Change PORT in .env to use another port.\n`);
  else console.error(err);
  process.exit(1);
});

server.listen(config.port, async () => {
  console.log(`ScreenDraw server listening on port ${config.port}. Checking network access…`);
  await setUpNetwork();
  printBanner();
});

let exiting = false;
async function shutdown() {
  if (exiting) return;
  exiting = true;
  console.log('\nStopping…');
  await Promise.race([mapping?.close(), new Promise((r) => setTimeout(r, 2500))]);
  process.exit(0);
}
for (const s of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK']) process.on(s, shutdown);
