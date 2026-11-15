const $ = (s) => document.querySelector(s);
const room = uid(6);
const viewerLink = `${location.origin}/viewer.html?room=${room}`;
const video = $('#video'), canvas = $('#canvas'), stage = $('#stage'), statusEl = $('#status');
const board = new Board();
const pen = buildPenTools($('#pen'));
let sig = null, hub = null, stream = null;

$('#room').textContent = room;

function status(cls, text) { statusEl.className = `status ${cls}`; statusEl.textContent = text; }
function updateCount() {
  const n = hub?.viewerCount() ?? 0;
  status('ok', `Sharing · ${n} viewer${n === 1 ? '' : 's'}`);
}

async function start() {
  try {
    stream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: { ideal: 30 } }, audio: false });
  } catch (err) {
    return status('bad', 'Screen capture was cancelled');
  }
  video.srcObject = stream;
  $('#empty').classList.add('hidden');
  stream.getVideoTracks()[0].addEventListener('ended', stop);

  sig = new Signaling(location.origin, room, 'sharer');
  hub = createSharerHub({ sig, stream, board, onChange: updateCount });
  sig.on('error', ({ message }) => status('bad', message));
  sig.on('disconnected', () => status('bad', 'Signalling server unreachable'));
  sig.on('reconnected', updateCount);
  sig.connect();

  $('#start').classList.add('hidden');
  $('#stop').classList.remove('hidden');
  updateCount();
}

function stop() {
  hub?.stop(); sig?.close();
  stream?.getTracks().forEach((t) => t.stop());
  hub = sig = stream = null;
  video.srcObject = null;
  board.apply({ type: 'clear' });
  $('#empty').classList.remove('hidden');
  $('#start').classList.remove('hidden');
  $('#stop').classList.add('hidden');
  status('', 'Not sharing');
}

trackVideoRect(video, stage, canvas, board);
startRendering(canvas, board);
attachPen(canvas, {
  author: () => 'host',
  color: pen.color,
  width: pen.width,
  emit: (m) => (hub ? hub.local(m) : board.apply(m)),
});

$('#start').onclick = start;
$('#stop').onclick = stop;
$('#clear').onclick = () => (hub ? hub.local({ type: 'clear' }) : board.apply({ type: 'clear' }));
$('#copy').onclick = async () => {
  try { await navigator.clipboard.writeText(viewerLink); $('#copy').textContent = 'Copied!'; }
  catch { prompt('Viewer link:', viewerLink); }
  setTimeout(() => ($('#copy').textContent = 'Copy viewer link'), 1500);
};
