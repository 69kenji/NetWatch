const { contextBridge, ipcRenderer } = require('electron')

function subscribe(channel, callback) {
  if (typeof callback !== 'function') return () => {}
  const listener = (_event, payload) => callback(payload)
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

// Main renderer bridge. Player-control methods live in player-preload.js so the
// transparent player overlay cannot call runtime/setup or main-window channels.
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
    getCredentialStatus: () => ipcRenderer.invoke('runtime:get-credential-status'),
    setSubtitleCredential: (provider, candidate) => ipcRenderer.invoke('runtime:set-subtitle-credential', provider, candidate),
    openCredentialSite: (provider) => ipcRenderer.invoke('runtime:open-credential-site', provider),
    getVpnProfile: () => ipcRenderer.invoke('runtime:get-vpn-profile'),
    setVpnProfileType: (profileType) => ipcRenderer.invoke('runtime:set-vpn-profile-type', profileType),
    replaceWireGuard: (profileType) => ipcRenderer.invoke('runtime:replace-wireguard', profileType),
    openVpnBook: () => ipcRenderer.invoke('runtime:open-vpnbook'),
    restartApp: () => ipcRenderer.invoke('runtime:restart-app'),
    onStatus: (callback) => subscribe('runtime:status', callback),
  },
  player: {
    openTorrent: (request) => ipcRenderer.invoke('player:open-torrent', request),
  },
})
