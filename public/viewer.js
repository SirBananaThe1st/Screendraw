const $ = (s) => document.querySelector(s);
const room = new URLSearchParams(location.search).get('room')?.trim().toLowerCase();
if (!room) location.replace('index.html');

const video = $('#video'), canvas = $('#canvas'), stage = $('#stage'), statusEl = $('#status'), empty = $('#empty'), emptyMsg = $('#emptyMsg');
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
const EMPTY = {
  waiting: `Nobody is sharing in room "${room}" right now.\nIf the sharer stopped and started again, ask them for the new link.`,
  connecting: 'Connecting to the sharer…',
  failed: "Couldn't connect directly to the sharer. A strict network (work, school, some mobile) may be blocking it; see \"If friends can't connect\" in the README.",
  offline: "Can't reach the ScreenDraw server. Retrying…",
};
let slowTimer = null, lastState = 'connecting';
function setState(s, text) {
  if (s !== 'offline') lastState = s;
  const [cls, label] = STATES[s] || ['', s];
  statusEl.className = `status ${cls}`;
  statusEl.textContent = text || label;
  if (text && s === 'failed') emptyMsg.textContent = text;
  else if (EMPTY[s]) emptyMsg.textContent = EMPTY[s];
  clearTimeout(slowTimer);
  if (s === 'connecting') {
    slowTimer = setTimeout(() => {
      if (!video.srcObject) emptyMsg.textContent = 'Still connecting… This usually takes a second or two, so something on the network may be blocking the connection.';
    }, 15000);
  }
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

sig.on('log', (text) => ($('#step').textContent = `Last step: ${text}`));
sig.on('error', ({ message }) => setState('failed', message));
sig.on('disconnected', () => setState('offline'));
sig.on('reconnected', () => setState(lastState));
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
