'use strict'

const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const { atomicJson } = require('./app-settings-store')

const MEDIA_EXTENSIONS = new Set(['.mkv', '.mp4', '.m4v', '.webm', '.avi', '.mov', '.wmv', '.mpg', '.mpeg', '.ts', '.m2ts'])
const MAX_FILES = 2000
const MAX_ROOTS = 12

function inside(root, target) {
  const relative = path.relative(root, target)
  return Boolean(relative && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
}

function localPath(value) {
  // Do not turn library playback into a UNC, device-path or alternate-stream opener.
  return typeof value === 'string' && /^[A-Za-z]:\\/u.test(value) && !value.slice(2).includes(':') && !value.includes('\0')
}

function episodeFromName(filename) {
  const stem = path.basename(filename, path.extname(filename))
  const match = /^(.*?)\bS(\d{1,3})E(\d{1,4})(?!\d)/iu.exec(stem.replace(/[._]/gu, ' '))
  return match ? { series: match[1].trim(), season: Number(match[2]), episode: Number(match[3]) } : null
}

function safeArtwork(value) {
  return typeof value === 'string' && /^http:\/\/127\.0\.0\.1:8000\/api\/metadata\/image\/[a-z0-9]+\/[A-Za-z0-9._-]+$/u.test(value) ? value : null
}

class LocalLibrary {
  constructor(filePath, backendJson) {
    this.filePath = filePath
    this.backendJson = backendJson
    this.roots = []
    this.matches = {}
    this.files = new Map()
    this.queue = Promise.resolve()
    this.warning = null
    try {
      if (fs.statSync(filePath).size > 8 * 1024 * 1024) throw new Error('Library configuration is too large')
      const saved = JSON.parse(fs.readFileSync(filePath, 'utf8'))
      if (saved.version !== 1 || !Array.isArray(saved.roots)) throw new Error('Invalid library configuration')
      this.roots = saved.roots.filter(item => /^[a-f0-9-]{36}$/u.test(item?.id) && localPath(item.path)).slice(0, MAX_ROOTS)
      if (saved.matches && typeof saved.matches === 'object' && !Array.isArray(saved.matches)) {
        for (const [id, match] of Object.entries(saved.matches).slice(0, MAX_FILES)) {
          if (/^[a-f0-9]{64}$/u.test(id) && this.validMatch(match) && typeof match.title === 'string' && this.roots.some(root => root.id === match.rootId)) {
            this.matches[id] = {
              rootId: match.rootId, id: match.id, type: match.type, title: match.title.slice(0, 240),
              overview: String(match.overview || '').slice(0, 1500),
              year: /^\d{4}$/u.test(match.year) ? match.year : '',
              poster: safeArtwork(match.poster), backdrop: safeArtwork(match.backdrop),
              season: match.type === 'tv' ? match.season : undefined, episode: match.type === 'tv' ? match.episode : undefined,
              lastEpisode: Number.isInteger(match.lastEpisode) && match.lastEpisode >= match.episode && match.lastEpisode <= 9999 ? match.lastEpisode : null,
              episode_title: String(match.episode_title || '').slice(0, 240), is_anime: match.is_anime === true,
              imdb_id: /^tt\d{5,12}$/u.test(match.imdb_id) ? match.imdb_id : undefined,
            }
          }
        }
      }
    } catch (error) {
      if (error.code !== 'ENOENT') this.warning = 'Library settings could not be read. Add your folders again.'
    }
  }

  run(callback) {
    const task = this.queue.then(async () => {
      const roots = this.roots.map(root => ({ ...root })), matches = { ...this.matches }
      try { return await callback() }
      catch (error) { this.roots = roots; this.matches = matches; throw error }
    })
    this.queue = task.catch(() => {})
    return task
  }

  save() {
    const value = { version: 1, roots: this.roots, matches: this.matches }
    if (Buffer.byteLength(JSON.stringify(value, null, 2), 'utf8') >= 8 * 1024 * 1024) throw new Error('Library configuration limit reached')
    atomicJson(this.filePath, value)
  }

  state() {
    return {
      roots: this.roots.map(root => ({ id: root.id, name: path.basename(root.path) || root.path, path: root.path })),
      items: [...this.files.values()].map(({ absolutePath: _path, ...item }) => ({ ...item, match: this.matches[item.id] || null })),
      warning: this.warning,
    }
  }

  addFolder(folderPath) {
    return this.run(async () => {
      if (!localPath(folderPath)) throw new Error('Choose a folder on a local drive')
      const canonical = await fs.promises.realpath(folderPath)
      if (!localPath(canonical) || !(await fs.promises.lstat(canonical)).isDirectory()) throw new Error('Folder is unavailable')
      if (!this.roots.some(root => root.path.toLowerCase() === canonical.toLowerCase())) {
        if (this.roots.length >= MAX_ROOTS) throw new Error('Library supports up to 12 folders')
        this.roots.push({ id: crypto.randomUUID(), path: canonical })
        this.save()
      }
      return this.scan()
    })
  }

  removeFolder(id) {
    return this.run(async () => {
      if (typeof id !== 'string' || !this.roots.some(root => root.id === id)) throw new Error('Folder is unavailable')
      this.roots = this.roots.filter(root => root.id !== id)
      for (const [fileId, match] of Object.entries(this.matches)) if (match.rootId === id) delete this.matches[fileId]
      this.save()
      return this.scan()
    })
  }

  refresh() { return this.run(() => this.scan()) }

  async scan() {
    const files = new Map(), seen = new Set()
    const started = Date.now()
    let visited = 0, skipped = false
    for (const root of this.roots) {
      const pending = [{ directory: root.path, depth: 0 }]
      while (pending.length && files.size < MAX_FILES && visited < 50_000 && Date.now() - started < 15_000) {
        const { directory, depth } = pending.pop()
        try {
          const canonical = await fs.promises.realpath(directory)
          if (canonical.toLowerCase() !== directory.toLowerCase() || !localPath(canonical)) { skipped = true; continue }
          const entries = await fs.promises.opendir(directory)
          for await (const entry of entries) {
            if (++visited > 50_000 || files.size >= MAX_FILES || Date.now() - started >= 15_000) break
            if (entry.isSymbolicLink()) continue
            const absolutePath = path.join(directory, entry.name)
            if (entry.isDirectory() && depth < 20) pending.push({ directory: absolutePath, depth: depth + 1 })
            else if (entry.isDirectory()) skipped = true
            if (!entry.isFile() || !MEDIA_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) continue
            if (seen.has(absolutePath.toLowerCase())) continue
            seen.add(absolutePath.toLowerCase())
            const relativePath = path.relative(root.path, absolutePath)
            const id = crypto.createHash('sha256').update(`${root.id}:${relativePath.toLowerCase()}`).digest('hex')
            files.set(id, { id, rootId: root.id, filename: entry.name, relativePath, absolutePath, episode: episodeFromName(entry.name) })
          }
        } catch { skipped = true }
      }
      if (pending.length) skipped = true
    }
    this.files = files
    this.warning = skipped || files.size >= MAX_FILES ? 'Some folders could not be read or the scan limit was reached (2,000 videos).' : null
    return this.state()
  }

  async resolve(id) {
    if (typeof id !== 'string' || !/^[a-f0-9]{64}$/u.test(id)) throw new Error('Invalid library item')
    const item = this.files.get(id)
    const root = item && this.roots.find(root => root.id === item.rootId)
    if (!root) throw new Error('Refresh the library and try again')
    const rootPath = await fs.promises.realpath(root.path)
    const canonical = await fs.promises.realpath(item.absolutePath)
    if (rootPath.toLowerCase() !== root.path.toLowerCase() || !localPath(canonical) ||
        canonical.toLowerCase() !== item.absolutePath.toLowerCase() || !inside(root.path, canonical) ||
        !(await fs.promises.lstat(canonical)).isFile()) throw new Error('Library file changed or is unavailable')
    return { ...item, absolutePath: canonical, match: this.matches[id] || null }
  }

  validMatch(value) {
    return value && ['movie', 'tv'].includes(value.type) && Number.isInteger(value.id) && value.id > 0 && value.id <= 2147483647 &&
      (value.type === 'movie' || (Number.isInteger(value.season) && value.season >= 0 && value.season <= 9999 &&
        Number.isInteger(value.episode) && value.episode > 0 && value.episode <= 9999))
  }

  match(id, selection) {
    return this.run(async () => {
      const item = await this.resolve(id)
      if (selection === null) { delete this.matches[id]; this.save(); return this.state() }
      if (!this.validMatch(selection)) throw new Error('Select a valid title and episode')
      if (!this.matches[id] && Object.keys(this.matches).length >= MAX_FILES) throw new Error('Library match limit reached')
      const details = await this.backendJson(`/api/metadata/${selection.type === 'movie' ? 'movies' : 'series'}/${selection.id}`, {}, 35_000)
      let episodeTitle = ''
      let lastEpisode = null
      if (selection.type === 'tv') {
        const season = await this.backendJson(`/api/metadata/series/${selection.id}/seasons/${selection.season}`, {}, 35_000)
        const episode = season.episodes?.find(item => item.episode_number === selection.episode)
        if (!episode) throw new Error('Episode was not found in that season')
        episodeTitle = String(episode.name || '').slice(0, 240)
        lastEpisode = Math.max(...season.episodes.map(item => Number(item.episode_number) || 0))
      }
      await this.resolve(id)
      this.matches[id] = {
        rootId: item.rootId,
        id: selection.id, type: selection.type, title: String(details.title || '').slice(0, 240),
        overview: String(details.overview || '').slice(0, 1500),
        year: String(details.year || '').slice(0, 4), poster: safeArtwork(details.poster), backdrop: safeArtwork(details.backdrop),
        season: selection.type === 'tv' ? selection.season : undefined,
        episode: selection.type === 'tv' ? selection.episode : undefined,
        episode_title: episodeTitle, lastEpisode, is_anime: details.is_anime === true,
        imdb_id: /^tt\d{5,12}$/u.test(details.imdb_id) ? details.imdb_id : undefined,
      }
      this.save()
      return this.state()
    })
  }

  async next(id) {
    const current = await this.resolve(id)
    const candidates = [...this.files.values()].filter(item => item.id !== id).map(item => ({ ...item, match: this.matches[item.id] }))
    const currentEpisode = current.match ? (current.match.type === 'tv' ? current.match : null) : current.episode
    if (!currentEpisode) return null
    const matches = candidates.filter(item => {
      const episode = current.match?.type === 'tv' ? item.match : item.episode
      const sameSeries = current.match?.type === 'tv'
        ? item.match?.type === 'tv' && item.match.id === current.match.id
        : !item.match && item.rootId === current.rootId && path.dirname(item.relativePath) === path.dirname(current.relativePath) &&
          Boolean(current.episode?.series) && item.episode?.series.toLowerCase() === current.episode.series.toLowerCase()
      const consecutive = episode && episode.season === currentEpisode.season && episode.episode === currentEpisode.episode + 1
      const nextSeason = current.match?.type === 'tv' && current.match.episode === current.match.lastEpisode &&
        current.match.season > 0 && episode?.season === current.match.season + 1 && episode?.episode === 1
      return sameSeries && (consecutive || nextSeason)
    })
    // Ambiguous duplicate cuts and missing episodes require an explicit choice.
    return matches.length === 1 ? this.resolve(matches[0].id) : null
  }
}

module.exports = { LocalLibrary, episodeFromName, localPath, inside, MAX_FILES }
