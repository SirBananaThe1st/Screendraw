// Zero-dependency signalling + static file server.
// Only the WebRTC handshake (offer/answer/ICE) passes through here.
// Video and drawings travel peer-to-peer once connected.

const http = require('http');
const https = require('https');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { mapPort } = require('./upnp');

const PORT = Number(process.env.PORT) || 8080;
const PUBLIC = path.join(__dirname, 'public');
const MAX_ROOMS = Number(process.env.MAX_ROOMS) || 200;
const MAX_PER_ROOM = Number(process.env.MAX_PER_ROOM) || 20;
const rooms = new Map(); // room -> Map(id -> member)

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Private-Network': 'true',
};
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};
const VALID = /^[\w-]{1,64}$/;

// What the sharer apps need to build a link for friends (served at /info).
const info = {
  port: PORT,
  localUrl: `http://localhost:${PORT}`,
  lanUrls: [],
  publicUrl: process.env.PUBLIC_URL ? process.env.PUBLIC_URL.replace(/\/+$/, '') : null,
  forwarding: 'pending', // pending | upnp | manual | blocked | off | custom
  message: 'Checking network…',
};

const time = () => new Date().toLocaleTimeString();

/* --------------------------------------------------------------- signalling */
// Long-polling: each /poll request returns as soon as there are messages (or
// after ~25s). Unlike a never-ending stream, a complete response can't get
// stuck in ISP / mobile-carrier proxies that buffer HTTP. Messages stay queued
// until the client acknowledges them, so a lost response is simply resent.

const POLL_HOLD_MS = Number(process.env.POLL_HOLD_MS) || 25000;
const MEMBER_TIMEOUT_MS = Number(process.env.MEMBER_TIMEOUT_MS) || 35000;
const NO_STORE = { ...CORS, 'Content-Type': 'application/json', 'Cache-Control': 'no-store, no-transform' };

function json(res, body, status = 200) {
  res.writeHead(status, NO_STORE);
  res.end(JSON.stringify(body));
}

function deliver(member, msg) {
  member.queue.push({ ...msg, seq: ++member.seq });
  flush(member);
}

function flush(member) {
  if (!member.waiter || !member.queue.length) return;
  const res = member.waiter;
  member.waiter = null;
  clearTimeout(member.waitTimer);
  json(res, { epoch: member.epoch, messages: member.queue });
}

function join(room, id, role) {
  if (!rooms.has(room) && rooms.size >= MAX_ROOMS) return { error: 'The server is busy. Try again later.' };
  if (!rooms.has(room)) rooms.set(room, new Map());
  const members = rooms.get(room);
  const sharer = [...members.values()].find((m) => m.role === 'sharer');
  if (role === 'sharer' && sharer) return { error: 'This room already has someone sharing.' };
  if (members.size >= MAX_PER_ROOM) return { error: 'This room is full.' };

  const member = { id, role, room, queue: [], seq: 0, epoch: Math.random().toString(36).slice(2), waiter: null, lastSeen: Date.now() };
  members.set(id, member);
  deliver(member, { type: 'welcome', id, sharer: role === 'sharer' ? id : sharer?.id ?? null });

  if (role === 'viewer') {
    if (sharer) deliver(sharer, { type: 'peer-joined', from: id });
    console.log(`[${time()}] Viewer ${id.slice(0, 4)} joined room ${room}${sharer ? '' : ' (no one is sharing in this room yet)'}`);
  } else {
    for (const m of members.values()) {
      if (m === member) continue;
      deliver(m, { type: 'sharer-joined', from: id });
      deliver(member, { type: 'peer-joined', from: m.id });
    }
    console.log(`[${time()}] Sharing started in room ${room}`);
  }
  return member;
}

function leave(member) {
  const members = rooms.get(member.room);
  if (members?.get(member.id) !== member) return;
  members.delete(member.id);
  if (member.waiter) { json(member.waiter, { epoch: member.epoch, messages: [] }); member.waiter = null; }
  clearTimeout(member.waitTimer);
  console.log(`[${time()}] ${member.role === 'sharer' ? 'Sharing stopped in' : 'Viewer left'} room ${member.room}`);
  for (const m of members.values()) deliver(m, { type: 'peer-left', from: member.id, role: member.role });
  if (!members.size) rooms.delete(member.room);
}

// Drop members whose browser stopped polling (closed tab, lost connection).
setInterval(() => {
  const now = Date.now();
  for (const members of rooms.values()) {
    for (const m of [...members.values()]) if (!m.waiter && now - m.lastSeen > MEMBER_TIMEOUT_MS) leave(m);
  }
}, 5000).unref();

function poll(req, res, url) {
  const room = url.searchParams.get('room');
  const id = url.searchParams.get('id');
  const role = url.searchParams.get('role') === 'sharer' ? 'sharer' : 'viewer';
  if (!VALID.test(room || '') || !VALID.test(id || '')) return json(res, { error: 'bad room or id' }, 400);

  let member = rooms.get(room)?.get(id);
  let after = Number(url.searchParams.get('after')) || 0;
  if (!member || member.epoch !== url.searchParams.get('epoch')) after = 0; // new session: send everything
  if (!member) {
    member = join(room, id, role);
    if (member.error) return json(res, { epoch: null, messages: [{ type: 'error', message: member.error, seq: 1 }] });
  }

  member.lastSeen = Date.now();
  member.queue = member.queue.filter((m) => m.seq > after); // drop acknowledged messages
  if (member.waiter) { // a newer poll replaces an older one
    const old = member.waiter;
    member.waiter = null;
    clearTimeout(member.waitTimer);
    json(old, { epoch: member.epoch, messages: [] });
  }
  if (member.queue.length) return json(res, { epoch: member.epoch, messages: member.queue });

  member.waiter = res;
  member.waitTimer = setTimeout(() => {
    if (member.waiter !== res) return;
    member.waiter = null;
    member.lastSeen = Date.now();
    json(res, { epoch: member.epoch, messages: [] });
  }, POLL_HOLD_MS);
  res.on('close', () => {
    if (member.waiter !== res) return;
    member.waiter = null;
    clearTimeout(member.waitTimer);
    member.lastSeen = Date.now();
  });
}

function readJson(req, cb) {
  let body = '';
  req.on('data', (chunk) => {
    body += chunk;
    if (body.length > 256 * 1024) req.destroy();
  });
  req.on('end', () => {
    try { cb(JSON.parse(body)); } catch { cb(null); }
  });
}

function signal(req, res) {
  readJson(req, (m) => {
    if (!m || !['offer', 'answer', 'ice'].includes(m.type)) return json(res, {}, 400);
    const members = rooms.get(m.room);
    const from = members?.get(m.from);
    const to = members?.get(m.to);
    if (!from || !to) return json(res, {}, 404);
    from.lastSeen = Date.now();
    deliver(to, { type: m.type, from: m.from, payload: m.payload });
    res.writeHead(204, CORS);
    res.end();
  });
}

// Progress lines from browsers, so the host can see what's happening on a
// friend's machine. Rate-limited per member.
function logRequest(req, res) {
  readJson(req, (m) => {
    const member = m && rooms.get(m.room)?.get(m.id);
    if (member && typeof m.text === 'string') {
      const now = Date.now();
      if (now - (member.logWindow || 0) > 60000) { member.logWindow = now; member.logCount = 0; }
      if (++member.logCount <= 40) {
        const who = member.role === 'sharer' ? 'sharer' : `viewer ${member.id.slice(0, 4)}`;
        console.log(`[${time()}]   ${who}: ${m.text.replace(/[\r\n]+/g, ' ').slice(0, 300)}`);
      }
    }
    res.writeHead(204, CORS);
    res.end();
  });
}

function leaveRequest(req, res) {
  readJson(req, (m) => {
    const member = m && rooms.get(m.room)?.get(m.id);
    if (member) leave(member);
    res.writeHead(204, CORS);
    res.end();
  });
}

function serveStatic(res, url) {
  let rel;
  try { rel = url.pathname === '/' ? '/index.html' : decodeURIComponent(url.pathname); }
  catch { res.writeHead(400); return res.end(); }
  const file = path.normalize(path.join(PUBLIC, rel));
  if (!file.startsWith(PUBLIC + path.sep)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (req.method === 'OPTIONS') { res.writeHead(204, CORS); return res.end(); }
  if (url.pathname === '/poll') return poll(req, res, url);
  if (url.pathname === '/signal' && req.method === 'POST') return signal(req, res);
  if (url.pathname === '/leave' && req.method === 'POST') return leaveRequest(req, res);
  if (url.pathname === '/log' && req.method === 'POST') return logRequest(req, res);
  if (url.pathname === '/info') {
    res.writeHead(200, { ...CORS, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    return res.end(JSON.stringify(info));
  }
  if (req.method === 'GET') return serveStatic(res, url);
  res.writeHead(405); res.end();
});

/* ------------------------------------------------------------------ network */

function lanAddresses() {
  const out = [];
  for (const nets of Object.values(os.networkInterfaces())) {
    for (const n of nets || []) if (n.family === 'IPv4' && !n.internal) out.push(n.address);
  }
  return out;
}

function isPrivateIp(ip) {
  const [a, b] = ip.split('.').map(Number);
  return a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254);
}

function fetchPublicIp() {
  return new Promise((resolve) => {
    const req = https.get('https://api.ipify.org', { timeout: 5000 }, (res) => {
      let d = '';
      res.on('data', (c) => (d += c));
      res.on('end', () => resolve(/^\d+\.\d+\.\d+\.\d+$/.test(d.trim()) ? d.trim() : null));
    });
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve(null));
  });
}

let mapping = null;

async function setUpNetwork() {
  info.lanUrls = lanAddresses().map((ip) => `http://${ip}:${PORT}`);

  if (info.publicUrl) {
    info.forwarding = 'custom';
    info.message = 'Using the PUBLIC_URL you set.';
    return;
  }

  const [webIp, upnp] = await Promise.all([
    fetchPublicIp(),
    process.env.UPNP === '0'
      ? Promise.resolve({ off: true })
      : mapPort(PORT).catch((err) => ({ error: err.message })),
  ]);
  if (typeof upnp.close === 'function') mapping = upnp;

  const publicIp = webIp || (upnp.externalIp && !isPrivateIp(upnp.externalIp) ? upnp.externalIp : null);
  info.publicUrl = publicIp ? `http://${publicIp}:${PORT}` : null;

  if (mapping && mapping.externalIp && (isPrivateIp(mapping.externalIp) || (webIp && webIp !== mapping.externalIp))) {
    info.forwarding = 'blocked';
    info.message =
      `Your router forwarded port ${PORT}, but your internet provider puts your router behind another network ` +
      `(carrier-grade NAT or a second router), so friends outside your home probably can't reach it. ` +
      `See "If friends can't connect" in the README.`;
  } else if (mapping) {
    info.forwarding = 'upnp';
    info.message = `Port ${PORT} was forwarded automatically to this computer (${mapping.internalIp}).`;
  } else if (upnp.off) {
    info.forwarding = 'off';
    info.message = `Automatic port forwarding is off. Make sure port ${PORT} (TCP) is forwarded to this computer.`;
  } else {
    info.forwarding = 'manual';
    const ip = lanAddresses()[0] || 'this computer';
    info.message =
      `Couldn't forward the port automatically: ${upnp.error}\n  ` +
      `If you've already forwarded port ${PORT} (TCP) to ${ip} in your router, you're fine. Otherwise, set that up.`;
  }
  if (!publicIp) info.message += ' Could not detect your public IP address (are you online?).';
}

function printBanner() {
  const line = '─'.repeat(64);
  console.log(`\n${line}\n  ScreenDraw is running\n${line}`);
  console.log(`  This computer:   ${info.localUrl}`);
  for (const u of info.lanUrls) console.log(`  Same Wi-Fi/LAN:  ${u}`);
  if (info.publicUrl) console.log(`  Friends online:  ${info.publicUrl}   <-- give your friends this`);
  console.log(`\n  ${info.message}`);
  console.log(`\n  Start sharing in the ScreenDraw app (or ${info.localUrl}/share.html),`);
  console.log(`  then send friends the viewer link it gives you.`);
  console.log(`  Close this window (or press Ctrl+C) to stop the server.\n${line}\n`);
}

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\nPort ${PORT} is already in use. ScreenDraw may already be running, or another program is using it.`);
    console.error(`Close the other program, or change PORT at the top of the launcher.\n`);
  } else console.error(err);
  process.exit(1);
});

server.listen(PORT, async () => {
  console.log(`Server listening on port ${PORT}. Setting up network access…`);
  await setUpNetwork();
  printBanner();
});

// Remove the router port mapping on the way out.
let exiting = false;
async function shutdown() {
  if (exiting) return;
  exiting = true;
  console.log('\nStopping…');
  await Promise.race([mapping?.close(), new Promise((r) => setTimeout(r, 2500))]);
  process.exit(0);
}
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK']) process.on(sig, shutdown);
