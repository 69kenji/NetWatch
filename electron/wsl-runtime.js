'use strict'

const { app, dialog } = require('electron')
const { spawn } = require('child_process')
const fs = require('fs')
const path = require('path')
const { composeRuntimeEnvironment } = require('./resource-profile')
const { normalizeVpnProfileType, wireGuardFileTimestamps } = require('./vpn-profile')
const { cleanWslOutput, runProcess, sleep } = require('./process-utils')

function createWslRuntime({ appSettings, backendJson, getRuntimeStatus, setRuntimeStatus }) {
  if (!appSettings || typeof backendJson !== 'function' || typeof getRuntimeStatus !== 'function' || typeof setRuntimeStatus !== 'function') {
    throw new Error('WSL runtime dependencies are invalid')
  }

  let packagedWslLocation = null
  let packagedRuntimeContext = null
  let packagedRuntimeUpdated = false

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
  
  function composeCommandArgsFor(settings, ...args) {
    const compose = ['docker', 'compose', '-f', composeFilePath()]
    if (settings.flareSolverrEnabled) compose.push('--profile', 'flaresolverr')
    return ['env', ...composeRuntimeEnvironment(settings), ...compose, ...args]
  }
  
  function composeCommandArgs(...args) {
    return composeCommandArgsFor(appSettings.get(), ...args)
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
    repairArgs.push('vpn', 'torrent-engine', 'prowlarr')
    if (appSettings.get().flareSolverrEnabled) repairArgs.push('flaresolverr')
    repairArgs.push('backend')
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
    if (!getRuntimeStatus().ready) {
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

  return {
    chooseAndImportWireGuard,
    composeCommandArgs,
    composeCommandArgsFor,
    containerHealth,
    ensurePackagedRuntime,
    inspectSecureSetupState,
    isPackagedRuntimeUpdated: () => packagedRuntimeUpdated,
    launchDockerDesktopIfPresent,
    logSetupEvent,
    runWsl,
    secureConfigAction,
    startComposeWithVpnSelfHeal,
    verifyVpnIsolation,
    vpnSanityCheck,
    waitForContainerHealthy,
    waitForDocker,
  }
}

module.exports = { createWslRuntime }
