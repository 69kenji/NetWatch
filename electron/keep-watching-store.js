const fs = require('fs')
const { atomicJson } = require('./app-settings-store')

const CACHE_VERSION = 3
const EPISODE_PROGRESS_LIMIT = 1000
const DISMISSED_LIMIT = 1000
const NEW_ENTRY_MINIMUM_SECONDS = 30
const COMPLETE_RATIO = 0.95
const MAX_DURATION_SECONDS = 7 * 24 * 60 * 60

function finiteSeconds(value) {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null
}

function normalizeCatalogId(value) {
  const match = /^(movie|tv):([1-9]\d{0,11})$/u.exec(String(value || ''))
  return match ? `${match[1]}:${match[2]}` : null
}

function normalizeRecord(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const catalogId = normalizeCatalogId(value.catalog_id)
  const title = typeof value.title === 'string'
    ? value.title.replace(/[\u0000-\u001f\u007f]/gu, '').trim().slice(0, 240)
    : ''
  const position = finiteSeconds(value.position_seconds)
  const duration = finiteSeconds(value.duration_seconds)
  const updatedAtMs = Date.parse(value.updated_at)
  if (!catalogId || !title || position === null || duration === null || duration <= 0 || duration > MAX_DURATION_SECONDS || !Number.isFinite(updatedAtMs)) return null

  const record = {
    catalog_id: catalogId,
    title,
    position_seconds: Math.min(position, duration),
    duration_seconds: duration,
    updated_at: new Date(updatedAtMs).toISOString(),
  }
  if (catalogId.startsWith('tv:')) {
    const season = Number(value.season)
    const episode = Number(value.episode)
    if (!Number.isInteger(season) || season < 0 || season > 9999 || !Number.isInteger(episode) || episode < 0 || episode > 9999) return null
    record.season = season
    record.episode = episode
  }
  return record
}

function episodeRecordKey(record) {
  return record?.catalog_id?.startsWith('tv:') && Number.isInteger(record.season) && Number.isInteger(record.episode)
    ? `${record.catalog_id}:${record.season}:${record.episode}`
    : null
}

function recordFromMedia(mediaItem, positionSeconds, durationSeconds, updatedAt) {
  if (!mediaItem || typeof mediaItem !== 'object') return null
  const kind = mediaItem.type === 'tv' ? 'tv' : mediaItem.type === 'movie' ? 'movie' : null
  const id = Number(mediaItem.tmdb_id || mediaItem.id)
  if (!kind || !Number.isSafeInteger(id) || id <= 0) return null
  return normalizeRecord({
    catalog_id: `${kind}:${id}`,
    title: mediaItem.title,
    season: mediaItem.season,
    episode: mediaItem.episode,
    position_seconds: positionSeconds,
    duration_seconds: durationSeconds,
    updated_at: updatedAt,
  })
}

class KeepWatchingStore {
  constructor(filePath, getSettings, onChanged = null, now = () => new Date()) {
    this.filePath = filePath
    this.getSettings = getSettings
    this.onChanged = onChanged
    this.now = now
    this.records = []
    this.episodeProgress = []
    this.dismissed = new Set()
    this.load()
  }

  enabled() {
    return Boolean(this.getSettings()?.keepWatchingEnabled)
  }

  limit() {
    const value = Number(this.getSettings()?.keepWatchingLimit)
    return Number.isInteger(value) ? Math.max(1, Math.min(20, value)) : 5
  }

  load() {
    if (!this.enabled()) {
      this.records = []
      this.episodeProgress = []
      this.dismissed.clear()
      try { fs.unlinkSync(this.filePath) } catch (error) {
        if (error?.code !== 'ENOENT') console.warn('[KeepWatching] Disabled cache could not be removed.')
      }
      return
    }
    try {
      if (fs.statSync(this.filePath).size > 1024 * 1024) throw new Error('cache file is too large')
      const value = JSON.parse(fs.readFileSync(this.filePath, 'utf8'))
      if (![1, 2, CACHE_VERSION].includes(value?.version) || !Array.isArray(value.items)) throw new Error('unsupported cache')
      const unique = new Map()
      for (const item of value.items) {
        const record = normalizeRecord(item)
        if (record && !unique.has(record.catalog_id)) unique.set(record.catalog_id, record)
      }
      this.records = [...unique.values()]
        .sort((left, right) => Date.parse(right.updated_at) - Date.parse(left.updated_at))
        .slice(0, this.limit())
      const savedEpisodeProgress = value.version === 1 ? this.records : value.episodeProgress
      if (!Array.isArray(savedEpisodeProgress)) throw new Error('unsupported episode cache')
      const episodeUnique = new Map()
      for (const item of savedEpisodeProgress) {
        const record = normalizeRecord(item)
        const key = episodeRecordKey(record)
        if (key && !episodeUnique.has(key)) {
          episodeUnique.set(key, record)
        }
      }
      this.episodeProgress = [...episodeUnique.values()]
        .sort((left, right) => Date.parse(right.updated_at) - Date.parse(left.updated_at))
        .slice(0, EPISODE_PROGRESS_LIMIT)
      this.dismissed = new Set(Array.isArray(value.dismissed)
        ? value.dismissed.map(normalizeCatalogId).filter(id => id?.startsWith('tv:')).slice(0, DISMISSED_LIMIT)
        : [])
      if (!Array.isArray(value.dismissed)) {
        for (const catalogId of new Set(this.episodeProgress.map(item => item.catalog_id))) this.syncSeriesRecord(catalogId)
        this.records = this.records.slice(0, this.limit())
      }
    } catch (error) {
      if (error?.code !== 'ENOENT') console.warn('[KeepWatching] Cache is unreadable; starting empty.')
      this.records = []
      this.episodeProgress = []
      this.dismissed.clear()
    }
  }

  list() {
    if (!this.enabled()) return []
    return this.records.map(item => ({ ...item }))
  }

  listEpisodeProgress() {
    if (!this.enabled()) return []
    return this.episodeProgress.map(item => ({ ...item }))
  }

  listDismissed() {
    return [...this.dismissed]
  }

  syncSeriesRecord(catalogId) {
    const normalized = normalizeCatalogId(catalogId)
    if (!normalized?.startsWith('tv:')) return
    this.records = this.records.filter(item => item.catalog_id !== normalized)
    if (this.dismissed.has(normalized)) return
    const unfinished = this.episodeProgress.find(item => item.catalog_id === normalized &&
      item.position_seconds >= NEW_ENTRY_MINIMUM_SECONDS && item.position_seconds / item.duration_seconds < COMPLETE_RATIO)
    if (unfinished) this.records.unshift({ ...unfinished })
  }

  emitChanged() {
    try { this.onChanged?.(this.list()) } catch (error) {
      console.warn('[KeepWatching] Could not notify the desktop renderer:', error?.message || error)
    }
  }

  get(catalogId) {
    if (!this.enabled()) return null
    const normalized = normalizeCatalogId(catalogId)
    const found = normalized ? this.records.find(item => item.catalog_id === normalized) : null
    return found ? { ...found } : null
  }

  persist() {
    if (!this.enabled()) return
    this.records = this.records.slice(0, this.limit())
    this.episodeProgress = this.episodeProgress.slice(0, EPISODE_PROGRESS_LIMIT)
    atomicJson(this.filePath, {
      version: CACHE_VERSION,
      items: this.records,
      episodeProgress: this.episodeProgress,
      dismissed: [...this.dismissed].slice(0, DISMISSED_LIMIT),
    })
    this.emitChanged()
  }

  checkpoint(mediaItem, positionSeconds, durationSeconds) {
    if (!this.enabled()) return false
    const record = recordFromMedia(mediaItem, positionSeconds, durationSeconds, this.now().toISOString())
    if (!record) return false
    const existingIndex = this.records.findIndex(item => item.catalog_id === record.catalog_id)
    let changed = false
    if (record.catalog_id.startsWith('tv:') && record.position_seconds >= NEW_ENTRY_MINIMUM_SECONDS) {
      const key = episodeRecordKey(record)
      const episodeIndex = this.episodeProgress.findIndex(item => episodeRecordKey(item) === key)
      if (episodeIndex >= 0) this.episodeProgress.splice(episodeIndex, 1)
      this.episodeProgress.unshift(record)
      if (record.position_seconds / record.duration_seconds < COMPLETE_RATIO) this.dismissed.delete(record.catalog_id)
      changed = true
    }
    if (record.position_seconds / record.duration_seconds >= COMPLETE_RATIO) {
      if (record.catalog_id.startsWith('tv:')) this.syncSeriesRecord(record.catalog_id)
      else if (existingIndex >= 0) this.records.splice(existingIndex, 1)
      changed = changed || existingIndex >= 0
      if (changed) this.persist()
      return changed
    }
    if (record.position_seconds < NEW_ENTRY_MINIMUM_SECONDS) return changed
    if (existingIndex >= 0) this.records.splice(existingIndex, 1)
    this.records.unshift(record)
    this.persist()
    return true
  }

  remove(catalogId) {
    if (!this.enabled()) return false
    const normalized = normalizeCatalogId(catalogId)
    if (!normalized) throw new Error('Keep Watching catalog identifier is invalid')
    const index = this.records.findIndex(item => item.catalog_id === normalized)
    if (index < 0) return false
    this.records.splice(index, 1)
    if (normalized.startsWith('tv:')) this.dismissed.add(normalized)
    this.persist()
    return true
  }

  markEpisodeWatched(mediaItem, durationSeconds) {
    const duration = Math.min(
      MAX_DURATION_SECONDS,
      Math.max(NEW_ENTRY_MINIMUM_SECONDS, finiteSeconds(durationSeconds) || NEW_ENTRY_MINIMUM_SECONDS),
    )
    return this.checkpoint(mediaItem, duration, duration)
  }

  removeEpisode(catalogId, season, episode) {
    if (!this.enabled()) return false
    const normalized = normalizeCatalogId(catalogId)
    const seasonNumber = Number(season)
    const episodeNumber = Number(episode)
    if (!normalized?.startsWith('tv:') || !Number.isInteger(seasonNumber) || seasonNumber < 0 || seasonNumber > 9999 ||
        !Number.isInteger(episodeNumber) || episodeNumber < 1 || episodeNumber > 9999) {
      throw new Error('Episode progress identifier is invalid')
    }
    const key = `${normalized}:${seasonNumber}:${episodeNumber}`
    const before = this.episodeProgress.length
    this.episodeProgress = this.episodeProgress.filter(item => episodeRecordKey(item) !== key)
    const activeIndex = this.records.findIndex(item => item.catalog_id === normalized && item.season === seasonNumber && item.episode === episodeNumber)
    if (activeIndex >= 0) this.records.splice(activeIndex, 1)
    if (activeIndex >= 0) this.syncSeriesRecord(normalized)
    const changed = this.episodeProgress.length !== before || activeIndex >= 0
    if (changed) this.persist()
    return changed
  }

  applyLimit() {
    if (!this.enabled()) return
    const before = this.records.length
    this.records = this.records.slice(0, this.limit())
    if (this.records.length !== before) this.persist()
    else this.emitChanged()
  }

  disable() {
    this.records = []
    this.episodeProgress = []
    this.dismissed.clear()
    try { fs.unlinkSync(this.filePath) } catch (error) {
      if (error?.code !== 'ENOENT') throw error
    }
    this.emitChanged()
  }

  enable() {
    this.records = []
    this.episodeProgress = []
    this.dismissed.clear()
    this.emitChanged()
  }

  switchFile(filePath) {
    if (typeof filePath !== 'string' || !filePath) throw new Error('Keep Watching profile path is invalid')
    this.filePath = filePath
    this.records = []
    this.episodeProgress = []
    this.dismissed.clear()
    this.load()
    this.emitChanged()
  }
}

module.exports = {
  CACHE_VERSION,
  COMPLETE_RATIO,
  EPISODE_PROGRESS_LIMIT,
  DISMISSED_LIMIT,
  KeepWatchingStore,
  NEW_ENTRY_MINIMUM_SECONDS,
  normalizeCatalogId,
  normalizeRecord,
  episodeRecordKey,
  recordFromMedia,
}
