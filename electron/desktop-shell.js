'use strict'

const { app, BrowserWindow, Menu, net, protocol, session, Tray } = require('electron')
const path = require('path')
const { pathToFileURL } = require('url')
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
    mainWindow = new BrowserWindow({
      width: 1400,
      height: 900,
      minWidth: 1100,
      minHeight: 700,
      show,
      frame: false,
      backgroundColor: '#0a0a0f',
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
  
    const expectedUrl = rendererUrl()
    hardenRendererNavigation(mainWindow.webContents, expectedUrl)
    mainWindow.loadURL(expectedUrl)
  
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
    mainWindow = new BrowserWindow({
      width: 760,
      height: 460,
      minWidth: 640,
      minHeight: 380,
      frame: true,
      backgroundColor: '#0a0a0f',
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
      html,body{height:100%;margin:0;background:#0a0a0f;color:#f0f0f8;font:14px/1.55 system-ui,sans-serif}
      body{display:grid;place-items:center}.card{width:min(580px,calc(100% - 56px));padding:28px;border:1px solid rgba(255,255,255,.08);border-radius:16px;background:#13131f}
      h1{margin:0 0 10px;font-size:22px}p{color:#9292aa;margin:0 0 16px}.error{padding:12px 14px;border-radius:10px;background:rgba(232,93,93,.08);color:#ff9a9a;white-space:pre-wrap;user-select:text}
      small{display:block;margin-top:18px;color:#66667c}
    </style></head><body><div class="card"><h1>NetWatch could not start the desktop UI.</h1><p>The desktop renderer could not be prepared. Close this window, verify the local Node/Electron install, and launch NetWatch again.</p><div class="error"></div><small>No torrent/player files were changed by this failure.</small></div><script>document.querySelector('.error').textContent=${JSON.stringify(message)}</script></body></html>`
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
