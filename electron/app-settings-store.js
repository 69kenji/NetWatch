const fs = require('fs')
const path = require('path')
const { PLAYBACK_DEFAULTS, normalizePlaybackPreferences } = require('../shared/playback-preferences.mjs')
const { DEFAULT_APPEARANCE, normalizeAppearance } = require('../shared/appearance.mjs')

const SETTINGS_VERSION = 5
const GLOBAL_DEFAULTS = Object.freeze({
  onClose: 'exit',
  startWithWindows: false,
  startMinimized: false,
  updateNotifications: false,
  flareSolverrEnabled: false,
  resourceProfile: 'standard',
  playbackVolume: 100,
  playbackMuted: false,
})
const PROFILE_DEFAULTS = Object.freeze({
  appearance: DEFAULT_APPEARANCE,
  keepWatchingEnabled: true,
  keepWatchingLimit: 5,
  defaultQuality: 'all',
  alwaysSkipIntro: false,
  ...PLAYBACK_DEFAULTS,
})
const DEFAULT_APP_SETTINGS = Object.freeze({ version: SETTINGS_VERSION, ...GLOBAL_DEFAULTS, ...PROFILE_DEFAULTS })

const QUALITY_VALUES = new Set(['all', '2160p', '1080p', '720p'])

function atomicJson(filePath, value) {
  const directory = path.dirname(filePath)
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 })
  const temporary = `${filePath}.${process.pid}.${Date.now()}.tmp`
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
      flag: 'wx',
    })
    fs.renameSync(temporary, filePath)
  } finally {
    try { fs.unlinkSync(temporary) } catch (error) {
      if (error?.code !== 'ENOENT') throw error
    }
  }
}

function normalizeSettings(value, fallback = DEFAULT_APP_SETTINGS) {
  const candidate = value && typeof value === 'object' && !Array.isArray(value) ? value : {}
  const limit = Number(candidate.keepWatchingLimit)
  return {
    appearance: normalizeAppearance(candidate.appearance),
    ...normalizePlaybackPreferences(candidate, fallback),
    version: SETTINGS_VERSION,
    onClose: candidate.onClose === 'minimize-to-tray' || candidate.onClose === 'exit'
      ? candidate.onClose
      : fallback.onClose,
    startWithWindows: typeof candidate.startWithWindows === 'boolean'
      ? candidate.startWithWindows
      : fallback.startWithWindows,
    startMinimized: typeof candidate.startMinimized === 'boolean'
      ? candidate.startMinimized
      : fallback.startMinimized,
    updateNotifications: typeof candidate.updateNotifications === 'boolean'
      ? candidate.updateNotifications
      : fallback.updateNotifications,
    keepWatchingEnabled: typeof candidate.keepWatchingEnabled === 'boolean'
      ? candidate.keepWatchingEnabled
      : fallback.keepWatchingEnabled,
    keepWatchingLimit: Number.isInteger(limit) && limit >= 1 && limit <= 20
      ? limit
      : fallback.keepWatchingLimit,
    defaultQuality: QUALITY_VALUES.has(candidate.defaultQuality)
      ? candidate.defaultQuality
      : fallback.defaultQuality,
    flareSolverrEnabled: typeof candidate.flareSolverrEnabled === 'boolean'
      ? candidate.flareSolverrEnabled
      : fallback.flareSolverrEnabled,
    resourceProfile: candidate.resourceProfile === 'reduced' || candidate.resourceProfile === 'standard'
      ? candidate.resourceProfile
      : fallback.resourceProfile,
    playbackVolume: typeof candidate.playbackVolume === 'number' && Number.isFinite(candidate.playbackVolume)
      ? Math.max(0, Math.min(150, candidate.playbackVolume))
      : fallback.playbackVolume,
    playbackMuted: typeof candidate.playbackMuted === 'boolean'
      ? candidate.playbackMuted : fallback.playbackMuted,
    alwaysSkipIntro: typeof candidate.alwaysSkipIntro === 'boolean'
      ? candidate.alwaysSkipIntro : fallback.alwaysSkipIntro,
  }
}

function normalizeGlobalSettings(value, fallback = GLOBAL_DEFAULTS) {
  const normalized = normalizeSettings(value, { ...DEFAULT_APP_SETTINGS, ...fallback })
  return Object.fromEntries(Object.keys(GLOBAL_DEFAULTS).map(key => [key, normalized[key]]))
}

function normalizeProfileSettings(value, fallback = PROFILE_DEFAULTS) {
  const normalized = normalizeSettings(value, { ...DEFAULT_APP_SETTINGS, ...fallback })
  return Object.fromEntries(Object.keys(PROFILE_DEFAULTS).map(key => [key, normalized[key]]))
}

class AppSettingsStore {
  constructor(filePath) {
    this.filePath = filePath
    this.persistedKeys = new Set()
    this.profileStore = null
    const loaded = this.load()
    this.legacyProfileSettings = normalizeProfileSettings(loaded)
    this.value = normalizeGlobalSettings(loaded)
  }

  load() {
    try {
      if (fs.statSync(this.filePath).size > 64 * 1024) throw new Error('settings file is too large')
      const parsed = JSON.parse(fs.readFileSync(this.filePath, 'utf8'))
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        this.persistedKeys = new Set(Object.keys(parsed))
      }
      return normalizeSettings(parsed)
    } catch (error) {
      if (error?.code !== 'ENOENT') console.warn('[Settings] App settings are unreadable; defaults are active.')
      return { ...DEFAULT_APP_SETTINGS }
    }
  }

  get() {
    return {
      version: SETTINGS_VERSION,
      ...this.value,
      ...(this.profileStore?.getSettings() || this.legacyProfileSettings),
    }
  }

  getGlobalSettings() {
    return { ...this.value }
  }

  replaceGlobalSettings(value) {
    const next = normalizeGlobalSettings(value, this.value)
    atomicJson(this.filePath, { version: SETTINGS_VERSION, ...next })
    this.value = next
    return this.getGlobalSettings()
  }

  attachProfileStore(profileStore) {
    if (!profileStore || typeof profileStore.getSettings !== 'function' || typeof profileStore.updateSettings !== 'function') {
      throw new Error('Profile settings store is invalid')
    }
    this.profileStore = profileStore
    // Do not erase the legacy personal fields when a corrupt profile file could
    // not be replaced. They remain the recovery source for the next launch.
    if (profileStore.isWritable?.() !== false) {
      atomicJson(this.filePath, { version: SETTINGS_VERSION, ...this.value })
    }
  }

  wasPersisted(key) {
    return this.persistedKeys.has(key)
  }

  update(patch) {
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new Error('Settings update is invalid')
    const allowed = new Set([
      'appearance',
      'onClose',
      'startWithWindows',
      'startMinimized',
      'updateNotifications',
      'keepWatchingEnabled',
      'keepWatchingLimit',
      'defaultQuality',
      'flareSolverrEnabled',
      'resourceProfile',
      'playbackVolume',
      'playbackMuted',
      'alwaysSkipIntro',
      ...Object.keys(PLAYBACK_DEFAULTS),
    ])
    if (Object.keys(patch).some(key => !allowed.has(key))) throw new Error('Settings update contains an unsupported field')
    const current = this.get()
    const next = normalizeSettings({ ...current, ...patch }, current)
    const globalPatch = Object.fromEntries(Object.keys(patch).filter(key => key in GLOBAL_DEFAULTS).map(key => [key, next[key]]))
    const profilePatch = Object.fromEntries(Object.keys(patch).filter(key => key in PROFILE_DEFAULTS).map(key => [key, next[key]]))
    if (Object.keys(profilePatch).length) {
      if (!this.profileStore) throw new Error('Profile settings are unavailable')
      this.profileStore.updateSettings(profilePatch)
    }
    if (Object.keys(globalPatch).length) {
      const nextGlobal = normalizeGlobalSettings({ ...this.value, ...globalPatch }, this.value)
      atomicJson(this.filePath, { version: SETTINGS_VERSION, ...nextGlobal })
      this.value = nextGlobal
    }
    return this.get()
  }
}

module.exports = {
  AppSettingsStore,
  DEFAULT_APP_SETTINGS,
  GLOBAL_DEFAULTS,
  PROFILE_DEFAULTS,
  SETTINGS_VERSION,
  atomicJson,
  normalizeGlobalSettings,
  normalizeProfileSettings,
  normalizeSettings,
}
