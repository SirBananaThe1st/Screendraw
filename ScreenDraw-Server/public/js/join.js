// Join screen. In the desktop app the server address is asked for on first
// run and remembered (with a way to forget it). In a browser, the server is
// the site you're on.
(() => {
  const { $ } = SD;
  const params = new URLSearchParams(location.search);
  const ROOM_RE = /^[a-z0-9][a-z0-9-]{2,31}$/;

  async function fetchInfo(server) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 6000);
    try {
      const res = await fetch(`${server}/info`, { cache: 'no-store', signal: ctrl.signal });
      const info = await res.json();
      if (info.app !== 'screendraw') throw new Error('not a ScreenDraw server');
      return info;
    } finally { clearTimeout(t); }
  }

  function showServer() {
    $('#joinCard').classList.add('hidden');
    $('#serverCard').classList.remove('hidden');
    $('#serverInput').value = SD.store.get('lastServer', '') || '';
    $('#serverInput').focus();
  }

  async function showJoin(server, info) {
    $('#serverCard').classList.add('hidden');
    $('#joinCard').classList.remove('hidden');
    if (SD.isDesktop) {
      $('#serverLine').classList.remove('hidden');
      $('#serverName').textContent = server.replace(/^https?:\/\//, '');
    }
    $('#name').value = SD.store.get('name', '') || '';
    $('#room').value = (params.get('room') || SD.store.get('lastRoom', '') || '').toLowerCase();
    if (!info) { try { info = await fetchInfo(server); } catch { /* checked again on join */ } }
    if (info?.passwordRequired) {
      $('#passwordBox').classList.remove('hidden');
      $('#password').value = SD.store.get(`password:${server}`, '') || '';
    }
    if (params.get('error')) $('#joinError').textContent = params.get('error');
    ($('#name').value ? $('#room') : $('#name')).focus();
  }

  $('#serverCard').addEventListener('submit', async (e) => {
    e.preventDefault();
    const server = SD.normalizeServer($('#serverInput').value);
    $('#serverError').textContent = '';
    if (!server) { $('#serverError').textContent = 'That doesn\'t look like an address.'; return; }
    $('#serverConnect').disabled = true;
    $('#serverConnect').textContent = 'Connecting…';
    try {
      const info = await fetchInfo(server);
      SD.store.set('server', server);
      SD.store.set('lastServer', server);
      showJoin(server, info);
    } catch (err) {
      $('#serverError').textContent = `Couldn't reach a ScreenDraw server at ${server}. Check the address, and that the server is running and its port is forwarded.`;
    } finally {
      $('#serverConnect').disabled = false;
      $('#serverConnect').textContent = 'Connect';
    }
  });

  $('#forgetServer').addEventListener('click', () => { SD.store.del('server'); showServer(); });
  $('#newRoom').addEventListener('click', () => { $('#room').value = SD.uid(6); });

  $('#joinCard').addEventListener('submit', (e) => {
    e.preventDefault();
    const name = $('#name').value.trim();
    const room = $('#room').value.trim().toLowerCase();
    if (!name) { $('#joinError').textContent = 'Enter your name.'; return; }
    if (!ROOM_RE.test(room)) { $('#joinError').textContent = 'Room codes are 3–32 letters, numbers or dashes.'; return; }
    SD.store.set('name', name);
    SD.store.set('lastRoom', room);
    const server = SD.isDesktop ? SD.store.get('server') : location.origin;
    if (!$('#passwordBox').classList.contains('hidden')) SD.store.set(`password:${server}`, $('#password').value);
    location.href = `room.html?room=${encodeURIComponent(room)}`;
  });

  if (SD.isDesktop) {
    const server = SD.store.get('server');
    if (server) showJoin(server); else showServer();
  } else {
    showJoin(location.origin);
  }
})();
