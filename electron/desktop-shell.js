'use strict'

const { app, BrowserWindow, Menu, nativeTheme, net, protocol, session, Tray } = require('electron')
const { normalizeAppearance, resolveAppearance } = require('../shared/appearance.mjs')
const os = require('node:os')
const path = require('path')
const { pathToFileURL } = require('url')
const { setClientFrameExtension } = require('./native-window-effects')
const { shouldMinimizeOnClose } = require('./window-lifecycle-policy')

const START_MINIMIZED_ARGUMENT = '--netwatch-start-minimized'

function registerAppScheme() {
  protocol.registerSchemesAsPrivileged([{
    scheme: 'app',
    privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true },
  }])
}

function createDesktopShell({ appSettings, isDev, lifecycle, onForegroundRequested, useViteDevServer }) {
  if (!appSettings || !lifecycle || typeof onForegroundRequested !== 'function') {
    throw new Error('Desktop shell dependencies are invalid')
  }

  let mainWindow
  let tray = null
  let lastNativeKey = ''
  let loggedFrameExperimentFailure = false
  const acrylicSupported = process.platform === 'win32' && Number(os.release().split('.')[2]) >= 22621 && typeof BrowserWindow.prototype.setBackgroundMaterial === 'function'
  function nativeAppearance() {
    const settings = appSettings.get(), appearance = normalizeAppearance(settings.appearance)
    const material = ['liquid-glass', 'frosted-glass', 'minimal-acrylic'].includes(appearance.theme)
    // DWM owns the system backdrop. Chromium's GPU feature report controls the
    // cost of renderer effects, but it should not disable a supported native
    // material by itself.
    const reduced = settings.resourceProfile === 'reduced' || nativeTheme.shouldUseHighContrastColors || nativeTheme.prefersReducedTransparency
    const mode = material && acrylicSupported && !reduced ? 'acrylic' : 'opaque'
    return { mode, supported: acrylicSupported }
  }
  function reducedEffects() {
    return appSettings.get().resourceProfile === 'reduced' || nativeTheme.shouldUseHighContrastColors || nativeTheme.prefersReducedTransparency || app.getGPUFeatureStatus().gpu_compositing !== 'enabled'
  }
  function applyNativeAppearance({ forceFrame = false } = {}) {
    const state = nativeAppearance()
    if (mainWindow && !mainWindow.isDestroyed()) {
      const canvas = resolveAppearance(appSettings.get().appearance).palette.canvas
      // DWM can draw Acrylic only where Chromium does not paint an opaque
      // backing surface. Keep the normal, resizable BrowserWindow and make its
      // backing color transparent only while the system material is active.
      const windowBackground = state.mode === 'acrylic' ? '#00000000' : canvas
      const key = `${state.mode}:${windowBackground}`
      if (key === lastNativeKey && !forceFrame) return state
      try {
        if (key !== lastNativeKey) {
          if (acrylicSupported) mainWindow.setBackgroundMaterial(state.mode === 'acrylic' ? 'acrylic' : 'none')
          mainWindow.setBackgroundColor(windowBackground)
        }
        try {
          setClientFrameExtension(mainWindow, state.mode === 'acrylic')
        } catch (error) {
          if (!loggedFrameExperimentFailure) {
            loggedFrameExperimentFailure = true
            console.warn('[Appearance] DWM client-frame experiment was not applied:', error.message)
          }
        }
        lastNativeKey = key
      } catch { mainWindow.setBackgroundColor(canvas); return { ...state, mode: 'opaque' } }
    }
    return state
  }

  function rendererUrl() {
    if (useViteDevServer) return 'http://localhost:5173/'
    return 'app://netwatch/index.html'
  }
  
  function playerRendererUrl() {
    if (useViteDevServer) return 'http://localhost:5173/player.html'
    return 'app://netwatch/player.html'
  }
  
  async function registerAppProtocol() {
    if (useViteDevServer) return
    const distRoot = path.resolve(__dirname, '../dist')
    await protocol.handle('app', request => {
      try {
        const parsed = new URL(request.url)
        if (parsed.hostname !== 'netwatch' || parsed.username || parsed.password || parsed.port) {
          return new Response('Not found', { status: 404 })
        }
        const requested = decodeURIComponent(parsed.pathname || '/').replace(/^\/+/, '') || 'index.html'
        const target = path.resolve(distRoot, requested)
        const relative = path.relative(distRoot, target)
        if (!relative || relative === '.') return new Response('Not found', { status: 404 })
        if (relative.startsWith(`..${path.sep}`) || relative === '..' || path.isAbsolute(relative)) {
          return new Response('Not found', { status: 404 })
        }
        return net.fetch(pathToFileURL(target).toString())
      } catch {
        return new Response('Not found', { status: 404 })
      }
    })
  }
  
  function isExpectedRendererUrl(candidateUrl, expectedUrl) {
    try {
      const candidate = new URL(candidateUrl)
      const expected = new URL(expectedUrl)
      return (
        candidate.protocol === expected.protocol &&
        candidate.host === expected.host &&
        candidate.pathname === expected.pathname &&
        !candidate.username &&
        !candidate.password
      )
    } catch (_) {
      return false
    }
  }
  
  function hardenRendererNavigation(webContents, expectedUrl) {
    webContents.setWindowOpenHandler(({ url }) => {
      console.warn('[Security] Blocked renderer window request.')
      return { action: 'deny' }
    })
  
    const blockUnexpectedNavigation = (event, url) => {
      if (isExpectedRendererUrl(url, expectedUrl)) return
      event.preventDefault()
      console.warn('[Security] Blocked renderer navigation.')
    }
  
    webContents.on('will-navigate', blockUnexpectedNavigation)
    webContents.on('will-redirect', blockUnexpectedNavigation)
  }
  
  function createWindow({ show = true } = {}) {
    lastNativeKey = ''
    const appearance = normalizeAppearance(appSettings.get().appearance)
    mainWindow = new BrowserWindow({
      width: 1400,
      height: 900,
      minWidth: 940,
      minHeight: 640,
      show,
      frame: false,
      transparent: false,
      resizable: true,
      maximizable: true,
      backgroundColor: resolveAppearance(appearance).palette.canvas,
      webPreferences: {
        preload: path.join(__dirname, 'preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webSecurity: true,
        webviewTag: false,
        devTools: isDev && process.env.NETWATCH_DEVTOOLS === '1',
      },
      titleBarStyle: 'hidden',
      trafficLightPosition: { x: 16, y: 16 },
    })
    applyNativeAppearance()
  
    const expectedUrl = rendererUrl()
    hardenRendererNavigation(mainWindow.webContents, expectedUrl)
    mainWindow.loadURL(expectedUrl)

    // Chromium may update the native frame while its renderer initializes or
    // the window state changes. Reapply the public DWM experiment at those
    // stable lifecycle points without rebuilding any renderer state.
    mainWindow.webContents.once('did-finish-load', () => applyNativeAppearance({ forceFrame: true }))
    mainWindow.on('maximize', () => setImmediate(() => applyNativeAppearance({ forceFrame: true })))
    mainWindow.on('unmaximize', () => setImmediate(() => applyNativeAppearance({ forceFrame: true })))
    mainWindow.on('restore', () => setImmediate(() => applyNativeAppearance({ forceFrame: true })))
  
    mainWindow.on('close', event => {
      if (!canMinimizeToTray()) return
      event.preventDefault()
      mainWindow.hide()
    })
    mainWindow.on('closed', () => { mainWindow = null })
  
    if (isDev && process.env.NETWATCH_DEVTOOLS === '1') mainWindow.webContents.openDevTools({ mode: 'detach' })
  }
  
  function trayIconPath() {
    return app.isPackaged
      ? path.join(process.resourcesPath, 'tray', 'netwatch.ico')
      : path.resolve(__dirname, '../build/netwatch.ico')
  }
  
  function createTray() {
    if (process.platform !== 'win32' || (tray && !tray.isDestroyed())) return
    try {
      tray = new Tray(trayIconPath())
      tray.setToolTip('NetWatch')
      tray.setContextMenu(Menu.buildFromTemplate([{
        label: 'Exit NetWatch',
        click: () => app.quit(),
      }]))
      tray.on('click', onForegroundRequested)
    } catch (error) {
      tray = null
      console.error('[Tray] Could not create the NetWatch tray icon:', error)
    }
  }
  
  function createStartupErrorWindow(error) {
    const message = error instanceof Error ? error.message : String(error)
    let appearance = resolveAppearance(null)
    try { appearance = resolveAppearance(appSettings.get().appearance) } catch { /* Use safe defaults if settings cannot load. */ }
    const tokens = Object.entries(appearance.tokens).map(([key, value]) => `${key}:${value}`).join(';')
    const escapedMessage = message.replace(/[&<>"']/gu, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character])
    mainWindow = new BrowserWindow({
      width: 760,
      height: 460,
      minWidth: 640,
      minHeight: 380,
      frame: true,
      backgroundColor: appearance.palette.canvas,
      title: 'NetWatch — Startup Error',
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webSecurity: true,
        webviewTag: false,
        devTools: false,
      },
    })
    const html = `<!doctype html><html><head><meta charset="utf-8"><title>NetWatch startup error</title><style>
      :root{${tokens};color-scheme:var(--nw-color-scheme)}
      html,body{height:100%;margin:0;background:var(--nw-bg-canvas);color:var(--nw-text-primary);font:14px/1.55 system-ui,sans-serif}
      body{display:grid;place-items:center}.card{width:min(580px,calc(100% - 56px));padding:28px;border:1px solid var(--nw-border);border-radius:var(--nw-radius-card);background:var(--nw-bg-surface)}
      h1{margin:0 0 10px;font-size:22px}p{color:var(--nw-text-secondary);margin:0 0 16px}.error{padding:12px 14px;border-radius:var(--nw-radius-control);background:var(--nw-bg-raised);color:var(--nw-danger);white-space:pre-wrap;overflow-wrap:anywhere;user-select:text}
      small{display:block;margin-top:18px;color:var(--nw-text-secondary)}
    </style></head><body><div class="card"><h1>NetWatch could not start the desktop UI.</h1><p>The desktop renderer could not be prepared. Close this window, verify the local Node/Electron install, and launch NetWatch again.</p><div class="error">${escapedMessage}</div><small>No torrent/player files were changed by this failure.</small></div></body></html>`
    mainWindow.loadURL(`data:text/html;charset=UTF-8,${encodeURIComponent(html)}`)
  }
  
  function assertWindowSender(event, window, label, expectedUrl) {
    const mainFrame = window && !window.isDestroyed() ? window.webContents.mainFrame : null
    const senderUrl = event.senderFrame?.url || ''
    if (
      !window || window.isDestroyed() ||
      event.sender.id !== window.webContents.id ||
      event.senderFrame !== mainFrame ||
      !isExpectedRendererUrl(senderUrl, expectedUrl)
    ) {
      throw new Error(`Unauthorized ${label} IPC sender.`)
    }
  }
  
  
  function assertMainRendererSender(event) {
    assertWindowSender(event, mainWindow, 'main renderer', rendererUrl())
  }
  
  function hardenDefaultSession() {
    const ses = session.defaultSession
    ses.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false))
    ses.setPermissionCheckHandler(() => false)
    ses.on('will-download', (_event, item) => item.cancel())
  }

  function foregroundMainWindow() {
    if (!mainWindow || mainWindow.isDestroyed()) createWindow()
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.show()
    mainWindow.focus()
  }

  function sendToMain(channel, payload) {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload)
  }

  function destroyTray() {
    if (tray && !tray.isDestroyed()) tray.destroy()
    tray = null
  }

  function canMinimizeToTray() {
    return shouldMinimizeOnClose({
      onClose: appSettings.get().onClose,
      trayReady: Boolean(tray && !tray.isDestroyed()),
      quitting: lifecycle.quittingApp || lifecycle.quitCleanupComplete,
    })
  }

  function syncLoginItemSettings(settings = appSettings.get()) {
    if (process.platform !== 'win32' || !app.isPackaged) return
    const startMinimized = Boolean(settings.startWithWindows && settings.startMinimized)
    app.setLoginItemSettings({
      openAtLogin: Boolean(settings.startWithWindows),
      path: process.execPath,
      args: startMinimized ? [START_MINIMIZED_ARGUMENT] : [],
    })
  }

  function shouldStartMinimized() {
    const settings = appSettings.get()
    return Boolean(
      process.platform === 'win32' &&
      app.isPackaged &&
      settings.startWithWindows &&
      settings.startMinimized &&
      process.argv.includes(START_MINIMIZED_ARGUMENT)
    )
  }

  return {
    applyNativeAppearance,
    nativeAppearance,
    assertMainRendererSender,
    assertWindowSender,
    canMinimizeToTray,
    createMainWindow: createWindow,
    createStartupErrorWindow,
    createTray,
    destroyTray,
    foregroundMainWindow,
    getMainWindow: () => mainWindow,
    hardenDefaultSession,
    hardenRendererNavigation,
    hasTray: () => Boolean(tray && !tray.isDestroyed()),
    playerRendererUrl,
    registerAppProtocol,
    rendererUrl,
    sendToMain,
    shouldStartMinimized,
    syncLoginItemSettings,
    windowClose: () => mainWindow?.close(),
    windowMaximize: () => { if (mainWindow) (mainWindow.isMaximized() ? mainWindow.unmaximize() : mainWindow.maximize()) },
    windowMinimize: () => mainWindow?.minimize(),
  }
}

module.exports = { START_MINIMIZED_ARGUMENT, createDesktopShell, registerAppScheme }
