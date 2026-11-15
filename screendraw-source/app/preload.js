const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('desktop', {
  info: ipcRenderer.sendSync('info'),
  getSources: () => ipcRenderer.invoke('get-sources'),
  selectSource: (id, audio) => ipcRenderer.invoke('select-source', id, audio),
  openOverlay: (sourceId) => ipcRenderer.invoke('overlay-open', sourceId),
  closeOverlay: () => ipcRenderer.invoke('overlay-close'),
  setOverlayVisible: (v) => ipcRenderer.invoke('overlay-visible', v),
  toOverlay: (msg) => ipcRenderer.send('overlay-msg', msg),
  onOverlayOp: (cb) => ipcRenderer.on('overlay-op', (_e, msg) => cb(msg)),
  toggleDrawMode: () => ipcRenderer.invoke('draw-mode-toggle'),
  setDrawMode: (on) => ipcRenderer.invoke('draw-mode', on),
  onDrawMode: (cb) => ipcRenderer.on('draw-mode', (_e, on) => cb(on)),
  audioInfo: () => ipcRenderer.invoke('audio-info'),
  audioList: (windowSourceId) => ipcRenderer.invoke('audio-list', windowSourceId),
  audioStart: (spec) => ipcRenderer.invoke('audio-start', spec),
  audioStop: () => ipcRenderer.invoke('audio-stop'),
  onAudioData: (cb) => { ipcRenderer.removeAllListeners('audio-data'); ipcRenderer.on('audio-data', (_e, idx, rate, buf) => cb(idx, rate, buf)); },
  onAudioStatus: (cb) => { ipcRenderer.removeAllListeners('audio-status'); ipcRenderer.on('audio-status', (_e, msg) => cb(msg)); },
  // used by the overlay window
  onBoard: (cb) => ipcRenderer.on('board', (_e, msg) => cb(msg)),
  overlayOp: (msg) => ipcRenderer.send('overlay-op', msg),
});
