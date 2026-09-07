const { app } = require('electron')
const path = require('path')
const fs = require('fs')
const { RemoteGatewayController } = require('./remote-gateway-controller')
const { AppSettingsStore } = require('./app-settings-store')
const { KeepWatchingStore } = require('./keep-watching-store')
const { createBackendJson } = require('./backend-client')
const { createPlayerSessionController } = require('./player-session-controller')
const { createWslRuntime } = require('./wsl-runtime')
const { createSetupController } = require('./setup-controller')
const { createRuntimeController } = require('./runtime-controller')
const { createSettingsController } = require('./settings-controller')
const { createDesktopShell, registerAppScheme } = require('./desktop-shell')
const { registerApplicationIpc } = require('./ipc-registration')

registerAppScheme()

const isDev = !app.isPackaged

// Keep development builds away from the installed application's data and cache.
if (isDev && process.env.LOCALAPPDATA) {
  try {
    const devDataRoot = path.join(process.env.LOCALAPPDATA, 'NetWatchDev', 'UserData')
    const devCacheRoot = path.join(process.env.LOCALAPPDATA, 'NetWatchDev', 'Cache')
    fs.mkdirSync(devDataRoot, { recursive: true })
    fs.mkdirSync(devCacheRoot, { recursive: true })
    app.setPath('userData', devDataRoot)
    app.setPath('cache', devCacheRoot)
  } catch (error) {
    console.warn('[Startup] Could not isolate Electron cache paths:', error)
  }
}

const useViteDevServer = isDev && process.env.NETWATCH_USE_VITE_DEV_SERVER === '1'
const BACKEND_BASE_URL = isDev
  ? (process.env.NETWATCH_BACKEND_URL || 'http://127.0.0.1:8000').replace(/\/+$/u, '')
  : 'http://127.0.0.1:8000'
const backendJson = createBackendJson(BACKEND_BASE_URL)
const lifecycle = { quittingApp: false, quitCleanupComplete: false }
let remoteGateway = null

const appSettings = new AppSettingsStore(path.join(app.getPath('userData'), 'app-settings-v1.json'))
const keepWatching = new KeepWatchingStore(
  path.join(app.getPath('userData'), 'keep-watching-v1.json'),
  () => appSettings.get(),
  items => sendKeepWatchingChanged(items),
)

const desktopShell = createDesktopShell({
  appSettings,
  isDev,
  lifecycle,
  onForegroundRequested: () => foregroundNetWatch(),
  useViteDevServer,
})

const player = createPlayerSessionController({
  backendBaseUrl: BACKEND_BASE_URL,
  backendJson,
  getAppSettings: () => appSettings.get(),
  getMainWindow: () => desktopShell.getMainWindow(),
  hardenRendererNavigation: desktopShell.hardenRendererNavigation,
  isDev,
  keepWatching,
  lifecycle,
  onQuitReady: async () => {
    runtimeController.stopDevelopmentServer()
    app.quit()
  },
  playerRendererUrl: desktopShell.playerRendererUrl,
  shouldMinimizeToTray: desktopShell.canMinimizeToTray,
})

function foregroundNetWatch() {
  if (player.foreground()) return
  desktopShell.foregroundMainWindow()
}

// Prevent rapid double-clicks/relaunches from creating multiple independent
// Electron main processes (and, in dev-server mode, multiple Vite servers).
const hasSingleInstanceLock = app.requestSingleInstanceLock()
if (!hasSingleInstanceLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    const target = setupController.getActiveWindow() || desktopShell.getMainWindow()
    if (!target || target.isDestroyed()) {
      foregroundNetWatch()
      return
    }
    if (typeof target.isMinimized === 'function' && target.isMinimized()) target.restore()
    target.show()
    target.focus()
  })
}

function sendKeepWatchingChanged(items = keepWatching.list()) {
  desktopShell.sendToMain('keep-watching:changed', {
    enabled: appSettings.get().keepWatchingEnabled,
    limit: appSettings.get().keepWatchingLimit,
    items,
  })
}

function keepWatchingState() {
  const settings = appSettings.get()
  return {
    enabled: settings.keepWatchingEnabled,
    limit: settings.keepWatchingLimit,
    items: keepWatching.list(),
  }
}

function removeKeepWatchingItem(catalogId) {
  const removed = keepWatching.remove(catalogId)
  return { removed, state: keepWatchingState() }
}

const RUNTIME_DEFAULT = {
  phase: 'starting',
  ready: false,
  message: 'Starting NetWatch…',
  error: null,
  services: {
    docker: 'pending',
    stack: 'pending',
    backend: 'pending',
    torrentEngine: 'pending',
    prowlarr: 'pending',
  },
}

let runtimeStatus = { ...RUNTIME_DEFAULT, services: { ...RUNTIME_DEFAULT.services } }

function sendRuntimeStatus() {
  desktopShell.sendToMain('runtime:status', { ...runtimeStatus, services: { ...runtimeStatus.services } })
}

function setRuntimeStatus(patch) {
  runtimeStatus = {
    ...runtimeStatus,
    ...patch,
    services: {
      ...runtimeStatus.services,
      ...(patch.services || {}),
    },
  }
  sendRuntimeStatus()
  void remoteGateway?.setRuntimeReady(Boolean(runtimeStatus.ready))
  return { ...runtimeStatus, services: { ...runtimeStatus.services } }
}

function resetRuntimeStatus() {
  runtimeStatus = { ...RUNTIME_DEFAULT, services: { ...RUNTIME_DEFAULT.services } }
  sendRuntimeStatus()
}

const wslRuntime = createWslRuntime({
  appSettings,
  backendJson,
  getRuntimeStatus: () => runtimeStatus,
  setRuntimeStatus,
})
const {
  ensurePackagedRuntime,
} = wslRuntime

const CREDENTIAL_SITES = Object.freeze({
  tmdb: 'https://www.themoviedb.org/settings/api',
  opensubtitles: 'https://www.opensubtitles.com/en/consumers',
  subdl: 'https://subdl.com/panel/api',
})
const OPTIONAL_SUBTITLE_PROVIDERS = new Set(['opensubtitles', 'subdl'])

const setupController = createSetupController({
  assertWindowSender: desktopShell.assertWindowSender,
  backendBaseUrl: BACKEND_BASE_URL,
  backendJson,
  credentialSites: CREDENTIAL_SITES,
  getMainWindow: () => desktopShell.getMainWindow(),
  hardenRendererNavigation: desktopShell.hardenRendererNavigation,
  isDev,
  lifecycle,
  onStartNormalDesktop: () => startNormalDesktop(),
  optionalSubtitleProviders: OPTIONAL_SUBTITLE_PROVIDERS,
  useViteDevServer,
  wslRuntime,
})

async function startNormalDesktop() {
  const runtimePromise = runtimeController.start().catch(error => {
    console.error('[Runtime startup]', error)
  })
  await runtimeController.ensureRendererBuild()
  if (!desktopShell.getMainWindow() || desktopShell.getMainWindow().isDestroyed()) desktopShell.createMainWindow()
  desktopShell.createTray()
  sendRuntimeStatus()
  sendKeepWatchingChanged()
  void runtimePromise
}

const runtimeController = createRuntimeController({
  appSettings,
  backendBaseUrl: BACKEND_BASE_URL,
  backendJson,
  getRuntimeStatus: () => runtimeStatus,
  isDev,
  resetRuntimeStatus,
  setRuntimeStatus,
  useViteDevServer,
  wslRuntime,
})

const settingsController = createSettingsController({
  appSettings,
  backendBaseUrl: BACKEND_BASE_URL,
  getMainWindow: () => desktopShell.getMainWindow(),
  getRuntimeStatus: () => runtimeStatus,
  keepWatching,
  setRuntimeStatus,
  wslRuntime,
})


registerApplicationIpc({
  appSettings,
  credentialSites: CREDENTIAL_SITES,
  desktopShell,
  getRemoteGateway: () => remoteGateway,
  getRuntimeStatus: () => runtimeStatus,
  keepWatchingState,
  removeKeepWatchingItem,
  optionalSubtitleProviders: OPTIONAL_SUBTITLE_PROVIDERS,
  player,
  runtimeController,
  settingsController,
  setupController,
  wslRuntime,
})

app.whenReady().then(async () => {
  await desktopShell.registerAppProtocol()
  desktopShell.hardenDefaultSession()
  remoteGateway = new RemoteGatewayController({
    getRuntimeReady: () => Boolean(runtimeStatus.ready),
    isTorrentInDesktopUse: infoHash => player.isTorrentInUse(infoHash),
    onStatus: status => {
      desktopShell.sendToMain('remote:status', status)
    },
    keepWatching: {
      getState: () => keepWatchingState(),
      get: catalogId => {
        const record = keepWatching.get(catalogId)
        return record ? { ...record, defaultQuality: appSettings.get().defaultQuality } : null
      },
      checkpoint: payload => player.checkpointRemotePlayback(payload),
    },
  })
  await remoteGateway.initialize()
  try {
    // A packaged build first installs/synchronizes its clean runtime template
    // into the user's WSL data directory. Private config and Prowlarr state live
    // outside that immutable runtime and survive application upgrades. Incomplete
    // private configuration is handled by the hardened first-run windows rather
    // than by a manual-file startup error.
    if (app.isPackaged) {
      const packaged = await ensurePackagedRuntime()
      if (await setupController.beginPackagedFirstRun(packaged.setupState)) return
    }

    // Fully configured packaged installs and normal development launches use the
    // established desktop/runtime path.
    await startNormalDesktop()
  } catch (error) {
    console.error('[App startup]', error)
    setRuntimeStatus({
      phase: 'error',
      ready: false,
      message: 'Startup failed',
      error: error instanceof Error ? error.message : String(error),
    })
    desktopShell.createStartupErrorWindow(error)
  }
})

app.on('before-quit', event => {
  lifecycle.quittingApp = true
  desktopShell.destroyTray()
  if (lifecycle.quitCleanupComplete) {
    void player.stopImmediately()
    void remoteGateway?.stopChild()
    runtimeController.stopDevelopmentServer()
    return
  }

  if (player.hasSession() && !player.isClosing()) {
    event.preventDefault()
    lifecycle.quittingApp = true
    void player.close().finally(() => {
      lifecycle.quitCleanupComplete = true
      void remoteGateway?.stopChild()
      runtimeController.stopDevelopmentServer()
      app.quit()
    })
    return
  }

  lifecycle.quitCleanupComplete = true
  void player.stopImmediately()
  void remoteGateway?.stopChild()
  runtimeController.stopDevelopmentServer()
})

app.on('window-all-closed', () => {
  if (!lifecycle.quittingApp && process.platform === 'win32' && desktopShell.hasTray() && appSettings.get().onClose === 'minimize-to-tray') {
    return
  }
  void remoteGateway?.stopChild()
  runtimeController.stopDevelopmentServer()
  if (process.platform !== 'darwin') app.quit()
})
