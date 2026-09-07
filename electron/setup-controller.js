'use strict'

const { app, BrowserWindow, ipcMain, session, shell } = require('electron')
const path = require('path')
const { pathToFileURL } = require('url')
const { httpOk, waitForHttp } = require('./process-utils')
const { VPNBOOK_REFRESH_URL, normalizeVpnProfileType } = require('./vpn-profile')

function createSetupController({
  assertWindowSender,
  backendBaseUrl,
  backendJson,
  credentialSites,
  getMainWindow,
  hardenRendererNavigation,
  isDev,
  lifecycle,
  onStartNormalDesktop,
  optionalSubtitleProviders,
  useViteDevServer,
  wslRuntime,
}) {
  if (typeof assertWindowSender !== 'function' || !backendBaseUrl || typeof backendJson !== 'function' || !wslRuntime) {
    throw new Error('Setup controller dependencies are invalid')
  }

  const {
    chooseAndImportWireGuard,
    composeCommandArgs,
    inspectSecureSetupState,
    launchDockerDesktopIfPresent,
    logSetupEvent,
    runWsl,
    secureConfigAction,
    verifyVpnIsolation,
    waitForDocker,
  } = wslRuntime
  let setupWindow = null
  let prowlarrSetupWindow = null
  let setupVpnVerified = false
  let firstRunTransitionPromise = null

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
    if (!optionalSubtitleProviders.has(provider)) throw new Error('Unsupported optional credential provider.')
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
    const ready = await waitForHttp(`${backendBaseUrl}/api/health`, 90_000, 400)
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
    if (app.isPackaged && wslRuntime.isPackagedRuntimeUpdated()) args.push('--build')
    args.push(...serviceNames)
    try {
      await runWsl(composeCommandArgs(...args), app.isPackaged && wslRuntime.isPackagedRuntimeUpdated() ? 600_000 : timeoutMs)
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
  
    const backendReady = await waitForHttp(`${backendBaseUrl}/api/health`, 120_000, 500)
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
    const ready = await waitForHttp(`${backendBaseUrl}/api/health`, 90_000, 400)
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
    const ready = await waitForHttp(`${backendBaseUrl}/api/health`, 90_000, 400)
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
      if (typeof site !== 'string' || !Object.prototype.hasOwnProperty.call(credentialSites, site)) {
        throw new Error('Unknown credential site.')
      }
      await shell.openExternal(credentialSites[site])
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
      if (!getMainWindow() && !prowlarrSetupWindow && !lifecycle.quittingApp) app.quit()
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
      if (!getMainWindow() && !setupWindow && !lifecycle.quittingApp) app.quit()
    })
    await prowlarrSetupWindow.loadURL(expectedUrl)
    prowlarrSetupWindow.show()
  }
  
  async function finishFirstRun() {
    if (firstRunTransitionPromise) return firstRunTransitionPromise
    firstRunTransitionPromise = (async () => {
      await onStartNormalDesktop()
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

  function getActiveWindow() {
    if (setupWindow && !setupWindow.isDestroyed()) return setupWindow
    if (prowlarrSetupWindow && !prowlarrSetupWindow.isDestroyed()) return prowlarrSetupWindow
    return null
  }

  return {
    beginPackagedFirstRun,
    credentialStatus: credentialStatusForRenderer,
    getActiveWindow,
    saveOptionalSubtitleCredential,
    setVpnProfileType,
    vpnProfile: vpnProfileForRenderer,
  }
}

module.exports = { createSetupController }
