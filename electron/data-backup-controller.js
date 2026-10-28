'use strict'

const crypto = require('crypto')
const fs = require('fs')
const path = require('path')
const { app, dialog } = require('electron')
const { atomicJson, normalizeGlobalSettings, normalizeProfileSettings, PROFILE_DEFAULTS } = require('./app-settings-store')
const { normalizeProfileStore } = require('./profile-store')
const { CACHE_VERSION, DISMISSED_LIMIT, EPISODE_PROGRESS_LIMIT, normalizeCatalogId, normalizeRecord } = require('./keep-watching-store')

const BACKUP_VERSION = 3
const MAX_BACKUP_BYTES = 64 * 1024 * 1024
const MAX_LOCAL_VALUE_BYTES = 4 * 1024 * 1024
const LOCAL_KEYS = new Set([
  'netwatch-my-list-v1',
  'netwatch-search-history-v1',
  'netwatch-search-history-enabled-v1',
  'netwatch-ui-preferences-v1',
  'netwatch-collections-v1',
  'netwatch-tracked-series-v1',
])

function safeProfileStore(value) {
  const normalized = normalizeProfileStore(value, PROFILE_DEFAULTS)
  return {
    ...normalized,
    profiles: normalized.profiles.map(profile => {
      const settings = normalizeProfileSettings(profile.settings)
      settings.appearance = {
        ...settings.appearance,
        background: { ...settings.appearance.background, imageId: null },
      }
      return { ...profile, avatar: profile.avatar.startsWith('image:') ? 'preset:violet' : profile.avatar, settings }
    }),
  }
}

function normalizeLocalProfiles(value, profileIds) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Profile browser data is invalid')
  const allowedProfiles = new Set(profileIds)
  const result = {}
  let total = 0
  for (const [profileId, entries] of Object.entries(value)) {
    if (!allowedProfiles.has(profileId) || !entries || typeof entries !== 'object' || Array.isArray(entries)) throw new Error('Profile browser data is invalid')
    const clean = {}
    for (const [key, raw] of Object.entries(entries)) {
      if (!LOCAL_KEYS.has(key) || typeof raw !== 'string' || Buffer.byteLength(raw, 'utf8') > MAX_LOCAL_VALUE_BYTES) throw new Error('Profile browser data exceeds its limits')
      const parsed = JSON.parse(raw)
      if (key === 'netwatch-ui-preferences-v1' && parsed && typeof parsed === 'object' && !Array.isArray(parsed) && parsed.appearance?.background) {
        parsed.appearance = { ...parsed.appearance, background: { ...parsed.appearance.background, imageId: null } }
      }
      clean[key] = JSON.stringify(parsed)
      total += Buffer.byteLength(clean[key], 'utf8')
      if (total > MAX_BACKUP_BYTES) throw new Error('Profile browser data is too large')
    }
    result[profileId] = clean
  }
  for (const id of profileIds) if (!result[id]) result[id] = {}
  return result
}

function normalizeKeepWatching(value, profileIds) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Keep Watching data is invalid')
  const result = {}
  for (const id of profileIds) {
    const saved = value[id]
    const items = Array.isArray(saved) ? saved : saved?.items
    const episodeProgress = Array.isArray(saved) ? saved.filter(item => String(item?.catalog_id || '').startsWith('tv:')) : saved?.episodeProgress
    const dismissed = Array.isArray(saved?.dismissed) ? [...new Set(saved.dismissed.map(normalizeCatalogId))] : []
    if (saved == null) { result[id] = { items: [], episodeProgress: [], dismissed: [] }; continue }
    if (!Array.isArray(items) || items.length > 20 || !Array.isArray(episodeProgress) || episodeProgress.length > EPISODE_PROGRESS_LIMIT ||
        dismissed.length > DISMISSED_LIMIT || dismissed.some(value => !value?.startsWith('tv:'))) {
      throw new Error('Keep Watching data is invalid')
    }
    const normalizeUnique = (records, tvOnly = false) => {
      const seen = new Set()
      return records.map(normalizeRecord).filter(item => {
        if (!item || (tvOnly && !item.catalog_id.startsWith('tv:'))) return false
        const key = tvOnly ? `${item.catalog_id}:${item.season}:${item.episode}` : item.catalog_id
        if (seen.has(key)) return false
        seen.add(key)
        return true
      })
    }
    const cleanItems = normalizeUnique(items)
    const cleanEpisodeProgress = normalizeUnique(episodeProgress, true)
    if (cleanItems.length !== items.length || cleanEpisodeProgress.length !== episodeProgress.length) throw new Error('Keep Watching data contains invalid records')
    result[id] = { items: cleanItems, episodeProgress: cleanEpisodeProgress, dismissed }
  }
  return result
}

function readBackup(filePath) {
  const stat = fs.lstatSync(filePath)
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 2 || stat.size > MAX_BACKUP_BYTES) throw new Error('Choose a NetWatch backup under 64 MB')
  const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'))
  if (parsed?.format !== 'netwatch-backup' || ![1, 2, BACKUP_VERSION].includes(parsed.version)) throw new Error('This backup format is not supported')
  const profiles = safeProfileStore(parsed.profiles)
  const profileIds = profiles.profiles.map(profile => profile.id)
  return {
    format: 'netwatch-backup',
    version: BACKUP_VERSION,
    createdAt: typeof parsed.createdAt === 'string' && Number.isFinite(Date.parse(parsed.createdAt)) ? parsed.createdAt : null,
    sourceVersion: typeof parsed.sourceVersion === 'string' ? parsed.sourceVersion.slice(0, 40) : 'Unknown',
    globalSettings: normalizeGlobalSettings(parsed.globalSettings),
    profiles,
    localProfiles: normalizeLocalProfiles(parsed.localProfiles, profileIds),
    keepWatching: normalizeKeepWatching(parsed.keepWatching, profileIds),
  }
}

function createDataBackupController({ appSettings, desktopShell, keepWatchingPath, onRestored, player, profiles }) {
  const prepared = new Map()
  const readKeepWatching = profileId => {
    try {
      const file = keepWatchingPath(profileId)
      if (fs.statSync(file).size > 1024 * 1024) throw new Error('too large')
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
      if (![1, 2, CACHE_VERSION].includes(parsed?.version) || !Array.isArray(parsed.items)) return { items: [], episodeProgress: [], dismissed: [] }
      const items = parsed.items.map(normalizeRecord).filter(Boolean).slice(0, 20)
      const episodeProgress = (parsed.version === 1 ? items : parsed.episodeProgress || [])
        .map(normalizeRecord).filter(item => item?.catalog_id.startsWith('tv:')).slice(0, EPISODE_PROGRESS_LIMIT)
      const dismissed = Array.isArray(parsed.dismissed)
        ? [...new Set(parsed.dismissed.map(normalizeCatalogId))].filter(id => id?.startsWith('tv:')).slice(0, DISMISSED_LIMIT)
        : []
      return { items, episodeProgress, dismissed }
    } catch (error) {
      if (error?.code !== 'ENOENT') console.warn('[Backup] Keep Watching data was skipped:', error?.message || error)
      return { items: [], episodeProgress: [], dismissed: [] }
    }
  }

  const exportBackup = async localProfiles => {
    const profileValue = safeProfileStore(profiles.backupValue())
    const ids = profileValue.profiles.map(profile => profile.id)
    const local = normalizeLocalProfiles(localProfiles, ids)
    const backup = {
      format: 'netwatch-backup',
      version: BACKUP_VERSION,
      createdAt: new Date().toISOString(),
      sourceVersion: app.getVersion(),
      globalSettings: appSettings.getGlobalSettings(),
      profiles: profileValue,
      localProfiles: local,
      keepWatching: Object.fromEntries(ids.map(id => [id, readKeepWatching(id)])),
      exclusions: ['credentials', 'vpn', 'remote-access', 'background-images', 'profile-pictures', 'local-media'],
    }
    const chosen = await dialog.showSaveDialog(desktopShell.getMainWindow(), {
      title: 'Export NetWatch backup',
      defaultPath: `NetWatch-backup-${new Date().toISOString().slice(0, 10)}.json`,
      filters: [{ name: 'NetWatch backup', extensions: ['json'] }],
    })
    if (chosen.canceled || !chosen.filePath) return { cancelled: true }
    atomicJson(chosen.filePath, backup)
    return { cancelled: false, fileName: path.basename(chosen.filePath) }
  }

  const prepareImport = async () => {
    if (player.getSession()) throw new Error('Close the player before restoring a backup.')
    const chosen = await dialog.showOpenDialog(desktopShell.getMainWindow(), {
      title: 'Choose NetWatch backup',
      properties: ['openFile', 'dontAddToRecent'],
      filters: [{ name: 'NetWatch backup', extensions: ['json'] }],
    })
    if (chosen.canceled || chosen.filePaths.length !== 1) return { cancelled: true }
    const backup = readBackup(chosen.filePaths[0])
    const token = crypto.randomBytes(24).toString('hex')
    prepared.clear()
    prepared.set(token, { backup, expires: Date.now() + 10 * 60 * 1000 })
    return {
      cancelled: false,
      token,
      localProfiles: backup.localProfiles,
      summary: {
        createdAt: backup.createdAt,
        sourceVersion: backup.sourceVersion,
        profileCount: backup.profiles.profiles.length,
        profileNames: backup.profiles.profiles.map(profile => profile.name),
        keepWatchingCount: Object.values(backup.keepWatching).reduce((sum, value) => sum + value.items.length, 0),
      },
    }
  }

  const commitImport = async (token, selection) => {
    const pending = prepared.get(token)
    prepared.delete(token)
    if (!pending || pending.expires < Date.now()) throw new Error('The restore request expired. Choose the backup again.')
    if (player.getSession()) throw new Error('Close the player before restoring a backup.')
    const choices = {
      library: selection?.library !== false,
      history: selection?.history !== false,
      keepWatching: selection?.keepWatching !== false,
    }
    const answer = await dialog.showMessageBox(desktopShell.getMainWindow(), {
      type: 'warning',
      buttons: ['Cancel', 'Restore and restart'],
      defaultId: 0,
      cancelId: 0,
      title: 'Restore this backup?',
      message: `Replace local data for ${pending.backup.profiles.profiles.length} profile${pending.backup.profiles.profiles.length === 1 ? '' : 's'}?`,
      detail: `Profiles and preferences will be replaced.${choices.library ? ' My List and collections will be replaced.' : ''}${choices.history ? ' Search history will be replaced.' : ''}${choices.keepWatching ? ' Keep Watching and episode progress will be replaced.' : ''} Credentials, VPN settings, paired devices, local media, and background images are not affected.`,
    })
    if (answer.response !== 1) return { cancelled: true }

    const oldProfiles = profiles.backupValue()
    const oldGlobal = appSettings.getGlobalSettings()
    const allIds = new Set([...oldProfiles.profiles.map(profile => profile.id), ...pending.backup.profiles.profiles.map(profile => profile.id)])
    const oldKeepWatching = new Map()
    for (const id of allIds) {
      try { oldKeepWatching.set(id, fs.readFileSync(keepWatchingPath(id))) } catch (error) { if (error?.code === 'ENOENT') oldKeepWatching.set(id, null); else throw error }
    }
    try {
      appSettings.replaceGlobalSettings(pending.backup.globalSettings)
      profiles.replaceValue(pending.backup.profiles)
      if (choices.keepWatching) {
        for (const profile of pending.backup.profiles.profiles) {
          const value = pending.backup.keepWatching[profile.id] || { items: [], episodeProgress: [], dismissed: [] }
          atomicJson(keepWatchingPath(profile.id), {
            version: CACHE_VERSION,
            items: value.items,
            episodeProgress: value.episodeProgress,
            dismissed: value.dismissed,
          })
        }
      }
      const live = new Set(pending.backup.profiles.profiles.map(profile => profile.id))
      for (const id of allIds) if (!live.has(id)) {
        try { fs.unlinkSync(keepWatchingPath(id)) } catch (error) { if (error?.code !== 'ENOENT') throw error }
      }
      await onRestored()
      return { cancelled: false, state: profiles.state() }
    } catch (error) {
      try {
        appSettings.replaceGlobalSettings(oldGlobal)
        profiles.replaceValue(oldProfiles)
        for (const [id, bytes] of oldKeepWatching) {
          const file = keepWatchingPath(id)
          if (bytes) { fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 }); fs.writeFileSync(file, bytes, { mode: 0o600 }) }
          else { try { fs.unlinkSync(file) } catch (unlinkError) { if (unlinkError?.code !== 'ENOENT') throw unlinkError } }
        }
        await onRestored()
      } catch (rollbackError) {
        console.error('[Backup] Restore rollback failed:', rollbackError)
      }
      throw error
    }
  }

  return { exportBackup, prepareImport, commitImport, cancelImport: token => prepared.delete(token) }
}

module.exports = { BACKUP_VERSION, createDataBackupController, normalizeLocalProfiles, readBackup }
