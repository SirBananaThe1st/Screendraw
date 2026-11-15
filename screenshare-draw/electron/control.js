const $ = (s) => document.querySelector(s);
const board = new Board();
const video = $('#video'), canvas = $('#canvas');
let sig = null, hub = null, stream = null, room = null;

try { $('#server').value = localStorage.getItem('screendraw.server') || $('#server').value; } catch { /* ignore */ }
const checkLocal = () => $('#localWarn').classList.toggle('hidden', !/\/\/(localhost|127\.)/.test($('#server').value));
$('#server').addEventListener('input', checkLocal);
checkLocal();

window.desktop.displays().then((list) => {
  $('#display').innerHTML = list.map((d) => `<option value="${d.id}">${d.label}</option>`).join('');
});

trackVideoRect(video, $('.preview'), canvas, board);
startRendering(canvas, board);

function updateStatus() {
  const n = hub?.viewerCount() ?? 0;
  $('#status').className = 'status ok';
  $('#status').textContent = `Sharing · ${n} viewer${n === 1 ? '' : 's'}`;
}

async function start() {
  $('#error').textContent = '';
  const server = $('#server').value.trim().replace(/\/+$/, '');
  try { new URL(server); } catch { return ($('#error').textContent = 'Enter a valid server URL.'); }
  try { localStorage.setItem('screendraw.server', server); } catch { /* ignore */ }

  await window.desktop.selectDisplay($('#display').value);
  try {
    stream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: { ideal: 30 } }, audio: false });
  } catch (err) {
    return ($('#error').textContent = `Could not capture the screen: ${err.message}`);
  }
  video.srcObject = stream;
  stream.getVideoTracks()[0].addEventListener('ended', stop);

  board.apply({ type: 'clear' });
  await window.desktop.openOverlay();
  $('#showOverlay').checked = true;

  room = uid(6);
  sig = new Signaling(server, room, 'sharer');
  hub = createSharerHub({
    sig,
    stream,
    board,
    onBoard: (m) => window.desktop.toOverlay(m),
    onChange: updateStatus,
  });
  sig.on('error', ({ message }) => { $('#status').className = 'status bad'; $('#status').textContent = message; });
  sig.on('disconnected', () => { $('#status').className = 'status bad'; $('#status').textContent = 'Signalling server unreachable'; });
  sig.on('reconnected', updateStatus);
  sig.connect();

  const link = `${server}/viewer.html?room=${room}`;
  $('#room').textContent = room;
  $('#link').textContent = link;
  $('#copy').onclick = async () => {
    await navigator.clipboard.writeText(link);
    $('#copy').textContent = 'Copied!';
    setTimeout(() => ($('#copy').textContent = 'Copy viewer link'), 1500);
  };

  $('#setup').classList.add('hidden');
  $('#live').classList.remove('hidden');
  updateStatus();
}

function stop() {
  hub?.stop(); sig?.close();
  stream?.getTracks().forEach((t) => t.stop());
  hub = sig = stream = null;
  video.srcObject = null;
  board.apply({ type: 'clear' });
  window.desktop.closeOverlay();
  $('#live').classList.add('hidden');
  $('#setup').classList.remove('hidden');
}

$('#start').onclick = start;
$('#stop').onclick = stop;
$('#clear').onclick = () => hub?.local({ type: 'clear' });
$('#showOverlay').onchange = (e) => window.desktop.setOverlayVisible(e.target.checked);
