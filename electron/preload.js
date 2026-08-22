const { contextBridge, ipcRenderer } = require('electron')

function subscribe(channel, callback) {
  if (typeof callback !== 'function') return () => {}
  const listener = (_event, payload) => callback(payload)
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

contextBridge.exposeInMainWorld('electron', {
  window: {
    minimize: () => ipcRenderer.send('window:minimize'),
    maximize: () => ipcRenderer.send('window:maximize'),
    close: () => ipcRenderer.send('window:close'),
  },
  runtime: {
    getStatus: () => ipcRenderer.invoke('runtime:get-status'),
    retry: () => ipcRenderer.invoke('runtime:retry'),
    vpnSanity: () => ipcRenderer.invoke('runtime:vpn-sanity'),
    getVpnProfile: () => ipcRenderer.invoke('runtime:get-vpn-profile'),
    setVpnProfileType: (profileType) => ipcRenderer.invoke('runtime:set-vpn-profile-type', profileType),
    replaceWireGuard: (profileType) => ipcRenderer.invoke('runtime:replace-wireguard', profileType),
    openVpnBook: () => ipcRenderer.invoke('runtime:open-vpnbook'),
    restartApp: () => ipcRenderer.invoke('runtime:restart-app'),
    onStatus: (callback) => subscribe('runtime:status', callback),
  },
  player: {
    openTorrent: (request) => ipcRenderer.invoke('player:open-torrent', request),
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
