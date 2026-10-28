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
  appearance: {
    initial: () => ipcRenderer.sendSync('appearance:initial'),
    get: () => ipcRenderer.invoke('appearance:get'),
    update: patch => ipcRenderer.invoke('appearance:update', patch),
    preview: color => ipcRenderer.invoke('appearance:preview', color),
    importImage: () => ipcRenderer.invoke('appearance:import'),
    image: () => ipcRenderer.invoke('appearance:image'),
    onChanged: callback => subscribe('appearance:changed', callback),
  },
  window: {
    minimize: () => ipcRenderer.send('window:minimize'),
    maximize: () => ipcRenderer.send('window:maximize'),
    close: () => ipcRenderer.send('window:close'),
  },
  settings: {
    get: () => ipcRenderer.invoke('settings:get'),
    update: (patch) => ipcRenderer.invoke('settings:update', patch),
  },
  profiles: {
    getState: () => ipcRenderer.invoke('profiles:get-state'),
    create: (name, kind) => ipcRenderer.invoke('profiles:create', name, kind),
    rename: (id, name) => ipcRenderer.invoke('profiles:rename', id, name),
    update: (id, patch) => ipcRenderer.invoke('profiles:update', id, patch),
    avatar: id => ipcRenderer.invoke('profiles:avatar', id),
    importAvatar: id => ipcRenderer.invoke('profiles:import-avatar', id),
    export: (id, localProfile) => ipcRenderer.invoke('profiles:export', id, localProfile),
    import: () => ipcRenderer.invoke('profiles:import'),
    commitImport: (token, selection) => ipcRenderer.invoke('profiles:commit-import', token, selection),
    cancelImport: token => ipcRenderer.invoke('profiles:cancel-import', token),
    switch: id => ipcRenderer.invoke('profiles:switch', id),
    delete: id => ipcRenderer.invoke('profiles:delete', id),
    onChanged: callback => subscribe('profiles:changed', callback),
  },
  history: {
    getState: () => ipcRenderer.invoke('history:get-state'),
    remove: id => ipcRenderer.invoke('history:remove', id),
    clearTitle: catalogId => ipcRenderer.invoke('history:clear-title', catalogId),
    clear: () => ipcRenderer.invoke('history:clear'),
    onChanged: callback => subscribe('history:changed', callback),
  },
  notifications: {
    seriesUpdates: titles => ipcRenderer.invoke('notifications:series-updates', titles),
  },
  library: {
    list: () => ipcRenderer.invoke('library:list'),
    addFolder: () => ipcRenderer.invoke('library:add-folder'),
    removeFolder: id => ipcRenderer.invoke('library:remove-folder', id),
    search: query => ipcRenderer.invoke('library:search', query),
    match: (id, selection) => ipcRenderer.invoke('library:match', id, selection),
    play: id => ipcRenderer.invoke('library:play', id),
  },
  keepWatching: {
    getState: () => ipcRenderer.invoke('keep-watching:get-state'),
    remove: catalogId => ipcRenderer.invoke('keep-watching:remove', catalogId),
    markEpisodeWatched: (mediaItem, durationSeconds) => ipcRenderer.invoke('keep-watching:mark-episode-watched', mediaItem, durationSeconds),
    removeEpisode: (catalogId, season, episode) => ipcRenderer.invoke('keep-watching:remove-episode', catalogId, season, episode),
    onChanged: (callback) => subscribe('keep-watching:changed', callback),
  },
  diagnostics: {
    copy: () => ipcRenderer.invoke('diagnostics:copy'),
  },
  backup: {
    export: localProfiles => ipcRenderer.invoke('backup:export', localProfiles),
    prepareImport: () => ipcRenderer.invoke('backup:prepare-import'),
    commitImport: (token, selection) => ipcRenderer.invoke('backup:commit-import', token, selection),
    cancelImport: token => ipcRenderer.invoke('backup:cancel-import', token),
  },
  updates: {
    check: () => ipcRenderer.invoke('updates:check'),
    download: () => ipcRenderer.invoke('updates:download'),
    openInstaller: () => ipcRenderer.invoke('updates:open-installer'),
    openReleasePage: () => ipcRenderer.invoke('updates:open-release-page'),
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
  remote: {
    getStatus: () => ipcRenderer.invoke('remote:get-status'),
    enable: (options) => ipcRenderer.invoke('remote:enable', options),
    disable: () => ipcRenderer.invoke('remote:disable'),
    beginPairing: () => ipcRenderer.invoke('remote:begin-pairing'),
    cancelPairing: () => ipcRenderer.invoke('remote:cancel-pairing'),
    revokeDevice: (deviceId) => ipcRenderer.invoke('remote:revoke-device', deviceId),
    revokeAll: () => ipcRenderer.invoke('remote:revoke-all'),
    regenerateIdentity: () => ipcRenderer.invoke('remote:regenerate-identity'),
    onStatus: (callback) => subscribe('remote:status', callback),
  },
  player: {
    openTorrent: (request) => ipcRenderer.invoke('player:open-torrent', request),
    openDirectTorrent: (request) => ipcRenderer.invoke('player:open-direct-torrent', request),
  },
})
