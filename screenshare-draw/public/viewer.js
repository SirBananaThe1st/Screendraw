const $ = (s) => document.querySelector(s);
const room = new URLSearchParams(location.search).get('room')?.trim().toLowerCase();
if (!room) location.replace('index.html');

const video = $('#video'), canvas = $('#canvas'), stage = $('#stage'), statusEl = $('#status'), empty = $('#empty');
const board = new Board();
const pen = buildPenTools($('#pen'));
const sig = new Signaling(location.origin, room, 'viewer');

const STATES = {
  waiting: ['warn', 'Waiting for sharer'],
  connecting: ['warn', 'Connecting…'],
  connected: ['ok', 'Connected'],
  failed: ['bad', 'Connection failed'],
  offline: ['bad', 'Signalling server unreachable'],
};
function setState(s, text) {
  const [cls, label] = STATES[s] || ['', s];
  statusEl.className = `status ${cls}`;
  statusEl.textContent = text || label;
  if (s === 'waiting') empty.textContent = 'Waiting for the screen share to start…';
  if (s === 'failed') empty.textContent = 'Could not connect peer-to-peer. A TURN server may be needed on this network.';
}

const viewer = createViewer({
  sig,
  board,
  onState: setState,
  onStream: (stream) => {
    video.srcObject = stream;
    empty.classList.toggle('hidden', !!stream);
  },
});

sig.on('error', ({ message }) => setState('failed', message));
sig.on('disconnected', () => setState('offline'));
sig.connect();
document.title = `ScreenDraw — room ${room}`;

trackVideoRect(video, stage, canvas, board);
startRendering(canvas, board);
attachPen(canvas, {
  author: () => sig.id,
  color: pen.color,
  width: pen.width,
  emit: (m) => viewer.send(m),
});

const undo = () => viewer.send({ type: 'undo', author: sig.id });
$('#undo').onclick = undo;
$('#clear').onclick = () => viewer.send({ type: 'clear', author: sig.id });
const toggleFs = () => (document.fullscreenElement ? document.exitFullscreen() : stage.requestFullscreen());
$('#fullscreen').onclick = toggleFs;
window.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); undo(); }
  else if (e.key.toLowerCase() === 'f' && !e.ctrlKey && !e.metaKey) toggleFs();
});
