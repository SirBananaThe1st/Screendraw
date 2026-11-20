// Loads settings from a .env file (next to the launcher) without any dependencies.
// Real environment variables take priority over the file.
const fs = require('fs');
const path = require('path');

const ENV_FILE = path.join(__dirname, '..', '.env');

function parseEnv(text) {
  const out = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    let value = m[2];
    if (/^["']/.test(value)) {
      const q = value[0];
      const end = value.indexOf(q, 1);
      value = end > 0 ? value.slice(1, end) : value.slice(1);
      if (q === '"') value = value.replace(/\\n/g, '\n');
    } else {
      value = value.replace(/\s+#.*$/, '').trim(); // inline comment
    }
    out[m[1]] = value;
  }
  return out;
}

function load() {
  let file = {};
  let found = false;
  try {
    file = parseEnv(fs.readFileSync(ENV_FILE, 'utf8'));
    found = true;
  } catch { /* no .env: defaults */ }
  const get = (k) => (process.env[k] !== undefined && process.env[k] !== '' ? process.env[k] : file[k]);
  const num = (k, d, min, max) => {
    const v = Number(get(k));
    return Number.isFinite(v) && v >= min && v <= max ? v : d;
  };
  const bool = (k, d) => {
    const v = String(get(k) ?? '').trim().toLowerCase();
    if (['1', 'true', 'yes', 'on'].includes(v)) return true;
    if (['0', 'false', 'no', 'off'].includes(v)) return false;
    return d;
  };
  const list = (k) => String(get(k) || '').split(',').map((s) => s.trim()).filter(Boolean);

  const port = num('PORT', 8080, 1, 65535);

  // PUBLIC_URL may be written without a scheme ("example.com"). Add http://
  // and, if no port was given and we aren't on 80, the server's port.
  let publicUrl = (get('PUBLIC_URL') || '').trim().replace(/\/+$/, '');
  if (publicUrl && !/^https?:\/\//i.test(publicUrl)) {
    const hasPort = /:\d+$/.test(publicUrl);
    publicUrl = `http://${publicUrl}${hasPort || port === 80 ? '' : `:${port}`}`;
  }

  const stun = list('STUN_URLS');
  const iceServers = [{ urls: stun.length ? stun : ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }];
  const turn = list('TURN_URLS');
  if (turn.length) iceServers.push({ urls: turn, username: get('TURN_USERNAME') || '', credential: get('TURN_CREDENTIAL') || '' });

  const mode = String(get('DEFAULT_MEDIA_MODE') || 'p2p').toLowerCase();

  return {
    envFile: found ? ENV_FILE : null,
    port,
    upnp: bool('UPNP', true),
    publicUrl: publicUrl || null,
    password: get('SERVER_PASSWORD') || '',
    maxRooms: num('MAX_ROOMS', 200, 1, 100000),
    maxPerRoom: num('MAX_PER_ROOM', 20, 2, 1000),
    pollHoldMs: num('POLL_HOLD_MS', 25000, 1000, 120000),
    memberTimeoutMs: num('MEMBER_TIMEOUT_MS', 35000, 5000, 600000),
    allowRelay: bool('ALLOW_RELAY', true),
    defaultMode: mode === 'relay' ? 'relay' : 'p2p',
    maxStickerKB: num('MAX_STICKER_KB', 400, 16, 4096),
    maxGifKB: num('MAX_GIF_KB', 2048, 16, 16384),
    maxRoomStickersMB: num('MAX_ROOM_STICKERS_MB', 24, 1, 1024),
    iceServers,
  };
}

module.exports = { load, parseEnv };
