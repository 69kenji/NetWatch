const { app, dialog } = require('electron')
const crypto = require('crypto')
const path = require('path')
const fs = require('fs')
const { RemoteGatewayController } = require('./remote-gateway-controller')
const { AppSettingsStore, atomicJson } = require('./app-settings-store')
const { CACHE_VERSION, DISMISSED_LIMIT, EPISODE_PROGRESS_LIMIT, KeepWatchingStore, normalizeCatalogId, normalizeRecord } = require('./keep-watching-store')
const { ProfileStore } = require('./profile-store')
const { HISTORY_LIMIT, HISTORY_VERSION, ViewingHistoryStore, normalizeEntry } = require('./viewing-history-store')
const { createBackendJson } = require('./backend-client')
const { createPlayerSessionController } = require('./player-session-controller')
const { loadPlaybackOwnerToken } = require('./playback-owner-token')
const { createWslRuntime } = require('./wsl-runtime')
const { createSetupController } = require('./setup-controller')
const { createRuntimeController } = require('./runtime-controller')
const { createSettingsController } = require('./settings-controller')
const { createDesktopShell, registerAppScheme } = require('./desktop-shell')
const { registerApplicationIpc } = require('./ipc-registration')
const { LocalLibrary } = require('./local-library')
const { registerLocalLibraryIpc } = require('./local-library-ipc')
const { createAppearanceController } = require('./appearance-controller')
const { createDataBackupController, normalizeLocalProfiles } = require('./data-backup-controller')
const { createUpdateController } = require('./update-controller')
const { importImage, inspectImage, readBounded } = require('./background-image')

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
let appearanceController = null
let updateController = null

const userDataPath = app.getPath('userData')
const playbackOwnerToken = loadPlaybackOwnerToken(path.join(userDataPath, 'playback-owner-v1.json'))
const appSettings = new AppSettingsStore(path.join(userDataPath, 'app-settings-v1.json'))
const profiles = new ProfileStore(path.join(userDataPath, 'profiles-v1.json'), appSettings.get())
const profilesAvailable = profiles.isWritable()
if (profilesAvailable) appSettings.attachProfileStore(profiles)
const initialProfileState = profilesAvailable ? profiles.state() : null
const localLibrary = new LocalLibrary(path.join(userDataPath, 'local-library-v1.json'), backendJson)
const profileAvatarDirectory = path.join(userDataPath, 'profile-avatars')
const PROFILE_EXPORT_VERSION = 1
const PROFILE_EXPORT_LIMIT = 64 * 1024 * 1024

function keepWatchingPath(profileId) {
  return path.join(userDataPath, 'profiles', profileId, 'keep-watching-v1.json')
}

function viewingHistoryPath(profileId) {
  return path.join(userDataPath, 'profiles', profileId, 'viewing-history-v1.json')
}

function normalizedRecords(values, limit, tvOnly = false) {
  if (!Array.isArray(values) || values.length > limit) throw new Error('Profile playback data is invalid.')
  const records = values.map(normalizeRecord)
  if (records.some(item => !item || (tvOnly && !item.catalog_id.startsWith('tv:')))) throw new Error('Profile playback data is invalid.')
  return records
}

function normalizedDismissed(values) {
  if (values === undefined) return []
  if (!Array.isArray(values) || values.length > DISMISSED_LIMIT) throw new Error('Profile playback data is invalid.')
  const result = [...new Set(values.map(normalizeCatalogId))]
  if (result.some(id => !id?.startsWith('tv:'))) throw new Error('Profile playback data is invalid.')
  return result
}

function readProfileExport(filePath) {
  const info = fs.lstatSync(filePath)
  if (!info.isFile() || info.isSymbolicLink() || info.size < 2 || info.size > PROFILE_EXPORT_LIMIT) throw new Error('Choose a NetWatch profile under 64 MB.')
  const value = JSON.parse(fs.readFileSync(filePath, 'utf8'))
  if (value?.format !== 'netwatch-profile' || value.version !== PROFILE_EXPORT_VERSION || !value.profile) throw new Error('This profile file is not supported.')
  const localProfile = normalizeLocalProfiles({ imported: value.localProfile || {} }, ['imported']).imported
  const items = normalizedRecords(value.keepWatching?.items || [], 20)
  const episodeProgress = normalizedRecords(value.keepWatching?.episodeProgress || [], EPISODE_PROGRESS_LIMIT, true)
  const dismissed = normalizedDismissed(value.keepWatching?.dismissed)
  if (!Array.isArray(value.history?.entries) || value.history.entries.length > HISTORY_LIMIT) throw new Error('Profile viewing history is invalid.')
  const history = value.history.entries.map(normalizeEntry)
  if (history.some(entry => !entry)) throw new Error('Profile viewing history is invalid.')
  let avatar = null
  if (value.avatar !== null && value.avatar !== undefined) {
    if (typeof value.avatar !== 'string' || value.avatar.length > 28_000_000) throw new Error('Profile picture is invalid.')
    avatar = Buffer.from(value.avatar, 'base64')
    inspectImage(avatar, '.png')
  }
  return { profile: value.profile, localProfile, items, episodeProgress, dismissed, history, avatar }
}

function pruneDeletedProfileFiles(liveProfileIds) {
  const profilesPath = path.join(userDataPath, 'profiles')
  const live = new Set(liveProfileIds)
  let entries = []
  try { entries = fs.readdirSync(profilesPath, { withFileTypes: true }) } catch (error) {
    if (error?.code !== 'ENOENT') console.warn('[Profiles] Profile data directory could not be inspected:', error?.message || error)
    return
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^[0-9a-f]{32}$/u.test(entry.name) || live.has(entry.name)) continue
    const directory = path.join(profilesPath, entry.name)
    try { fs.rmSync(directory, { recursive: true, force: true }) } catch (error) {
      if (error?.code !== 'ENOENT' && error?.code !== 'ENOTEMPTY') console.warn('[Profiles] Empty profile directory could not be removed:', error?.message || error)
    }
  }
}

function pruneProfileAvatars() {
  const live = new Set(profiles.value.profiles.map(profile => profile.avatar.startsWith('image:') ? `${profile.avatar.slice(6)}.png` : null).filter(Boolean))
  let entries = []
  try { entries = fs.readdirSync(profileAvatarDirectory, { withFileTypes: true }) } catch (error) {
    if (error?.code !== 'ENOENT') console.warn('[Profiles] Profile pictures could not be inspected:', error?.message || error)
    return
  }
  for (const entry of entries) {
    if (!entry.isFile() || !/^[0-9a-f]{32}\.png$/u.test(entry.name) || live.has(entry.name)) continue
    try { fs.unlinkSync(path.join(profileAvatarDirectory, entry.name)) } catch (error) {
      if (error?.code !== 'ENOENT') console.warn('[Profiles] Unused profile picture could not be removed:', error?.message || error)
    }
  }
}

function migrateLegacyKeepWatching() {
  if (!initialProfileState || !initialProfileState.profiles.some(profile => profile.id === initialProfileState.initialId)) return
  const legacyPath = path.join(userDataPath, 'keep-watching-v1.json')
  const targetPath = keepWatchingPath(initialProfileState.initialId)
  if (!fs.existsSync(legacyPath) || fs.existsSync(targetPath)) return
  try {
    fs.mkdirSync(path.dirname(targetPath), { recursive: true, mode: 0o700 })
    fs.renameSync(legacyPath, targetPath)
  } catch (error) {
    console.warn('[Profiles] Existing Keep Watching data could not be migrated:', error?.message || error)
  }
}

migrateLegacyKeepWatching()
if (initialProfileState) pruneDeletedProfileFiles(initialProfileState.profiles.map(profile => profile.id))
if (initialProfileState) pruneProfileAvatars()
const keepWatching = new KeepWatchingStore(
  initialProfileState ? keepWatchingPath(initialProfileState.activeId) : path.join(userDataPath, 'keep-watching-v1.json'),
  () => appSettings.get(),
  () => sendKeepWatchingChanged(),
)
const viewingHistory = new ViewingHistoryStore(
  initialProfileState ? viewingHistoryPath(initialProfileState.activeId) : path.join(userDataPath, 'viewing-history-v1.json'),
  () => sendViewingHistoryChanged(),
)

const desktopShell = createDesktopShell({
  appSettings,
  isDev,
  lifecycle,
  onForegroundRequested: () => foregroundNetWatch(),
  useViteDevServer,
})

const player = createPlayerSessionController({
  localLibrary,
  backendBaseUrl: BACKEND_BASE_URL,
  backendJson,
  getAppSettings: () => appSettings.get(),
  saveAppSettings: patch => appSettings.update(patch),
  getMainWindow: () => desktopShell.getMainWindow(),
  hardenRendererNavigation: desktopShell.hardenRendererNavigation,
  isDev,
  keepWatching,
  viewingHistory,
  lifecycle,
  onQuitReady: async () => {
    runtimeController.stopDevelopmentServer()
    app.quit()
  },
  playerRendererUrl: desktopShell.playerRendererUrl,
  playbackOwnerToken,
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

function sendKeepWatchingChanged() {
  desktopShell.sendToMain('keep-watching:changed', {
    enabled: appSettings.get().keepWatchingEnabled,
    limit: appSettings.get().keepWatchingLimit,
    items: keepWatching.list(),
    episodeProgress: keepWatching.listEpisodeProgress(),
  })
}

function keepWatchingState() {
  const settings = appSettings.get()
  return {
    enabled: settings.keepWatchingEnabled,
    limit: settings.keepWatchingLimit,
    items: keepWatching.list(),
    episodeProgress: keepWatching.listEpisodeProgress(),
  }
}

function sendViewingHistoryChanged() {
  desktopShell.sendToMain('history:changed', viewingHistory.state())
}

function viewingHistoryState() {
  return viewingHistory.state()
}

function removeKeepWatchingItem(catalogId) {
  const removed = keepWatching.remove(catalogId)
  return { removed, state: keepWatchingState() }
}

function markEpisodeWatched(mediaItem, durationSeconds) {
  const marked = keepWatching.markEpisodeWatched(mediaItem, durationSeconds)
  if (marked) viewingHistory.markWatched(mediaItem, durationSeconds)
  return { marked, state: keepWatchingState() }
}

function removeEpisodeProgress(catalogId, season, episode) {
  const removed = keepWatching.removeEpisode(catalogId, season, episode)
  viewingHistory.removeManualEpisode(catalogId, season, episode)
  return { removed, state: keepWatchingState() }
}

function sendProfilesChanged() {
  appearanceController?.refresh()
  const state = profiles.state()
  desktopShell.sendToMain('profiles:changed', state)
  return state
}

const preparedProfileImports = new Map()

function discardActiveGuest() {
  try {
    const active = profiles.active()
    if (active.kind !== 'guest' || profiles.state().profiles.length < 2) return
    const state = profiles.delete(active.id)
    keepWatching.switchFile(keepWatchingPath(state.activeId))
    viewingHistory.switchFile(viewingHistoryPath(state.activeId))
    pruneDeletedProfileFiles(state.profiles.map(profile => profile.id))
    pruneProfileAvatars()
  } catch (error) {
    console.warn('[Profiles] Guest cleanup failed:', error?.message || error)
  }
}

const profileController = {
  state: () => profiles.state(),
  create: (name, kind) => {
    profiles.create(name, kind)
    return sendProfilesChanged()
  },
  rename: (id, name) => {
    profiles.rename(id, name)
    return sendProfilesChanged()
  },
  update: (id, patch) => {
    profiles.update(id, patch)
    pruneProfileAvatars()
    return sendProfilesChanged()
  },
  avatar: async id => {
    const profile = profiles.value.profiles.find(entry => entry.id === id)
    if (!profile || !profile.avatar.startsWith('image:')) return { data: null }
    try {
      const bytes = await readBounded(path.join(profileAvatarDirectory, `${profile.avatar.slice(6)}.png`))
      inspectImage(bytes, '.png')
      return { data: `data:image/png;base64,${bytes.toString('base64')}` }
    } catch { return { data: null } }
  },
  importAvatar: async id => {
    if (!profiles.value.profiles.some(entry => entry.id === id)) throw new Error('Profile was not found.')
    const selected = await dialog.showOpenDialog(desktopShell.getMainWindow(), {
      title: 'Choose profile picture', properties: ['openFile'],
      filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp'] }],
    })
    if (selected.canceled || selected.filePaths.length !== 1) return { cancelled: true, state: profiles.state() }
    const imageId = await importImage(selected.filePaths[0], profileAvatarDirectory)
    profiles.update(id, { avatar: `image:${imageId}` })
    pruneProfileAvatars()
    return { cancelled: false, state: sendProfilesChanged() }
  },
  exportProfile: async (id, localProfile) => {
    const state = profiles.state()
    const profile = profiles.value.profiles.find(entry => entry.id === id)
    if (!profile || id !== state.activeId) throw new Error('Open the profile before exporting it.')
    const local = normalizeLocalProfiles({ [id]: localProfile || {} }, [id])[id]
    let avatar = null
    if (profile.avatar.startsWith('image:')) {
      const bytes = await readBounded(path.join(profileAvatarDirectory, `${profile.avatar.slice(6)}.png`))
      inspectImage(bytes, '.png')
      avatar = bytes.toString('base64')
    }
    const chosen = await dialog.showSaveDialog(desktopShell.getMainWindow(), {
      title: `Export ${profile.name}`,
      defaultPath: `NetWatch-${profile.name.replace(/[^a-z0-9]+/giu, '-').replace(/^-|-$/gu, '') || 'profile'}.json`,
      filters: [{ name: 'NetWatch profile', extensions: ['json'] }],
    })
    if (chosen.canceled || !chosen.filePath) return { cancelled: true }
    const settings = {
      ...profile.settings,
      appearance: {
        ...profile.settings.appearance,
        background: { ...profile.settings.appearance.background, imageId: null },
      },
    }
    atomicJson(chosen.filePath, {
      format: 'netwatch-profile', version: PROFILE_EXPORT_VERSION, createdAt: new Date().toISOString(), sourceVersion: app.getVersion(),
      profile: { name: profile.name, tagline: profile.tagline, avatar: avatar ? 'embedded' : profile.avatar, kind: profile.kind, createdAt: profile.createdAt, settings },
      localProfile: local,
      keepWatching: { version: CACHE_VERSION, items: keepWatching.list(), episodeProgress: keepWatching.listEpisodeProgress(), dismissed: keepWatching.listDismissed() },
      history: { version: HISTORY_VERSION, entries: viewingHistory.state().entries },
      avatar,
    })
    return { cancelled: false, fileName: path.basename(chosen.filePath) }
  },
  importProfile: async () => {
    if (player.getSession()) throw new Error('Close the player before importing a profile.')
    const chosen = await dialog.showOpenDialog(desktopShell.getMainWindow(), {
      title: 'Choose NetWatch profile', properties: ['openFile', 'dontAddToRecent'],
      filters: [{ name: 'NetWatch profile', extensions: ['json'] }],
    })
    if (chosen.canceled || chosen.filePaths.length !== 1) return { cancelled: true, state: profiles.state() }
    const imported = readProfileExport(chosen.filePaths[0])
    const token = crypto.randomBytes(24).toString('hex')
    preparedProfileImports.clear()
    preparedProfileImports.set(token, { imported, expires: Date.now() + 10 * 60 * 1000 })
    return {
      cancelled: false, token, state: profiles.state(), preview: {
        name: imported.profile.name, historyCount: imported.history.length,
        progressCount: imported.episodeProgress.length, listCount: Object.keys(imported.localProfile || {}).length,
        hasAvatar: Boolean(imported.avatar),
      },
    }
  },
  commitProfileImport: async (token, selection) => {
    if (player.getSession()) throw new Error('Close the player before importing a profile.')
    const pending = preparedProfileImports.get(token)
    preparedProfileImports.delete(token)
    if (!pending || pending.expires < Date.now()) throw new Error('The profile import expired. Choose the file again.')
    const imported = pending.imported
    let created = null, avatarId = null
    try {
      if (imported.avatar) {
        avatarId = crypto.randomBytes(16).toString('hex')
        fs.mkdirSync(profileAvatarDirectory, { recursive: true, mode: 0o700 })
        fs.writeFileSync(path.join(profileAvatarDirectory, `${avatarId}.png`), imported.avatar, { flag: 'wx', mode: 0o600 })
      }
      const result = profiles.importProfile({ ...imported.profile, avatar: avatarId ? `image:${avatarId}` : imported.profile.avatar })
      created = result.profile.id
      const includeProgress = selection?.progress !== false
      const includeHistory = selection?.history !== false
      atomicJson(keepWatchingPath(created), {
        version: CACHE_VERSION,
        items: includeProgress ? imported.items : [],
        episodeProgress: includeProgress ? imported.episodeProgress : [],
        dismissed: includeProgress ? imported.dismissed : [],
      })
      atomicJson(viewingHistoryPath(created), { version: HISTORY_VERSION, entries: includeHistory ? imported.history : [] })
      pruneProfileAvatars()
      return { cancelled: false, profileId: created, localProfile: imported.localProfile, state: sendProfilesChanged() }
    } catch (error) {
      if (created) {
        try { profiles.delete(created) } catch (rollbackError) { console.error('[Profiles] Import rollback failed:', rollbackError) }
        pruneDeletedProfileFiles(profiles.state().profiles.map(profile => profile.id))
      }
      if (avatarId) try { fs.unlinkSync(path.join(profileAvatarDirectory, `${avatarId}.png`)) } catch {}
      throw error
    }
  },
  cancelProfileImport: token => preparedProfileImports.delete(token),
  switch: id => {
    if (player.getSession()) throw new Error('Close the player before switching profiles.')
    const previous = profiles.active()
    let state = profiles.switch(id)
    if (previous.kind === 'guest' && previous.id !== state.activeId) {
      state = profiles.delete(previous.id)
    }
    if (state.activeId !== previous.id) {
      keepWatching.switchFile(keepWatchingPath(state.activeId))
      viewingHistory.switchFile(viewingHistoryPath(state.activeId))
      sendKeepWatchingChanged()
      sendViewingHistoryChanged()
    }
    pruneDeletedProfileFiles(state.profiles.map(profile => profile.id))
    pruneProfileAvatars()
    return sendProfilesChanged()
  },
  delete: id => {
    if (player.getSession()) throw new Error('Close the player before deleting a profile.')
    const previousId = profiles.state().activeId
    const state = profiles.delete(id)
    if (state.activeId !== previousId) {
      keepWatching.switchFile(keepWatchingPath(state.activeId))
      viewingHistory.switchFile(viewingHistoryPath(state.activeId))
      sendKeepWatchingChanged()
      sendViewingHistoryChanged()
    }
    pruneDeletedProfileFiles(state.profiles.map(profile => profile.id))
    pruneProfileAvatars()
    return sendProfilesChanged()
  },
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
  if (!desktopShell.getMainWindow() || desktopShell.getMainWindow().isDestroyed()) {
    desktopShell.createMainWindow({ show: !desktopShell.shouldStartMinimized() })
  }
  desktopShell.createTray()
  updateController?.startNotifications()
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
  applyLoginItemSettings: desktopShell.syncLoginItemSettings,
  backendBaseUrl: BACKEND_BASE_URL,
  getMainWindow: () => desktopShell.getMainWindow(),
  getRuntimeStatus: () => runtimeStatus,
  keepWatching,
  setRuntimeStatus,
  wslRuntime,
})

updateController = createUpdateController({ appSettings, desktopShell })
const backupController = createDataBackupController({
  appSettings,
  desktopShell,
  keepWatchingPath,
  player,
  profiles,
  onRestored: async () => {
    const state = profiles.state()
    keepWatching.switchFile(keepWatchingPath(state.activeId))
    viewingHistory.switchFile(viewingHistoryPath(state.activeId))
    pruneDeletedProfileFiles(state.profiles.map(profile => profile.id))
    desktopShell.syncLoginItemSettings()
    sendProfilesChanged()
    sendKeepWatchingChanged()
    sendViewingHistoryChanged()
  },
})


registerLocalLibraryIpc({ library: localLibrary, player, desktopShell, backendJson })

registerApplicationIpc({
  appearanceChanged: () => appearanceController?.refresh(),
  appSettings,
  backupController,
  credentialSites: CREDENTIAL_SITES,
  desktopShell,
  getRemoteGateway: () => remoteGateway,
  getRuntimeStatus: () => runtimeStatus,
  keepWatchingState,
  markEpisodeWatched,
  removeKeepWatchingItem,
  removeEpisodeProgress,
  optionalSubtitleProviders: OPTIONAL_SUBTITLE_PROVIDERS,
  player,
  profileController,
  runtimeController,
  settingsController,
  setupController,
  updateController,
  viewingHistory,
  viewingHistoryState,
  wslRuntime,
})

app.whenReady().then(async () => {
  appearanceController = createAppearanceController({ appSettings, profiles, desktopShell, player, setupController })
  await appearanceController.cleanup()
  await desktopShell.registerAppProtocol()
  desktopShell.hardenDefaultSession()
  try {
    desktopShell.syncLoginItemSettings()
  } catch (error) {
    console.warn('[Startup] Could not synchronize the Windows login item:', error)
  }
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
      discardActiveGuest()
      lifecycle.quitCleanupComplete = true
      void remoteGateway?.stopChild()
      runtimeController.stopDevelopmentServer()
      app.quit()
    })
    return
  }

  discardActiveGuest()
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
