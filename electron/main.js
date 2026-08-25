const { app, BaseWindow, BrowserWindow, dialog, ipcMain, net, protocol, session, shell } = require('electron')
const path = require('path')
const { pathToFileURL } = require('url')
const { spawn } = require('child_process')
const fs = require('fs')
const { MpvController } = require('./mpv-controller')
const { METADATA_PREPARATION_TIMEOUT_MS, metadataPreparationTimedOut } = require('./preparation-policy')
const { playerFullscreenShortcutAction } = require('./player-shortcuts')
const { VPNBOOK_REFRESH_URL, normalizeVpnProfileType, wireGuardFileTimestamps } = require('./vpn-profile')

protocol.registerSchemesAsPrivileged([{
  scheme: 'app',
  privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true },
}])

// Keep this copied development Electron build away from Electron's shared/default
// cache directories. Multiple local Electron copies can otherwise contend for the
// same cache and emit Access denied / GPU cache errors before the app even loads.
if (process.env.LOCALAPPDATA) {
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

const isDev = !app.isPackaged || process.env.NODE_ENV === 'development'
const isPlayerSmokeMode = isDev && Boolean(
  process.env.NETWATCH_PLAYER_TEST_TORRENT_SOURCE || process.env.NETWATCH_PLAYER_TEST_SOURCE,
)
// Normal desktop launch uses a built renderer and no localhost dev-server port.
// The established player smoke harness keeps using its externally-owned Vite server.
const useViteDevServer = isDev && (process.env.NETWATCH_USE_VITE_DEV_SERVER === '1' || isPlayerSmokeMode)
const BACKEND_BASE_URL = (process.env.NETWATCH_BACKEND_URL || 'http://127.0.0.1:8000').replace(/\/+$/u, '')
const PREPARATION_POLL_MS = 400
const PREPARATION_REANNOUNCE_MS = 10_000
const PLAYER_TELEMETRY_POLL_MS = 1000

let mainWindow
let backendProcess
let viteProcess = null
let viteOwned = false
let runtimeStartupPromise = null
let playerVideoWindow
let playerOverlayWindow
let playerSession = null
let playerPreparation = defaultPlayerPreparation()
let playerPreparationGeneration = 0
let closingPlayer = false
let playerSurfaceSyncTimer = null
let playerLaunchWindowState = { maximized: false, fullscreen: false }
let quittingApp = false
let quitCleanupComplete = false
let activeSubtitleToken = null
let packagedWslLocation = null
let packagedRuntimeContext = null
let packagedRuntimeUpdated = false
let setupWindow = null
let prowlarrSetupWindow = null
let setupVpnVerified = false
let firstRunTransitionPromise = null

const mpv = new MpvController()

// Prevent rapid double-clicks/relaunches from creating multiple independent
// Electron main processes (and, in dev-server mode, multiple Vite servers).
const hasSingleInstanceLock = app.requestSingleInstanceLock()
if (!hasSingleInstanceLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    const target = setupWindow && !setupWindow.isDestroyed()
      ? setupWindow
      : prowlarrSetupWindow && !prowlarrSetupWindow.isDestroyed()
        ? prowlarrSetupWindow
        : mainWindow
    if (!target || target.isDestroyed()) return
    if (typeof target.isMinimized === 'function' && target.isMinimized()) target.restore()
    target.show()
    target.focus()
  })
}

function defaultPlayerPreparation() {
  return {
    stage: 'idle',
    ready: false,
    message: null,
    infoHash: null,
    progress: null,
    videoProgress: null,
    downloaded: 0,
    size: 0,
    dlSpeed: 0,
    seeders: 0,
    peers: 0,
    torrentState: null,
    firstReady: false,
    lastReady: false,
    bufferedBytes: 0,
    bufferTargetBytes: 0,
    bufferProgress: 0,
    error: null,
    updatedAt: new Date().toISOString(),
  }
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

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1100,
    minHeight: 700,
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

  if (isDev && process.env.NETWATCH_DEVTOOLS === '1') mainWindow.webContents.openDevTools({ mode: 'detach' })
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
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('runtime:status', { ...runtimeStatus, services: { ...runtimeStatus.services } })
  }
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
  return { ...runtimeStatus, services: { ...runtimeStatus.services } }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

async function httpOk(url, timeoutMs = 1500) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(url, { signal: controller.signal, cache: 'no-store' })
    return response.ok
  } catch (_) {
    return false
  } finally {
    clearTimeout(timer)
  }
}

async function waitForHttp(url, timeoutMs, pollMs = 400) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await httpOk(url)) return true
    await sleep(pollMs)
  }
  return false
}


function projectWslLocation() {
  if (app.isPackaged && packagedWslLocation) {
    return { ...packagedWslLocation }
  }

  const configuredDistro = process.env.NETWATCH_WSL_DISTRO
  const configuredPath = process.env.NETWATCH_WSL_PROJECT_PATH
  if (configuredDistro && configuredPath) {
    return { distro: configuredDistro, linuxPath: configuredPath.replace(/\\/gu, '/') }
  }

  const root = path.resolve(__dirname, '..')
  const normalized = root.replace(/\//gu, '\\')
  const match = /^\\\\wsl(?:\.localhost|\$)?\\([^\\]+)\\(.+)$/iu.exec(normalized)
  if (!match) return null

  return {
    distro: match[1],
    linuxPath: `/${match[2].replace(/\\/gu, '/')}`,
  }
}

function runProcess(command, args, {
  timeoutMs = 30_000,
  cwd = undefined,
  env = process.env,
  input = null,
  rejectOnNonzero = true,
  maxOutputBytes = 256 * 1024,
} = {}) {
  return new Promise((resolve, reject) => {
    const hasInput = Buffer.isBuffer(input) || typeof input === 'string'
    const child = spawn(command, args, {
      shell: false,
      windowsHide: true,
      cwd,
      env,
      stdio: [hasInput ? 'pipe' : 'ignore', 'pipe', 'pipe'],
    })

    let stdout = ''
    let stderr = ''
    let settled = false
    const appendBounded = (current, chunk) => `${current}${chunk.toString()}`.slice(-maxOutputBytes)
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      child.kill()
      reject(new Error(`${command} timed out after ${timeoutMs}ms`))
    }, timeoutMs)

    child.stdout.on('data', chunk => { stdout = appendBounded(stdout, chunk) })
    child.stderr.on('data', chunk => { stderr = appendBounded(stderr, chunk) })
    child.once('error', error => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(error)
    })
    child.once('exit', code => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (code === 0 || !rejectOnNonzero) {
        resolve({ stdout, stderr, code })
      } else {
        reject(new Error(`${command} exited with code ${code}: ${(stderr || stdout).trim()}`))
      }
    })

    if (hasInput) {
      child.stdin.on('error', () => {})
      child.stdin.end(input)
    }
  })
}

function cleanWslOutput(value) {
  return String(value || '').replace(/\0/gu, '').replace(/\r/gu, '').trim()
}

async function runWslDistro(distro, args, timeoutMs = 30_000) {
  return runProcess(
    'wsl.exe',
    ['-d', distro, '--', ...args],
    { timeoutMs },
  )
}

async function detectPackagedWslDistro() {
  const configured = String(process.env.NETWATCH_WSL_DISTRO || '').trim()
  if (configured) return configured

  let stdout
  try {
    ;({ stdout } = await runProcess('wsl.exe', ['-l', '-q'], { timeoutMs: 10_000 }))
  } catch (error) {
    throw new Error(`WSL 2 is required by NetWatch. Could not list WSL distributions: ${error instanceof Error ? error.message : String(error)}`)
  }

  const distros = cleanWslOutput(stdout)
    .split('\n')
    .map(value => cleanWslOutput(value))
    .filter(Boolean)
    .filter(value => !/^docker-desktop(?:-data)?$/iu.test(value))

  if (!distros.length) {
    throw new Error('NetWatch requires a normal WSL Linux distribution (Ubuntu recommended) in addition to Docker Desktop.')
  }

  return distros.find(value => /^ubuntu$/iu.test(value))
    || distros.find(value => /^ubuntu[-\s]/iu.test(value))
    || distros[0]
}

async function packagedWslHome(distro) {
  const { stdout } = await runWslDistro(
    distro,
    ['sh', '-lc', 'printf "%s" "$HOME"'],
    10_000,
  )
  const home = cleanWslOutput(stdout)
  if (!home.startsWith('/')) throw new Error(`Could not resolve the WSL home directory for ${distro}.`)
  return home.replace(/\/+$/u, '')
}

async function wslPathExists(distro, linuxPath) {
  try {
    await runWslDistro(distro, ['test', '-e', linuxPath], 5000)
    return true
  } catch (_) {
    return false
  }
}

async function readWslTextFile(distro, linuxPath) {
  try {
    const { stdout } = await runWslDistro(distro, ['cat', linuxPath], 5000)
    return cleanWslOutput(stdout)
  } catch (_) {
    return ''
  }
}

async function windowsPathToWsl(distro, windowsPath) {
  // wsl.exe ultimately forwards the Linux command line through WSL's argument
  // parser. Raw Windows backslashes can therefore be consumed as escape
  // characters before wslpath receives them (for example C:\\Foo becoming
  // C:Foo). Windows accepts forward slashes in this drive-path form, and
  // wslpath can translate it without relying on shell quoting. Keep this
  // conversion local to the bootstrap path; the installed files themselves are
  // unchanged.
  const portableWindowsPath = String(windowsPath || '').replace(/\\/gu, '/')
  const { stdout } = await runWslDistro(
    distro,
    ['wslpath', '-a', '-u', portableWindowsPath],
    10_000,
  )
  const converted = cleanWslOutput(stdout)
  if (!converted.startsWith('/')) throw new Error(`Could not map packaged runtime path into WSL: ${windowsPath}`)
  return converted
}

async function ensurePackagedRuntime() {
  if (!app.isPackaged) return null

  const templateRoot = path.join(process.resourcesPath, 'runtime-template')
  const sourceMarkerPath = path.join(templateRoot, '.netwatch-runtime-version')
  if (!fs.existsSync(templateRoot) || !fs.existsSync(sourceMarkerPath)) {
    throw new Error('The installed NetWatch runtime template is missing. Reinstall NetWatch.')
  }

  const expectedRuntimeVersion = fs.readFileSync(sourceMarkerPath, 'utf8').trim()
  if (!expectedRuntimeVersion) throw new Error('The installed NetWatch runtime version marker is empty.')

  const distro = await detectPackagedWslDistro()
  const home = await packagedWslHome(distro)
  const baseDir = `${home}/.local/share/netwatch`
  const runtimeDir = `${baseDir}/runtime`
  const configDir = `${baseDir}/config`
  const dataDir = `${baseDir}/data`
  const runtimeMarker = `${runtimeDir}/.netwatch-runtime-version`

  await runWslDistro(distro, [
    'mkdir', '-p',
    `${configDir}/wireguard/wg_confs`,
    `${dataDir}/prowlarr`,
    `${dataDir}/backend-cache`,
  ], 10_000)

  const currentRuntimeVersion = await readWslTextFile(distro, runtimeMarker)
  if (currentRuntimeVersion !== expectedRuntimeVersion) {
    const templateWslPath = await windowsPathToWsl(distro, templateRoot)
    const nextRuntimeDir = `${baseDir}/runtime.new`

    await runWslDistro(distro, ['rm', '-rf', nextRuntimeDir], 15_000)
    await runWslDistro(distro, ['mkdir', '-p', nextRuntimeDir], 10_000)
    await runWslDistro(distro, ['cp', '-a', `${templateWslPath}/.`, `${nextRuntimeDir}/`], 60_000)
    await runWslDistro(distro, ['rm', '-rf', runtimeDir], 15_000)
    await runWslDistro(distro, ['mv', nextRuntimeDir, runtimeDir], 15_000)
    packagedRuntimeUpdated = true
  }

  // Create safe reference templates in the persistent private-config directory,
  // but never promote examples to active credentials automatically.
  const exampleCopies = [
    [`${runtimeDir}/backend/.env.example`, `${configDir}/backend.env.example`],
    [`${runtimeDir}/docker/wireguard/wg_confs/wg0.conf.example`, `${configDir}/wireguard/wg_confs/wg0.conf.example`],
  ]
  for (const [source, target] of exampleCopies) {
    if (!(await wslPathExists(distro, target)) && (await wslPathExists(distro, source))) {
      await runWslDistro(distro, ['cp', source, target], 5000)
    }
  }

  packagedWslLocation = { distro, linuxPath: runtimeDir }
  packagedRuntimeContext = { distro, home, baseDir, runtimeDir, configDir, dataDir }

  // The secure helper creates only an empty managed backend.env when needed,
  // repairs private file modes, and derives config/resolv.conf from an existing
  // validated WireGuard configuration. It never prints secret values.
  const helperPath = `${runtimeDir}/docker/secure_config.py`
  const { stdout } = await runWslDistro(
    distro,
    ['python3', helperPath, 'bootstrap', baseDir],
    20_000,
  )
  let setupState
  try {
    setupState = JSON.parse(cleanWslOutput(stdout))
  } catch (_) {
    throw new Error('NetWatch could not inspect the private first-run configuration safely.')
  }
  if (!setupState?.ok) {
    throw new Error(setupState?.message || 'NetWatch could not prepare its private configuration directory.')
  }

  return {
    distro,
    home,
    baseDir,
    runtimeDir,
    configDir,
    dataDir,
    setupState,
    runtimeUpdated: packagedRuntimeUpdated,
  }

}

function composeFilePath() {
  return app.isPackaged ? 'docker/docker-compose.packaged.yml' : 'docker/docker-compose.yml'
}

function composeCommandArgs(...args) {
  return ['docker', 'compose', '-f', composeFilePath(), ...args]
}

async function runWsl(args, timeoutMs = 30_000) {
  const location = projectWslLocation()
  if (!location) {
    throw new Error(
      'Could not locate the WSL project. Launch NetWatch from its \\wsl.localhost\\<distro> project path, or set NETWATCH_WSL_DISTRO and NETWATCH_WSL_PROJECT_PATH.',
    )
  }
  return runProcess(
    'wsl.exe',
    ['-d', location.distro, '--cd', location.linuxPath, ...args],
    { timeoutMs },
  )
}


async function runWslWithInput(args, input, timeoutMs = 30_000, { rejectOnNonzero = true } = {}) {
  const location = projectWslLocation()
  if (!location) throw new Error('Could not locate the packaged WSL runtime.')
  return runProcess(
    'wsl.exe',
    ['-d', location.distro, '--cd', location.linuxPath, ...args],
    { timeoutMs, input, rejectOnNonzero, maxOutputBytes: 64 * 1024 },
  )
}

function setupBaseDir() {
  if (!packagedRuntimeContext?.baseDir) throw new Error('The packaged NetWatch setup context is unavailable.')
  return packagedRuntimeContext.baseDir
}

function parseSecureHelperResult(stdout, fallback) {
  try {
    const payload = JSON.parse(cleanWslOutput(stdout))
    if (payload && typeof payload === 'object') return payload
  } catch (_) {}
  return { ok: false, code: 'HELPER_INVALID_RESPONSE', message: fallback }
}

async function secureConfigAction(action, { payload = null, rawInput = null, args = [], timeoutMs = 20_000 } = {}) {
  if (payload !== null && rawInput !== null) throw new Error('Secure configuration request cannot contain two input payloads.')
  if (rawInput !== null && !Buffer.isBuffer(rawInput)) throw new Error('Secure configuration raw input must be a buffer.')
  const command = ['python3', 'docker/secure_config.py', action, setupBaseDir(), ...args]
  let inputBuffer = null
  try {
    if (payload !== null) inputBuffer = Buffer.from(JSON.stringify(payload), 'utf8')
    else if (rawInput !== null) inputBuffer = rawInput
    const { stdout, code } = await runWslWithInput(command, inputBuffer, timeoutMs, { rejectOnNonzero: false })
    const result = parseSecureHelperResult(stdout, 'NetWatch secure configuration helper returned an invalid response.')
    if (code !== 0 || !result.ok) throw new Error(result.message || 'NetWatch could not safely update its private configuration.')
    return result
  } finally {
    if (inputBuffer) inputBuffer.fill(0)
    if (payload && typeof payload === 'object') {
      for (const key of Object.keys(payload)) {
        if (typeof payload[key] === 'string') payload[key] = ''
      }
    }
  }
}

const MAX_WIREGUARD_IMPORT_BYTES = 8 * 1024

async function readWireGuardImportFile(filePath) {
  let handle = null
  let staging = null
  try {
    const linkInfo = await fs.promises.lstat(filePath)
    if (linkInfo.isSymbolicLink() || !linkInfo.isFile()) {
      throw new Error('The selected WireGuard configuration must be a regular file.')
    }

    handle = await fs.promises.open(filePath, 'r')
    const openedInfo = await handle.stat()
    if (!openedInfo.isFile()) throw new Error('The selected WireGuard configuration must be a regular file.')
    if (openedInfo.size <= 0) throw new Error('The selected WireGuard configuration is empty.')
    if (openedInfo.size > MAX_WIREGUARD_IMPORT_BYTES) {
      throw new Error('The selected WireGuard configuration exceeds the 8 KiB size limit.')
    }

    staging = Buffer.alloc(MAX_WIREGUARD_IMPORT_BYTES + 1)
    const { bytesRead } = await handle.read(staging, 0, staging.length, 0)
    if (bytesRead <= 0) throw new Error('The selected WireGuard configuration is empty.')
    if (bytesRead > MAX_WIREGUARD_IMPORT_BYTES) {
      throw new Error('The selected WireGuard configuration exceeds the 8 KiB size limit.')
    }

    return {
      bytes: Buffer.from(staging.subarray(0, bytesRead)),
      timestamps: wireGuardFileTimestamps(openedInfo),
    }
  } catch (error) {
    if (error instanceof Error && /^The selected WireGuard configuration/u.test(error.message)) throw error
    throw new Error('The selected WireGuard configuration could not be read.')
  } finally {
    if (staging) staging.fill(0)
    if (handle) {
      try { await handle.close() } catch (_) {}
    }
  }
}

async function chooseAndImportWireGuard(parentWindow, profileType, { confirmReplace = false, stageOnly = false } = {}) {
  const normalizedType = normalizeVpnProfileType(profileType)
  if (confirmReplace) {
    const confirmation = await dialog.showMessageBox(parentWindow, {
      type: 'warning',
      buttons: ['Keep current configuration', 'Replace configuration'],
      defaultId: 0,
      cancelId: 0,
      title: 'Replace WireGuard configuration?',
      message: 'Replace the existing private WireGuard configuration?',
      detail: 'NetWatch will only overwrite it after the newly selected provider file passes strict validation.',
      noLink: true,
    })
    if (confirmation.response !== 1) return { cancelled: true }
  }

  const selection = await dialog.showOpenDialog(parentWindow, {
    title: 'Choose VPN provider WireGuard configuration',
    properties: ['openFile'],
    filters: [
      { name: 'WireGuard configuration', extensions: ['conf'] },
      { name: 'Text files', extensions: ['txt'] },
    ],
  })
  if (selection.canceled || selection.filePaths.length !== 1) return { cancelled: true }

  await logSetupEvent('WG_IMPORT_STARTED')
  let providerConfig = null
  try {
    const imported = await readWireGuardImportFile(selection.filePaths[0])
    providerConfig = imported.bytes
    const action = stageOnly ? 'stage-wireguard' : 'import-wireguard'
    const secureResult = await secureConfigAction(action, {
      rawInput: providerConfig,
      args: [normalizedType, imported.timestamps.sourceCreatedAt, imported.timestamps.sourceModifiedAt],
      timeoutMs: 20_000,
    })
    providerConfig = null // secureConfigAction owns and zeroes the buffer.
    return { cancelled: false, profile: secureResult.vpn_profile || null }
  } finally {
    if (providerConfig) providerConfig.fill(0)
  }
}

async function inspectSecureSetupState() {
  return secureConfigAction('inspect')
}

async function logSetupEvent(eventName) {
  try {
    await secureConfigAction('log-event', { args: [eventName], timeoutMs: 5000 })
  } catch (_) {
    // Setup diagnostics are useful but must never weaken or block the security gate.
  }
}

function dockerDesktopCandidates() {
  const roots = [process.env.ProgramFiles, process.env['ProgramW6432']].filter(Boolean)
  return [...new Set(roots.map(root => path.join(root, 'Docker', 'Docker', 'Docker Desktop.exe')))]
}

function launchDockerDesktopIfPresent() {
  const executable = dockerDesktopCandidates().find(candidate => fs.existsSync(candidate))
  if (!executable) return false

  try {
    const child = spawn(executable, [], {
      detached: true,
      windowsHide: true,
      stdio: 'ignore',
    })
    child.unref()
    return true
  } catch (_) {
    return false
  }
}

async function waitForDocker(timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      await runWsl(['docker', 'info', '--format', '{{.ServerVersion}}'], 5000)
      return true
    } catch (_) {
      await sleep(1500)
    }
  }
  return false
}

async function containerHealth(containerName) {
  try {
    const { stdout } = await runWsl([
      'docker',
      'inspect',
      '--format',
      '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}',
      containerName,
    ], 5000)
    return stdout.trim().toLowerCase() || 'unknown'
  } catch (_) {
    return 'missing'
  }
}

async function waitForContainerHealthy(containerName, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs
  let status = await containerHealth(containerName)

  while (Date.now() < deadline) {
    if (status === 'healthy') return { healthy: true, status }
    // Once Docker has positively marked the VPN unhealthy there is no benefit in
    // waiting out the full timeout. NetWatch can rebuild the namespace now.
    if (status === 'unhealthy' || status === 'dead' || status === 'exited') {
      return { healthy: false, status }
    }
    await sleep(1500)
    status = await containerHealth(containerName)
  }

  return { healthy: status === 'healthy', status }
}

async function recreateVpnNamespace(reason) {
  console.warn(`[Startup] Recreating VPN namespace: ${reason}`)
  setRuntimeStatus({
    phase: 'services',
    ready: false,
    message: 'Repairing private VPN tunnel…',
    services: { stack: 'starting', backend: 'starting', torrentEngine: 'starting', prowlarr: 'starting' },
  })

  // All outbound NetWatch services use network_mode: service:vpn. Recreating
  // only nw_vpn would leave those containers attached to the old network namespace,
  // so repair the complete privacy namespace as one unit, including FlareSolverr.
  const repairArgs = ['up', '-d', '--force-recreate']
  if (app.isPackaged && packagedRuntimeUpdated) repairArgs.push('--build')
  repairArgs.push('vpn', 'torrent-engine', 'prowlarr', 'flaresolverr', 'backend')
  const repairTimeoutMs = app.isPackaged && packagedRuntimeUpdated ? 600_000 : 180_000
  await runWsl(composeCommandArgs(...repairArgs), repairTimeoutMs)

  const health = await waitForContainerHealthy('nw_vpn', 90_000)
  if (!health.healthy) {
    throw new Error(`The VPN container did not become healthy after automatic recovery (status: ${health.status}).`)
  }
}

async function startComposeWithVpnSelfHeal() {
  let recovered = false
  const upArgs = ['up', '-d']
  if (app.isPackaged && packagedRuntimeUpdated) upArgs.push('--build')
  const composeArgs = composeCommandArgs(...upArgs)
  const composeTimeoutMs = app.isPackaged && packagedRuntimeUpdated ? 600_000 : 120_000

  // Docker Desktop can restore an old nw_vpn container before WSL networking is
  // fully settled after a Windows reboot. If Docker has already marked that
  // restored container unhealthy, repair it before Compose waits on services
  // that are required to share the VPN namespace.
  const initialHealth = await containerHealth('nw_vpn')
  if (initialHealth === 'unhealthy' || initialHealth === 'dead' || initialHealth === 'exited') {
    await recreateVpnNamespace(`existing nw_vpn is ${initialHealth}`)
    recovered = true
  } else if (initialHealth === 'starting') {
    const startupHealth = await waitForContainerHealthy('nw_vpn', 35_000)
    if (!startupHealth.healthy) {
      await recreateVpnNamespace(`restored nw_vpn did not become healthy (status: ${startupHealth.status})`)
      recovered = true
    }
  }

  try {
    await runWsl(composeArgs, composeTimeoutMs)
  } catch (error) {
    const failedHealth = await containerHealth('nw_vpn')
    if (!recovered && failedHealth !== 'healthy') {
      await recreateVpnNamespace(`Compose startup failed while nw_vpn was ${failedHealth}`)
      recovered = true
      // The first Compose run may have stopped at torrent-engine's VPN health
      // dependency. Run the full stack again after the namespace is repaired.
      await runWsl(composeArgs, composeTimeoutMs)
    } else {
      throw error
    }
  }

  let finalHealth = await waitForContainerHealthy('nw_vpn', 60_000)
  if (!finalHealth.healthy && !recovered) {
    await recreateVpnNamespace(`nw_vpn remained ${finalHealth.status} after Compose startup`)
    recovered = true
    await runWsl(composeArgs, composeTimeoutMs)
    finalHealth = await waitForContainerHealthy('nw_vpn', 90_000)
  }

  if (!finalHealth.healthy) {
    throw new Error(`The VPN container is not healthy (status: ${finalHealth.status}).`)
  }

  return recovered
}

async function verifyVpnIsolation() {
  setRuntimeStatus({
    message: 'Verifying VPN isolation…',
    services: { stack: 'starting', backend: 'starting', torrentEngine: 'starting', prowlarr: 'starting' },
  })
  try {
    await runWsl(['python3', 'docker/verify-networking.py'], 60_000)
  } catch (error) {
    throw new Error(`VPN isolation verification failed. ${error instanceof Error ? error.message : String(error)}`)
  }
}

async function vpnSanityCheck() {
  if (!runtimeStatus.ready) {
    throw new Error('NetWatch services are not ready yet.')
  }

  // First prove that every network client is attached to nw_vpn and that the
  // WireGuard kill switch/DNS isolation are intact. Only then ask the backend,
  // which lives in that namespace, for the public IP visible to the internet.
  await runWsl(['python3', 'docker/verify-networking.py'], 60_000)
  const payload = await backendJson('/api/diagnostics/vpn-sanity', { method: 'GET' }, 15_000)
  if (!payload || !payload.connected || !payload.public_ip || !['ok', 'degraded'].includes(payload.status)) {
    throw new Error(payload?.error || 'VPN public IP check did not return a safe result.')
  }
  return { ...payload, structural_verified: true }
}


const CREDENTIAL_SITES = Object.freeze({
  tmdb: 'https://www.themoviedb.org/settings/api',
  opensubtitles: 'https://www.opensubtitles.com/en/consumers',
  subdl: 'https://subdl.com/panel/api',
})
const OPTIONAL_SUBTITLE_PROVIDERS = new Set(['opensubtitles', 'subdl'])

function normalizeCredentialCandidate(name, value) {
  if (typeof value !== 'string') throw new Error('Credential must be text.')
  const cleaned = value.trim()
  if ([...cleaned].some(ch => { const code = ch.charCodeAt(0); return code < 32 || code === 127 })) {
    throw new Error('Credential contains unsupported control characters.')
  }
  if (name === 'subdl') {
    if (!cleaned.startsWith('subdl_') || cleaned.length !== 49 || cleaned.slice(6).length !== 43) {
      throw new Error('SubDL API key must contain subdl_ followed by exactly 43 characters.')
    }
    return cleaned
  }
  if (!['tmdb', 'opensubtitles', 'prowlarr'].includes(name)) throw new Error('Credential type is unsupported.')
  if (cleaned.length !== 32) {
    const label = name === 'tmdb' ? 'TMDB' : name === 'opensubtitles' ? 'OpenSubtitles' : 'Prowlarr'
    throw new Error(`${label} API key must be exactly 32 characters.`)
  }
  return cleaned
}
const PROWLARR_LOCAL_URL = 'http://127.0.0.1:9696/'
const SETUP_CHANNELS = [
  'setup:get-state',
  'setup:choose-wireguard',
  'setup:set-vpn-profile-type',
  'setup:open-vpnbook',
  'setup:verify-vpn',
  'setup:submit-api',
  'setup:open-credential-site',
]
const PROWLARR_SETUP_CHANNELS = [
  'prowlarr-setup:prepare',
  'prowlarr-setup:open',
  'prowlarr-setup:submit',
]

function removeIpcHandlers(channels) {
  for (const channel of channels) ipcMain.removeHandler(channel)
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

function assertPlayerRendererSender(event) {
  assertWindowSender(event, playerOverlayWindow, 'player renderer', playerRendererUrl())
}

function hardenDefaultSession() {
  const ses = session.defaultSession
  ses.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false))
  ses.setPermissionCheckHandler(() => false)
  ses.on('will-download', (_event, item) => item.cancel())
}

function hardenSetupSession(partitionName) {
  const ses = session.fromPartition(partitionName, { cache: false })
  ses.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false))
  ses.setPermissionCheckHandler(() => false)
  ses.webRequest.onBeforeRequest(
    { urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'] },
    (_details, callback) => callback({ cancel: true }),
  )
  ses.on('will-download', (_event, item) => item.cancel())
  return ses
}

function setupWindowUrl(filename) {
  return pathToFileURL(path.join(__dirname, filename)).toString()
}

function secureBrowserPreferences(preloadName, partition) {
  return {
    preload: path.join(__dirname, preloadName),
    contextIsolation: true,
    nodeIntegration: false,
    sandbox: true,
    webSecurity: true,
    allowRunningInsecureContent: false,
    devTools: false,
    webviewTag: false,
    partition,
  }
}

async function ensureDockerForSetup() {
  try {
    await runWsl(['docker', 'info', '--format', '{{.ServerVersion}}'], 5000)
    return
  } catch (_) {}
  launchDockerDesktopIfPresent()
  if (!(await waitForDocker(180_000))) {
    throw new Error('Docker Desktop is not ready. Start Docker Desktop and retry.')
  }
}

async function setupStateForRenderer() {
  const state = await inspectSecureSetupState()
  return { ...state, vpn_verified: setupVpnVerified }
}

async function vpnProfileForRenderer() {
  const state = await inspectSecureSetupState()
  const staged = state?.vpn_replacement?.staged ? state.vpn_replacement.profile : null
  if (staged) return { ...staged, replacement_pending: true }
  return { ...(state?.vpn_profile || { profile_type: 'generic' }), replacement_pending: false }
}

async function credentialStatusForRenderer() {
  const state = await inspectSecureSetupState()
  const configured = state?.env?.configured || {}
  return {
    tmdb: Boolean(configured.tmdb),
    prowlarr: Boolean(configured.prowlarr),
    opensubtitles: Boolean(configured.opensubtitles),
    subdl: Boolean(configured.subdl),
  }
}

async function validateSubtitleCredentialThroughVpn(provider, key) {
  const requestBody = { provider, api_key: key }
  try {
    const status = await backendJson('/api/diagnostics/subtitle-credential', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(requestBody),
    }, 30_000)
    if (!status?.connected || !status?.authenticated || status?.status !== 'ok') {
      throw new Error(`${provider === 'opensubtitles' ? 'OpenSubtitles' : 'SubDL'} authentication failed. The entered key was not retained.`)
    }
  } finally {
    requestBody.api_key = ''
  }
}

async function saveOptionalSubtitleCredential(provider, candidate) {
  if (!OPTIONAL_SUBTITLE_PROVIDERS.has(provider)) throw new Error('Unsupported optional credential provider.')
  const key = normalizeCredentialCandidate(provider, candidate)
  await validateSubtitleCredentialThroughVpn(provider, key)
  const secretPayload = { name: provider, value: key }
  try {
    await secureConfigAction('set-optional-api', { payload: secretPayload })
    await logSetupEvent('API_CREDENTIALS_VALIDATED')
  } finally {
    secretPayload.value = ''
  }
  try {
    await runWsl(composeCommandArgs('up', '-d', '--force-recreate', 'backend'), 180_000)
  } catch (_) {
    throw new Error('The saved subtitle credential could not be loaded by the backend. Restart NetWatch and retry.')
  }
  const ready = await waitForHttp(`${BACKEND_BASE_URL}/api/health`, 90_000, 400)
  if (!ready) throw new Error('The backend did not reload the saved subtitle credential in time. Restart NetWatch and retry.')
  return credentialStatusForRenderer()
}

async function setVpnProfileType(profileType) {
  const state = await inspectSecureSetupState()
  if (state?.vpn_replacement?.staged) {
    throw new Error('Restart NetWatch before changing the VPN profile type again.')
  }
  const result = await secureConfigAction('set-vpn-profile-type', {
    payload: { profile_type: normalizeVpnProfileType(profileType) },
  })
  return { ...(result.vpn_profile || await vpnProfileForRenderer()), replacement_pending: false }
}

async function forceRecreateSetupServices(serviceNames, timeoutMs = 240_000) {
  const args = ['up', '-d', '--force-recreate']
  if (app.isPackaged && packagedRuntimeUpdated) args.push('--build')
  args.push(...serviceNames)
  try {
    await runWsl(composeCommandArgs(...args), app.isPackaged && packagedRuntimeUpdated ? 600_000 : timeoutMs)
  } catch (_) {
    // Compose output can contain image/build paths and large third-party logs.
    // Keep the privileged setup surface sanitized; detailed diagnostics remain
    // available through Docker/WSL for an explicit troubleshooting session.
    throw new Error('NetWatch could not start the private setup runtime. Check Docker Desktop and retry.')
  }
}

async function verifySetupVpn() {
  const state = await inspectSecureSetupState()
  if (!state?.wg?.valid) throw new Error('A valid WireGuard configuration is required before VPN verification.')
  if (!state?.permissions?.dirs_secure || !state?.permissions?.files_secure) {
    throw new Error('NetWatch could not secure its private configuration permissions.')
  }

  await logSetupEvent('VPN_START_REQUESTED')
  await ensureDockerForSetup()
  // Recreate both services so a replaced wg0.conf cannot leave a stale network
  // namespace or a backend attached to the previous tunnel.
  await forceRecreateSetupServices(['vpn', 'backend'])

  const backendReady = await waitForHttp(`${BACKEND_BASE_URL}/api/health`, 120_000, 500)
  if (!backendReady) throw new Error('The VPN-routed setup backend did not become ready in time.')

  try {
    await runWsl(['python3', 'docker/verify-vpn-bootstrap.py'], 60_000)
  } catch (_) {
    throw new Error('VPN structure verification failed. NetWatch will not continue without fail-closed routing.')
  }

  let sanity
  try {
    sanity = await backendJson('/api/diagnostics/vpn-sanity', { method: 'GET' }, 20_000)
  } catch (_) {
    throw new Error('NetWatch could not verify real VPN egress through the private tunnel.')
  }
  if (!sanity?.connected || sanity?.status !== 'ok' || !sanity?.dns_ok || !sanity?.public_ip) {
    throw new Error('VPN egress or VPN-routed DNS verification failed. There is no bypass option.')
  }

  await secureConfigAction('mark-vpn-validated')
  setupVpnVerified = true
  await logSetupEvent('VPN_VERIFIED')
  return setupStateForRenderer()
}

function apiValidationSummary(metadata, subtitles, names) {
  const requested = new Set(Array.isArray(names) ? names : [])
  const failures = []
  if (requested.has('tmdb') && (!metadata?.connected || !metadata?.authenticated)) failures.push('TMDB authentication failed')
  if (requested.has('opensubtitles') && (!subtitles?.opensubtitles?.connected || !subtitles?.opensubtitles?.authenticated)) failures.push('OpenSubtitles authentication failed')
  if (requested.has('subdl') && (!subtitles?.subdl?.connected || !subtitles?.subdl?.authenticated)) failures.push('SubDL authentication failed')
  return failures
}

async function validateApiCredentialsThroughVpn(updatedNames) {
  if (!setupVpnVerified) await verifySetupVpn()
  await forceRecreateSetupServices(['backend'])
  const ready = await waitForHttp(`${BACKEND_BASE_URL}/api/health`, 90_000, 400)
  if (!ready) throw new Error('The VPN-routed backend did not reload the new credentials in time.')

  let metadata
  let subtitles
  try {
    ;[metadata, subtitles] = await Promise.all([
      backendJson('/api/metadata/status', { method: 'GET' }, 20_000),
      backendJson('/api/subtitles/providers', { method: 'GET' }, 30_000),
    ])
  } catch (_) {
    await secureConfigAction('clear-api', { payload: { names: updatedNames } })
    throw new Error('The API providers could not be validated through the VPN. The newly entered values were not retained.')
  }

  const failures = apiValidationSummary(metadata, subtitles, updatedNames)
  if (failures.length) {
    await secureConfigAction('clear-api', { payload: { names: updatedNames } })
    throw new Error(`${failures.join('; ')}. The newly entered values were not retained.`)
  }
  await logSetupEvent('API_CREDENTIALS_VALIDATED')
}

async function prepareProwlarrForSetup() {
  if (!setupVpnVerified) await verifySetupVpn()
  await ensureDockerForSetup()
  try {
    await runWsl(composeCommandArgs('up', '-d', 'prowlarr'), 180_000)
  } catch (_) {
    throw new Error('NetWatch could not start the local Prowlarr service. Check Docker Desktop and retry.')
  }
  const ready = await waitForHttp(PROWLARR_LOCAL_URL, 120_000, 700)
  if (!ready) throw new Error('The local Prowlarr Web UI did not become ready in time.')
  await logSetupEvent('PROWLARR_READY')

  const state = await inspectSecureSetupState()
  if (state?.pending?.prowlarr && state?.env?.configured?.prowlarr) {
    const valid = await validateProwlarrKey().catch(() => false)
    if (valid) {
      await secureConfigAction('mark-prowlarr-validated')
      await logSetupEvent('PROWLARR_CONFIGURED')
      await logSetupEvent('SETUP_COMPLETE')
      setTimeout(() => { void finishFirstRun() }, 350)
      return { ready: true, recovered: true }
    }
    await secureConfigAction('clear-prowlarr').catch(() => {})
    return { ready: true, recovered: false, pendingCleared: true }
  }
  return { ready: true, recovered: false }
}

async function validateProwlarrKey() {
  await forceRecreateSetupServices(['backend'])
  const ready = await waitForHttp(`${BACKEND_BASE_URL}/api/health`, 90_000, 400)
  if (!ready) throw new Error('The backend did not reload the Prowlarr credential in time.')
  let status
  try {
    status = await backendJson('/api/diagnostics/prowlarr', { method: 'GET' }, 15_000)
  } catch (_) {
    return false
  }
  return Boolean(status?.connected && status?.authenticated && status?.status === 'ok')
}

function closeSetupWindow() {
  removeIpcHandlers(SETUP_CHANNELS)
  if (setupWindow && !setupWindow.isDestroyed()) setupWindow.destroy()
  setupWindow = null
}

function closeProwlarrSetupWindow() {
  removeIpcHandlers(PROWLARR_SETUP_CHANNELS)
  if (prowlarrSetupWindow && !prowlarrSetupWindow.isDestroyed()) prowlarrSetupWindow.destroy()
  prowlarrSetupWindow = null
}

function setupReadyToFinish(state) {
  const configured = state?.env?.configured || {}
  return Boolean(
    configured.tmdb && configured.prowlarr
    && !state?.pending?.api && !state?.pending?.prowlarr && !state?.pending?.vpn
  )
}

function scheduleProwlarrSetupIfReady(state) {
  const configured = state?.env?.configured || {}
  const apiComplete = Boolean(configured.tmdb)
  if (!apiComplete || configured.prowlarr || state?.pending?.api) return
  setTimeout(() => {
    void createProwlarrSetupWindow().then(() => closeSetupWindow())
  }, 350)
}

function continueFirstRunAfterApi(state) {
  if (setupReadyToFinish(state)) {
    setTimeout(() => { void finishFirstRun() }, 350)
    return
  }
  scheduleProwlarrSetupIfReady(state)
}

function registerSetupHandlers() {
  removeIpcHandlers(SETUP_CHANNELS)
  ipcMain.handle('setup:get-state', async event => {
    assertWindowSender(event, setupWindow, 'setup', setupWindowUrl('setup.html'))
    return setupStateForRenderer()
  })
  ipcMain.handle('setup:choose-wireguard', async (event, profileType) => {
    assertWindowSender(event, setupWindow, 'setup', setupWindowUrl('setup.html'))
    const current = await inspectSecureSetupState()
    const result = await chooseAndImportWireGuard(setupWindow, profileType, { confirmReplace: Boolean(current?.wg?.valid) })
    if (result.cancelled) return { cancelled: true, state: await setupStateForRenderer() }
    setupVpnVerified = false
    await logSetupEvent('WG_CONFIG_VALIDATED')
    await logSetupEvent('CONFIG_PERMISSIONS_VERIFIED')
    return { cancelled: false, state: await setupStateForRenderer() }
  })
  ipcMain.handle('setup:set-vpn-profile-type', async (event, profileType) => {
    assertWindowSender(event, setupWindow, 'setup', setupWindowUrl('setup.html'))
    await setVpnProfileType(profileType)
    return { ok: true, state: await setupStateForRenderer() }
  })
  ipcMain.handle('setup:open-vpnbook', async event => {
    assertWindowSender(event, setupWindow, 'setup', setupWindowUrl('setup.html'))
    await shell.openExternal(VPNBOOK_REFRESH_URL)
    return { opened: true }
  })
  ipcMain.handle('setup:verify-vpn', async event => {
    assertWindowSender(event, setupWindow, 'setup', setupWindowUrl('setup.html'))
    let state = await verifySetupVpn()
    if (state?.pending?.api) {
      const names = Array.isArray(state.pending.api_names) ? state.pending.api_names : []
      const configured = state?.env?.configured || {}
      if (names.length && names.every(name => configured[name])) {
        await validateApiCredentialsThroughVpn(names)
        await secureConfigAction('mark-api-validated')
        state = await setupStateForRenderer()
        scheduleProwlarrSetupIfReady(state)
      }
    }
    if (setupReadyToFinish(state)) setTimeout(() => { void finishFirstRun() }, 350)
    return { ok: true, state }
  })
  ipcMain.handle('setup:submit-api', async (event, payload) => {
    assertWindowSender(event, setupWindow, 'setup', setupWindowUrl('setup.html'))
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('API credential request is invalid.')
    const allowed = new Set(['tmdb', 'opensubtitles', 'subdl'])
    if (Object.keys(payload).some(key => !allowed.has(key))) throw new Error('API credential request contains an unsupported field.')
    const before = await inspectSecureSetupState()
    const configured = before?.env?.configured || {}
    const safePayload = {}

    if (!configured.tmdb) {
      if (typeof payload.tmdb !== 'string' || !payload.tmdb.trim()) throw new Error('TMDB API key is required.')
      safePayload.tmdb = normalizeCredentialCandidate('tmdb', payload.tmdb)
    }
    for (const name of ['opensubtitles', 'subdl']) {
      if (configured[name]) continue
      const raw = typeof payload[name] === 'string' ? payload[name].trim() : ''
      if (!raw) continue
      safePayload[name] = normalizeCredentialCandidate(name, raw)
    }

    const updatedNames = Object.keys(safePayload)
    if (!configured.tmdb && !updatedNames.includes('tmdb')) {
      throw new Error('TMDB API key is required.')
    }
    if (!updatedNames.length) {
      const next = await setupStateForRenderer()
      continueFirstRunAfterApi(next)
      return { ok: true, state: next }
    }

    try {
      await secureConfigAction('set-api', { payload: safePayload })
      await logSetupEvent('API_CREDENTIALS_SAVED')
      try {
        await validateApiCredentialsThroughVpn(updatedNames)
        await secureConfigAction('mark-api-validated')
      } catch (error) {
        await secureConfigAction('clear-api', { payload: { names: updatedNames } }).catch(() => {})
        throw error
      }
    } finally {
      for (const key of Object.keys(payload)) if (typeof payload[key] === 'string') payload[key] = ''
      for (const key of Object.keys(safePayload)) safePayload[key] = ''
    }
    const next = await setupStateForRenderer()
    continueFirstRunAfterApi(next)
    return { ok: true, state: next }
  })
  ipcMain.handle('setup:open-credential-site', async (event, site) => {
    assertWindowSender(event, setupWindow, 'setup', setupWindowUrl('setup.html'))
    if (typeof site !== 'string' || !Object.prototype.hasOwnProperty.call(CREDENTIAL_SITES, site)) {
      throw new Error('Unknown credential site.')
    }
    await shell.openExternal(CREDENTIAL_SITES[site])
    return { opened: true }
  })
}

function registerProwlarrSetupHandlers() {
  removeIpcHandlers(PROWLARR_SETUP_CHANNELS)
  ipcMain.handle('prowlarr-setup:prepare', async event => {
    assertWindowSender(event, prowlarrSetupWindow, 'Prowlarr setup', setupWindowUrl('prowlarr-setup.html'))
    return prepareProwlarrForSetup()
  })
  ipcMain.handle('prowlarr-setup:open', async event => {
    assertWindowSender(event, prowlarrSetupWindow, 'Prowlarr setup', setupWindowUrl('prowlarr-setup.html'))
    if (!(await httpOk(PROWLARR_LOCAL_URL, 1500))) throw new Error('The local Prowlarr Web UI is not ready yet.')
    await shell.openExternal(PROWLARR_LOCAL_URL)
    return { opened: true }
  })
  ipcMain.handle('prowlarr-setup:submit', async (event, key) => {
    assertWindowSender(event, prowlarrSetupWindow, 'Prowlarr setup', setupWindowUrl('prowlarr-setup.html'))
    if (typeof key !== 'string') throw new Error('Prowlarr credential request is invalid.')
    key = normalizeCredentialCandidate('prowlarr', key)
    const secretPayload = { prowlarr: key }
    try {
      await secureConfigAction('set-prowlarr', { payload: secretPayload })
    } finally {
      key = ''
      secretPayload.prowlarr = ''
    }
    let valid = false
    try {
      valid = await validateProwlarrKey()
    } catch (_) {
      valid = false
    }
    if (!valid) {
      await secureConfigAction('clear-prowlarr').catch(() => {})
      throw new Error('Prowlarr authentication failed. The entered key was not retained.')
    }
    await secureConfigAction('mark-prowlarr-validated')
    await logSetupEvent('PROWLARR_CONFIGURED')
    await logSetupEvent('SETUP_COMPLETE')
    setTimeout(() => { void finishFirstRun() }, 250)
    return { ok: true }
  })
}

async function createSetupWindow() {
  if (setupWindow && !setupWindow.isDestroyed()) {
    setupWindow.show()
    setupWindow.focus()
    return
  }
  hardenSetupSession('netwatch-secure-setup')
  setupWindow = new BrowserWindow({
    width: 720,
    height: 640,
    minWidth: 640,
    minHeight: 540,
    frame: true,
    show: false,
    title: 'NetWatch Secure Setup',
    backgroundColor: '#0a0a0f',
    webPreferences: secureBrowserPreferences('setup-preload.js', 'netwatch-secure-setup'),
  })
  setupWindow.setMenuBarVisibility(false)
  const expectedUrl = setupWindowUrl('setup.html')
  hardenRendererNavigation(setupWindow.webContents, expectedUrl)
  registerSetupHandlers()
  setupWindow.on('closed', () => {
    setupWindow = null
    removeIpcHandlers(SETUP_CHANNELS)
    if (!mainWindow && !prowlarrSetupWindow && !quittingApp) app.quit()
  })
  await setupWindow.loadURL(expectedUrl)
  await logSetupEvent('SETUP_STARTED')
  setupWindow.show()
}

async function createProwlarrSetupWindow() {
  if (prowlarrSetupWindow && !prowlarrSetupWindow.isDestroyed()) {
    prowlarrSetupWindow.show()
    prowlarrSetupWindow.focus()
    return
  }
  hardenSetupSession('netwatch-prowlarr-setup')
  prowlarrSetupWindow = new BrowserWindow({
    width: 680,
    height: 520,
    minWidth: 620,
    minHeight: 480,
    frame: true,
    show: false,
    title: 'NetWatch — Prowlarr Setup',
    backgroundColor: '#0a0a0f',
    webPreferences: secureBrowserPreferences('prowlarr-preload.js', 'netwatch-prowlarr-setup'),
  })
  prowlarrSetupWindow.setMenuBarVisibility(false)
  const expectedUrl = setupWindowUrl('prowlarr-setup.html')
  hardenRendererNavigation(prowlarrSetupWindow.webContents, expectedUrl)
  registerProwlarrSetupHandlers()
  prowlarrSetupWindow.on('closed', () => {
    prowlarrSetupWindow = null
    removeIpcHandlers(PROWLARR_SETUP_CHANNELS)
    if (!mainWindow && !setupWindow && !quittingApp) app.quit()
  })
  await prowlarrSetupWindow.loadURL(expectedUrl)
  prowlarrSetupWindow.show()
}

async function startNormalDesktop() {
  const runtimePromise = startRuntime().catch(error => {
    console.error('[Runtime startup]', error)
  })
  await ensureRendererBuild()
  if (!mainWindow || mainWindow.isDestroyed()) createWindow()
  sendRuntimeStatus()
  void runtimePromise
}

async function finishFirstRun() {
  if (firstRunTransitionPromise) return firstRunTransitionPromise
  firstRunTransitionPromise = (async () => {
    await startNormalDesktop()
    closeProwlarrSetupWindow()
    closeSetupWindow()
  })().finally(() => { firstRunTransitionPromise = null })
  return firstRunTransitionPromise
}

async function beginPackagedFirstRun(setupState) {
  if (!setupState?.env?.parse_ok) {
    throw new Error('The private backend.env file is malformed. NetWatch will not overwrite an existing malformed secret file automatically.')
  }
  if (!setupState?.permissions?.dirs_secure || !setupState?.permissions?.files_secure) {
    throw new Error('NetWatch could not enforce private permissions on its WSL configuration files.')
  }

  const configured = setupState?.env?.configured || {}
  const apiComplete = Boolean(configured.tmdb)
  const prowlarrComplete = Boolean(configured.prowlarr)
  const pendingApi = Boolean(setupState?.pending?.api)
  const pendingProwlarr = Boolean(setupState?.pending?.prowlarr)
  const pendingVpn = Boolean(setupState?.pending?.vpn)

  if (!setupState?.wg?.valid || !apiComplete || pendingApi || pendingVpn) {
    await createSetupWindow()
    return true
  }
  if (!prowlarrComplete || pendingProwlarr) {
    await createProwlarrSetupWindow()
    return true
  }
  return false
}

async function ensureVite() {
  if (!isDev) return
  if (await httpOk('http://127.0.0.1:5173/', 800)) return

  const projectRoot = path.resolve(__dirname, '..')

  // IMPORTANT: keep this launch shape in sync with the exact command that is
  // already proven to work from Windows PowerShell for this WSL-hosted repo:
  //
  //   cmd.exe /d /s /c "pushd \\\\wsl.localhost\\<distro>\\home\\<user>\\projects\\netwatch && npm run dev:react"
  //
  // `pushd` is what makes cmd.exe assign a temporary drive letter for the UNC
  // WSL path. The outer quotes around the complete /c command are significant.
  // Do not replace this with a UNC cwd or direct node/vite invocation; both have
  // already been shown to fail with this project layout.
  const command = `"pushd ${projectRoot} && npm run dev:react -- --host 127.0.0.1 --port 5173 --strictPort"`

  let recentOutput = ''
  let exited = false
  let exitCode = null
  let spawnError = null

  const rememberOutput = (prefix, chunk) => {
    const text = chunk.toString()
    recentOutput = `${recentOutput}${prefix}${text}`.slice(-12_000)
    return text.trimEnd()
  }

  viteProcess = spawn('cmd.exe', ['/d', '/s', '/c', command], {
    shell: false,
    windowsHide: true,
    // Node normally performs another layer of Windows argument quoting. For
    // cmd.exe /s /c that can change the meaning of the outer command quotes.
    // Pass the arguments verbatim so the resulting command line matches the
    // known-good manual invocation above.
    windowsVerbatimArguments: true,
    cwd: process.env.SystemRoot || 'C:\\Windows',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      BROWSER: 'none',
    },
  })
  viteOwned = true

  viteProcess.stdout.on('data', chunk => {
    const line = rememberOutput('', chunk)
    if (line) console.log('[Vite]', line)
  })
  viteProcess.stderr.on('data', chunk => {
    const line = rememberOutput('', chunk)
    if (line) console.error('[Vite]', line)
  })
  viteProcess.once('error', error => {
    spawnError = error
  })
  viteProcess.once('exit', code => {
    exited = true
    exitCode = code
  })

  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    if (await httpOk('http://127.0.0.1:5173/', 800)) return

    if (spawnError) {
      throw new Error(`Could not launch the hidden Vite process: ${spawnError.message}`)
    }
    if (exited) {
      const details = recentOutput.trim()
      throw new Error(
        `Vite exited before becoming ready (exit code ${exitCode}).${details ? `\n\n${details}` : ''}`,
      )
    }
    await sleep(250)
  }

  const details = recentOutput.trim()
  throw new Error(
    `Vite did not become ready on http://127.0.0.1:5173${details ? `\n\n${details}` : ''}`,
  )
}


async function ensureRendererBuild() {
  if (app.isPackaged || !isDev) return

  // Existing player smoke tests deliberately keep their externally-owned Vite
  // server. The normal GUI does not: it builds the renderer once, then loads
  // dist/index.html and dist/player.html directly via file:// URLs.
  if (useViteDevServer) {
    await ensureVite()
    return
  }

  const projectRoot = path.resolve(__dirname, '..')
  const distIndex = path.join(projectRoot, 'dist', 'index.html')
  const distPlayer = path.join(projectRoot, 'dist', 'player.html')
  const command = `"pushd ${projectRoot} && npm run build:renderer"`

  let recentOutput = ''
  const child = spawn('cmd.exe', ['/d', '/s', '/c', command], {
    shell: false,
    windowsHide: true,
    windowsVerbatimArguments: true,
    cwd: process.env.SystemRoot || 'C:\\Windows',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      BROWSER: 'none',
    },
  })

  const rememberOutput = (prefix, chunk) => {
    const text = chunk.toString()
    recentOutput = `${recentOutput}${prefix}${text}`.slice(-12_000)
    return text.trimEnd()
  }

  child.stdout.on('data', chunk => {
    const line = rememberOutput('', chunk)
    if (line) console.log('[Renderer build]', line)
  })
  child.stderr.on('data', chunk => {
    const line = rememberOutput('', chunk)
    if (line) console.error('[Renderer build]', line)
  })

  await new Promise((resolve, reject) => {
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      try {
        spawn('taskkill.exe', ['/pid', String(child.pid), '/t', '/f'], {
          shell: false,
          windowsHide: true,
          stdio: 'ignore',
        }).unref()
      } catch (_) {}
      reject(new Error(`Renderer build timed out after 90 seconds.${recentOutput.trim() ? `\n\n${recentOutput.trim()}` : ''}`))
    }, 90_000)

    child.once('error', error => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(new Error(`Could not launch the hidden renderer build: ${error.message}`))
    })
    child.once('exit', code => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (code === 0) {
        resolve()
      } else {
        reject(new Error(
          `Renderer build exited with code ${code}.${recentOutput.trim() ? `\n\n${recentOutput.trim()}` : ''}`,
        ))
      }
    })
  })

  if (!fs.existsSync(distIndex) || !fs.existsSync(distPlayer)) {
    throw new Error('Renderer build completed but dist/index.html or dist/player.html is missing.')
  }
}

function stopOwnedVite() {
  if (!viteOwned || !viteProcess) return
  const pid = viteProcess.pid
  viteOwned = false
  viteProcess = null
  if (!pid) return
  try {
    const killer = spawn('taskkill.exe', ['/pid', String(pid), '/t', '/f'], {
      shell: false,
      windowsHide: true,
      stdio: 'ignore',
    })
    killer.unref()
  } catch (_) {}
}

async function ensureInfrastructure() {
  setRuntimeStatus({
    phase: 'docker',
    ready: false,
    message: 'Checking Docker…',
    error: null,
    services: { docker: 'starting' },
  })

  let dockerReady = false
  try {
    await runWsl(['docker', 'info', '--format', '{{.ServerVersion}}'], 5000)
    dockerReady = true
  } catch (_) {
    setRuntimeStatus({ message: 'Starting Docker Desktop…' })
    launchDockerDesktopIfPresent()
    dockerReady = await waitForDocker(90_000)
  }

  if (!dockerReady) {
    throw new Error('Docker is unavailable. Start Docker Desktop, then retry NetWatch startup.')
  }

  setRuntimeStatus({
    phase: 'services',
    message: 'Starting private streaming services…',
    services: { docker: 'ready', stack: 'starting' },
  })

  await startComposeWithVpnSelfHeal()

  setRuntimeStatus({
    message: 'Waiting for NetWatch API…',
    services: { stack: 'ready', backend: 'starting' },
  })

  const backendReady = await waitForHttp(`${BACKEND_BASE_URL}/api/health`, 90_000, 500)
  if (!backendReady) throw new Error('The NetWatch backend did not become healthy in time.')

  setRuntimeStatus({
    message: 'Checking torrent engine and search service…',
    services: { backend: 'ready', torrentEngine: 'starting', prowlarr: 'starting' },
  })

  const deadline = Date.now() + 60_000
  let lastPayload = null
  while (Date.now() < deadline) {
    try {
      lastPayload = await backendJson('/api/diagnostics/dependencies', { method: 'GET' }, 5000)
    } catch (_) {
      await sleep(1000)
      continue
    }

    if (lastPayload?.all_connected) {
      // Verify the complete privacy topology on every launch, not only after a
      // cold-boot repair. A failed privacy check is fatal and is intentionally
      // not swallowed by the dependency retry loop.
      await verifyVpnIsolation()
      setRuntimeStatus({
        phase: 'ready',
        ready: true,
        message: 'Ready',
        error: null,
        services: { stack: 'ready', backend: 'ready', torrentEngine: 'ready', prowlarr: 'ready' },
      })
      return
    }
    await sleep(1000)
  }

  const engineError = lastPayload?.torrent_engine?.error || lastPayload?.torrent_engine?.status
  const prowlarrError = lastPayload?.prowlarr?.error || lastPayload?.prowlarr?.status
  throw new Error(
    `Dependencies did not become ready.${engineError ? ` torrent-engine: ${engineError}.` : ''}${prowlarrError ? ` Prowlarr: ${prowlarrError}.` : ''}`,
  )
}

function startRuntime() {
  if (runtimeStartupPromise) return runtimeStartupPromise
  runtimeStartupPromise = ensureInfrastructure()
    .catch(error => {
      setRuntimeStatus({
        phase: 'error',
        ready: false,
        message: 'Startup failed',
        error: error instanceof Error ? error.message : String(error),
      })
      throw error
    })
    .finally(() => {
      runtimeStartupPromise = null
    })
  return runtimeStartupPromise
}

async function retryRuntime() {
  if (runtimeStartupPromise) return { ...runtimeStatus, services: { ...runtimeStatus.services } }
  runtimeStatus = { ...RUNTIME_DEFAULT, services: { ...RUNTIME_DEFAULT.services } }
  sendRuntimeStatus()
  try {
    await startRuntime()
  } catch (_) {}
  return { ...runtimeStatus, services: { ...runtimeStatus.services } }
}

function sendToPlayerRenderer(channel, payload) {
  if (playerOverlayWindow && !playerOverlayWindow.isDestroyed()) {
    playerOverlayWindow.webContents.send(channel, payload)
  }
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload)
  }
}

function setPlayerPreparation(patch) {
  playerPreparation = {
    ...playerPreparation,
    ...patch,
    updatedAt: new Date().toISOString(),
  }
  sendToPlayerRenderer('player:preparation', { ...playerPreparation })
  return { ...playerPreparation }
}

function syncPlayerOverlayBounds() {
  if (!playerVideoWindow || playerVideoWindow.isDestroyed()) return
  if (!playerOverlayWindow || playerOverlayWindow.isDestroyed()) return

  // With the native Windows frame restored, controls belong only to the client
  // area. getContentBounds() excludes the title bar and resize border.
  playerOverlayWindow.setBounds(playerVideoWindow.getContentBounds())
}

function schedulePlayerVideoSurfaceSync(delayMs = 75) {
  if (playerSurfaceSyncTimer) clearTimeout(playerSurfaceSyncTimer)
  playerSurfaceSyncTimer = setTimeout(() => {
    playerSurfaceSyncTimer = null
    if (!playerVideoWindow || playerVideoWindow.isDestroyed()) return
    void mpv.syncVideoSurface(playerVideoWindow, 1500).catch(error => {
      console.error('[Player surface]', error)
    })
  }, delayMs)
}

function restoreFullscreenPlayerForeground(delayMs = 0) {
  setTimeout(() => {
    if (!playerVideoWindow || playerVideoWindow.isDestroyed()) return
    if (!playerVideoWindow.isFullScreen()) return

    // Returning to a fullscreen BaseWindow through Alt+Tab or its taskbar entry can
    // leave the transparent BrowserWindow controls behind the mpv host while the
    // Windows taskbar remains foreground. Reassert the player pair's z-order and
    // give focus back to the interactive overlay without changing fullscreen state.
    try { playerVideoWindow.moveTop() } catch (_) {}
    syncPlayerOverlayBounds()

    if (playerOverlayWindow && !playerOverlayWindow.isDestroyed()) {
      playerOverlayWindow.show()
      try { playerOverlayWindow.moveTop() } catch (_) {}
      playerOverlayWindow.focus()
    } else {
      playerVideoWindow.focus()
    }

    schedulePlayerVideoSurfaceSync(50)
  }, Math.max(0, delayMs))
}

function restorePlayerVisualsAfterMinimize() {
  // Windows can restore the BaseWindow at exactly the same client size it had
  // before minimization. mpv's persistent child-HWND watcher intentionally skips
  // unchanged sizes, so a child hidden by minimization would otherwise stay
  // hidden and expose only the host's black background. Restarting the watcher
  // forces one ShowWindow/SetWindowPos pass, then returns to the cheap resize loop.
  setTimeout(() => {
    if (!playerVideoWindow || playerVideoWindow.isDestroyed()) return

    syncPlayerOverlayBounds()
    void mpv.restartVideoSurface(playerVideoWindow, 2500)
      .then(() => {
        if (!playerOverlayWindow || playerOverlayWindow.isDestroyed()) return
        syncPlayerOverlayBounds()
        playerOverlayWindow.show()
        playerOverlayWindow.focus()
      })
      .catch(error => {
        console.error('[Player restore surface]', error)
      })
  }, 75)
}

function getPlayerLaunchPlacement() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return {
      bounds: { x: 100, y: 100, width: 1280, height: 720 },
      maximized: false,
      fullscreen: false,
    }
  }

  // Preserve the main window's normal/restored geometry separately from its
  // current state. A maximized Electron window's getBounds() describes the
  // maximized rectangle; using that as the player's normal bounds would make
  // "restore" reopen as a screen-sized window. getNormalBounds() retains the
  // actual restored size while we explicitly carry maximized/fullscreen state.
  return {
    bounds: mainWindow.getNormalBounds(),
    maximized: mainWindow.isMaximized(),
    fullscreen: mainWindow.isFullScreen(),
  }
}

function showPlayerVideoWindowFromLaunchState() {
  if (!playerVideoWindow || playerVideoWindow.isDestroyed()) return

  if (playerLaunchWindowState.fullscreen) {
    playerVideoWindow.show()
    playerVideoWindow.setFullScreen(true)
  } else if (playerLaunchWindowState.maximized) {
    // maximize() also shows a hidden native window on Windows. This preserves
    // the real maximized state rather than merely sizing a normal window to the
    // monitor rectangle, so mpv and its overlay inherit the correct client area.
    playerVideoWindow.maximize()
  } else {
    playerVideoWindow.show()
  }
}

async function createPlayerWindows() {
  if (
    playerVideoWindow && !playerVideoWindow.isDestroyed() &&
    playerOverlayWindow && !playerOverlayWindow.isDestroyed()
  ) {
    return
  }

  const launchPlacement = getPlayerLaunchPlacement()
  const bounds = launchPlacement.bounds
  playerLaunchWindowState = {
    maximized: launchPlacement.maximized,
    fullscreen: launchPlacement.fullscreen,
  }

  playerVideoWindow = new BaseWindow({
    ...bounds,
    minWidth: 800,
    minHeight: 450,
    frame: true,
    show: false,
    title: 'NetWatch Player',
    backgroundColor: '#000000',
    minimizable: true,
    maximizable: true,
    resizable: true,
  })
  playerVideoWindow.setMenuBarVisibility(false)

  const contentBounds = playerVideoWindow.getContentBounds()
  playerOverlayWindow = new BrowserWindow({
    ...contentBounds,
    frame: false,
    show: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: false,
    parent: playerVideoWindow,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    closable: false,
    skipTaskbar: true,
    webPreferences: {
      preload: path.join(__dirname, 'player-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      webviewTag: false,
      devTools: isDev && process.env.NETWATCH_DEVTOOLS === '1',
    },
  })
  playerOverlayWindow.setMenuBarVisibility(false)
  playerOverlayWindow.webContents.on('before-input-event', (event, input) => {
    const action = playerFullscreenShortcutAction(input)
    if (action === 'ignore') return

    // Chromium/Electron otherwise applies F11 to the focused transparent overlay
    // BrowserWindow. The visible player is the native BaseWindow hosting mpv, so
    // consume the browser shortcut and route it through the existing player
    // fullscreen controller instead. This keeps the overlay and mpv surface in sync.
    event.preventDefault()
    if (action === 'toggle') {
      void setPlayerFullscreen(!(playerVideoWindow?.isFullScreen() || false))
    }
  })
  const expectedOverlayUrl = playerRendererUrl()
  hardenRendererNavigation(playerOverlayWindow.webContents, expectedOverlayUrl)
  await playerOverlayWindow.loadURL(expectedOverlayUrl)

  const sync = () => {
    syncPlayerOverlayBounds()
    schedulePlayerVideoSurfaceSync(50)
  }

  playerVideoWindow.on('move', sync)
  playerVideoWindow.on('resize', sync)
  playerVideoWindow.on('resized', () => schedulePlayerVideoSurfaceSync(0))
  playerVideoWindow.on('enter-full-screen', sync)
  playerVideoWindow.on('leave-full-screen', sync)
  playerVideoWindow.on('maximize', sync)
  playerVideoWindow.on('unmaximize', sync)
  playerVideoWindow.on('restore', restorePlayerVisualsAfterMinimize)
  playerVideoWindow.on('focus', () => restoreFullscreenPlayerForeground(0))

  // The native title-bar X exits NetWatch. Keep the window alive long enough
  // to stop mpv and delete the torrent/data before the application actually quits.
  // Returning to the main menu is handled separately by the in-player back button.
  playerVideoWindow.on('close', event => {
    if (closingPlayer || quitCleanupComplete) return
    event.preventDefault()
    void quitAppFromPlayer()
  })

  playerVideoWindow.on('closed', () => {
    playerVideoWindow = null
  })

  playerOverlayWindow.on('closed', () => {
    playerOverlayWindow = null
    if (!closingPlayer && playerSession) void closePlayerSession()
  })

  syncPlayerOverlayBounds()
}

function setPlayerWindowTitle(title) {
  if (!playerVideoWindow || playerVideoWindow.isDestroyed()) return
  playerVideoWindow.setTitle(title ? `${title} — NetWatch` : 'NetWatch Player')
}

function showPlayerShell({ focus = true } = {}) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.hide()
  showPlayerVideoWindowFromLaunchState()
  syncPlayerOverlayBounds()
  if (playerOverlayWindow && !playerOverlayWindow.isDestroyed()) {
    playerOverlayWindow.show()
    if (focus) playerOverlayWindow.focus()
  }
}

function extractBtih(source) {
  if (typeof source !== 'string' || !source.toLowerCase().startsWith('magnet:?')) return null
  try {
    const url = new URL(source)
    for (const value of url.searchParams.getAll('xt')) {
      const match = /^urn:btih:([0-9a-f]{40})$/iu.exec(value.trim())
      if (match) return match[1].toLowerCase()
    }
  } catch (_) {}
  return null
}

function backendErrorMessage(payload, fallback) {
  const detail = payload?.detail
  if (typeof detail === 'string' && detail.trim()) return detail
  if (detail && typeof detail === 'object') {
    if (typeof detail.message === 'string' && detail.message.trim()) return detail.message
    if (typeof detail.error === 'string' && detail.error.trim()) return detail.error
  }
  return fallback
}

async function backendJson(pathname, options = {}, timeoutMs = 10_000) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(`${BACKEND_BASE_URL}${pathname}`, {
      ...options,
      signal: controller.signal,
      headers: {
        'Cache-Control': 'no-store',
        ...(options.headers || {}),
      },
    })
    const text = await response.text()
    let payload = null
    try { payload = text ? JSON.parse(text) : null } catch (_) {}

    if (!response.ok) {
      const error = new Error(backendErrorMessage(payload, `backend returned HTTP ${response.status}`))
      error.status = response.status
      error.payload = payload
      throw error
    }
    return payload
  } finally {
    clearTimeout(timer)
  }
}

async function deleteTorrentAndData(infoHash) {
  if (typeof infoHash !== 'string' || !infoHash.trim()) return true

  const normalized = infoHash.trim().toLowerCase()
  let lastError = null

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const payload = await backendJson(
        `/api/torrents/${encodeURIComponent(normalized)}?delete_files=true`,
        { method: 'DELETE' },
        5000,
      )
      if (payload?.removed === true && payload?.verified_absent === true) {
        console.log(`[Player cleanup] Removed torrent ${normalized} and its data`)
        return true
      }
      throw new Error(`torrent cleanup was not verified for ${normalized}`)
    } catch (error) {
      if (error?.status === 404) return true
      lastError = error
      if (attempt < 3) {
        await new Promise(resolve => setTimeout(resolve, attempt * 250))
      }
    }
  }

  throw lastError || new Error(`torrent cleanup failed for ${normalized}`)
}

function preparationFromBackend(status) {
  return {
    stage: status.stage || 'buffering',
    ready: Boolean(status.ready),
    message: status.message || 'Preparing stream…',
    infoHash: status.hash || playerSession?.infoHash || null,
    progress: Number.isFinite(status.progress) ? status.progress : null,
    videoProgress: Number.isFinite(status.video_progress) ? status.video_progress : null,
    downloaded: Number(status.downloaded) || 0,
    size: Number(status.size) || 0,
    dlSpeed: Number(status.dl_speed) || 0,
    seeders: Number(status.seeds) || 0,
    peers: Number(status.peers) || 0,
    torrentState: status.state || null,
    firstReady: Boolean(status.first_ready),
    lastReady: Boolean(status.last_ready),
    bufferedBytes: Number(status.buffered_bytes) || 0,
    bufferTargetBytes: Number(status.buffer_target_bytes) || 0,
    bufferProgress: Number.isFinite(status.buffer_progress)
      ? Math.max(0, Math.min(1, status.buffer_progress))
      : 0,
    error: null,
  }
}

function preparationIsCurrent(generation, infoHash = null) {
  if (generation !== playerPreparationGeneration) return false
  if (!playerSession) return false
  if (infoHash && playerSession.infoHash && playerSession.infoHash !== infoHash) return false
  return true
}

async function monitorTorrentTelemetry(infoHash, generation) {
  while (preparationIsCurrent(generation, infoHash)) {
    try {
      const progress = await backendJson(
        `/api/torrents/progress/${encodeURIComponent(infoHash)}`,
        { method: 'GET' },
        5000,
      )
      if (!preparationIsCurrent(generation, infoHash)) return

      setPlayerPreparation({
        stage: 'ready',
        ready: true,
        progress: Number.isFinite(progress?.progress) ? progress.progress : playerPreparation.progress,
        downloaded: Number(progress?.downloaded) || 0,
        size: Number(progress?.size) || 0,
        dlSpeed: Number(progress?.dl_speed) || 0,
        seeders: Number(progress?.num_seeds) || 0,
        peers: Number(progress?.num_leechs) || 0,
        torrentState: progress?.state || playerPreparation.torrentState || null,
        error: null,
      })
    } catch (error) {
      if (!preparationIsCurrent(generation, infoHash)) return
      if (error?.status === 404) return
      // Telemetry is informational only. Playback and the cache state remain
      // authoritative if this lightweight status poll is temporarily unavailable.
    }

    await new Promise(resolve => setTimeout(resolve, PLAYER_TELEMETRY_POLL_MS))
  }
}

async function monitorTorrentPreparation(infoHash, source, generation) {
  const startedAt = Date.now()
  let reannounced = false
  let consecutiveErrors = 0

  while (preparationIsCurrent(generation, infoHash)) {
    const elapsed = Date.now() - startedAt
    const shouldReannounce = !reannounced && elapsed >= PREPARATION_REANNOUNCE_MS
    const suffix = shouldReannounce ? '?reannounce=true' : ''

    try {
      const status = await backendJson(
        `/api/torrents/playback-status/${encodeURIComponent(infoHash)}${suffix}`,
        { method: 'GET' },
        6000,
      )
      if (!preparationIsCurrent(generation, infoHash)) return

      if (shouldReannounce) reannounced = true
      consecutiveErrors = 0
      setPlayerPreparation(preparationFromBackend(status || {}))

      if (metadataPreparationTimedOut(status, elapsed)) {
        const timeoutSeconds = Math.round(METADATA_PREPARATION_TIMEOUT_MS / 1000)
        setPlayerPreparation({
          stage: 'error',
          ready: false,
          message: 'Unable to prepare this source',
          error: `Torrent metadata did not become available within ${timeoutSeconds} seconds.`,
        })
        await deleteTorrentAndData(infoHash).catch(error => {
          console.error('[Player metadata-timeout cleanup]', error)
        })
        return
      }

      if (status?.path && playerSession) {
        playerSession = { ...playerSession, filePath: status.path }
        sendToPlayerRenderer('player:session', playerSession)
      }

      if (status?.ready) {
        setPlayerPreparation({
          stage: 'starting',
          ready: false,
          message: 'Starting video…',
          error: null,
        })

        if (!playerVideoWindow || playerVideoWindow.isDestroyed()) return
        try {
          await mpv.start(playerVideoWindow, source)
        } catch (error) {
          if (!preparationIsCurrent(generation, infoHash)) return
          console.error('[Player mpv startup]', error)
          await mpv.stop({ graceful: false }).catch(stopError => {
            console.error('[Player mpv startup cleanup]', stopError)
          })
          setPlayerPreparation({
            stage: 'error',
            ready: false,
            message: 'Player could not start',
            error: error instanceof Error ? error.message : String(error),
          })
          return
        }
        if (!preparationIsCurrent(generation, infoHash)) {
          await mpv.stop({ graceful: false })
          return
        }

        // mpv's child surface is now alive. Reassert the transparent controls
        // window above it, preserving the HWND ordering that made embedding stable.
        syncPlayerOverlayBounds()
        if (playerOverlayWindow && !playerOverlayWindow.isDestroyed()) {
          playerOverlayWindow.show()
          playerOverlayWindow.focus()
        }

        setPlayerPreparation({
          stage: 'ready',
          ready: true,
          message: 'Playing',
          error: null,
        })
        void monitorTorrentTelemetry(infoHash, generation)
        return
      }
    } catch (error) {
      if (!preparationIsCurrent(generation, infoHash)) return
      consecutiveErrors += 1

      if (error?.status === 404) {
        setPlayerPreparation({
          stage: 'error',
          ready: false,
          message: 'Source is no longer available',
          error: error.message,
        })
        return
      }

      // Short backend/torrent-service interruptions should not kill a healthy playback
      // attempt. Keep the player visible and retry while surfacing the condition.
      setPlayerPreparation({
        stage: consecutiveErrors >= 3 ? 'peers' : playerPreparation.stage,
        ready: false,
        message: consecutiveErrors >= 3
          ? 'Waiting for torrent service…'
          : playerPreparation.message,
        error: null,
      })
    }

    await new Promise(resolve => setTimeout(resolve, PREPARATION_POLL_MS))
  }
}

async function runTorrentAddAndPreparation(payload, generation) {
  const releaseRef = typeof payload.releaseRef === 'string' ? payload.releaseRef.trim() : ''
  const torrentSource = typeof payload.torrentSource === 'string' ? payload.torrentSource.trim() : ''
  const mediaName = payload.mediaName || payload.title || 'NetWatch media'
  const expectedHash = payload.expectedHash || (torrentSource ? extractBtih(torrentSource) : null) || null

  try {
    const addPayload = {
      media_name: mediaName,
      expected_hash: expectedHash,
    }
    if (releaseRef) addPayload.release_ref = releaseRef
    else addPayload.magnet = torrentSource

    const added = await backendJson('/api/torrents/add', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(addPayload),
    }, 30_000)

    const infoHash = typeof added?.hash === 'string' ? added.hash.toLowerCase() : null
    if (!infoHash) throw new Error('Backend did not return a torrent hash')

    if (!preparationIsCurrent(generation)) {
      await deleteTorrentAndData(infoHash).catch(error => console.error('[Player cleanup]', error))
      return
    }

    const source = `${BACKEND_BASE_URL}/api/torrents/stream/${encodeURIComponent(infoHash)}`
    playerSession = {
      ...playerSession,
      source,
      infoHash,
    }
    sendToPlayerRenderer('player:session', playerSession)
    setPlayerPreparation({
      stage: 'metadata',
      ready: false,
      message: 'Acquiring torrent metadata…',
      infoHash,
      error: null,
    })

    await monitorTorrentPreparation(infoHash, source, generation)
  } catch (error) {
    if (!preparationIsCurrent(generation)) return

    const cleanupHash = playerSession?.infoHash || expectedHash
    if (cleanupHash) {
      await deleteTorrentAndData(cleanupHash).catch(cleanupError => {
        console.error('[Player cleanup after preparation failure]', cleanupError)
      })
    }

    setPlayerPreparation({
      stage: 'error',
      ready: false,
      message: 'Unable to prepare this source',
      error: error instanceof Error ? error.message : String(error),
    })
  }
}

async function openPreparingPlayerSession(payload) {
  if (playerSession) throw new Error('A player session is already open')
  await createPlayerWindows()
  await mpv.stop({ graceful: false })

  const generation = ++playerPreparationGeneration
  const directSource = typeof payload.torrentSource === 'string' ? payload.torrentSource : ''
  const expectedHash = payload.infoHash || payload.expectedHash || (directSource ? extractBtih(directSource) : null) || null

  playerSession = {
    source: payload.source || null,
    title: payload.title || null,
    infoHash: expectedHash,
    filePath: payload.filePath || null,
    mediaItem: payload.mediaItem || null,
    openedAt: new Date().toISOString(),
  }

  playerPreparation = defaultPlayerPreparation()
  setPlayerPreparation({
    stage: payload.infoHash ? 'metadata' : 'adding',
    ready: false,
    message: payload.infoHash ? 'Checking stream readiness…' : 'Adding torrent…',
    infoHash: expectedHash,
  })

  setPlayerWindowTitle(playerSession.title)
  sendToPlayerRenderer('player:session', playerSession)
  showPlayerShell()
  return generation
}

async function openTorrentSession(payload, { allowDirectSource = false } = {}) {
  const releaseRef = typeof payload?.releaseRef === 'string' ? payload.releaseRef.trim() : ''
  const torrentSource = typeof payload?.torrentSource === 'string' ? payload.torrentSource.trim() : ''
  if (!releaseRef && !(allowDirectSource && torrentSource.toLowerCase().startsWith('magnet:?'))) {
    throw new Error('player.openTorrent requires a backend-issued release reference')
  }

  const normalizedPayload = { ...payload, releaseRef, torrentSource: allowDirectSource ? torrentSource : '' }
  const generation = await openPreparingPlayerSession(normalizedPayload)
  void runTorrentAddAndPreparation(normalizedPayload, generation)
  return {
    session: playerSession,
    state: mpv.getState(),
    preparation: { ...playerPreparation },
  }
}

async function openExistingTorrentSession(payload) {
  if (!payload || typeof payload.source !== 'string' || !payload.source.trim()) {
    throw new Error('Existing torrent playback requires a stream source')
  }
  if (!payload.infoHash) throw new Error('Existing torrent playback requires an info hash')

  const generation = await openPreparingPlayerSession(payload)
  void monitorTorrentPreparation(payload.infoHash.toLowerCase(), payload.source, generation)
  return {
    session: playerSession,
    state: mpv.getState(),
    preparation: { ...playerPreparation },
  }
}

async function openPlayerSession(payload) {
  if (!payload || typeof payload.source !== 'string' || !payload.source.trim()) {
    throw new Error('player.open requires a non-empty source')
  }
  if (playerSession) throw new Error('A player session is already open')

  await createPlayerWindows()
  ++playerPreparationGeneration
  playerPreparation = defaultPlayerPreparation()
  setPlayerPreparation({ stage: 'ready', ready: true, message: 'Playing' })

  playerSession = {
    source: payload.source,
    title: payload.title || null,
    infoHash: payload.infoHash || null,
    filePath: payload.filePath || null,
    mediaItem: payload.mediaItem || null,
    openedAt: new Date().toISOString(),
  }

  setPlayerWindowTitle(playerSession.title)
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.hide()
  syncPlayerOverlayBounds()
  sendToPlayerRenderer('player:session', playerSession)

  try {
    showPlayerVideoWindowFromLaunchState()
    await new Promise(resolve => setTimeout(resolve, 100))
    await mpv.start(playerVideoWindow, payload.source)

    if (playerOverlayWindow && !playerOverlayWindow.isDestroyed()) {
      syncPlayerOverlayBounds()
      playerOverlayWindow.show()
      playerOverlayWindow.focus()
    }

    return { session: playerSession, state: mpv.getState(), preparation: { ...playerPreparation } }
  } catch (error) {
    sendToPlayerRenderer('player:state', {
      ...mpv.getState(),
      status: 'error',
      error: error.message,
    })
    throw error
  }
}

async function releaseSubtitleToken(token) {
  if (!token) return
  try {
    await backendJson(`/api/subtitles/file/${encodeURIComponent(token)}`, { method: 'DELETE' }, 3000)
  } catch (error) {
    // Subtitle payloads live only in the backend's in-memory cache and expire on
    // their own. Cleanup is best-effort so a provider/backend hiccup never blocks
    // closing the native player.
    console.warn('[Subtitle cleanup]', error?.message || error)
  }
}

function isLoopbackHostname(hostname) {
  const normalized = String(hostname || '').toLowerCase().replace(/^\[|\]$/gu, '')
  return normalized === '127.0.0.1' || normalized === 'localhost' || normalized === '::1'
}

function effectiveUrlPort(url) {
  if (url.port) return url.port
  if (url.protocol === 'http:') return '80'
  if (url.protocol === 'https:') return '443'
  return ''
}

function validateLocalSubtitleAction(action) {
  const token = typeof action?.token === 'string' ? action.token.trim() : ''
  if (!token) throw new Error('Subtitle token is required')
  if (typeof action?.path !== 'string' || !action.path.trim()) {
    throw new Error('Subtitle path is required')
  }

  let subtitleUrl
  let backendUrl
  try {
    subtitleUrl = new URL(action.path)
    backendUrl = new URL(BACKEND_BASE_URL)
  } catch (_) {
    throw new Error('Subtitle URL is invalid')
  }

  if (
    !isLoopbackHostname(subtitleUrl.hostname) ||
    !isLoopbackHostname(backendUrl.hostname) ||
    subtitleUrl.protocol !== backendUrl.protocol ||
    effectiveUrlPort(subtitleUrl) !== effectiveUrlPort(backendUrl) ||
    subtitleUrl.username ||
    subtitleUrl.password ||
    subtitleUrl.search ||
    subtitleUrl.hash
  ) {
    throw new Error('Subtitle URL must use the local NetWatch backend')
  }

  const prefix = '/api/subtitles/file/'
  if (!subtitleUrl.pathname.startsWith(prefix)) {
    throw new Error('Subtitle URL must use the NetWatch subtitle endpoint')
  }
  const encodedToken = subtitleUrl.pathname.slice(prefix.length)
  if (!encodedToken || encodedToken.includes('/')) {
    throw new Error('Subtitle URL contains an invalid token')
  }

  let pathToken
  try {
    pathToken = decodeURIComponent(encodedToken)
  } catch (_) {
    throw new Error('Subtitle URL contains an invalid token')
  }
  if (pathToken !== token) throw new Error('Subtitle URL token does not match the active subtitle')

  return { ...action, path: subtitleUrl.toString(), token }
}

async function executePlayerCommand(action) {
  if (!action || typeof action.type !== 'string') return mpv.execute(action)

  if (action.type === 'loadSubtitle') {
    const validatedAction = validateLocalSubtitleAction(action)
    const newToken = validatedAction.token
    const previousToken = activeSubtitleToken
    try {
      const result = await mpv.execute(validatedAction)
      activeSubtitleToken = newToken
      if (previousToken && previousToken !== newToken) void releaseSubtitleToken(previousToken)
      return result
    } catch (error) {
      if (newToken) void releaseSubtitleToken(newToken)
      throw error
    }
  }

  if (action.type === 'disableSubtitles') {
    const previousToken = activeSubtitleToken
    const result = await mpv.execute(action)
    activeSubtitleToken = null
    if (previousToken) void releaseSubtitleToken(previousToken)
    return result
  }

  return mpv.execute(action)
}

async function closePlayerSession() {
  if (closingPlayer) return
  closingPlayer = true
  ++playerPreparationGeneration
  const closingSession = playerSession

  try {
    if (playerSurfaceSyncTimer) {
      clearTimeout(playerSurfaceSyncTimer)
      playerSurfaceSyncTimer = null
    }

    if (playerOverlayWindow && !playerOverlayWindow.isDestroyed()) playerOverlayWindow.hide()
    if (playerVideoWindow && !playerVideoWindow.isDestroyed()) playerVideoWindow.hide()

    await mpv.stop()

    const subtitleToken = activeSubtitleToken
    activeSubtitleToken = null
    if (subtitleToken) await releaseSubtitleToken(subtitleToken)

    if (closingSession?.infoHash) {
      try {
        await deleteTorrentAndData(closingSession.infoHash)
      } catch (error) {
        console.error('[Player cleanup]', error)
        sendToPlayerRenderer('player:log', {
          level: 'error',
          message: `Torrent cleanup failed: ${error.message}`,
          timestamp: new Date().toISOString(),
        })
      }
    }

    playerSession = null
    playerPreparation = defaultPlayerPreparation()
    sendToPlayerRenderer('player:session', null)
    sendToPlayerRenderer('player:preparation', { ...playerPreparation })

    const overlay = playerOverlayWindow
    const video = playerVideoWindow
    playerOverlayWindow = null
    playerVideoWindow = null

    if (overlay && !overlay.isDestroyed()) overlay.destroy()
    if (video && !video.isDestroyed()) video.destroy()

    if (!quittingApp && mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.show()
      mainWindow.focus()
    }
  } finally {
    closingPlayer = false
  }
}

async function quitAppFromPlayer() {
  if (quittingApp || quitCleanupComplete) return
  quittingApp = true

  try {
    if (playerSession && !closingPlayer) await closePlayerSession()
  } finally {
    // closePlayerSession already stops mpv and removes torrent data. Mark that
    // cleanup complete before app.quit() so before-quit does not start it again.
    quitCleanupComplete = true
    if (backendProcess) backendProcess.kill()
    stopOwnedVite()
    app.quit()
  }
}

async function setPlayerFullscreen(enabled) {
  if (!playerVideoWindow || playerVideoWindow.isDestroyed()) return false
  playerVideoWindow.setFullScreen(Boolean(enabled))
  setTimeout(syncPlayerOverlayBounds, 50)
  schedulePlayerVideoSurfaceSync(100)
  const fullscreen = playerVideoWindow.isFullScreen()
  if (fullscreen) restoreFullscreenPlayerForeground(50)
  sendToPlayerRenderer('player:window-state', {
    fullscreen,
    maximized: playerVideoWindow.isMaximized(),
  })
  return fullscreen
}

mpv.on('state', state => sendToPlayerRenderer('player:state', state))
mpv.on('log', entry => sendToPlayerRenderer('player:log', entry))

app.whenReady().then(async () => {
  await registerAppProtocol()
  hardenDefaultSession()
  // Player-core smoke mode remains independent of the main GUI/orchestrator.
  // Existing smoke scripts can keep owning Vite/Docker exactly as before.
  // The torrent-source variant exercises the exact production lifecycle: open
  // the player shell first, then let Electron add/monitor/clean the torrent.
  if (isDev && process.env.NETWATCH_PLAYER_TEST_TORRENT_SOURCE) {
    try {
      await openTorrentSession({
        torrentSource: process.env.NETWATCH_PLAYER_TEST_TORRENT_SOURCE,
        expectedHash: process.env.NETWATCH_PLAYER_TEST_EXPECTED_HASH || null,
        title: process.env.NETWATCH_PLAYER_TEST_TITLE || 'NetWatch torrent player test',
        mediaName: process.env.NETWATCH_PLAYER_TEST_TITLE || 'NetWatch torrent player test',
      }, { allowDirectSource: true })
    } catch (error) {
      console.error('[Player torrent test]', error)
      app.quit()
    }
    return
  }

  // Existing-stream smoke mode is retained for low-level player regression tests.
  if (isDev && process.env.NETWATCH_PLAYER_TEST_SOURCE) {
    try {
      const infoHash = process.env.NETWATCH_PLAYER_TEST_INFO_HASH || null
      if (infoHash) {
        await openExistingTorrentSession({
          source: process.env.NETWATCH_PLAYER_TEST_SOURCE,
          title: process.env.NETWATCH_PLAYER_TEST_TITLE || 'NetWatch torrent player test',
          infoHash,
        })
      } else {
        await openPlayerSession({
          source: process.env.NETWATCH_PLAYER_TEST_SOURCE,
          title: process.env.NETWATCH_PLAYER_TEST_TITLE || 'NetWatch native player test',
        })
      }
    } catch (error) {
      console.error('[Player test]', error)
      app.quit()
    }
    return
  }

  try {
    // A packaged build first installs/synchronizes its clean runtime template
    // into the user's WSL data directory. Private config and Prowlarr state live
    // outside that immutable runtime and survive application upgrades. Incomplete
    // private configuration is handled by the hardened first-run windows rather
    // than by a manual-file startup error.
    if (app.isPackaged) {
      const packaged = await ensurePackagedRuntime()
      if (await beginPackagedFirstRun(packaged.setupState)) return
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
    createStartupErrorWindow(error)
  }
})

app.on('before-quit', event => {
  if (quitCleanupComplete) {
    closingPlayer = true
    void mpv.stop({ graceful: false })
    if (backendProcess) backendProcess.kill()
    stopOwnedVite()
    return
  }

  if (playerSession && !closingPlayer) {
    event.preventDefault()
    quittingApp = true
    void closePlayerSession().finally(() => {
      quitCleanupComplete = true
      if (backendProcess) backendProcess.kill()
      stopOwnedVite()
      app.quit()
    })
    return
  }

  quitCleanupComplete = true
  closingPlayer = true
  void mpv.stop({ graceful: false })
  if (backendProcess) backendProcess.kill()
  stopOwnedVite()
})

app.on('window-all-closed', () => {
  if (backendProcess) backendProcess.kill()
  stopOwnedVite()
  if (process.platform !== 'darwin') app.quit()
})

// Main application window controls. Every channel is authorized against the
// exact top-level renderer that owns the capability.
ipcMain.on('window:minimize', event => { assertMainRendererSender(event); mainWindow?.minimize() })
ipcMain.on('window:maximize', event => { assertMainRendererSender(event); if (mainWindow) (mainWindow.isMaximized() ? mainWindow.unmaximize() : mainWindow.maximize()) })
ipcMain.on('window:close', event => { assertMainRendererSender(event); mainWindow?.close() })


ipcMain.handle('runtime:get-status', event => { assertMainRendererSender(event); return { ...runtimeStatus, services: { ...runtimeStatus.services } } })
ipcMain.handle('runtime:retry', event => { assertMainRendererSender(event); return retryRuntime() })
ipcMain.handle('runtime:vpn-sanity', event => { assertMainRendererSender(event); return vpnSanityCheck() })
ipcMain.handle('runtime:get-credential-status', async event => {
  assertMainRendererSender(event)
  return credentialStatusForRenderer()
})
ipcMain.handle('runtime:set-subtitle-credential', async (event, provider, candidate) => {
  assertMainRendererSender(event)
  return saveOptionalSubtitleCredential(provider, candidate)
})
ipcMain.handle('runtime:open-credential-site', async (event, provider) => {
  assertMainRendererSender(event)
  if (!OPTIONAL_SUBTITLE_PROVIDERS.has(provider) || !CREDENTIAL_SITES[provider]) throw new Error('Unknown credential site.')
  await shell.openExternal(CREDENTIAL_SITES[provider])
  return { opened: true }
})
ipcMain.handle('runtime:get-vpn-profile', async event => {
  assertMainRendererSender(event)
  return vpnProfileForRenderer()
})
ipcMain.handle('runtime:set-vpn-profile-type', async (event, profileType) => {
  assertMainRendererSender(event)
  return setVpnProfileType(profileType)
})
ipcMain.handle('runtime:replace-wireguard', async (event, profileType) => {
  assertMainRendererSender(event)
  const result = await chooseAndImportWireGuard(mainWindow, profileType, { confirmReplace: true, stageOnly: true })
  if (result.cancelled) return { cancelled: true, profile: await vpnProfileForRenderer(), restart_required: false }
  await logSetupEvent('WG_CONFIG_VALIDATED')
  await logSetupEvent('CONFIG_PERMISSIONS_VERIFIED')
  return { cancelled: false, profile: { ...(result.profile || await vpnProfileForRenderer()), replacement_pending: true }, restart_required: true }
})
ipcMain.handle('runtime:open-vpnbook', async event => {
  assertMainRendererSender(event)
  await shell.openExternal(VPNBOOK_REFRESH_URL)
  return { opened: true }
})
ipcMain.handle('runtime:restart-app', event => {
  assertMainRendererSender(event)
  app.relaunch()
  app.quit()
  return { restarting: true }
})

// Native mpv player control. Opening a torrent belongs to the main renderer;
// controls for an existing session belong only to the player overlay renderer.
ipcMain.handle('player:open-torrent', (event, payload) => { assertMainRendererSender(event); return openTorrentSession(payload) })
ipcMain.handle('player:get-session', event => { assertPlayerRendererSender(event); return playerSession })
ipcMain.handle('player:get-state', event => { assertPlayerRendererSender(event); return mpv.getState() })
ipcMain.handle('player:get-preparation', event => { assertPlayerRendererSender(event); return { ...playerPreparation } })
ipcMain.handle('player:command', (event, action) => { assertPlayerRendererSender(event); return executePlayerCommand(action) })
ipcMain.handle('player:close', event => { assertPlayerRendererSender(event); return closePlayerSession() })
ipcMain.handle('player:set-fullscreen', (event, enabled) => { assertPlayerRendererSender(event); return setPlayerFullscreen(enabled) })
ipcMain.handle('player:toggle-fullscreen', event => { assertPlayerRendererSender(event); return setPlayerFullscreen(!(playerVideoWindow?.isFullScreen() || false)) })
ipcMain.handle('player:get-window-state', event => {
  assertPlayerRendererSender(event)
  return {
    fullscreen: Boolean(playerVideoWindow?.isFullScreen()),
    maximized: Boolean(playerVideoWindow?.isMaximized()),
  }
})
