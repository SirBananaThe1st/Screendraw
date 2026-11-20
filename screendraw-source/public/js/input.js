// Pointer input on a board canvas: drawing, moving/resizing stickers, and
// reporting our cursor position. Works with mouse, pen and touch.
(() => {
  const round = (v) => Math.round(SD.clamp(v, 0, 1) * 10000) / 10000;

  function attachInput(canvas, opts) {
    // opts: board, myId(), tool() 'pen'|'move', color(), width(), fade(), send(msg),
    //       canEdit(sticker), onSelect(id), onCursor(x, y|null), enabled()
    const { board } = opts;
    let stroke = null, buffer = [], scheduled = false, seq = 0;
    let drag = null; // { id, mode: 'move'|'resize', start, orig }
    let selected = null;
    let lastCursor = 0, cursorTimer = null, pendingCursor = null;

    const norm = (e) => {
      const r = canvas.getBoundingClientRect();
      return [(e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height];
    };
    const local = (msg) => { board.apply(msg); opts.send(msg); };

    const flushPoints = () => {
      scheduled = false;
      if (stroke && buffer.length) local({ type: 'stroke-points', id: stroke, pts: buffer });
      buffer = [];
    };

    const setSelected = (id) => {
      if (selected === id) return;
      selected = id;
      board.dirty = true;
      opts.onSelect?.(id);
    };

    const cursor = (x, y) => {
      pendingCursor = x === null ? null : [round(x), round(y)];
      const send = () => { lastCursor = performance.now(); cursorTimer = null; opts.onCursor?.(pendingCursor ? pendingCursor[0] : null, pendingCursor ? pendingCursor[1] : null); };
      if (x === null) { clearTimeout(cursorTimer); return send(); }
      if (cursorTimer) return;
      const wait = Math.max(0, 40 - (performance.now() - lastCursor));
      cursorTimer = setTimeout(send, wait);
    };

    function hitSticker(x, y) {
      const r = canvas.getBoundingClientRect();
      const list = [...board.stickers.values()].reverse();
      for (const st of list) {
        const hx = (st.x + st.w) * r.width, hy = (st.y + st.h) * r.height;
        if (opts.canEdit(st) && Math.abs(x * r.width - hx) <= 10 && Math.abs(y * r.height - hy) <= 10) return { st, mode: 'resize' };
        if (x >= st.x && x <= st.x + st.w && y >= st.y && y <= st.y + st.h) return { st, mode: 'move' };
      }
      return null;
    }

    canvas.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || !opts.enabled()) return;
      e.preventDefault();
      canvas.setPointerCapture(e.pointerId);
      const [x, y] = norm(e);
      if (opts.tool() === 'move') {
        const hit = hitSticker(x, y);
        setSelected(hit ? hit.st.id : null);
        if (hit && opts.canEdit(hit.st)) drag = { id: hit.st.id, mode: hit.mode, start: [x, y], orig: { ...hit.st } };
        return;
      }
      setSelected(null);
      stroke = `${opts.myId()}-${(seq++).toString(36)}${SD.uid(3)}`;
      local({ type: 'stroke-start', id: stroke, author: opts.myId(), color: opts.color(), width: opts.width(), fade: opts.fade(), x: round(x), y: round(y) });
    });

    canvas.addEventListener('pointermove', (e) => {
      const [x, y] = norm(e);
      cursor(x, y);
      if (drag) {
        const st = board.stickers.get(drag.id);
        if (!st) { drag = null; return; }
        const dx = x - drag.start[0], dy = y - drag.start[1];
        if (drag.mode === 'move') { st.x = drag.orig.x + dx; st.y = drag.orig.y + dy; }
        else {
          const scale = Math.max(0.05, (drag.orig.w + dx) / drag.orig.w);
          st.w = drag.orig.w * scale; st.h = drag.orig.h * scale;
        }
        board.dirty = true;
        if (!scheduled) {
          scheduled = true;
          requestAnimationFrame(() => { scheduled = false; if (board.stickers.has(st.id)) opts.send({ type: 'sticker-update', id: st.id, x: st.x, y: st.y, w: st.w, h: st.h }); });
        }
        return;
      }
      if (!stroke) return;
      const events = e.getCoalescedEvents?.() || [];
      for (const ev of events.length ? events : [e]) { const p = norm(ev); buffer.push([round(p[0]), round(p[1])]); }
      if (!scheduled) { scheduled = true; requestAnimationFrame(flushPoints); }
    });

    const end = () => {
      if (drag) {
        const st = board.stickers.get(drag.id);
        if (st) opts.send({ type: 'sticker-update', id: st.id, x: st.x, y: st.y, w: st.w, h: st.h });
        drag = null;
      }
      if (!stroke) return;
      flushPoints();
      local({ type: 'stroke-end', id: stroke });
      stroke = null;
    };
    canvas.addEventListener('pointerup', end);
    canvas.addEventListener('pointercancel', end);
    canvas.addEventListener('lostpointercapture', end);
    canvas.addEventListener('pointerleave', () => { if (!stroke && !drag) cursor(null); });

    window.addEventListener('keydown', (e) => {
      if (!selected || !['Delete', 'Backspace'].includes(e.key) || e.target.matches('input, textarea, select')) return;
      const st = board.stickers.get(selected);
      if (st && opts.canEdit(st)) { local({ type: 'remove', ids: [st.id] }); opts.send({ type: 'sticker-remove', id: st.id }); setSelected(null); }
    });

    return {
      get selected() { return selected; },
      deselect: () => setSelected(null),
      removeSelected() {
        const st = board.stickers.get(selected);
        if (st && opts.canEdit(st)) { board.apply({ type: 'remove', ids: [st.id] }); opts.send({ type: 'sticker-remove', id: st.id }); setSelected(null); }
      },
    };
  }

  // Turn an image file into a sticker data URL that fits the server limits.
  // Animated GIFs are kept byte-for-byte so they stay animated; a GIF over its
  // limit is added as a still image instead (tooBig: true).
  async function makeSticker(file, maxKB, maxGifKB = 2048) {
    const bmp = await createImageBitmap(file);
    if (file.type === 'image/gif') {
      if (file.size <= maxGifKB * 1024) {
        const src = await new Promise((resolve, reject) => {
          const r = new FileReader();
          r.onload = () => resolve(String(r.result));
          r.onerror = () => reject(r.error);
          r.readAsDataURL(file);
        });
        return { src, aspect: bmp.width / bmp.height, animated: true };
      }
      return { ...stillSticker(bmp, maxKB), tooBig: true };
    }
    return stillSticker(bmp, maxKB);
  }

  // Resize and re-encode a still image until it fits.
  function stillSticker(bmp, maxKB) {
    for (const side of [512, 384, 256, 192, 128]) {
      const s = Math.min(1, side / Math.max(bmp.width, bmp.height));
      const c = document.createElement('canvas');
      c.width = Math.max(1, Math.round(bmp.width * s));
      c.height = Math.max(1, Math.round(bmp.height * s));
      c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
      for (const type of ['image/webp', 'image/png']) {
        const src = c.toDataURL(type, 0.86);
        if (!src.startsWith(`data:${type}`)) continue; // browser can't encode this type
        if (src.length <= maxKB * 1024 * 1.33) return { src, aspect: c.width / c.height };
      }
    }
    throw new Error('Image is too detailed to use as a sticker.');
  }

  SD.attachInput = attachInput;
  SD.makeSticker = makeSticker;
})();
