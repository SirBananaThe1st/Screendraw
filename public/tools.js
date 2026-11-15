// Pen toolbar: colour swatches, custom colour picker and pen size.
// Keyboard: 1–0 pick a swatch, [ and ] change size.
function buildPenTools(container, { storageKey = 'screendraw.pen' } = {}) {
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem(storageKey)) || {}; } catch { /* storage unavailable */ }
  const state = {
    color: COLOR_RE.test(saved.color) ? saved.color : PALETTE[0],
    size: Number(saved.size) >= 1 && Number(saved.size) <= 16 ? Number(saved.size) : 4,
  };

  container.innerHTML = `
    <div class="group swatches"></div>
    <input type="color" title="Custom colour" />
    <div class="sep"></div>
    <div class="group" title="Pen size ([ and ])">
      <span class="dot preview"></span>
      <input type="range" min="1" max="16" step="1" />
    </div>`;

  const swatchBox = container.querySelector('.swatches');
  const picker = container.querySelector('input[type=color]');
  const range = container.querySelector('input[type=range]');
  const preview = container.querySelector('.preview');

  const swatches = PALETTE.map((c, i) => {
    const b = document.createElement('button');
    b.className = 'swatch';
    b.style.background = c;
    b.title = `${c} (${(i + 1) % 10})`;
    b.onclick = () => setColor(c);
    swatchBox.appendChild(b);
    return b;
  });

  function save() { try { localStorage.setItem(storageKey, JSON.stringify(state)); } catch { /* ignore */ } }
  function render() {
    swatches.forEach((b, i) => b.classList.toggle('active', PALETTE[i] === state.color));
    picker.value = state.color;
    range.value = state.size;
    const px = 4 + state.size * 1.2;
    Object.assign(preview.style, { width: `${px}px`, height: `${px}px`, color: state.color });
  }
  function setColor(c) { state.color = c.toLowerCase(); render(); save(); }
  function setSize(s) { state.size = Math.min(16, Math.max(1, s)); render(); save(); }

  picker.oninput = () => setColor(picker.value);
  range.oninput = () => setSize(Number(range.value));
  window.addEventListener('keydown', (e) => {
    if (e.target.matches('input[type=text], input[type=url]') || e.ctrlKey || e.metaKey || e.altKey) return;
    if (/^[0-9]$/.test(e.key)) setColor(PALETTE[(Number(e.key) + 9) % 10]);
    if (e.key === '[') setSize(state.size - 1);
    if (e.key === ']') setSize(state.size + 1);
  });

  render();
  return {
    color: () => state.color,
    width: () => state.size / 1000, // fraction of frame height
  };
}
