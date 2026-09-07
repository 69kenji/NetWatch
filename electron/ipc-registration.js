'use strict'

const { app, clipboard, dialog, ipcMain, shell } = require('electron')
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
  appSettings,
  credentialSites,
  desktopShell,
  getRemoteGateway,
  getRuntimeStatus,
  keepWatchingState,
  optionalSubtitleProviders,
  player,
  removeKeepWatchingItem,
  runtimeController,
  settingsController,
  setupController,
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
    return settingsController.update(patch)
  })
  
  ipcMain.handle('keep-watching:get-state', event => {
    desktopShell.assertMainRendererSender(event)
    return keepWatchingState()
  })
  ipcMain.handle('keep-watching:remove', (event, catalogId) => {
    desktopShell.assertMainRendererSender(event)
    return removeKeepWatchingItem(catalogId)
  })
  
  
  ipcMain.handle('runtime:get-status', event => { desktopShell.assertMainRendererSender(event); return { ...getRuntimeStatus(), services: { ...getRuntimeStatus().services } } })
  ipcMain.handle('diagnostics:copy', event => {
    desktopShell.assertMainRendererSender(event)
    clipboard.writeText(runtimeDiagnosticsText(getRuntimeStatus()))
    return { copied: true }
  })
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
  ipcMain.handle('player:get-session', event => { assertPlayerRendererSender(event); return player.getSession() })
  ipcMain.handle('player:get-state', event => { assertPlayerRendererSender(event); return player.getState() })
  ipcMain.handle('player:get-preparation', event => { assertPlayerRendererSender(event); return player.getPreparation() })
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
