// Shared helpers. Everything lives on the global SD namespace.
const SD = (window.SD = window.SD || {});

SD.VERSION = 2;
SD.PALETTE = ['#ff3b30', '#ff9500', '#ffcc00', '#34c759', '#00c7be', '#007aff', '#af52de', '#ff2d92', '#ffffff', '#000000'];
SD.COLOR_RE = /^#[0-9a-f]{6}$/i;
SD.isDesktop = !!window.desktop;

SD.uid = (n = 8) => {
  const chars = 'abcdefghijkmnpqrstuvwxyz23456789';
  return Array.from(crypto.getRandomValues(new Uint8Array(n)), (b) => chars[b % chars.length]).join('');
};
SD.clamp = (v, a, b) => Math.min(b, Math.max(a, v));
SD.$ = (s, root = document) => root.querySelector(s);
SD.$$ = (s, root = document) => [...root.querySelectorAll(s)];

SD.store = {
  get(key, fallback = null) {
    try { const v = localStorage.getItem(`screendraw.${key}`); return v === null ? fallback : JSON.parse(v); }
    catch { return fallback; }
  },
  set(key, value) { try { localStorage.setItem(`screendraw.${key}`, JSON.stringify(value)); } catch { /* storage unavailable */ } },
  del(key) { try { localStorage.removeItem(`screendraw.${key}`); } catch { /* ignore */ } },
};

SD.escape = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

SD.toast = (text, kind = '') => {
  let box = SD.$('#toasts');
  if (!box) { box = document.createElement('div'); box.id = 'toasts'; document.body.appendChild(box); }
  const t = document.createElement('div');
  t.className = `toast ${kind}`;
  t.textContent = text;
  box.appendChild(t);
  setTimeout(() => t.classList.add('out'), 4200);
  setTimeout(() => t.remove(), 4700);
};

// WebRTC can be switched off (privacy extensions, Firefox setting); some leave a
// broken prefixed constructor behind, so actually try creating a connection.
SD.PeerConnection = window.RTCPeerConnection || window.webkitRTCPeerConnection || window.mozRTCPeerConnection;
let webrtcOk = null;
SD.webrtcSupported = () => {
  if (webrtcOk === null) { try { new SD.PeerConnection().close(); webrtcOk = true; } catch { webrtcOk = false; } }
  return webrtcOk;
};
SD.IS_FIREFOX = /Firefox\//.test(navigator.userAgent);
SD.WEBRTC_MISSING = SD.IS_FIREFOX
  ? 'WebRTC is switched off in this Firefox. To turn it on: open about:config, search for media.peerconnection.enabled and set it to true. Or use Chrome, Edge or the ScreenDraw app.'
  : 'WebRTC is switched off in this browser (usually a privacy/VPN extension or setting). Turn it on for this site, or use Chrome, Edge or the ScreenDraw app.';

SD.browserName = () => {
  if (SD.isDesktop) return `ScreenDraw app (${window.desktop.info?.platform || 'desktop'})`;
  const m = /(Edg|OPR|Firefox|Chrome|Version)\/([\d.]+)/.exec(navigator.userAgent);
  if (!m) return 'unknown browser';
  return `${({ Edg: 'Edge', OPR: 'Opera', Version: 'Safari', Electron: 'ScreenDraw app' })[m[1]] || m[1]} ${m[2].split('.')[0]}`;
};

// Position a canvas at (x, y, w, h) CSS px with a crisp backing store.
SD.fitCanvas = (canvas, x, y, w, h) => {
  const dpr = window.devicePixelRatio || 1;
  Object.assign(canvas.style, { left: `${x}px`, top: `${y}px`, width: `${w}px`, height: `${h}px` });
  const bw = Math.max(1, Math.round(w * dpr)), bh = Math.max(1, Math.round(h * dpr));
  if (canvas.width !== bw) canvas.width = bw;
  if (canvas.height !== bh) canvas.height = bh;
  canvas._css = { w, h, dpr };
};

// Largest rectangle with aspect `aw:ah` that fits in `box`, centred.
SD.contain = (box, aw, ah) => {
  const s = Math.min(box.width / aw, box.height / ah);
  const w = aw * s, h = ah * s;
  return { x: (box.width - w) / 2, y: (box.height - h) / 2, w, h };
};

SD.normalizeServer = (input) => {
  let s = String(input || '').trim().replace(/\/+$/, '');
  if (!s) return '';
  if (!/^https?:\/\//i.test(s)) s = `http://${s}`;
  try { const u = new URL(s); return `${u.protocol}//${u.host}`; } catch { return ''; }
};
