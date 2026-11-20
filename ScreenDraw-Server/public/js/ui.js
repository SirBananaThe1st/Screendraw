// Room chrome: folds the top strip and tool rail away during a share, rail pop-outs, tooltips.
(() => {
  const SD = window.SD;
  const $ = (s) => document.querySelector(s);
  const body = document.body;
  const EDGE = 56;          // px from the top or left edge that brings the controls back
  const IDLE_MS = 2000;     // how long the controls stay after the pointer leaves them

  let pinned = !!SD.store.get('uiPinned');
  let forced = false;       // opened with the handle or H; stays until closed the same way
  let hot = false;          // pointer is over the controls or near an edge
  let timer = null;
  let muted = false;        // just hidden on purpose: ignore hover until the pointer moves away

  const dialogOpen = () => !!document.querySelector('dialog[open]');
  const popOpen = () => !!document.querySelector('.pop.open');
  const sharing = () => body.classList.contains('sharing');

  let wasSharing = false;
  function apply() {
    if (sharing() && !wasSharing) { hot = true; clearTimeout(timer); timer = null; setHot(false); } // a share just started: let people see the controls before they fold away
    wasSharing = sharing();
    const show = !sharing() || pinned || forced || hot || dialogOpen() || popOpen();
    body.classList.toggle('chrome-hidden', !show);
    body.classList.toggle('pinned', pinned);
    $('#uiToggle').setAttribute('aria-label', show ? 'Hide controls' : 'Show controls');
    $('#uiToggle').dataset.tip = show ? 'Hide controls (H)' : 'Show controls (H)';
    $('#uiToggle').classList.toggle('on', forced);
    SD.setIcon($('#pinBtn'), pinned ? 'pin-off' : 'pin');
    $('#pinBtn').classList.toggle('on', pinned);
    $('#pinBtn').dataset.tip = pinned ? 'Let controls hide during a share (H)' : 'Keep controls visible (H)';
    $('#pinBtn').setAttribute('aria-pressed', String(pinned));
  }
  function setHot(v) {
    if (v) { clearTimeout(timer); timer = null; if (!hot) { hot = true; apply(); } return; }
    if (!hot || timer) return; // already counting down
    timer = setTimeout(() => { timer = null; hot = false; apply(); }, IDLE_MS);
  }

  window.addEventListener('pointermove', (e) => {
    body.classList.add('moved');
    clearTimeout(apply.fadeHandle);
    apply.fadeHandle = setTimeout(() => body.classList.remove('moved'), IDLE_MS);
    if (e.buttons && e.target.id === 'board') return; // drawing near an edge shouldn't pop the bars over the pen
    const overChrome = !!e.target.closest?.('.chrome');
    const nearEdge = e.clientY < EDGE || e.clientX < EDGE;
    if (muted) { if (!overChrome && !nearEdge && !e.target.closest?.('.handle')) muted = false; return; }
    if (overChrome || nearEdge) setHot(true);
    else setHot(false);
  }, { passive: true });
  document.documentElement.addEventListener('pointerleave', () => setHot(false));

  // Keyboard focus inside the controls keeps them visible.
  document.addEventListener('focusin', (e) => { if (e.target.closest?.('.chrome')) setHot(true); });

  $('#uiToggle').onclick = () => {
    const visible = !body.classList.contains('chrome-hidden');
    if (forced || (visible && sharing() && !pinned)) { forced = false; hot = false; muted = true; clearTimeout(timer); timer = null; }
    else forced = true;
    apply();
  };
  $('#pinBtn').onclick = () => { pinned = !pinned; SD.store.set('uiPinned', pinned); forced = false; apply(); };

  /* ------------------------------------------------------------ pop-outs */

  function closePops(except) {
    document.querySelectorAll('.pop.open').forEach((p) => { if (p !== except) p.classList.remove('open'); });
    document.querySelectorAll('[data-pop]').forEach((b) => b.classList.toggle('popped', !!except && b.dataset.pop === except.id));
  }
  document.querySelectorAll('[data-pop]').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const pop = document.getElementById(btn.dataset.pop);
      const opening = !pop.classList.contains('open');
      closePops(opening ? pop : null);
      if (!opening) { apply(); return; }
      const r = btn.getBoundingClientRect();
      pop.classList.add('open');
      const h = pop.offsetHeight;
      pop.style.left = `${r.right + 8}px`;
      pop.style.top = `${Math.max(8, Math.min(r.top, innerHeight - h - 8))}px`;
      apply();
    });
  });
  document.addEventListener('pointerdown', (e) => { if (!e.target.closest('.pop, [data-pop]')) { closePops(null); apply(); } });
  // A swatch pick is a complete choice, so the colour pop-out closes.
  $('#swatches').addEventListener('click', (e) => { if (e.target.closest('.swatch')) { closePops(null); apply(); } });

  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && popOpen()) { closePops(null); apply(); return; }
    if (e.ctrlKey || e.metaKey || e.altKey || dialogOpen()) return;
    if (e.target.matches('input[type=text], input[type=password], textarea, select')) return;
    if (e.key.toLowerCase() === 'h') { $('#uiToggle').click(); }
  });

  // Dialogs opening or closing change whether the controls may hide.
  new MutationObserver(apply).observe(document.body, { subtree: true, attributes: true, attributeFilter: ['open'] });

  /* ------------------------------------------------------------- tooltips */

  const tip = document.createElement('div');
  tip.className = 'tip';
  tip.setAttribute('role', 'tooltip');
  document.body.appendChild(tip);
  let tipFor = null, tipTimer = null;
  function showTip(el) {
    const text = el.dataset.tip;
    if (!text) return;
    tipFor = el;
    tip.textContent = text;
    tip.classList.add('on');
    const r = el.getBoundingClientRect(), t = tip.getBoundingClientRect();
    const inRail = !!el.closest('.rail');
    let x, y;
    if (inRail) { x = r.right + 10; y = r.top + (r.height - t.height) / 2; }
    else { x = r.left + (r.width - t.width) / 2; y = r.bottom + 8; if (y + t.height > innerHeight - 4) y = r.top - t.height - 8; }
    tip.style.left = `${Math.round(Math.max(6, Math.min(x, innerWidth - t.width - 6)))}px`;
    tip.style.top = `${Math.round(Math.max(6, y))}px`;
  }
  const hideTip = () => { clearTimeout(tipTimer); tipFor = null; tip.classList.remove('on'); };
  document.addEventListener('pointerover', (e) => {
    const el = e.target.closest?.('[data-tip]');
    if (el === tipFor) return;
    hideTip();
    if (el && !el.closest('.pop.open') && !(el.dataset.pop && document.getElementById(el.dataset.pop)?.classList.contains('open'))) {
      tipTimer = setTimeout(() => showTip(el), 450);
    }
  });
  document.addEventListener('pointerdown', hideTip, true);
  document.addEventListener('focusin', (e) => { if (e.target.matches?.(':focus-visible') && e.target.dataset?.tip) showTip(e.target); });
  document.addEventListener('focusout', hideTip);
  // Native title tooltips would double up with ours.
  document.querySelectorAll('[data-tip][title]').forEach((el) => el.removeAttribute('title'));

  SD.ui = { refresh: apply, closePops, debug: () => ({ pinned, forced, hot, timer: !!timer, muted }) };
  apply();
})();
