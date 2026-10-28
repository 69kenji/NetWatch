'use strict'

const crypto = require('crypto')
const fs = require('fs')
const { atomicJson } = require('./app-settings-store')
const { normalizeCatalogId } = require('./keep-watching-store')

const HISTORY_VERSION = 2
const HISTORY_LIMIT = 2000
const HISTORY_FILE_LIMIT = 4 * 1024 * 1024
const MAX_DURATION_SECONDS = 7 * 24 * 60 * 60
const PERSIST_INTERVAL_MS = 15_000

function clean(value, limit) {
  return typeof value === 'string'
    ? value.replace(/[\u0000-\u001f\u007f]/gu, '').trim().slice(0, limit)
    : ''
}

function seconds(value, maximum = MAX_DURATION_SECONDS) {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed >= 0 ? Math.min(parsed, maximum) : 0
}

function mediaRecord(mediaItem) {
  if (!mediaItem || typeof mediaItem !== 'object' || Array.isArray(mediaItem)) return null
  const type = mediaItem.type === 'movie' ? 'movie' : mediaItem.type === 'tv' ? 'tv' : null
  const id = Number(mediaItem.tmdb_id || mediaItem.id)
  const catalogId = type && Number.isSafeInteger(id) && id > 0 ? normalizeCatalogId(`${type}:${id}`) : null
  const title = clean(mediaItem.title, 240)
  if (!catalogId || !title) return null
  const record = {
    catalogId,
    type,
    title,
    year: clean(mediaItem.year, 12),
    poster: clean(mediaItem.poster, 800) || null,
    backdrop: clean(mediaItem.backdrop, 800) || null,
    isAnime: mediaItem.is_anime === true,
    genres: Array.isArray(mediaItem.genres) ? [...new Set(mediaItem.genres.map(value => clean(value, 60)).filter(Boolean))].slice(0, 12) : [],
  }
  if (type === 'tv') {
    const season = Number(mediaItem.season), episode = Number(mediaItem.episode)
    if (!Number.isInteger(season) || season < 0 || season > 9999 || !Number.isInteger(episode) || episode < 1 || episode > 9999) return null
    record.season = season
    record.episode = episode
    record.episodeTitle = clean(mediaItem.episode_title, 240)
    const totalEpisodes = Number(mediaItem.series_total_episodes), totalSeasons = Number(mediaItem.series_total_seasons)
    record.totalEpisodes = Number.isInteger(totalEpisodes) && totalEpisodes > 0 && totalEpisodes <= 100_000 ? totalEpisodes : 0
    record.totalSeasons = Number.isInteger(totalSeasons) && totalSeasons > 0 && totalSeasons <= 10_000 ? totalSeasons : 0
  }
  return record
}

function normalizeEntry(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const media = mediaRecord({
    id: String(value.catalogId || '').split(':')[1], type: value.type, title: value.title, year: value.year,
    poster: value.poster, backdrop: value.backdrop, is_anime: value.isAnime, genres: value.genres,
    season: value.season, episode: value.episode, episode_title: value.episodeTitle,
    series_total_episodes: value.totalEpisodes, series_total_seasons: value.totalSeasons,
  })
  const updatedAt = Number.isFinite(Date.parse(value.updatedAt)) ? new Date(value.updatedAt).toISOString() : null
  const startedAt = Number.isFinite(Date.parse(value.startedAt)) ? new Date(value.startedAt).toISOString() : updatedAt
  if (!media || !updatedAt || !startedAt || typeof value.id !== 'string' || !/^[0-9a-f]{32}$/u.test(value.id)) return null
  return {
    id: value.id,
    sessionId: clean(value.sessionId, 100),
    ...media,
    startedAt,
    updatedAt,
    watchedSeconds: seconds(value.watchedSeconds),
    lastPositionSeconds: seconds(value.lastPositionSeconds),
    durationSeconds: seconds(value.durationSeconds),
    completed: value.completed === true,
    manual: value.manual === true,
    startedFrom: value.manual === true ? 'manual' : value.startedFrom === 'resumed' ? 'resumed' : 'beginning',
  }
}

class ViewingHistoryStore {
  constructor(filePath, onChanged = null) {
    this.filePath = filePath
    this.onChanged = onChanged
    this.entries = []
    this.lastPersistAt = 0
    this.load()
  }

  load() {
    try {
      if (fs.statSync(this.filePath).size > HISTORY_FILE_LIMIT) throw new Error('history file is too large')
      const value = JSON.parse(fs.readFileSync(this.filePath, 'utf8'))
      if (![1, HISTORY_VERSION].includes(value?.version) || !Array.isArray(value.entries)) throw new Error('unsupported history')
      this.entries = value.entries.map(normalizeEntry).filter(Boolean)
        .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt)).slice(0, HISTORY_LIMIT)
    } catch (error) {
      if (error?.code !== 'ENOENT') console.warn('[History] Viewing history is unreadable; starting empty.')
      this.entries = []
    }
  }

  persist() {
    this.entries = this.entries.sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt)).slice(0, HISTORY_LIMIT)
    atomicJson(this.filePath, { version: HISTORY_VERSION, entries: this.entries })
    this.lastPersistAt = Date.now()
    try { this.onChanged?.(this.state()) } catch (error) { console.warn('[History] Could not notify the renderer:', error?.message || error) }
  }

  state() { return { entries: this.entries.map(entry => ({ ...entry, genres: [...entry.genres] })) } }

  switchFile(filePath) { this.filePath = filePath; this.entries = []; this.lastPersistAt = 0; this.load() }

  record(mediaItem, sessionId, deltaSeconds, positionSeconds, durationSeconds, { force = false, manual = false, startedFrom = 'beginning' } = {}) {
    const media = mediaRecord(mediaItem)
    const session = clean(sessionId, 100)
    if (!media || !session) return false
    const now = new Date().toISOString()
    let entry = this.entries.find(item => item.sessionId === session)
    const delta = seconds(deltaSeconds, 300)
    if (!entry && !delta && !manual) return false
    if (!entry) {
      entry = { id: crypto.randomUUID().replace(/-/gu, ''), sessionId: session, ...media, startedAt: now, updatedAt: now, watchedSeconds: 0, lastPositionSeconds: 0, durationSeconds: 0, completed: false, manual, startedFrom: manual ? 'manual' : startedFrom === 'resumed' ? 'resumed' : 'beginning' }
      this.entries.unshift(entry)
    }
    entry.watchedSeconds = Math.min(MAX_DURATION_SECONDS, entry.watchedSeconds + delta)
    entry.lastPositionSeconds = seconds(positionSeconds)
    entry.durationSeconds = seconds(durationSeconds)
    entry.completed = entry.durationSeconds > 0 && entry.lastPositionSeconds / entry.durationSeconds >= 0.95
    entry.manual = entry.manual || manual
    entry.updatedAt = now
    if (force || manual || entry.completed || Date.now() - this.lastPersistAt >= PERSIST_INTERVAL_MS) this.persist()
    return true
  }

  markWatched(mediaItem, durationSeconds) {
    const duration = Math.max(30, seconds(durationSeconds))
    return this.record(mediaItem, `manual:${crypto.randomUUID()}`, 0, duration, duration, { manual: true })
  }

  remove(id) {
    const before = this.entries.length
    this.entries = this.entries.filter(entry => entry.id !== id)
    if (this.entries.length === before) return false
    this.persist(); return true
  }

  clearTitle(catalogId) {
    const normalized = normalizeCatalogId(catalogId)
    if (!normalized) throw new Error('History title is invalid.')
    const before = this.entries.length
    this.entries = this.entries.filter(entry => entry.catalogId !== normalized)
    if (this.entries.length !== before) this.persist()
    return before - this.entries.length
  }

  removeManualEpisode(catalogId, season, episode) {
    const normalized = normalizeCatalogId(catalogId)
    const seasonNumber = Number(season), episodeNumber = Number(episode)
    if (!normalized || !Number.isInteger(seasonNumber) || !Number.isInteger(episodeNumber)) return false
    const before = this.entries.length
    this.entries = this.entries.filter(entry => !(entry.manual && entry.catalogId === normalized && entry.season === seasonNumber && entry.episode === episodeNumber))
    if (this.entries.length === before) return false
    this.persist(); return true
  }

  clear() {
    if (!this.entries.length) return false
    this.entries = []; this.persist(); return true
  }
}

module.exports = { HISTORY_LIMIT, HISTORY_VERSION, ViewingHistoryStore, mediaRecord, normalizeEntry }
