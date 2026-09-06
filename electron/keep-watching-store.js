const fs = require('fs')
const { atomicJson } = require('./app-settings-store')

const CACHE_VERSION = 1
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
      try { fs.unlinkSync(this.filePath) } catch (error) {
        if (error?.code !== 'ENOENT') console.warn('[KeepWatching] Disabled cache could not be removed.')
      }
      return
    }
    try {
      if (fs.statSync(this.filePath).size > 128 * 1024) throw new Error('cache file is too large')
      const value = JSON.parse(fs.readFileSync(this.filePath, 'utf8'))
      if (value?.version !== CACHE_VERSION || !Array.isArray(value.items)) throw new Error('unsupported cache')
      const unique = new Map()
      for (const item of value.items) {
        const record = normalizeRecord(item)
        if (record && !unique.has(record.catalog_id)) unique.set(record.catalog_id, record)
      }
      this.records = [...unique.values()]
        .sort((left, right) => Date.parse(right.updated_at) - Date.parse(left.updated_at))
        .slice(0, this.limit())
    } catch (error) {
      if (error?.code !== 'ENOENT') console.warn('[KeepWatching] Cache is unreadable; starting empty.')
      this.records = []
    }
  }

  list() {
    if (!this.enabled()) return []
    return this.records.map(item => ({ ...item }))
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
    atomicJson(this.filePath, { version: CACHE_VERSION, items: this.records })
    this.emitChanged()
  }

  checkpoint(mediaItem, positionSeconds, durationSeconds) {
    if (!this.enabled()) return false
    const record = recordFromMedia(mediaItem, positionSeconds, durationSeconds, this.now().toISOString())
    if (!record) return false
    const existingIndex = this.records.findIndex(item => item.catalog_id === record.catalog_id)
    if (record.position_seconds / record.duration_seconds >= COMPLETE_RATIO) {
      if (existingIndex < 0) return false
      this.records.splice(existingIndex, 1)
      this.persist()
      return true
    }
    if (record.position_seconds < NEW_ENTRY_MINIMUM_SECONDS) return false
    if (existingIndex >= 0) this.records.splice(existingIndex, 1)
    this.records.unshift(record)
    this.persist()
    return true
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
    try { fs.unlinkSync(this.filePath) } catch (error) {
      if (error?.code !== 'ENOENT') throw error
    }
    this.emitChanged()
  }

  enable() {
    this.records = []
    this.emitChanged()
  }
}

module.exports = {
  CACHE_VERSION,
  COMPLETE_RATIO,
  KeepWatchingStore,
  NEW_ENTRY_MINIMUM_SECONDS,
  normalizeCatalogId,
  normalizeRecord,
  recordFromMedia,
}
