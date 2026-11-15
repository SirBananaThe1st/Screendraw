const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('desktop', {
  displays: () => ipcRenderer.invoke('displays'),
  selectDisplay: (id) => ipcRenderer.invoke('select-display', id),
  openOverlay: () => ipcRenderer.invoke('overlay-open'),
  closeOverlay: () => ipcRenderer.invoke('overlay-close'),
  setOverlayVisible: (v) => ipcRenderer.invoke('overlay-visible', v),
  toOverlay: (msg) => ipcRenderer.send('overlay-msg', msg),
  onBoard: (cb) => ipcRenderer.on('board', (_e, msg) => cb(msg)),
});
