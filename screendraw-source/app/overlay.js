// Transparent overlay on the sharer's screen: shows the room's drawings,
// stickers and cursors. In draw mode the sharer can draw here directly.
(() => {
  const { $ } = SD;
  const canvas = $('#canvas');
  const board = new SD.Board();
  const pen = { color: '#ff3b30', size: 5, fade: false, ...SD.store.get('overlayPen', {}) };
  let me = null;
  let drawMode = false;

  const fit = () => SD.fitCanvas(canvas, 0, 0, window.innerWidth, window.innerHeight);
  window.addEventListener('resize', () => { fit(); board.dirty = true; });
  fit();
  const stickerLayer = $('#stickers');
  const stickerTop = $('#stickersTop');
  SD.startRendering(canvas, board, () => ({ hideCursor: me, stickerLayer, stickerTop }));

  window.desktop.onBoard((msg) => {
    if (msg.type === 'load') board.load(msg.board);
    else if (msg.type === 'members') { board.setMembers(msg.list); me = msg.me; }
    else board.apply(msg);
  });

  const send = (msg) => window.desktop.overlayOp(msg);
  const input = SD.attachInput(canvas, {
    board,
    myId: () => me || 'host',
    tool: () => 'pen',
    color: () => pen.color,
    width: () => pen.size / 1000,
    fade: () => (pen.fade ? 3000 : 0),
    send,
    canEdit: () => false,
    enabled: () => drawMode && !!me,
  });

  const save = () => SD.store.set('overlayPen', pen);
  const swatches = SD.PALETTE.slice(0, 8).map((c) => {
    const b = document.createElement('button');
    b.className = 'sw'; b.style.background = c;
    b.onclick = () => { pen.color = c; render(); save(); };
    $('#swatches').appendChild(b);
    return b;
  });
  function render() {
    swatches.forEach((b, i) => b.classList.toggle('active', SD.PALETTE[i] === pen.color));
    $('#fade').classList.toggle('on', pen.fade);
    document.body.style.setProperty('--pen', pen.color);
  }
  $('#fade').onclick = () => { pen.fade = !pen.fade; render(); save(); };
  const undo = () => { const m = { type: 'undo', author: me }; board.apply(m); send(m); };
  $('#undo').onclick = undo;
  $('#clear').onclick = () => { const m = { type: 'clear', all: true, author: me }; board.apply(m); send(m); };
  $('#done').onclick = () => window.desktop.setDrawMode(false);
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') window.desktop.setDrawMode(false);
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') undo();
  });

  window.desktop.onDrawMode((on) => {
    drawMode = on;
    document.body.classList.toggle('draw', on);
    void input;
  });
  render();
})();
