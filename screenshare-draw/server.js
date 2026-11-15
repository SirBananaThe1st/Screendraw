// Zero-dependency signalling + static file server.
// Only the WebRTC handshake (offer/answer/ICE) passes through here.
// Video and drawings travel peer-to-peer once connected.
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PORT = Number(process.env.PORT) || 8080;
const PUBLIC = path.join(__dirname, 'public');
const rooms = new Map(); // room -> Map(id -> { res, role })

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};
const VALID = /^[\w-]{1,64}$/;

const push = (res, obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);

function events(req, res, url) {
  const room = url.searchParams.get('room');
  const id = url.searchParams.get('id');
  const role = url.searchParams.get('role') === 'sharer' ? 'sharer' : 'viewer';
  if (!VALID.test(room || '') || !VALID.test(id || '')) {
    res.writeHead(400, CORS);
    return res.end('bad room or id');
  }

  res.writeHead(200, {
    ...CORS,
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write(': connected\n\n');

  if (!rooms.has(room)) rooms.set(room, new Map());
  const members = rooms.get(room);
  const sharer = [...members].find(([, m]) => m.role === 'sharer');

  if (role === 'sharer' && sharer && sharer[0] !== id) {
    push(res, { type: 'error', message: 'This room already has someone sharing.' });
    return res.end();
  }

  members.set(id, { res, role });
  push(res, { type: 'welcome', id, sharer: role === 'sharer' ? id : sharer?.[0] ?? null });

  if (role === 'viewer') {
    if (sharer) push(sharer[1].res, { type: 'peer-joined', from: id });
  } else {
    for (const [vid, m] of members) {
      if (vid === id) continue;
      push(m.res, { type: 'sharer-joined', from: id });
      push(res, { type: 'peer-joined', from: vid });
    }
  }

  const heartbeat = setInterval(() => res.write(': ping\n\n'), 20000);
  req.on('close', () => {
    clearInterval(heartbeat);
    if (members.get(id)?.res !== res) return;
    members.delete(id);
    for (const m of members.values()) push(m.res, { type: 'peer-left', from: id, role });
    if (!members.size) rooms.delete(room);
  });
}

function signal(req, res) {
  let body = '';
  req.on('data', (chunk) => {
    body += chunk;
    if (body.length > 256 * 1024) req.destroy();
  });
  req.on('end', () => {
    let m;
    try { m = JSON.parse(body); } catch { res.writeHead(400, CORS); return res.end(); }
    if (!['offer', 'answer', 'ice'].includes(m.type)) { res.writeHead(400, CORS); return res.end(); }
    const members = rooms.get(m.room);
    const from = members?.get(m.from);
    const to = members?.get(m.to);
    if (!from || !to) { res.writeHead(404, CORS); return res.end(); }
    push(to.res, { type: m.type, from: m.from, payload: m.payload });
    res.writeHead(204, CORS);
    res.end();
  });
}

function serveStatic(res, url) {
  const rel = url.pathname === '/' ? '/index.html' : decodeURIComponent(url.pathname);
  const file = path.normalize(path.join(PUBLIC, rel));
  if (!file.startsWith(PUBLIC + path.sep)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
}

http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (req.method === 'OPTIONS') { res.writeHead(204, CORS); return res.end(); }
  if (url.pathname === '/events') return events(req, res, url);
  if (url.pathname === '/signal' && req.method === 'POST') return signal(req, res);
  if (req.method === 'GET') return serveStatic(res, url);
  res.writeHead(405); res.end();
}).listen(PORT, () => {
  console.log(`ScreenDraw server running:`);
  console.log(`  http://localhost:${PORT}`);
  for (const nets of Object.values(os.networkInterfaces())) {
    for (const n of nets || []) {
      if (n.family === 'IPv4' && !n.internal) console.log(`  http://${n.address}:${PORT}   (share this one on your network)`);
    }
  }
});
