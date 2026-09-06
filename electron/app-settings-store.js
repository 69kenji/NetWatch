const fs = require('fs')
const path = require('path')

const SETTINGS_VERSION = 2
const DEFAULT_APP_SETTINGS = Object.freeze({
  version: SETTINGS_VERSION,
  onClose: 'exit',
  keepWatchingEnabled: true,
  keepWatchingLimit: 5,
  defaultQuality: 'all',
  flareSolverrEnabled: false,
  resourceProfile: 'standard',
})

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
    version: SETTINGS_VERSION,
    onClose: candidate.onClose === 'minimize-to-tray' || candidate.onClose === 'exit'
      ? candidate.onClose
      : fallback.onClose,
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
  }
}

class AppSettingsStore {
  constructor(filePath) {
    this.filePath = filePath
    this.persistedKeys = new Set()
    this.value = this.load()
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
    return { ...this.value }
  }

  wasPersisted(key) {
    return this.persistedKeys.has(key)
  }

  update(patch) {
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new Error('Settings update is invalid')
    const allowed = new Set([
      'onClose',
      'keepWatchingEnabled',
      'keepWatchingLimit',
      'defaultQuality',
      'flareSolverrEnabled',
      'resourceProfile',
    ])
    if (Object.keys(patch).some(key => !allowed.has(key))) throw new Error('Settings update contains an unsupported field')
    this.value = normalizeSettings({ ...this.value, ...patch }, this.value)
    atomicJson(this.filePath, this.value)
    return this.get()
  }
}

module.exports = {
  AppSettingsStore,
  DEFAULT_APP_SETTINGS,
  SETTINGS_VERSION,
  atomicJson,
  normalizeSettings,
}
