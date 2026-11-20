// Update bar (desktop app only): shows when GitHub has a newer release.
(() => {
  if (!window.SD?.isDesktop || !window.desktop?.updates) return;
  const U = window.desktop.updates;
  let bar = null;

  function ensureBar() {
    if (bar) return bar;
    bar = document.createElement('div');
    bar.id = 'updateBar';
    bar.className = 'updatebar hidden';
    document.body.appendChild(bar);
    return bar;
  }

  const inRoom = () => !!document.querySelector('#stage');
  const sharing = () => !!window.SD.debug?.share;

  function button(label, cls, fn) {
    const b = document.createElement('button');
    b.textContent = label;
    b.className = `btn ${cls || ''}`.trim();
    b.onclick = fn;
    return b;
  }
  function closeButton(fn) {
    const b = document.createElement('button');
    b.className = 'ib';
    b.setAttribute('aria-label', 'Dismiss');
    b.innerHTML = SD.icon ? SD.icon('x') : 'Close';
    b.onclick = fn;
    return b;
  }

  function render(s) {
    const el = ensureBar();
    el.innerHTML = '';
    const text = document.createElement('span');
    el.appendChild(text);
    const hide = () => el.classList.add('hidden');
    el.classList.remove('hidden');

    switch (s?.state) {
      case 'available': {
        if (!s.manual && SD.store.get('skipVersion') === s.version) return hide();
        text.textContent = `ScreenDraw ${s.version} is available (you have ${s.current}).`;
        if (s.method === 'auto') el.appendChild(button('Update', 'primary', () => U.download()));
        else el.appendChild(button('Download', 'primary', () => U.openPage()));
        el.appendChild(button('What\'s new', 'ghost', () => U.openPage()));
        el.appendChild(button('Skip this version', 'ghost', () => { SD.store.set('skipVersion', s.version); hide(); }));
        el.appendChild(closeButton(hide));
        return;
      }
      case 'downloading':
        text.textContent = `Downloading ScreenDraw ${s.version}… ${s.percent || 0}%`;
        return;
      case 'ready':
        text.textContent = `ScreenDraw ${s.version} is ready.`;
        el.appendChild(button('Restart to update', 'primary', () => {
          if (inRoom() && !confirm(sharing() ? 'Restarting stops your share and leaves the room. Update now?' : 'Restarting leaves the room. Update now?')) return;
          U.install();
        }));
        el.appendChild(button('Later', 'ghost', hide));
        return;
      case 'error':
        text.textContent = `Update failed: ${s.message}`;
        el.appendChild(button('Open download page', '', () => U.openPage()));
        el.appendChild(closeButton(hide));
        return;
      case 'none':
        hide();
        if (s.manual) SD.toast(`You're up to date (ScreenDraw ${s.current}).`);
        return;
      case 'check-failed':
        hide();
        if (s.manual) SD.toast(`Couldn't check for updates: ${s.message}`, 'bad');
        return;
      default:
        hide();
    }
  }

  U.onStatus(render);
  U.get().then((s) => s && render(s)).catch(() => {});

  // Join screen: version + manual check link
  const card = document.querySelector('#joinCard');
  if (card) {
    const p = document.createElement('p');
    p.className = 'foot';
    p.innerHTML = `Version ${SD.escape(window.desktop.info?.version || '')}. <a href="#" id="checkUpdates">Check for updates</a>`;
    card.appendChild(p);
    p.querySelector('#checkUpdates').onclick = (e) => { e.preventDefault(); U.check(); };
  }
})();
