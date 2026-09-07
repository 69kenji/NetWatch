'use strict'

const { app, dialog } = require('electron')
const { waitForHttp } = require('./process-utils')

function createSettingsController({
  appSettings,
  applyLoginItemSettings,
  backendBaseUrl,
  getMainWindow,
  getRuntimeStatus,
  keepWatching,
  setRuntimeStatus,
  wslRuntime,
}) {
  if (!appSettings || !keepWatching || !wslRuntime) throw new Error('Settings controller dependencies are invalid')
  if (typeof applyLoginItemSettings !== 'function') throw new Error('Login item settings dependency is invalid')

  const {
    composeCommandArgs,
    composeCommandArgsFor,
    runWsl,
    verifyVpnIsolation,
    waitForContainerHealthy,
  } = wslRuntime

  async function update(patch) {
    const previous = appSettings.get()
    const applyToRuntime = Boolean(getRuntimeStatus().ready)
    const loginItemChanged = Boolean(
      patch && (
        (patch.startWithWindows !== undefined && patch.startWithWindows !== previous.startWithWindows) ||
        (patch.startMinimized !== undefined && patch.startMinimized !== previous.startMinimized)
      )
    )
    if (patch?.keepWatchingEnabled === false && previous.keepWatchingEnabled) {
      const result = await dialog.showMessageBox(getMainWindow(), {
        type: 'warning',
        buttons: ['Cancel', 'Disable and delete'],
        defaultId: 0,
        cancelId: 0,
        title: 'Disable Keep Watching?',
        message: 'Disabling Keep Watching permanently deletes the current viewing history.',
      })
      if (result.response !== 1) return { cancelled: true, settings: previous }
    }
    if (patch?.resourceProfile && patch.resourceProfile !== previous.resourceProfile && applyToRuntime) {
      const result = await dialog.showMessageBox(getMainWindow(), {
        type: 'warning',
        buttons: ['Cancel', 'Apply and restart services'],
        defaultId: 0,
        cancelId: 0,
        title: 'Change resource usage?',
        message: 'Changing resource usage restarts the streaming services.',
        detail: 'Any active Android stream will stop. Start playback again after NetWatch returns to Ready.',
      })
      if (result.response !== 1) return { cancelled: true, settings: previous }
    }
    const next = appSettings.update(patch)
    try {
      if (loginItemChanged) applyLoginItemSettings(next)

      if (previous.keepWatchingEnabled && !next.keepWatchingEnabled) keepWatching.disable()
      else if (!previous.keepWatchingEnabled && next.keepWatchingEnabled) keepWatching.enable()
      if (previous.keepWatchingLimit !== next.keepWatchingLimit) keepWatching.applyLimit()

      if (previous.flareSolverrEnabled !== next.flareSolverrEnabled && applyToRuntime) {
        if (next.flareSolverrEnabled) {
          await runWsl(composeCommandArgs('up', '-d', 'flaresolverr'), app.isPackaged ? 600_000 : 180_000)
          const flareReady = await waitForContainerHealthy('nw_flaresolverr', 90_000)
          if (!flareReady.healthy) throw new Error('FlareSolverr did not become ready.')
        } else {
          await runWsl(composeCommandArgsFor(previous, 'stop', 'flaresolverr'), 60_000).catch(() => {})
          await runWsl(composeCommandArgsFor(previous, 'rm', '-f', 'flaresolverr'), 60_000).catch(() => {})
        }
        await verifyVpnIsolation()
      }

      if (previous.resourceProfile !== next.resourceProfile && applyToRuntime) {
        setRuntimeStatus({ ready: false, phase: 'services', message: 'Applying resource usage…' })
        await runWsl(composeCommandArgs('up', '-d', '--force-recreate', 'torrent-engine', 'backend'), 240_000)
        const ready = await waitForHttp(`${backendBaseUrl}/api/health`, 90_000, 500)
        if (!ready) throw new Error('NetWatch services did not become ready after applying resource usage.')
        await verifyVpnIsolation()
        setRuntimeStatus({
          phase: 'ready', ready: true, message: 'Ready', error: null,
          services: { docker: 'ready', stack: 'ready', backend: 'ready', torrentEngine: 'ready', prowlarr: 'ready' },
        })
      }
      return { cancelled: false, settings: next }
    } catch (error) {
      const restored = appSettings.update({
        startWithWindows: previous.startWithWindows,
        startMinimized: previous.startMinimized,
        flareSolverrEnabled: previous.flareSolverrEnabled,
        resourceProfile: previous.resourceProfile,
      })
      if (loginItemChanged) {
        try { applyLoginItemSettings(restored) } catch (restoreError) {
          console.warn('[Settings] Could not restore the previous Windows login item:', restoreError)
        }
      }
      try {
        if (previous.flareSolverrEnabled !== next.flareSolverrEnabled && applyToRuntime) {
          if (previous.flareSolverrEnabled) {
            await runWsl(composeCommandArgsFor(previous, 'up', '-d', 'flaresolverr'), app.isPackaged ? 600_000 : 180_000)
            const flareRestored = await waitForContainerHealthy('nw_flaresolverr', 90_000)
            if (!flareRestored.healthy) throw new Error('Previous FlareSolverr configuration did not recover.')
          } else {
            await runWsl(composeCommandArgsFor(next, 'stop', 'flaresolverr'), 60_000).catch(() => {})
            await runWsl(composeCommandArgsFor(next, 'rm', '-f', 'flaresolverr'), 60_000).catch(() => {})
          }
          await verifyVpnIsolation()
        }
        if (previous.resourceProfile !== next.resourceProfile && applyToRuntime) {
          await runWsl(composeCommandArgsFor(previous, 'up', '-d', '--force-recreate', 'torrent-engine', 'backend'), 240_000)
          const restored = await waitForHttp(`${backendBaseUrl}/api/health`, 90_000, 500)
          if (!restored) throw new Error('Previous resource profile did not recover.')
          await verifyVpnIsolation()
          setRuntimeStatus({
            phase: 'ready', ready: true, message: 'Ready', error: null,
            services: { docker: 'ready', stack: 'ready', backend: 'ready', torrentEngine: 'ready', prowlarr: 'ready' },
          })
        }
      } catch (rollbackError) {
        setRuntimeStatus({
          phase: 'error', ready: false,
          message: 'NetWatch could not restore the previous service configuration.',
          error: rollbackError?.message || String(rollbackError),
        })
      }
      throw error
    }
  }

  return { update }
}

module.exports = { createSettingsController }
