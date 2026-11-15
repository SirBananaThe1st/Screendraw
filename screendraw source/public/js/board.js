// The shared drawing surface: strokes (optionally vanishing), stickers and
// everyone's cursors. Coordinates are 0..1 relative to the shared screen;
// pen width is a fraction of the screen height.
(() => {
  const FADE_OUT_MS = 450;
  const CURSOR_IDLE_MS = 6000;

  class Board {
    constructor() {
      this.strokes = new Map();
      this.stickers = new Map();
      this.cursors = new Map(); // memberId -> { x, y, t }
      this.members = new Map(); // memberId -> { name, color }
      this.images = new Map(); // src -> HTMLImageElement
      this.dirty = true;
    }

    load(snapshot) {
      this.strokes.clear();
      this.stickers.clear();
      const now = performance.now();
      for (const s of snapshot?.strokes || []) this.strokes.set(s.id, { ...s, points: s.points.slice(), endAt: s.done ? now : null });
      for (const st of snapshot?.stickers || []) this.stickers.set(st.id, { ...st });
      this.dirty = true;
    }

    // Apply a board message (from the server, or our own local action).
    apply(m) {
      switch (m.type) {
        case 'stroke-start':
          this.strokes.set(m.id, { id: m.id, author: m.author, color: m.color, width: m.width, fade: m.fade || 0, points: [[m.x, m.y]], done: false, endAt: null });
          break;
        case 'stroke-points': {
          const s = this.strokes.get(m.id);
          if (!s) return false;
          for (const p of m.pts) s.points.push(p);
          break;
        }
        case 'stroke-end': {
          const s = this.strokes.get(m.id);
          if (!s) return false;
          s.done = true;
          s.endAt = performance.now();
          break;
        }
        case 'remove':
          for (const id of m.ids) { this.strokes.delete(id); this.stickers.delete(id); }
          break;
        case 'undo': { // local optimistic undo
          let last = null;
          for (const s of this.strokes.values()) if (s.author === m.author) last = s.id;
          if (last) this.strokes.delete(last);
          break;
        }
        case 'clear': // local optimistic clear
          for (const [id, s] of this.strokes) if (m.all || s.author === m.author) this.strokes.delete(id);
          for (const [id, s] of this.stickers) if (m.all || s.author === m.author) this.stickers.delete(id);
          break;
        case 'sticker-add':
          this.stickers.set(m.id, { id: m.id, author: m.author, src: m.src, x: m.x, y: m.y, w: m.w, h: m.h });
          break;
        case 'sticker-update': {
          const st = this.stickers.get(m.id);
          if (!st) return false;
          Object.assign(st, { x: m.x, y: m.y, w: m.w, h: m.h });
          break;
        }
        case 'cursor':
          if (m.x === null) this.cursors.delete(m.id);
          else this.cursors.set(m.id, { x: m.x, y: m.y, t: performance.now() });
          break;
        default:
          return false;
      }
      this.dirty = true;
      return true;
    }

    setMembers(list) {
      this.members = new Map(list.map((m) => [m.id, { name: m.name, color: m.color }]));
      for (const id of [...this.cursors.keys()]) if (!this.members.has(id)) this.cursors.delete(id);
      this.dirty = true;
    }

    image(src) {
      let img = this.images.get(src);
      if (!img) {
        img = new Image();
        img.onload = () => (this.dirty = true);
        img.src = src;
        this.images.set(src, img);
        if (this.images.size > 80) this.images.delete(this.images.keys().next().value);
      }
      return img;
    }

    // Draws everything. Returns true while something is animating.
    render(ctx, w, h, { selected = null, hideCursor = null, editable = () => false } = {}) {
      const now = performance.now();
      let animating = false;
      ctx.clearRect(0, 0, w, h);

      for (const st of this.stickers.values()) {
        const img = this.image(st.src);
        if (img.complete && img.naturalWidth) ctx.drawImage(img, st.x * w, st.y * h, st.w * w, st.h * h);
        if (selected === st.id) {
          ctx.save();
          ctx.strokeStyle = '#5b8cff'; ctx.lineWidth = 2; ctx.setLineDash([6, 4]);
          ctx.strokeRect(st.x * w, st.y * h, st.w * w, st.h * h);
          ctx.setLineDash([]);
          if (editable(st)) {
            ctx.fillStyle = '#5b8cff';
            ctx.fillRect((st.x + st.w) * w - 7, (st.y + st.h) * h - 7, 14, 14);
          }
          ctx.restore();
        }
      }

      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      for (const s of this.strokes.values()) {
        let alpha = 1;
        if (s.fade && s.done) {
          const age = now - s.endAt;
          if (age >= s.fade) { this.strokes.delete(s.id); continue; }
          if (age > s.fade - FADE_OUT_MS) alpha = (s.fade - age) / FADE_OUT_MS;
          animating = true;
        }
        drawStroke(ctx, s, w, h, alpha);
      }

      for (const [id, c] of this.cursors) {
        if (id === hideCursor) continue;
        const age = now - c.t;
        if (age > CURSOR_IDLE_MS) { this.cursors.delete(id); continue; }
        const m = this.members.get(id);
        if (!m) continue;
        const alpha = age > CURSOR_IDLE_MS - 800 ? (CURSOR_IDLE_MS - age) / 800 : 1;
        drawCursor(ctx, c.x * w, c.y * h, m.color, m.name, alpha);
        animating = true; // keep checking idle timeouts
      }

      this.dirty = false;
      return animating;
    }
  }

  function drawStroke(ctx, s, w, h, alpha) {
    const p = s.points;
    ctx.globalAlpha = alpha;
    ctx.strokeStyle = s.color;
    ctx.lineWidth = Math.max(1, s.width * h);
    ctx.beginPath();
    ctx.moveTo(p[0][0] * w, p[0][1] * h);
    if (p.length === 1) ctx.lineTo(p[0][0] * w + 0.01, p[0][1] * h);
    for (let i = 1; i < p.length - 1; i++) {
      const mx = ((p[i][0] + p[i + 1][0]) / 2) * w, my = ((p[i][1] + p[i + 1][1]) / 2) * h;
      ctx.quadraticCurveTo(p[i][0] * w, p[i][1] * h, mx, my);
    }
    if (p.length > 1) ctx.lineTo(p[p.length - 1][0] * w, p[p.length - 1][1] * h);
    ctx.stroke();
    ctx.globalAlpha = 1;
  }

  function drawCursor(ctx, x, y, color, name, alpha) {
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.translate(x, y);
    ctx.beginPath();
    ctx.moveTo(0, 0); ctx.lineTo(0, 17); ctx.lineTo(4.5, 13); ctx.lineTo(8, 20.5); ctx.lineTo(10.8, 19.3); ctx.lineTo(7.4, 12); ctx.lineTo(13, 12); ctx.closePath();
    ctx.fillStyle = color; ctx.fill();
    ctx.lineWidth = 1.5; ctx.strokeStyle = '#fff'; ctx.stroke();
    ctx.font = '600 12px system-ui, -apple-system, Segoe UI, sans-serif';
    const tw = ctx.measureText(name).width;
    ctx.fillStyle = color;
    roundRect(ctx, 14, 16, tw + 12, 20, 6); ctx.fill();
    ctx.fillStyle = luminance(color) > 0.6 ? '#000' : '#fff';
    ctx.fillText(name, 20, 30);
    ctx.restore();
  }

  function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
  }

  function luminance(hex) {
    const n = parseInt(hex.slice(1), 16);
    return (0.299 * ((n >> 16) & 255) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255;
  }

  // Redraw on animation frames whenever something changed.
  function startRendering(canvas, board, getOptions = () => ({})) {
    const ctx = canvas.getContext('2d');
    let animating = false;
    (function frame() {
      if ((board.dirty || animating) && canvas._css) {
        const { w, h, dpr } = canvas._css;
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        animating = board.render(ctx, w, h, getOptions());
      }
      requestAnimationFrame(frame);
    })();
  }

  SD.Board = Board;
  SD.startRendering = startRendering;
})();
