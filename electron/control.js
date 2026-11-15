const $ = (s) => document.querySelector(s);
const board = new Board();
const video = $('#video'), canvas = $('#canvas');
let sig = null, hub = null, stream = null, room = null;

// Server address: from the launcher, else the last one used, else localhost.
window.desktop.defaults().then(({ server }) => {
  let saved = null;
  try { saved = localStorage.getItem('screendraw.server'); } catch { /* ignore */ }
  $('#server').value = server || saved || $('#server').value;
});

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

  $('#room').textContent = room;
  $('#link').textContent = 'Checking network…';
  $('#lanLink').classList.add('hidden');
  $('#netNote').classList.add('hidden');
  $('#setup').classList.add('hidden');
  $('#live').classList.remove('hidden');
  updateStatus();

  const { base, lan, info } = await getNetworkInfo(server);
  const link = `${base}/viewer.html?room=${room}`;
  $('#link').textContent = link;
  if (lan) {
    $('#lanLink').textContent = `On the same Wi-Fi: ${lan}/viewer.html?room=${room}`;
    $('#lanLink').classList.remove('hidden');
  }
  if (info?.message) {
    const cls = { upnp: 'ok', custom: 'ok', blocked: 'bad' }[info.forwarding] || '';
    $('#netNote').className = `warnbox ${cls}`;
    $('#netNote').textContent = info.message;
  }
  $('#copy').onclick = async () => {
    await navigator.clipboard.writeText(link);
    $('#copy').textContent = 'Copied!';
    setTimeout(() => ($('#copy').textContent = 'Copy viewer link'), 1500);
  };
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
