const { contextBridge, ipcRenderer } = require('electron')

function subscribe(channel, callback) {
  if (typeof callback !== 'function') return () => {}
  const listener = (_event, payload) => callback(payload)
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

// The player overlay intentionally gets no runtime, setup, window-chrome, or
// torrent-opening capability. It can only control the already-open player.
contextBridge.exposeInMainWorld('electron', {
  player: {
    getSession: () => ipcRenderer.invoke('player:get-session'),
    getState: () => ipcRenderer.invoke('player:get-state'),
    getPreparation: () => ipcRenderer.invoke('player:get-preparation'),
    command: (action) => ipcRenderer.invoke('player:command', action),
    close: () => ipcRenderer.invoke('player:close'),
    setFullscreen: (enabled) => ipcRenderer.invoke('player:set-fullscreen', enabled),
    toggleFullscreen: () => ipcRenderer.invoke('player:toggle-fullscreen'),
    getWindowState: () => ipcRenderer.invoke('player:get-window-state'),
    onState: (callback) => subscribe('player:state', callback),
    onPreparation: (callback) => subscribe('player:preparation', callback),
    onSession: (callback) => subscribe('player:session', callback),
    onWindowState: (callback) => subscribe('player:window-state', callback),
    onLog: (callback) => subscribe('player:log', callback),
  },
})
