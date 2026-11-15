// Desktop sharer: captures a display and draws viewers' strokes on a
// transparent, click-through, always-on-top window covering that display.
const { app, BrowserWindow, ipcMain, screen, desktopCapturer, session } = require('electron');
const path = require('path');

if (process.platform === 'linux') {
  app.commandLine.appendSwitch('enable-transparent-visuals');
  app.commandLine.appendSwitch('enable-features', 'WebRTCPipeWireCapturer');
}

let control = null;
let overlay = null;
let selectedDisplayId = null;

const preload = path.join(__dirname, 'preload.js');
const findDisplay = () =>
  screen.getAllDisplays().find((d) => String(d.id) === String(selectedDisplayId)) || screen.getPrimaryDisplay();

app.whenReady().then(() => {
  // Answer getDisplayMedia() in the control window with the chosen display.
  session.defaultSession.setDisplayMediaRequestHandler(async (_request, callback) => {
    const sources = await desktopCapturer.getSources({ types: ['screen'] });
    const source = sources.find((s) => String(s.display_id) === String(selectedDisplayId)) || sources[0];
    callback(source ? { video: source } : {});
  });

  control = new BrowserWindow({
    width: 480,
    height: 760,
    minWidth: 420,
    title: 'ScreenDraw',
    backgroundColor: '#0f1115',
    webPreferences: { preload, contextIsolation: true, nodeIntegration: false },
  });
  control.setMenuBarVisibility(false);
  control.loadFile(path.join(__dirname, 'control.html'));
  control.on('closed', () => {
    control = null;
    overlay?.destroy();
    app.quit();
  });
});

app.on('window-all-closed', () => app.quit());

ipcMain.handle('displays', () => {
  const primary = screen.getPrimaryDisplay().id;
  return screen.getAllDisplays().map((d, i) => ({
    id: String(d.id),
    label: `Display ${i + 1} — ${d.size.width}×${d.size.height}${d.id === primary ? ' (primary)' : ''}`,
  }));
});

ipcMain.handle('select-display', (_e, id) => {
  selectedDisplayId = id;
});

ipcMain.handle('overlay-open', async () => {
  overlay?.destroy();
  const { bounds } = findDisplay();
  overlay = new BrowserWindow({
    ...bounds,
    show: false,
    transparent: true,
    backgroundColor: '#00000000',
    frame: false,
    hasShadow: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    focusable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    enableLargerThanScreen: true,
    webPreferences: { preload, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false },
  });
  // Clicks and keys pass straight through to whatever is underneath.
  overlay.setIgnoreMouseEvents(true);
  overlay.setAlwaysOnTop(true, 'screen-saver');
  overlay.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  // Keep the overlay itself out of the screen capture, so viewers don't
  // see a delayed duplicate of every stroke. (Windows 10 2004+ and macOS.)
  overlay.setContentProtection(true);
  overlay.on('closed', () => (overlay = null));

  await overlay.loadFile(path.join(__dirname, 'overlay.html'));
  overlay.setBounds(bounds);
  overlay.showInactive();
});

ipcMain.handle('overlay-close', () => {
  overlay?.destroy();
  overlay = null;
});

ipcMain.handle('overlay-visible', (_e, visible) => {
  if (!overlay) return;
  visible ? overlay.showInactive() : overlay.hide();
});

ipcMain.on('overlay-msg', (_e, msg) => overlay?.webContents.send('board', msg));
