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
  updates: {
    get: () => ipcRenderer.invoke('update-get'),
    check: () => ipcRenderer.invoke('update-check'),
    download: () => ipcRenderer.invoke('update-download'),
    install: () => ipcRenderer.invoke('update-install'),
    openPage: () => ipcRenderer.invoke('update-open'),
    onStatus: (cb) => { ipcRenderer.removeAllListeners('update-status'); ipcRenderer.on('update-status', (_e, s) => cb(s)); },
  },
  // used by the overlay window
  onBoard: (cb) => ipcRenderer.on('board', (_e, msg) => cb(msg)),
  overlayOp: (msg) => ipcRenderer.send('overlay-op', msg),
});
