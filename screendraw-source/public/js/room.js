// Room page controller: connects to the server, shows whoever is sharing,
// handles drawing tools, stickers, cursors, sound, quality and sharing.
(() => {
  const { $, $$ } = SD;
  const params = new URLSearchParams(location.search);
  const ROOM = (params.get('room') || '').toLowerCase();
  const SERVER = SD.isDesktop ? SD.store.get('server') : location.origin;
  if (!ROOM || !SERVER) { location.replace('index.html'); return; }
  const NAME = SD.store.get('name') || 'Guest';

  const state = {
    me: null, members: new Map(), presenter: null, config: null,
    quality: SD.store.get('quality', 'auto'),
    tool: 'pen',
    color: SD.store.get('pen', {}).color || SD.PALETTE[0],
    size: SD.store.get('pen', {}).size || 4,
    fade: !!SD.store.get('pen', {}).fade,
    fadeMs: SD.store.get('pen', {}).fadeMs || 3000,
    sound: false, volume: SD.store.get('volume', 1),
  };

  const stage = $('#stage'), video = $('#video'), relayCanvas = $('#relayCanvas'), boardCanvas = $('#board');
  const board = new SD.Board();
  const conn = new SD.Connection(SERVER, { type: 'hello', room: ROOM, name: NAME, color: SD.store.get('cursorColor', '') || '', password: SD.store.get(`password:${SERVER}`, '') || '' });
  const log = (text) => { console.log(`[ScreenDraw] ${text}`); conn.send({ type: 'log', text }); };

  let myShare = null;   // our own share: { stream, settings, sourceId, label, p2p, relay, started }
  let viewP2P = null, viewRelay = null, mediaKind = null;
  let emptyTimer = null;

  $('#roomCode').textContent = ROOM;
  document.title = `ScreenDraw — ${ROOM}`;

  /* ============================================================ pen tools */

  const savePen = () => SD.store.set('pen', { color: state.color, size: state.size, fade: state.fade, fadeMs: state.fadeMs });
  const swatchEls = SD.PALETTE.map((c, i) => {
    const b = document.createElement('button');
    b.className = 'swatch'; b.style.background = c; b.title = `${c} (${(i + 1) % 10})`;
    b.onclick = () => setColor(c);
    $('#swatches').appendChild(b);
    return b;
  });
  function renderPen() {
    swatchEls.forEach((b, i) => b.classList.toggle('active', SD.PALETTE[i] === state.color));
    $('#customColor').value = state.color;
    $('#penSize').value = state.size;
    const px = 4 + state.size * 1.2;
    Object.assign($('#penPreview').style, { width: `${px}px`, height: `${px}px`, color: state.color });
    $('#fadeBtn').classList.toggle('on', state.fade);
    $('#fadeTime').value = String(state.fadeMs);
    $('#toolPen').classList.toggle('on', state.tool === 'pen');
    $('#toolMove').classList.toggle('on', state.tool === 'move');
    boardCanvas.classList.toggle('move', state.tool === 'move');
    document.documentElement.style.setProperty('--pen', state.color);
    $('#colorWell').style.background = state.color;
  }
  function setColor(c) { state.color = c.toLowerCase(); if (state.tool !== 'pen') setTool('pen'); renderPen(); savePen(); }
  function setSize(s) { state.size = SD.clamp(s, 1, 16); renderPen(); savePen(); }
  function setTool(t) { state.tool = t; if (t === 'pen') input.deselect(); renderPen(); }
  $('#customColor').oninput = (e) => setColor(e.target.value);
  $('#penSize').oninput = (e) => setSize(Number(e.target.value));
  $('#fadeBtn').onclick = () => { state.fade = !state.fade; renderPen(); savePen(); };
  $('#fadeTime').onchange = (e) => { state.fadeMs = Number(e.target.value); state.fade = true; renderPen(); savePen(); };
  $('#toolPen').onclick = () => setTool('pen');
  $('#toolMove').onclick = () => setTool('move');

  /* =============================================================== board */

  const isPresenter = () => !!state.me && state.presenter?.id === state.me.id;
  const canEdit = (st) => st.author === state.me?.id || isPresenter();

  const stickerLayer = $('#stickerLayer');
  SD.startRendering(boardCanvas, board, () => ({ selected: input?.selected, hideCursor: state.me?.id, editable: canEdit, stickerLayer }));
  const input = SD.attachInput(boardCanvas, {
    board,
    myId: () => state.me?.id || 'nobody',
    tool: () => state.tool,
    color: () => state.color,
    width: () => state.size / 1000,
    fade: () => (state.fade ? state.fadeMs : 0),
    send: (msg) => { conn.send(msg); toOverlay(msg); },
    canEdit,
    onSelect: (id) => $('#deleteSticker').classList.toggle('hidden', !id || !canEdit(board.stickers.get(id) || {})),
    onCursor: (x, y) => conn.send({ type: 'cursor', x, y }),
    enabled: () => !!state.presenter && !!state.me,
  });

  const localBoard = (msg) => { board.apply(msg); conn.send(msg); toOverlay(msg); };
  $('#undoBtn').onclick = () => localBoard({ type: 'undo', author: state.me?.id });
  $('#clearMine').onclick = () => localBoard({ type: 'clear', author: state.me?.id });
  $('#clearAll').onclick = () => { if (isPresenter()) localBoard({ type: 'clear', all: true, author: state.me?.id }); };
  $('#deleteSticker').onclick = () => { input.removeSelected(); };

  /* ============================================================ stickers */

  async function addSticker(file) {
    if (!file || !file.type.startsWith('image/')) return;
    if (!state.presenter) { SD.toast('Stickers go on the shared screen. Wait until someone is sharing.'); return; }
    try {
      const { src, aspect, tooBig } = await SD.makeSticker(file, state.config?.maxStickerKB || 400, state.config?.maxGifKB || 2048);
      if (tooBig) SD.toast(`That GIF is over the ${+((state.config?.maxGifKB || 2048) / 1024).toFixed(1)} MB limit, so it was added as a still image.`);
      const css = boardCanvas._css || { w: 16, h: 9 };
      const w = 0.22, h = (w / aspect) * (css.w / css.h);
      const msg = { type: 'sticker-add', id: `${state.me.id}-s${SD.uid(5)}`, author: state.me.id, src, x: 0.5 - w / 2, y: 0.5 - h / 2, w, h };
      localBoard(msg);
      setTool('move');
    } catch (err) { SD.toast(`Couldn't add that image: ${err.message}`, 'bad'); }
  }
  $('#stickerBtn').onclick = () => $('#stickerFile').click();
  $('#stickerFile').onchange = (e) => { addSticker(e.target.files[0]); e.target.value = ''; };
  document.addEventListener('paste', (e) => {
    const item = [...(e.clipboardData?.items || [])].find((i) => i.type.startsWith('image/'));
    if (item) { e.preventDefault(); addSticker(item.getAsFile()); }
  });
  stage.addEventListener('dragover', (e) => e.preventDefault());
  stage.addEventListener('drop', (e) => { e.preventDefault(); addSticker(e.dataTransfer.files[0]); });

  /* ============================================================== layout */

  function mediaSize() {
    if (mediaKind === 'relay' && viewRelay?.frameW) return { w: viewRelay.frameW, h: viewRelay.frameH };
    if (video.videoWidth) return { w: video.videoWidth, h: video.videoHeight };
    if (state.presenter?.width) return { w: state.presenter.width, h: state.presenter.height };
    return { w: 16, h: 9 };
  }
  function layout() {
    const r = stage.getBoundingClientRect();
    const { w, h } = mediaSize();
    const c = SD.contain(r, w, h);
    SD.fitCanvas(boardCanvas, c.x, c.y, c.w, c.h);
    Object.assign(stickerLayer.style, { left: `${c.x}px`, top: `${c.y}px`, width: `${c.w}px`, height: `${c.h}px` });
    if (mediaKind === 'relay') { SD.fitCanvas(relayCanvas, c.x, c.y, c.w, c.h); viewRelay?.redraw(); }
    board.dirty = true;
  }
  new ResizeObserver(layout).observe(stage);
  video.addEventListener('resize', layout);
  video.addEventListener('loadedmetadata', layout);

  /* ========================================================= empty state */

  function showEmpty(title, text = '', step = '') {
    clearTimeout(emptyTimer);
    $('#empty').classList.remove('hidden');
    $('#emptyTitle').textContent = title;
    $('#emptyText').textContent = text;
    $('#emptyStep').textContent = step;
  }
  const hideEmpty = () => { clearTimeout(emptyTimer); $('#empty').classList.add('hidden'); };
  function showWaiting(p) {
    showEmpty(`Connecting to ${p.name}'s screen…`, '', p.mode === 'relay' ? 'Video is coming through the server.' : 'Video is coming directly from their computer.');
    emptyTimer = setTimeout(() => {
      $('#emptyText').textContent = 'This is taking longer than usual. Try Reload (R). If it keeps happening, something on the network may be blocking the video, and the sharer can try "Through server" mode.';
      log('still no video after 15s');
    }, 15000);
  }

  /* ============================================================= members */

  const initials = (n) => (String(n || '?').trim().split(/\s+/).slice(0, 2).map((w) => [...w][0] || '').join('') || '?').toUpperCase();
  function renderMembers() {
    const box = $('#members');
    box.innerHTML = '';
    for (const m of state.members.values()) {
      const chip = document.createElement('span');
      const me = m.id === state.me?.id;
      chip.className = `chip${me ? ' me' : ''}`;
      const sharingNow = state.presenter?.id === m.id;
      chip.dataset.tip = me ? `${m.name} (you). Change your name or cursor colour` : sharingNow ? `${m.name}, sharing` : m.name;
      if (me) { chip.setAttribute('role', 'button'); chip.tabIndex = 0; chip.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openProfile(); } }; }
      chip.innerHTML = `<span class="av" style="--c:${m.color}">${SD.escape(initials(m.name))}</span>${sharingNow ? SD.icon('monitor', 'sharing') : ''}`;
      chip.classList.toggle('presenting', sharingNow);
      if (me) chip.onclick = openProfile;
      box.appendChild(chip);
    }
    board.setMembers([...state.members.values()]);
    toOverlay({ type: 'members', list: [...state.members.values()], me: state.me?.id });
  }
  const MEMBER_COLORS = ['#ff5a5f', '#ffb020', '#2ecc71', '#00bcd4', '#5b8cff', '#a66bff', '#ff4fa3', '#8bc34a', '#ff7f50', '#26c6da', '#c0ca33', '#ec407a'];
  let profileColor = null;
  function renderProfileColors() {
    $$('#profileColors button').forEach((b) => b.classList.toggle('active', b.dataset.c === profileColor));
    $('#profileCustom').value = profileColor;
  }
  for (const c of MEMBER_COLORS) {
    const b = document.createElement('button');
    b.type = 'button'; b.dataset.c = c; b.style.background = c; b.title = c;
    b.onclick = () => { profileColor = c; renderProfileColors(); };
    $('#profileColors').appendChild(b);
  }
  $('#profileCustom').oninput = (e) => { profileColor = e.target.value.toLowerCase(); renderProfileColors(); };
  function openProfile() {
    $('#profileName').value = state.me.name;
    profileColor = state.me.color;
    renderProfileColors();
    $('#profileDialog').showModal();
  }
  $('#profileDialog').addEventListener('close', () => {
    if ($('#profileDialog').returnValue !== 'save') return;
    const name = $('#profileName').value.trim().slice(0, 24) || state.me.name;
    SD.store.set('name', name);
    SD.store.set('cursorColor', profileColor);
    conn.updateHello({ name, color: profileColor });
    conn.send({ type: 'profile', name, color: profileColor });
  });

  /* ============================================================== UI state */

  function updateUI() {
    const p = state.presenter;
    const mine = isPresenter();
    $('#shareBtn').classList.toggle('hidden', mine);
    $('#stopBtn').classList.toggle('hidden', !mine);
    $('#clearAll').classList.toggle('hidden', !mine);
    $('#reloadBtn').classList.toggle('hidden', !p);
    $('#presenterBanner').classList.toggle('hidden', !p);
    $('#desktopControls').classList.toggle('hidden', !(mine && SD.isDesktop));
    $('#hidePreviewBox').classList.toggle('hidden', !mine);
    $('#viewerTools').classList.toggle('hidden', mine);
    if (p) {
      const route = p.mode === 'relay' ? 'through the server' : 'direct (P2P)';
      $('#presenterText').textContent = mine ? `You're sharing ${p.label}` : `${p.name} is sharing ${p.label}`;
      const Route = route[0].toUpperCase() + route.slice(1);
      $('#presenterMeta').textContent = p.audio ? `${Route}, with sound` : Route;
      $('#presenterBanner').dataset.tip = $('#presenterMeta').textContent;
    }
    const hasAudio = !!p && !mine && p.audio;
    $('#soundBtn').disabled = !hasAudio;
    const soundOn = state.sound && hasAudio;
    SD.setIcon($('#soundBtn'), soundOn ? 'volume-2' : 'volume-x');
    $('#soundBtn').classList.toggle('on', soundOn);
    $('#soundBtn').setAttribute('aria-pressed', String(soundOn));
    $('#soundBtn').dataset.tip = !hasAudio ? 'The sharer isn\'t sharing sound' : soundOn ? 'Mute' : 'Unmute';
    $('#volume').disabled = !soundOn;
    document.body.classList.toggle('sharing', !!p);
    SD.ui?.refresh();
    $('#quality').value = state.quality;
    renderMembers();
    layout();
  }

  /* ========================================================== connection */

  conn.on('state', (s) => {
    const el = $('#status');
    if (s === 'connected') {
      el.className = `status ${conn.mode === 'poll' ? 'warn' : 'ok'}`;
      el.textContent = conn.mode === 'poll' ? 'Connected (limited)' : 'Connected';
      el.dataset.tip = conn.mode === 'poll' ? 'WebSockets are blocked on this network, so a slower fallback is used. Video "through the server" won\'t work.' : 'Connected to the server';
    } else if (s === 'reconnecting') { el.className = 'status warn'; el.textContent = 'Reconnecting…'; el.dataset.tip = 'Lost the server. Trying again.'; }
    else { el.className = 'status bad'; el.textContent = 'Disconnected'; el.dataset.tip = 'Not connected to the server'; }
  });

  conn.on('error', (e) => {
    if (e.code === 'password' || e.code === 'room' || e.code === 'version') {
      location.replace(`index.html?room=${encodeURIComponent(ROOM)}&error=${encodeURIComponent(e.message)}`);
      return;
    }
    showEmpty('Can\'t join this room', e.message);
  });
  conn.on('notice', (m) => SD.toast(m.message));

  conn.on('welcome', (w) => {
    state.me = w.you;
    state.config = w.config;
    state.members = new Map(w.members.map((m) => [m.id, m]));
    board.load(w.board);
    if (myShare) {
      // We reconnected while sharing: carry on if nobody else took over.
      if (w.presenter) stopShare(false);
      else { resetMyMedia(); announceShare(); }
    }
    setPresenter(w.presenter);
    log(`joined from ${SD.browserName()} (${conn.mode === 'ws' ? 'WebSocket' : 'fallback connection'})`);
  });

  conn.on('member-joined', ({ member }) => {
    state.members.set(member.id, member);
    if (isPresenter() && myShare?.p2p) myShare.p2p.addViewer(member.id);
    renderMembers();
  });
  conn.on('member-left', ({ id }) => {
    state.members.delete(id);
    myShare?.p2p?.removeViewer(id);
    board.cursors.delete(id);
    renderMembers();
  });
  conn.on('member-updated', ({ member }) => {
    state.members.set(member.id, member);
    if (member.id === state.me?.id) state.me = member;
    renderMembers();
  });

  conn.on('presenter', ({ presenter, board: snapshot }) => {
    board.load(snapshot);
    toOverlay({ type: 'load', board: snapshot });
    setPresenter(presenter);
  });
  conn.on('presenter-updated', ({ presenter }) => { state.presenter = presenter; updateUI(); });
  conn.on('share-stopped', ({ by }) => {
    stopShare(false);
    SD.toast(`${by} started sharing, so your share was stopped.`);
  });

  for (const t of ['stroke-start', 'stroke-points', 'stroke-end', 'remove', 'sticker-add', 'sticker-update', 'cursor']) {
    conn.on(t, (msg) => { board.apply(msg); toOverlay(msg); });
  }

  conn.on('signal', (m) => { if (myShare?.p2p) myShare.p2p.onSignal(m); else viewP2P?.onSignal(m); });
  conn.on('viewer-quality', (m) => myShare?.p2p?.setViewerQuality(m.id, m.value));
  conn.on('relay-layers', (m) => myShare?.relay?.setLayers(m.layers));
  conn.on('keyframe', (m) => myShare?.relay?.requestKey(m.layer));
  conn.on('relay-config', (c) => viewRelay?.onConfig(c));
  conn.on('binary', (b) => viewRelay?.onBinary(b));
  conn.on('relay-layer', (m) => { if (state.quality === 'auto') SD.toast(m.layer === 1 ? 'Your connection is struggling, so you\'ve been switched to lower quality.' : 'Back to full quality.'); });
  conn.on('relay-unavailable', (m) => { if (!isPresenter()) showEmpty('Can\'t receive this share', m.message); });

  /* ======================================================== who's sharing */

  function setPresenter(p) {
    state.presenter = p;
    if (myShare && (!p || p.id !== state.me?.id) && myShare.started) stopShare(false);
    closeViewerMedia();
    if (!p) {
      showEmpty('Nobody is sharing yet', 'Select Share screen to share your screen or an app. Everyone in the room can draw on it.');
    } else if (p.id === state.me?.id) {
      if (myShare) beginPresenting(); else conn.send({ type: 'share-stop' }); // stale share from before a reload
    } else {
      startViewing(p);
    }
    updateUI();
  }

  function closeViewerMedia() {
    viewP2P?.close(); viewP2P = null;
    viewRelay?.close(); viewRelay = null;
    if (!myShare?.started) video.srcObject = null;
    relayCanvas.classList.add('hidden');
    mediaKind = null;
  }

  function startViewing(p) {
    if (p.mode === 'p2p') {
      if (!SD.webrtcSupported()) { showEmpty('Can\'t play this share', SD.WEBRTC_MISSING); log('WebRTC is disabled in this browser'); return; }
      mediaKind = 'video';
      viewP2P = new SD.P2PViewer({
        conn, presenterId: p.id, iceServers: state.config.iceServers, log,
        onStream: (s) => {
          video.srcObject = s;
          applySound();
          video.play().catch(() => { showEmpty('Click anywhere to start the video'); document.addEventListener('pointerdown', () => video.play().then(hideEmpty), { once: true }); });
          video.addEventListener('loadeddata', () => { hideEmpty(); log(`video showing (${video.videoWidth}x${video.videoHeight}, direct)`); }, { once: true });
        },
        onState: (s, msg) => {
          if (s === 'failed') { showEmpty('Couldn\'t connect directly to the sharer', msg || 'A strict network may be blocking direct connections. The sharer can switch to "Through server" mode, or the server owner can add a TURN server.'); log('direct connection failed'); }
        },
      });
    } else {
      if (!SD.relaySupported.receive()) { showEmpty('Can\'t play this share', 'This browser can\'t play video sent through the server. Use Chrome, Edge, Firefox 130+ or the ScreenDraw app.'); return; }
      if (conn.mode !== 'ws') { showEmpty('Can\'t receive this share', 'Your connection to the server can\'t carry relayed video (WebSockets are blocked on this network). Ask the sharer to use Direct mode.'); return; }
      mediaKind = 'relay';
      relayCanvas.classList.remove('hidden');
      viewRelay = new SD.RelayViewer({
        conn, canvas: relayCanvas, log,
        onSize: layout,
        onFirstFrame: () => { hideEmpty(); log(`video showing (${viewRelay.frameW}x${viewRelay.frameH}, through server)`); },
      });
      if (state.sound) viewRelay.setSound(true, state.volume);
    }
    showWaiting(p);
    if (state.quality !== 'auto') conn.send({ type: 'quality', value: state.quality });
  }

  /* ============================================================== reload */
  // Rebuilds the video connection without leaving the room. Viewers get a fresh
  // connection (direct) or a fresh setup + full frame (through server); the
  // sharer refreshes their own preview and sends everyone a full frame.
  let reloadBusy = false;
  function reloadStream() {
    const p = state.presenter;
    if (!p || reloadBusy) return;
    reloadBusy = true;
    $('#reloadBtn').disabled = true;
    setTimeout(() => { reloadBusy = false; $('#reloadBtn').disabled = false; }, 2500);
    if (isPresenter()) {
      if (myShare?.relay) { myShare.relay.requestKey(0); myShare.relay.requestKey(1); }
      if (!SD.store.get('hidePreview', false) && myShare) { video.srcObject = null; applyPreview(); }
      layout();
      log('reloaded own preview');
      SD.toast('Preview reloaded.');
      return;
    }
    closeViewerMedia();
    startViewing(p);
    if (p.mode === 'p2p') conn.send({ type: 'signal', to: p.id, kind: 'renegotiate' });
    else conn.send({ type: 'relay-resync' });
    log(`reloaded the stream (${p.mode === 'relay' ? 'through server' : 'direct'})`);
  }
  $('#reloadBtn').onclick = reloadStream;

  /* ============================================================== sharing */

  function resetMyMedia() {
    if (!myShare) return;
    myShare.p2p?.stop(); myShare.relay?.stop();
    myShare.p2p = myShare.relay = null;
    myShare.started = false;
  }

  function announceShare() {
    const d = SD.describeTrack(myShare.stream);
    conn.send({ type: 'share-start', mode: myShare.settings.mode, label: myShare.label, width: d.width, height: d.height, audio: myShare.stream.getAudioTracks().length > 0 });
  }

  async function beginPresenting() {
    if (!myShare || myShare.started) return;
    myShare.started = true;
    const p = state.presenter;
    mediaKind = 'video';
    video.muted = true;
    applyPreview();
    if (p.mode === 'p2p') {
      myShare.p2p = new SD.P2PPresenter({ conn, stream: myShare.stream, settings: myShare.settings, iceServers: state.config.iceServers, log });
      for (const id of state.members.keys()) if (id !== state.me.id) myShare.p2p.addViewer(id);
    } else {
      myShare.relay = new SD.RelayPresenter({ conn, stream: myShare.stream, settings: myShare.settings, log });
      myShare.relay.start();
    }
    if (SD.isDesktop && myShare.sourceId) {
      try {
        await window.desktop.openOverlay(myShare.sourceId);
        toOverlay({ type: 'load', board: { strokes: [...board.strokes.values()], stickers: [...board.stickers.values()] } });
        toOverlay({ type: 'members', list: [...state.members.values()], me: state.me.id });
        $('#showOverlay').checked = true;
      } catch (err) { log(`overlay failed: ${err.message}`); }
    }
    // Keep everyone informed if the shared window/screen changes size.
    clearInterval(myShare.sizeTimer);
    myShare.sizeTimer = setInterval(() => {
      if (!myShare) return;
      const d = SD.describeTrack(myShare.stream);
      if (d.width && (d.width !== state.presenter?.width || d.height !== state.presenter?.height)) {
        conn.send({ type: 'share-update', width: d.width, height: d.height });
        myShare.p2p?.updateSize(d.width, d.height);
      }
    }, 2000);
    const wholeScreen = SD.isDesktop ? String(myShare.sourceId).startsWith('screen') : SD.describeTrack(myShare.stream).surface === 'monitor';
    const cantExclude = !SD.isDesktop || window.desktop.info?.platform === 'linux';
    if (wholeScreen && cantExclude && !SD.store.get('hidePreview', false) && !SD.store.get('mirrorTipShown', false)) {
      SD.store.set('mirrorTipShown', true);
      SD.toast('Tip: you\'re sharing the screen ScreenDraw is on, so viewers may see doubled cursors and stickers. Turn on "Hide preview" or minimise ScreenDraw to avoid it.');
    }
    log(`started sharing "${myShare.label}" ${p.mode === 'relay' ? 'through the server' : 'directly'} (${myShare.settings.res}, ${myShare.settings.fps} fps, ${myShare.settings.optimize})`);
    updateUI();
  }

  // The sharer can hide their own preview to save CPU/GPU; viewers aren't affected.
  function applyPreview() {
    if (!myShare) return;
    const hide = !!SD.store.get('hidePreview', false);
    $('#hidePreview').checked = hide;
    // Hiding the preview also hides the drawings, stickers and cursors drawn
    // over it, so nothing of ScreenDraw's own view can end up in the capture.
    boardCanvas.classList.toggle('hidden', hide);
    stickerLayer.classList.toggle('hidden', hide);
    if (hide) {
      video.srcObject = null;
      showEmpty('Your preview is hidden', 'You\'re still sharing, and viewers see your screen and everyone\'s drawings as normal. Turn off "Hide preview" to see it here again.');
    } else {
      video.srcObject = myShare.stream;
      video.play().catch(() => {});
      hideEmpty();
    }
  }
  $('#hidePreview').onchange = (e) => { SD.store.set('hidePreview', e.target.checked); applyPreview(); };

  function stopShare(notify) {
    if (!myShare) return;
    const s = myShare;
    myShare = null;
    boardCanvas.classList.remove('hidden');
    stickerLayer.classList.remove('hidden');
    clearInterval(s.sizeTimer);
    s.p2p?.stop(); s.relay?.stop();
    s.stream.nativeAudio?.stop();
    s.stream.getTracks().forEach((t) => t.stop());
    if (SD.isDesktop) window.desktop.closeOverlay();
    if (notify) conn.send({ type: 'share-stop' });
    if (mediaKind === 'video' && (video.srcObject === s.stream || !video.srcObject)) { video.srcObject = null; mediaKind = null; }
    updateUI();
  }

  async function startShare(settings, sourceId, sourceName) {
    SD.store.set('share', settings);
    let stream;
    try {
      stream = await SD.startCapture(settings, sourceId);
    } catch (err) {
      if (err.name !== 'NotAllowedError' && err.name !== 'AbortError') {
        SD.toast(`Couldn't start sharing: ${err.message}`, 'bad');
        log(`share failed: ${err.name}: ${err.message}`);
      }
      return;
    }
    if (myShare) stopShare(false);
    const d = SD.describeTrack(stream);
    const surface = { monitor: 'the whole screen', window: 'a window', browser: 'a browser tab' }[d.surface];
    let label = sourceName || surface || 'the whole screen';
    if (sourceName && /^(entire screen|screen \d+)$/i.test(sourceName)) label = 'the whole screen';
    if (settings.mode === 'relay' && (!SD.relaySupported.send() || conn.mode !== 'ws')) settings = { ...settings, mode: 'p2p' };
    myShare = { stream, settings, sourceId, label, started: false };
    stream.getVideoTracks()[0].addEventListener('ended', () => stopShare(true));
    announceShare();
  }

  /* ========================================================= share dialog */

  const dlg = $('#shareDialog');
  let sourceKind = 'screen', chosenSource = null, sourceList = [];

  for (const [k, v] of Object.entries(SD.RESOLUTIONS)) $('#resSelect').add(new Option(v.label, k));
  for (const f of SD.FRAME_RATES) $('#fpsSelect').add(new Option(`${f} fps`, String(f)));

  async function loadSources() {
    $('#sources').innerHTML = '<p class="muted">Loading…</p>';
    try { sourceList = await window.desktop.getSources(); } catch (err) { $('#sources').innerHTML = `<p class="muted">Couldn't list screens: ${SD.escape(err.message)}</p>`; return; }
    renderSources();
  }
  function renderSources() {
    const box = $('#sources');
    box.innerHTML = '';
    const list = sourceList.filter((s) => s.kind === sourceKind);
    if (!list.length) box.innerHTML = '<p class="muted">Nothing to show.</p>';
    if (!list.find((s) => s.id === chosenSource?.id)) chosenSource = list[0] || null;
    for (const s of list) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = `source${chosenSource?.id === s.id ? ' selected' : ''}`;
      b.innerHTML = `<img class="thumb" src="${s.thumbnail}" alt="" /><div class="name">${s.icon ? `<img src="${s.icon}" alt="" />` : ''}<span>${SD.escape(s.name)}</span></div>`;
      b.onclick = () => { chosenSource = s; renderSources(); refreshSound(); };
      b.ondblclick = () => { chosenSource = s; $('#startShare').click(); };
      box.appendChild(b);
    }
  }
  $$('.tabs [data-kind]').forEach((b) => b.addEventListener('click', () => {
    sourceKind = b.dataset.kind;
    $$('.tabs [data-kind]').forEach((x) => x.classList.toggle('on', x === b));
    renderSources();
    refreshSound();
  }));

  /* ------------------------------------------------ sound choice (desktop app) */
  let soundInfo = null, soundList = null, soundSaved = null, soundError = '';

  async function setupSound(saved) {
    soundSaved = { mode: 'system', apps: [], except: [], devices: [], ...(saved || {}) };
    $('#soundNote').textContent = 'Checking sound options…';
    soundInfo = await window.desktop.audioInfo().catch((err) => ({ available: false, reason: err.message }));
    await refreshSound();
  }

  async function refreshSound() {
    if (!SD.isDesktop || !soundSaved) return;
    soundError = '';
    if (soundInfo?.available) {
      try { soundList = await window.desktop.audioList(chosenSource?.id); }
      catch (err) { soundList = null; soundError = err.message; }
    }
    renderSound(true);
  }

  function renderSound(pickDefault) {
    const sel = $('#soundMode');
    const list = soundList || { devices: [], apps: [], perApp: false };
    const opt = (v) => sel.querySelector(`option[value=${v}]`);
    const isWindow = chosenSource?.kind === 'window';
    const perApp = !!soundInfo?.available && !!list.perApp;
    opt('window').hidden = !isWindow;
    opt('window').textContent = list.window ? `Only the shared app (${list.window.name})` : 'Only the shared app';
    for (const v of ['window', 'except', 'apps']) opt(v).disabled = !perApp;
    opt('system').disabled = !(window.desktop.info?.systemAudio || (soundInfo?.available && soundInfo.system));
    opt('devices').disabled = !soundInfo?.available || !list.devices.length;
    if (pickDefault) {
      let m = isWindow && perApp ? 'window' : soundSaved.mode;
      if (m === 'window' && !isWindow) m = 'system';
      if (opt(m)?.disabled || opt(m)?.hidden) m = [...sel.options].find((o) => !o.disabled && !o.hidden && o.value !== 'off')?.value || 'off';
      sel.value = m;
    }
    renderPick();
  }

  function renderPick() {
    const mode = $('#soundMode').value;
    const box = $('#soundPick');
    const list = soundList || { apps: [], devices: [] };
    const picking = mode === 'apps' || mode === 'except' || mode === 'devices';
    box.innerHTML = '';
    box.classList.toggle('hidden', !picking);
    let items = [];
    if (mode === 'apps' || mode === 'except') {
      const saved = (mode === 'apps' ? soundSaved.apps : soundSaved.except).map((n) => n.toLowerCase());
      const byName = new Map(list.apps.map((a) => [a.name.toLowerCase(), { key: a.name, label: a.name, tag: a.playing ? 'playing' : 'quiet', on: a.playing }]));
      for (const n of mode === 'apps' ? soundSaved.apps : soundSaved.except) if (!byName.has(n.toLowerCase())) byName.set(n.toLowerCase(), { key: n, label: n, tag: 'not running' });
      items = [...byName.values()].map((i) => ({ ...i, checked: saved.includes(i.key.toLowerCase()) }));
      if (!items.length) box.innerHTML = '<p class="muted small" style="margin:6px">No apps are using sound right now. Start playing something, then select Refresh.</p>';
    } else if (mode === 'devices') {
      items = list.devices.map((d) => ({ key: d.id, label: d.name, tag: d.default ? 'default' : '', checked: soundSaved.devices.includes(d.id) }));
    }
    for (const it of items) {
      const row = document.createElement('label');
      row.innerHTML = `<input type="checkbox" data-key="${SD.escape(it.key)}" ${it.checked ? 'checked' : ''} /><span>${SD.escape(it.label)}</span><span class="tag ${it.on ? 'on' : ''}">${SD.escape(it.tag || '')}</span>`;
      box.appendChild(row);
    }
    const linux = window.desktop.info?.platform === 'linux';
    const notes = {
      off: '',
      window: `Only sound from ${list.window?.name || 'the app you\'re sharing'} is shared, so voice chat and other apps stay out.`,
      system: linux ? 'Sound from every app (except ScreenDraw itself).' : 'Everything you hear, including voice chat like Discord. That can cause echo for your viewers: pick "Everything except these apps" to leave it out.',
      except: 'Tick the apps to leave out (for example Discord). Apps that start playing later are included automatically.',
      apps: 'Tick the apps to share. If they start playing sound later, they\'re picked up automatically.',
      devices: 'Tick one or more outputs, for example "Game" but not "Chat". Everything played on them is shared.',
    };
    $('#soundNote').textContent = !soundInfo?.available ? (soundInfo?.reason || 'Sound sharing isn\'t available.') : soundError || notes[mode] || '';
  }
  $('#soundMode').onchange = () => renderPick();
  $('#refreshSound').onclick = () => refreshSound();

  function collectSound() {
    const mode = $('#soundMode').value;
    const keys = $$('#soundPick input:checked').map((i) => i.dataset.key);
    const sound = { mode, apps: soundSaved.apps, except: soundSaved.except, devices: soundSaved.devices };
    if (mode === 'apps') sound.apps = keys;
    if (mode === 'except') sound.except = keys;
    if (mode === 'devices') sound.devices = keys;
    return sound;
  }
  $('#startShare').addEventListener('click', (e) => {
    if (!SD.isDesktop) return;
    const sound = collectSound();
    if ((sound.mode === 'apps' && !sound.apps.length) || (sound.mode === 'devices' && !sound.devices.length)) {
      e.preventDefault();
      $('#shareError').textContent = sound.mode === 'apps' ? 'Tick at least one app (or choose another sound option).' : 'Tick at least one output device.';
    }
  });
  $('#refreshSources').onclick = loadSources;

  function openShareDialog() {
    const s = SD.shareSettings(state.config?.defaultMode);
    const relayOk = state.config?.allowRelay && SD.relaySupported.send() && conn.mode === 'ws';
    const p2pOk = SD.webrtcSupported();
    if (!relayOk && s.mode === 'relay') s.mode = 'p2p';
    if (!p2pOk && relayOk) s.mode = 'relay';
    $$('input[name=mode]').forEach((r) => {
      r.checked = r.value === s.mode;
      r.disabled = r.value === 'relay' ? !relayOk : !p2pOk;
      r.parentElement.classList.toggle('disabled', r.disabled);
    });
    $('#modeHint').textContent = !p2pOk ? SD.WEBRTC_MISSING
      : !state.config?.allowRelay ? 'The server owner has turned off sending through the server.'
        : !relayOk ? (conn.mode !== 'ws' ? 'Through server needs a WebSocket connection, which this network blocks.' : 'This browser can\'t encode video for the server. Use Chrome, Edge or the app.')
          : 'Through server uploads once, so it scales to more viewers, but uses the server\'s bandwidth.';
    $$('input[name=optimize]').forEach((r) => (r.checked = r.value === s.optimize));
    $('#resSelect').value = s.res;
    $('#fpsSelect').value = String(s.fps);
    const audioOk = SD.canSystemAudio();
    $('#audioCheck').checked = s.audio && audioOk;
    $('#audioCheck').disabled = !audioOk;
    $('#audioLabel').textContent = SD.isDesktop
      ? (audioOk ? 'Share sound (your computer\'s audio)' : 'Share sound (not available on this operating system)')
      : 'Share sound (tick "Share audio" in the browser\'s picker too)';
    const p = state.presenter;
    $('#takeoverNote').classList.toggle('hidden', !p || isPresenter());
    if (p && !isPresenter()) $('#takeoverNote').textContent = `${p.name} is sharing right now. Starting your share will stop theirs.`;
    $('#shareError').textContent = '';
    $('#soundBrowser').classList.toggle('hidden', SD.isDesktop);
    $('#soundDesktop').classList.toggle('hidden', !SD.isDesktop);
    if (SD.isDesktop) setupSound(s.sound);
    $('#sourcePicker').classList.toggle('hidden', !SD.isDesktop);
    $('#browserPickerNote').classList.toggle('hidden', SD.isDesktop);
    if (SD.isDesktop) loadSources();
    dlg.showModal();
  }

  dlg.addEventListener('close', () => {
    if (dlg.returnValue !== 'start') return;
    const settings = {
      mode: $('input[name=mode]:checked')?.value || 'p2p',
      optimize: $('input[name=optimize]:checked')?.value || 'detail',
      res: $('#resSelect').value,
      fps: Number($('#fpsSelect').value),
      audio: $('#audioCheck').checked,
    };
    if (SD.isDesktop) settings.sound = collectSound();
    if (SD.isDesktop && !chosenSource) { SD.toast('Pick a screen or window to share.'); return; }
    startShare(settings, chosenSource?.id, chosenSource?.name);
  });

  $('#shareBtn').onclick = () => { if (state.me) openShareDialog(); };
  $('#stopBtn').onclick = () => stopShare(true);

  /* =================================================== desktop overlay */

  function toOverlay(msg) { if (SD.isDesktop && myShare?.started) window.desktop.toOverlay(msg); }
  if (SD.isDesktop) {
    window.desktop.onOverlayOp((msg) => {
      if (!state.me || !isPresenter()) return;
      board.apply(msg);
      conn.send(msg);
    });
    window.desktop.onDrawMode((on) => $('#drawMine').classList.toggle('on', on));
    $('#drawMine').onclick = () => window.desktop.toggleDrawMode();
    $('#showOverlay').onchange = (e) => window.desktop.setOverlayVisible(e.target.checked);
  }

  /* ============================================================= sound */

  function applySound() {
    const mine = isPresenter();
    video.muted = mine || !state.sound;
    video.volume = state.volume;
    viewRelay?.setSound(state.sound && !mine, state.volume);
    updateUI();
  }
  $('#soundBtn').onclick = () => { state.sound = !state.sound; applySound(); };
  $('#volume').value = state.volume;
  $('#volume').oninput = (e) => { state.volume = Number(e.target.value); SD.store.set('volume', state.volume); if (!state.sound && state.volume > 0) state.sound = true; applySound(); };

  $('#quality').onchange = (e) => {
    state.quality = e.target.value;
    SD.store.set('quality', state.quality);
    conn.send({ type: 'quality', value: state.quality });
  };

  /* ============================================================= stats */

  let statsPrev = null;
  async function updateStats() {
    const box = $('#stats');
    if (box.classList.contains('hidden')) return;
    const p = state.presenter;
    const lines = [`Connection: ${conn.mode === 'ws' ? 'WebSocket' : 'fallback (limited)'}`];
    if (!p) lines.push('Nobody is sharing');
    else {
      lines.push(`Route: ${p.mode === 'relay' ? 'through server' : 'direct (P2P)'}`);
      let cur = null;
      if (isPresenter()) {
        if (myShare?.relay) cur = { ...myShare.relay.stats(), t: performance.now() };
        if (myShare?.p2p) lines.push(`Viewers connected: ${myShare.p2p.viewerCount}`);
        const d = myShare ? SD.describeTrack(myShare.stream) : {};
        lines.push(`Capturing: ${d.width}x${d.height}`);
      } else if (viewRelay) cur = { ...viewRelay.stats(), t: performance.now() };
      else if (viewP2P?.pc) {
        const s = await SD.readStats(viewP2P.pc, 'inbound');
        if (s) cur = { frames: null, fps: s.fps, bytes: s.bytes, size: `${s.width}x${s.height}`, codec: s.codec, t: performance.now() };
      }
      if (cur) {
        if (statsPrev && cur.t > statsPrev.t) {
          const dt = (cur.t - statsPrev.t) / 1000;
          const fps = cur.fps ?? (cur.frames != null ? Math.round((cur.frames - statsPrev.frames) / dt) : '?');
          lines.push(`Video: ${cur.size || '?'} @ ${fps} fps`);
          lines.push(`Bitrate: ${(((cur.bytes - statsPrev.bytes) * 8) / dt / 1e6).toFixed(2)} Mbps`);
        }
        if (cur.codec) lines.push(`Codec: ${cur.codec}`);
        statsPrev = cur;
      }
    }
    box.textContent = lines.join('\n');
  }
  setInterval(updateStats, 1000);
  $('#statsBtn').onclick = () => { $('#stats').classList.toggle('hidden'); statsPrev = null; updateStats(); };

  /* ========================================================= misc buttons */

  $('#copyInvite').onclick = async () => {
    const base = state.config?.publicUrl || SERVER;
    const link = `${base}/?room=${ROOM}`;
    try { await navigator.clipboard.writeText(link); SD.toast(`Invite link copied: ${link}`); }
    catch { prompt('Invite link:', link); }
  };
  const toggleFs = () => (document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen());
  document.addEventListener('fullscreenchange', () => {
    const fs = !!document.fullscreenElement;
    SD.setIcon($('#fullscreenBtn'), fs ? 'minimize' : 'maximize');
    $('#fullscreenBtn').dataset.tip = fs ? 'Exit fullscreen (F)' : 'Fullscreen (F)';
  });
  $('#fullscreenBtn').onclick = toggleFs;
  $('#leaveBtn').onclick = () => { stopShare(true); conn.close(); location.href = 'index.html'; };
  window.addEventListener('pagehide', () => { stopShare(true); conn.close(); });

  window.addEventListener('keydown', (e) => {
    if (e.target.matches('input[type=text], input[type=password], textarea, select') || dlg.open) return;
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); $('#undoBtn').click(); return; }
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const k = e.key.toLowerCase();
    if (/^[0-9]$/.test(k)) setColor(SD.PALETTE[(Number(k) + 9) % 10]);
    else if (k === '[') setSize(state.size - 1);
    else if (k === ']') setSize(state.size + 1);
    else if (k === 'p') setTool('pen');
    else if (k === 'v') setTool('move');
    else if (k === 'e') $('#fadeBtn').click();
    else if (k === 'f') toggleFs();
    else if (k === 'r') reloadStream();
  });

  // Handy for troubleshooting from the browser console.
  SD.debug = { state, board, conn, get relayViewer() { return viewRelay; }, get p2pViewer() { return viewP2P; }, get share() { return myShare; } };

  renderPen();
  showEmpty('Connecting…');
  conn.connect();
})();
