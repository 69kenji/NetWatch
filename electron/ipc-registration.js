'use strict'

const { app, clipboard, dialog, ipcMain, Notification, shell } = require('electron')
const { VPNBOOK_REFRESH_URL } = require('./vpn-profile')

const DIAGNOSTIC_SERVICES = Object.freeze([
  ['docker', 'Docker Desktop'],
  ['stack', 'VPN Tunnel'],
  ['backend', 'Backend API'],
  ['torrentEngine', 'Torrent Engine'],
  ['prowlarr', 'Prowlarr'],
])

function diagnosticState(value) {
  const normalized = String(value || '').toLowerCase()
  if (normalized.includes('disabled')) return 'disabled'
  if (['error', 'unhealthy', 'failed', 'dead', 'disconnected', 'not connected', 'unavailable', 'stopped', 'missing'].some(token => normalized.includes(token))) return 'error'
  if (['ready', 'healthy', 'running', 'ok', 'connected'].some(token => normalized.includes(token))) return 'ready'
  return 'pending'
}

function runtimeDiagnosticsText(runtime) {
  const state = runtime && typeof runtime === 'object' ? runtime : {}
  const services = state.services && typeof state.services === 'object' ? state.services : {}
  const runtimeState = state.ready ? 'ready' : diagnosticState(state.phase)
  return [
    `NetWatch ${app.getVersion()}`,
    `Platform: ${process.platform} ${process.arch}`,
    `Electron: ${process.versions.electron || 'unknown'}`,
    `Chromium: ${process.versions.chrome || 'unknown'}`,
    `Runtime: ${runtimeState}`,
    ...DIAGNOSTIC_SERVICES.map(([key, label]) => `${label}: ${diagnosticState(services[key])}`),
  ].join('\n')
}

function registerApplicationIpc({
  appearanceChanged,
  appSettings,
  backupController,
  credentialSites,
  desktopShell,
  getRemoteGateway,
  getRuntimeStatus,
  keepWatchingState,
  markEpisodeWatched,
  optionalSubtitleProviders,
  player,
  profileController,
  removeKeepWatchingItem,
  removeEpisodeProgress,
  runtimeController,
  settingsController,
  setupController,
  updateController,
  viewingHistory,
  viewingHistoryState,
  wslRuntime,
}) {
  const { chooseAndImportWireGuard, logSetupEvent, vpnSanityCheck } = wslRuntime

  function assertPlayerRendererSender(event) {
    desktopShell.assertWindowSender(event, player.getOverlayWindow(), 'player renderer', desktopShell.playerRendererUrl())
  }

  // Main application window controls. Every channel is authorized against the
  // exact top-level renderer that owns the capability.
  ipcMain.on('window:minimize', event => { desktopShell.assertMainRendererSender(event); desktopShell.windowMinimize() })
  ipcMain.on('window:maximize', event => { desktopShell.assertMainRendererSender(event); desktopShell.windowMaximize() })
  ipcMain.on('window:close', event => { desktopShell.assertMainRendererSender(event); desktopShell.windowClose() })
  
  ipcMain.handle('settings:get', event => {
    desktopShell.assertMainRendererSender(event)
    return appSettings.get()
  })
  ipcMain.handle('settings:update', async (event, patch) => {
    desktopShell.assertMainRendererSender(event)
    if (patch && Object.prototype.hasOwnProperty.call(patch, 'appearance')) throw new Error('Use appearance settings to change appearance.')
    const result = await settingsController.update(patch)
    appearanceChanged?.()
    updateController?.startNotifications()
    return result
  })

  ipcMain.handle('profiles:get-state', event => {
    desktopShell.assertMainRendererSender(event)
    return profileController.state()
  })
  ipcMain.handle('profiles:create', (event, name, kind) => {
    desktopShell.assertMainRendererSender(event)
    return profileController.create(name, kind)
  })
  ipcMain.handle('profiles:rename', (event, id, name) => {
    desktopShell.assertMainRendererSender(event)
    return profileController.rename(id, name)
  })
  ipcMain.handle('profiles:update', (event, id, patch) => {
    desktopShell.assertMainRendererSender(event)
    return profileController.update(id, patch)
  })
  ipcMain.handle('profiles:avatar', (event, id) => {
    desktopShell.assertMainRendererSender(event)
    return profileController.avatar(id)
  })
  ipcMain.handle('profiles:import-avatar', (event, id) => {
    desktopShell.assertMainRendererSender(event)
    return profileController.importAvatar(id)
  })
  ipcMain.handle('profiles:export', (event, id, localProfile) => {
    desktopShell.assertMainRendererSender(event)
    return profileController.exportProfile(id, localProfile)
  })
  ipcMain.handle('profiles:import', event => {
    desktopShell.assertMainRendererSender(event)
    return profileController.importProfile()
  })
  ipcMain.handle('profiles:commit-import', (event, token, selection) => {
    desktopShell.assertMainRendererSender(event)
    return profileController.commitProfileImport(token, selection)
  })
  ipcMain.handle('profiles:cancel-import', (event, token) => {
    desktopShell.assertMainRendererSender(event)
    return { cancelled: profileController.cancelProfileImport(token) }
  })
  ipcMain.handle('profiles:switch', (event, id) => {
    desktopShell.assertMainRendererSender(event)
    return profileController.switch(id)
  })
  ipcMain.handle('profiles:delete', async (event, id) => {
    desktopShell.assertMainRendererSender(event)
    const state = profileController.state()
    const profile = state.profiles.find(entry => entry.id === id)
    if (!profile) throw new Error('Profile was not found.')
    const result = await dialog.showMessageBox(desktopShell.getMainWindow(), {
      type: 'warning',
      buttons: ['Cancel', 'Delete profile'],
      defaultId: 0,
      cancelId: 0,
      title: `Delete ${profile.name}?`,
      message: 'This permanently deletes this profile and its local records.',
      detail: 'My List, collections, Keep Watching, search history, watched markers, playback preferences, and subtitle settings will be removed. Local media files and system settings are not affected.',
    })
    if (result.response !== 1) return { cancelled: true, state }
    return { cancelled: false, state: profileController.delete(id) }
  })
  
  ipcMain.handle('keep-watching:get-state', event => {
    desktopShell.assertMainRendererSender(event)
    return keepWatchingState()
  })

  ipcMain.handle('history:get-state', event => {
    desktopShell.assertMainRendererSender(event)
    return viewingHistoryState()
  })
  ipcMain.handle('history:remove', (event, id) => {
    desktopShell.assertMainRendererSender(event)
    return { removed: viewingHistory.remove(id), state: viewingHistoryState() }
  })
  ipcMain.handle('history:clear-title', (event, catalogId) => {
    desktopShell.assertMainRendererSender(event)
    return { removed: viewingHistory.clearTitle(catalogId), state: viewingHistoryState() }
  })
  ipcMain.handle('history:clear', event => {
    desktopShell.assertMainRendererSender(event)
    return { cleared: viewingHistory.clear(), state: viewingHistoryState() }
  })
  ipcMain.handle('notifications:series-updates', (event, titles) => {
    desktopShell.assertMainRendererSender(event)
    const clean = Array.isArray(titles) ? titles.filter(title => typeof title === 'string' && title.trim()).map(title => title.trim().slice(0, 120)).slice(0, 10) : []
    if (!clean.length || !Notification.isSupported()) return { shown: false }
    new Notification({
      title: clean.length === 1 ? `${clean[0]} has a new episode` : `${clean.length} tracked series have new episodes`,
      body: clean.length === 1 ? 'Open NetWatch to continue watching.' : clean.slice(0, 3).join(' · '),
    }).show()
    return { shown: true }
  })
  ipcMain.handle('keep-watching:remove', (event, catalogId) => {
    desktopShell.assertMainRendererSender(event)
    return removeKeepWatchingItem(catalogId)
  })
  ipcMain.handle('keep-watching:mark-episode-watched', (event, mediaItem, durationSeconds) => {
    desktopShell.assertMainRendererSender(event)
    return markEpisodeWatched(mediaItem, durationSeconds)
  })
  ipcMain.handle('keep-watching:remove-episode', (event, catalogId, season, episode) => {
    desktopShell.assertMainRendererSender(event)
    return removeEpisodeProgress(catalogId, season, episode)
  })
  
  
  ipcMain.handle('runtime:get-status', event => { desktopShell.assertMainRendererSender(event); return { ...getRuntimeStatus(), services: { ...getRuntimeStatus().services } } })
  ipcMain.handle('diagnostics:copy', event => {
    desktopShell.assertMainRendererSender(event)
    clipboard.writeText(runtimeDiagnosticsText(getRuntimeStatus()))
    return { copied: true }
  })
  ipcMain.handle('backup:export', (event, localProfiles) => { desktopShell.assertMainRendererSender(event); return backupController.exportBackup(localProfiles) })
  ipcMain.handle('backup:prepare-import', event => { desktopShell.assertMainRendererSender(event); return backupController.prepareImport() })
  ipcMain.handle('backup:commit-import', (event, token, selection) => { desktopShell.assertMainRendererSender(event); return backupController.commitImport(token, selection) })
  ipcMain.handle('backup:cancel-import', (event, token) => { desktopShell.assertMainRendererSender(event); return { cancelled: backupController.cancelImport(token) } })
  ipcMain.handle('updates:check', event => { desktopShell.assertMainRendererSender(event); return updateController.check() })
  ipcMain.handle('updates:download', event => { desktopShell.assertMainRendererSender(event); return updateController.download() })
  ipcMain.handle('updates:open-installer', event => { desktopShell.assertMainRendererSender(event); return updateController.openInstaller() })
  ipcMain.handle('updates:open-release-page', event => { desktopShell.assertMainRendererSender(event); return updateController.openReleasePage() })
  ipcMain.handle('runtime:retry', event => { desktopShell.assertMainRendererSender(event); return runtimeController.retry() })
  ipcMain.handle('runtime:vpn-sanity', event => { desktopShell.assertMainRendererSender(event); return vpnSanityCheck() })
  ipcMain.handle('runtime:get-credential-status', async event => {
    desktopShell.assertMainRendererSender(event)
    return setupController.credentialStatus()
  })
  ipcMain.handle('runtime:set-subtitle-credential', async (event, provider, candidate) => {
    desktopShell.assertMainRendererSender(event)
    return setupController.saveOptionalSubtitleCredential(provider, candidate)
  })
  ipcMain.handle('runtime:open-credential-site', async (event, provider) => {
    desktopShell.assertMainRendererSender(event)
    if (!optionalSubtitleProviders.has(provider) || !credentialSites[provider]) throw new Error('Unknown credential site.')
    await shell.openExternal(credentialSites[provider])
    return { opened: true }
  })
  ipcMain.handle('runtime:get-vpn-profile', async event => {
    desktopShell.assertMainRendererSender(event)
    return setupController.vpnProfile()
  })
  ipcMain.handle('runtime:set-vpn-profile-type', async (event, profileType) => {
    desktopShell.assertMainRendererSender(event)
    return setupController.setVpnProfileType(profileType)
  })
  ipcMain.handle('runtime:replace-wireguard', async (event, profileType) => {
    desktopShell.assertMainRendererSender(event)
    const result = await chooseAndImportWireGuard(desktopShell.getMainWindow(), profileType, { confirmReplace: true, stageOnly: true })
    if (result.cancelled) return { cancelled: true, profile: await setupController.vpnProfile(), restart_required: false }
    await logSetupEvent('WG_CONFIG_VALIDATED')
    await logSetupEvent('CONFIG_PERMISSIONS_VERIFIED')
    return { cancelled: false, profile: { ...(result.profile || await setupController.vpnProfile()), replacement_pending: true }, restart_required: true }
  })
  ipcMain.handle('runtime:open-vpnbook', async event => {
    desktopShell.assertMainRendererSender(event)
    await shell.openExternal(VPNBOOK_REFRESH_URL)
    return { opened: true }
  })
  ipcMain.handle('runtime:restart-app', event => {
    desktopShell.assertMainRendererSender(event)
    app.relaunch()
    app.quit()
    return { restarting: true }
  })
  
  // Remote Access is controlled by the main renderer, but all network handling
  // runs in an isolated utility process. No TLS key or device credential is ever
  // returned across this renderer IPC boundary.
  ipcMain.handle('remote:get-status', event => {
    desktopShell.assertMainRendererSender(event)
    return getRemoteGateway()?.publicStatus() || { enabled: false, configured_enabled: false, interfaces: [], paired_devices: [] }
  })
  ipcMain.handle('remote:enable', async (event, options) => {
    desktopShell.assertMainRendererSender(event)
    if (!options || typeof options !== 'object' || Array.isArray(options)) throw new Error('Remote Access options are invalid')
    return getRemoteGateway().enable({ host: options.host, port: options.port })
  })
  ipcMain.handle('remote:disable', async event => {
    desktopShell.assertMainRendererSender(event)
    return getRemoteGateway().disable()
  })
  ipcMain.handle('remote:begin-pairing', async event => {
    desktopShell.assertMainRendererSender(event)
    return getRemoteGateway().beginPairing()
  })
  ipcMain.handle('remote:cancel-pairing', async event => {
    desktopShell.assertMainRendererSender(event)
    return getRemoteGateway().cancelPairing()
  })
  ipcMain.handle('remote:revoke-device', async (event, deviceId) => {
    desktopShell.assertMainRendererSender(event)
    return getRemoteGateway().revokeDevice(deviceId)
  })
  ipcMain.handle('remote:revoke-all', async event => {
    desktopShell.assertMainRendererSender(event)
    const result = await dialog.showMessageBox(desktopShell.getMainWindow(), {
      type: 'warning',
      buttons: ['Cancel', 'Revoke all'],
      defaultId: 0,
      cancelId: 0,
      title: 'Revoke all paired devices?',
      message: 'Every Android device will immediately lose access.',
    })
    if (result.response !== 1) return getRemoteGateway().publicStatus()
    return getRemoteGateway().revokeAll()
  })
  ipcMain.handle('remote:regenerate-identity', async event => {
    desktopShell.assertMainRendererSender(event)
    const result = await dialog.showMessageBox(desktopShell.getMainWindow(), {
      type: 'warning',
      buttons: ['Cancel', 'Regenerate identity'],
      defaultId: 0,
      cancelId: 0,
      title: 'Regenerate Remote Access identity?',
      message: 'The TLS identity will change and every Android device must pair again.',
    })
    if (result.response !== 1) return getRemoteGateway().publicStatus()
    return getRemoteGateway().regenerateIdentity()
  })
  
  // Native mpv player control. Opening a torrent belongs to the main renderer;
  // controls for an existing session belong only to the player overlay renderer.
  ipcMain.handle('player:open-torrent', (event, payload) => { desktopShell.assertMainRendererSender(event); return player.openTorrent(payload) })
  ipcMain.handle('player:open-direct-torrent', (event, payload) => { desktopShell.assertMainRendererSender(event); return player.openDirectTorrent(payload) })
  ipcMain.handle('player:get-session', event => { assertPlayerRendererSender(event); return player.getSession() })
  ipcMain.handle('player:get-state', event => { assertPlayerRendererSender(event); return player.getState() })
  ipcMain.handle('player:preferences:get', event => { assertPlayerRendererSender(event); return player.getPreferences() })
  ipcMain.handle('player:preferences:update', (event, patch) => { assertPlayerRendererSender(event); return player.updatePreferences(patch) })
  ipcMain.handle('player:get-preparation', event => { assertPlayerRendererSender(event); return player.getPreparation() })
  ipcMain.handle('player:episode-info', (event, openedAt) => { assertPlayerRendererSender(event); return player.getEpisodeInfo(openedAt) })
  ipcMain.handle('player:next-episode-info', (event, openedAt) => { assertPlayerRendererSender(event); return player.getNextEpisode(openedAt) })
  ipcMain.handle('player:next-episode', (event, openedAt) => { assertPlayerRendererSender(event); return player.playNextEpisode(openedAt) })
  ipcMain.handle('player:skip-intro', (event, openedAt) => { assertPlayerRendererSender(event); return player.skipIntro(openedAt) })
  ipcMain.handle('player:command', (event, action) => { assertPlayerRendererSender(event); return player.execute(action) })
  ipcMain.handle('player:close', event => { assertPlayerRendererSender(event); return player.close() })
  ipcMain.handle('player:set-fullscreen', (event, enabled) => { assertPlayerRendererSender(event); return player.setFullscreen(enabled) })
  ipcMain.handle('player:toggle-fullscreen', event => { assertPlayerRendererSender(event); return player.toggleFullscreen() })
  ipcMain.handle('player:get-window-state', event => {
    assertPlayerRendererSender(event)
    return player.getWindowState()
  })
}

module.exports = { diagnosticState, registerApplicationIpc, runtimeDiagnosticsText }
