// ScreenDraw desktop app: the same room UI as the website, plus a screen/app
// picker, system audio (Windows), and a transparent click-through overlay that
// shows everyone's drawings on top of whatever you're sharing. You can also
// draw on your own screen (Ctrl+Shift+D).
const { app, BrowserWindow, ipcMain, screen, desktopCapturer, session, dialog, globalShortcut, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const { WindowTracker } = require('./tracker');
const { createAudioSources } = require('./audio');
const { createUpdater } = require('./updater');

const PUBLIC = path.join(__dirname, '..', 'public');
const PRELOAD = path.join(__dirname, 'preload.js');
const DRAW_SHORTCUT = 'CommandOrControl+Shift+D';

if (process.platform === 'linux') {
  app.commandLine.appendSwitch('enable-transparent-visuals');
  app.commandLine.appendSwitch('enable-features', 'WebRTCPipeWireCapturer');
}

/* ------------------------------------------------------------------ logging */
let LOG_FILE = null;
function log(...parts) {
  const line = `[${new Date().toISOString()}] ${parts.join(' ')}`;
  console.log(line);
  try { if (LOG_FILE) fs.appendFileSync(LOG_FILE, line + '\n'); } catch { /* ignore */ }
}
function fail(title, err) {
  log(`${title}:`, err?.stack || err);
  try { dialog.showErrorBox(`ScreenDraw: ${title}`, String(err?.message || err)); } catch { /* not ready */ }
}
process.on('uncaughtException', (err) => fail('Unexpected error', err));
process.on('unhandledRejection', (err) => fail('Unexpected error', err));

function watch(win, name) {
  win.webContents.on('console-message', (e, level, message) => {
    const lvl = e.level ?? level, msg = e.message ?? message;
    if (lvl === 'error' || lvl === 3 || String(msg).startsWith('[ScreenDraw]')) log(`${name}:`, msg);
  });
  win.webContents.on('render-process-gone', (_e, d) => fail(`${name} window crashed`, d.reason));
  // Only our own local pages may load in our windows; links open in the browser.
  win.webContents.on('will-navigate', (e, url) => { if (!url.startsWith('file:')) { e.preventDefault(); shell.openExternal(url); } });
  win.webContents.setWindowOpenHandler(({ url }) => { if (/^https?:/.test(url)) shell.openExternal(url); return { action: 'deny' }; });
}

/* ------------------------------------------------------------------- state */
let mainWin = null;
let overlay = null;
let overlayVisible = true;
let drawMode = false;
let tracker = null;
let sources = new Map(); // id -> DesktopCapturerSource (from the last listing)
let selected = { id: null, audio: false };

const systemAudio = process.platform === 'win32';

// Chosen-sound capture (apps / everything except apps / output devices).
const audio = createAudioSources({
  log: (...a) => log(...a),
  send: (idx, rate, buf) => { if (mainWin && !mainWin.isDestroyed()) mainWin.webContents.send('audio-data', idx, rate, buf); },
  status: (msg) => mainWin?.webContents.send('audio-status', msg),
});

/* -------------------------------------------------------------------- app */
app.whenReady().then(() => {
  LOG_FILE = path.join(app.getPath('userData'), 'screendraw.log');
  log(`ScreenDraw starting (Electron ${process.versions.electron}, ${process.platform} ${process.arch}); log: ${LOG_FILE}`);

  session.defaultSession.setDisplayMediaRequestHandler(async (_req, callback) => {
    try {
      // Look the source up fresh (windows can change since the picker opened).
      let source = null;
      try {
        const list = await desktopCapturer.getSources({ types: ['screen', 'window'], thumbnailSize: { width: 0, height: 0 } });
        source = list.find((s) => s.id === selected.id);
      } catch (err) { log('getSources failed:', err.message); }
      source = source || sources.get(selected.id);
      if (!source) throw new Error('That screen or window is no longer available (was it closed?).');
      log(`capturing "${source.name}"${selected.audio && systemAudio ? ' with system audio' : ''}`);
      callback(selected.audio && systemAudio ? { video: source, audio: 'loopback' } : { video: source });
    } catch (err) {
      log('capture failed:', err.message);
      callback({});
    }
  });

  mainWin = new BrowserWindow({
    width: 1280, height: 820, minWidth: 900, minHeight: 560,
    title: 'ScreenDraw',
    backgroundColor: '#0d0f14',
    icon: path.join(__dirname, 'icon.png'),
    webPreferences: { preload: PRELOAD, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false },
  });
  mainWin.setMenuBarVisibility(false);
  watch(mainWin, 'app');
  mainWin.loadFile(path.join(PUBLIC, 'index.html'));
  mainWin.on('closed', () => { mainWin = null; audio.stop(); closeOverlay(); app.quit(); });

  // Update checks: shortly after start, then every 6 hours.
  updater = createUpdater({ app, log, send: (s) => mainWin?.webContents.send('update-status', s) });
  if (process.env.SCREENDRAW_NO_UPDATE_CHECK !== '1') {
    setTimeout(() => updater.check(false), 8000);
    setInterval(() => updater.check(false), 6 * 60 * 60 * 1000).unref?.();
  }
});

app.on('window-all-closed', () => app.quit());
app.on('will-quit', () => globalShortcut.unregisterAll());

/* -------------------------------------------------------------- sources */
let updater = null;
ipcMain.handle('update-get', () => updater?.status);
ipcMain.handle('update-check', () => updater?.check(true));
ipcMain.handle('update-download', () => updater?.download());
ipcMain.handle('update-install', () => updater?.install());
ipcMain.handle('update-open', () => updater?.openPage());

ipcMain.on('info', (e) => { e.returnValue = { platform: process.platform, systemAudio, version: app.getVersion() }; });

ipcMain.handle('get-sources', async () => {
  const list = await desktopCapturer.getSources({ types: ['screen', 'window'], thumbnailSize: { width: 320, height: 180 }, fetchWindowIcons: true });
  sources = new Map(list.map((s) => [s.id, s]));
  audio.windowTitles = new Map(list.map((s) => [s.id, s.name]));
  const screens = list.filter((s) => s.id.startsWith('screen'));
  return list
    .filter((s) => !/^ScreenDraw( overlay)?$/.test(s.name) && !s.name.startsWith('ScreenDraw —'))
    .map((s) => ({
      id: s.id,
      kind: s.id.startsWith('screen') ? 'screen' : 'window',
      name: s.id.startsWith('screen') && screens.length === 1 ? 'Entire screen' : s.name,
      thumbnail: s.thumbnail.isEmpty() ? '' : s.thumbnail.toDataURL(),
      icon: s.appIcon && !s.appIcon.isEmpty() ? s.appIcon.toDataURL() : '',
    }));
});

ipcMain.handle('select-source', (_e, id, withAudio) => { selected = { id, audio: !!withAudio }; });

ipcMain.handle('audio-info', () => audio.info());
ipcMain.handle('audio-list', (_e, windowSourceId) => audio.list(windowSourceId));
ipcMain.handle('audio-start', async (_e, spec) => { audio.stop(); log(`sound: ${JSON.stringify(spec)}`); return audio.start(spec); });
ipcMain.handle('audio-stop', () => audio.stop());
app.on('will-quit', () => audio.stop());

/* --------------------------------------------------------------- overlay */
function displayFor(sourceId) {
  const src = sources.get(sourceId);
  const all = screen.getAllDisplays();
  return all.find((d) => String(d.id) === String(src?.display_id)) || (all.length === 1 ? all[0] : screen.getPrimaryDisplay());
}

function setDrawMode(on) {
  if (!overlay) on = false;
  drawMode = !!on;
  if (overlay) {
    overlay.setIgnoreMouseEvents(!drawMode);
    overlay.setFocusable(drawMode);
    if (drawMode) { if (!overlayVisible) overlay.showInactive(); overlay.focus(); }
    else if (!overlayVisible) overlay.hide();
    overlay.webContents.send('draw-mode', drawMode);
  }
  mainWin?.webContents.send('draw-mode', drawMode);
}

function placeOverlay(rect) {
  if (!overlay) return;
  if (!rect) { overlay.hide(); return; }
  overlay.setBounds({ x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) });
  if (overlayVisible || drawMode) overlay.showInactive();
}

async function openOverlay(sourceId) {
  closeOverlay();
  // While sharing, keep ScreenDraw's own window out of the capture too.
  // Otherwise a whole-screen share shows your preview (with everyone's cursors
  // and stickers) inside itself, and viewers see doubled, trailing copies.
  // Works on Windows 10 2004+ and macOS; not supported on Linux.
  mainWin?.setContentProtection(true);
  const isWindow = sourceId.startsWith('window');
  const initial = isWindow ? { x: 0, y: 0, width: 400, height: 300 } : displayFor(sourceId).bounds;
  overlay = new BrowserWindow({
    ...initial,
    show: false, transparent: true, backgroundColor: '#00000000', frame: false, hasShadow: false,
    resizable: false, movable: false, minimizable: false, maximizable: false, fullscreenable: false,
    focusable: false, skipTaskbar: true, alwaysOnTop: true, enableLargerThanScreen: true,
    title: 'ScreenDraw overlay',
    webPreferences: { preload: PRELOAD, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false },
  });
  overlay.setIgnoreMouseEvents(true);
  overlay.setAlwaysOnTop(true, 'screen-saver');
  overlay.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  overlay.setContentProtection(true); // keep the overlay out of the screen capture
  overlay.on('closed', () => { overlay = null; });
  watch(overlay, 'overlay');
  await overlay.loadFile(path.join(__dirname, 'overlay.html'));
  overlayVisible = true;

  if (isWindow) {
    tracker = new WindowTracker(sourceId, placeOverlay, log);
    if (!tracker.start()) log('this system can\'t follow app windows; drawings only show for viewers');
  } else {
    overlay.setBounds(initial);
    overlay.showInactive();
  }
  try { globalShortcut.register(DRAW_SHORTCUT, () => setDrawMode(!drawMode)); } catch { /* taken */ }
}

function closeOverlay() {
  mainWin?.setContentProtection(false);
  tracker?.stop(); tracker = null;
  drawMode = false;
  try { globalShortcut.unregister(DRAW_SHORTCUT); } catch { /* ignore */ }
  overlay?.destroy(); overlay = null;
  mainWin?.webContents.send('draw-mode', false);
}

ipcMain.handle('overlay-open', (_e, sourceId) => openOverlay(sourceId));
ipcMain.handle('overlay-close', () => closeOverlay());
ipcMain.handle('overlay-visible', (_e, v) => {
  overlayVisible = !!v;
  if (!overlay) return;
  if (overlayVisible || drawMode) { if (!tracker || tracker.last !== 'none') overlay.showInactive(); }
  else overlay.hide();
});
ipcMain.handle('draw-mode-toggle', () => setDrawMode(!drawMode));
ipcMain.handle('draw-mode', (_e, on) => setDrawMode(on));
ipcMain.on('overlay-msg', (_e, msg) => overlay?.webContents.send('board', msg));
ipcMain.on('overlay-op', (_e, msg) => mainWin?.webContents.send('overlay-op', msg));
