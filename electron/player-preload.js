const { contextBridge, ipcRenderer } = require('electron')

function subscribe(channel, callback) {
  if (typeof callback !== 'function') return () => {}
  const listener = (_event, payload) => callback(payload)
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

// The player overlay intentionally gets no runtime, setup, window-chrome, or
// arbitrary torrent-opening capability. Episode advancement is derived from the
// current session in the main process, not from a renderer-supplied URL or title.
contextBridge.exposeInMainWorld('electron', {
  appearance: {
    initial: () => ipcRenderer.sendSync('appearance:initial'),
    get: () => ipcRenderer.invoke('appearance:get'),
    onChanged: callback => subscribe('appearance:changed', callback),
  },
  player: {
    getSession: () => ipcRenderer.invoke('player:get-session'),
    getState: () => ipcRenderer.invoke('player:get-state'),
    getPreferences: () => ipcRenderer.invoke('player:preferences:get'),
    updatePreferences: patch => ipcRenderer.invoke('player:preferences:update', patch),
    getPreparation: () => ipcRenderer.invoke('player:get-preparation'),
    getEpisodeInfo: openedAt => ipcRenderer.invoke('player:episode-info', openedAt),
    getNextEpisode: openedAt => ipcRenderer.invoke('player:next-episode-info', openedAt),
    playNextEpisode: openedAt => ipcRenderer.invoke('player:next-episode', openedAt),
    skipIntro: openedAt => ipcRenderer.invoke('player:skip-intro', openedAt),
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
