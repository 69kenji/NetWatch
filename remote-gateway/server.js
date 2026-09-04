const crypto = require('crypto')
const https = require('https')

const { BackendClient, BackendError } = require('./backend-client')
const { DeviceStore } = require('./state-store')
const {
  assertSafeResponse,
  isPrivateIpv4,
  isSameSubnet,
  normalizeDeviceName,
  normalizeIpv4,
  parseCatalogId,
  sanitizeRemotePayload,
  sha256Base64Url,
  timingSafeTextEqual,
} = require('./security')

const PROTOCOL_VERSION = 1
const DEFAULT_PORT = 42117
const PAIRING_TTL_MS = 5 * 60 * 1000
const SESSION_IDLE_MS = 30 * 60 * 1000
const MAX_BODY_BYTES = 64 * 1024
const MAX_GLOBAL_STREAMS = 3
const MAX_ASSET_BYTES = 12 * 1024 * 1024

class RemoteError extends Error {
  constructor(code, status, message, retryAfter = null) {
    super(message)
    this.code = code
    this.status = status
    this.retryAfter = retryAfter
  }
}

class SlidingWindowLimiter {
  constructor() {
    this.buckets = new Map()
  }

  take(key, limit, windowMs) {
    const now = Date.now()
    const previous = this.buckets.get(key) || []
    const active = previous.filter(timestamp => timestamp > now - windowMs)
    if (active.length >= limit) {
      this.buckets.set(key, active)
      return Math.max(1, Math.ceil((active[0] + windowMs - now) / 1000))
    }
    active.push(now)
    this.buckets.set(key, active)
    if (this.buckets.size > 2048) {
      for (const [bucketKey, timestamps] of this.buckets) {
        if (!timestamps.length || timestamps[timestamps.length - 1] <= now - windowMs) this.buckets.delete(bucketKey)
        if (this.buckets.size <= 1024) break
      }
    }
    return 0
  }
}

function jsonBody(request) {
  return new Promise((resolve, reject) => {
    const contentType = String(request.headers['content-type'] || '').split(';', 1)[0].trim().toLowerCase()
    if (contentType !== 'application/json') {
      reject(new RemoteError('INVALID_CONTENT_TYPE', 415, 'Content-Type must be application/json'))
      return
    }
    const declared = Number(request.headers['content-length'] || 0)
    if (!Number.isFinite(declared) || declared < 0 || declared > MAX_BODY_BYTES) {
      reject(new RemoteError('REQUEST_TOO_LARGE', 413, 'Request body exceeds the size limit'))
      return
    }
    const chunks = []
    let total = 0
    request.on('data', chunk => {
      total += chunk.length
      if (total > MAX_BODY_BYTES) {
        reject(new RemoteError('REQUEST_TOO_LARGE', 413, 'Request body exceeds the size limit'))
        request.destroy()
        return
      }
      chunks.push(chunk)
    })
    request.on('end', () => {
      try {
        const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('object required')
        resolve(parsed)
      } catch {
        reject(new RemoteError('INVALID_JSON', 400, 'Request body must be a JSON object'))
      }
    })
    request.on('error', reject)
  })
}

function boundedInteger(value, label, minimum, maximum) {
  if (value === null || value === undefined || value === '') return null
  if (!/^\d+$/u.test(String(value))) throw new RemoteError('INVALID_INPUT', 422, `${label} is invalid`)
  const number = Number(value)
  if (!Number.isSafeInteger(number) || number < minimum || number > maximum) {
    throw new RemoteError('INVALID_INPUT', 422, `${label} is out of range`)
  }
  return number
}

function mapBackendError(error) {
  if (!(error instanceof BackendError)) return error
  if (error.status === 404) return new RemoteError('NOT_FOUND', 404, 'Requested resource was not found')
  if (error.status === 410) return new RemoteError('RELEASE_EXPIRED', 410, 'Release reference expired; refresh stream options')
  if (error.status === 429) return new RemoteError('RATE_LIMITED', 429, 'The protected runtime is rate limited')
  if (error.status === 504) return new RemoteError('RUNTIME_NOT_READY', 503, 'The protected runtime did not respond in time')
  return new RemoteError('RUNTIME_NOT_READY', 503, 'The protected NetWatch runtime is unavailable')
}

function transformBackendPayload(value) {
  if (Array.isArray(value)) return value.map(transformBackendPayload)
  if (!value || typeof value !== 'object') {
    if (typeof value === 'string' && value.startsWith('http://127.0.0.1:8000/api/metadata/image/')) {
      return value.replace('http://127.0.0.1:8000/api/metadata/image/', '/remote/v1/artwork/')
    }
    if (typeof value === 'string' && /^(?:https?|file):\/\//iu.test(value.trim())) return null
    return value
  }
  const safe = sanitizeRemotePayload(value)
  for (const [key, child] of Object.entries(safe)) safe[key] = transformBackendPayload(child)
  return safe
}

class RemoteGateway {
  constructor(config) {
    if (!isPrivateIpv4(config.host)) throw new Error('Gateway host must be a private IPv4 address')
    if (!isPrivateIpv4(config.host) || !config.netmask || !config.tls?.key || !config.tls?.cert) {
      throw new Error('Gateway configuration is incomplete')
    }
    this.host = config.host
    this.netmask = config.netmask
    this.port = Number(config.port || DEFAULT_PORT)
    this.desktopVersion = String(config.desktopVersion || 'unknown')
    this.runtimeReady = Boolean(config.runtimeReady)
    this.serverSpkiSha256 = String(config.serverSpkiSha256 || '')
    this.backend = new BackendClient(config.backendBaseUrl)
    this.deviceStore = new DeviceStore(config.devicesPath)
    this.canCleanupTorrent = config.canCleanupTorrent || (async () => true)
    this.onEvent = config.onEvent || (() => {})
    this.pairing = null
    this.sessions = new Map()
    this.torrentLeases = new Map()
    this.activeStreams = new Map()
    this.activeTorrentStreams = new Map()
    this.activeConnections = new Map()
    this.limiter = new SlidingWindowLimiter()
    this.cleanupTimer = null
    this.server = https.createServer({
      key: config.tls.key,
      cert: config.tls.cert,
      minVersion: 'TLSv1.2',
      honorCipherOrder: true,
      requestCert: false,
    }, (request, response) => void this.handle(request, response))
    this.server.maxHeadersCount = 48
    this.server.headersTimeout = 10_000
    this.server.requestTimeout = 30_000
    this.server.keepAliveTimeout = 10_000
    this.server.on('clientError', (_error, socket) => socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n'))
  }

  async start() {
    await new Promise((resolve, reject) => {
      this.server.once('error', reject)
      this.server.listen(this.port, this.host, () => {
        this.server.off('error', reject)
        resolve()
      })
    })
    const address = this.server.address()
    this.port = typeof address === 'object' && address ? address.port : this.port
    this.cleanupTimer = setInterval(() => void this.cleanupExpiredSessions(), 60_000)
    this.cleanupTimer.unref?.()
    this.emitStatus()
    return this.status()
  }

  async stop() {
    if (this.cleanupTimer) clearInterval(this.cleanupTimer)
    this.cleanupTimer = null
    this.pairing = null
    for (const connections of this.activeConnections.values()) {
      for (const connection of connections) connection.response.destroy()
    }
    await Promise.allSettled([...this.sessions.keys()].map(id => this.closeSession(id, null, { force: true })))
    if (this.server.listening) {
      await new Promise(resolve => this.server.close(() => resolve()))
    }
  }

  setRuntimeReady(ready) {
    this.runtimeReady = Boolean(ready)
    this.emitStatus()
  }

  status() {
    return {
      enabled: this.server.listening,
      host: this.host,
      port: this.port,
      protocol_min: PROTOCOL_VERSION,
      protocol_max: PROTOCOL_VERSION,
      runtime_ready: this.runtimeReady,
      pairing_active: Boolean(this.pairing && this.pairing.expiresAt > Date.now()),
      paired_devices: this.deviceStore.listPublic(),
    }
  }

  emitStatus() {
    this.onEvent({ type: 'status', status: this.status() })
  }

  beginPairing() {
    const expiresAt = Date.now() + PAIRING_TTL_MS
    this.pairing = {
      secret: crypto.randomBytes(24).toString('base64url'),
      expiresAt,
      attempts: 0,
      sourceAttempts: new Map(),
    }
    const payload = {
      version: PROTOCOL_VERSION,
      host: this.host,
      port: this.port,
      pairing_secret: this.pairing.secret,
      server_spki_sha256: this.serverSpkiSha256,
      expires_at: new Date(expiresAt).toISOString(),
    }
    this.emitStatus()
    return payload
  }

  cancelPairing() {
    this.pairing = null
    this.emitStatus()
    return this.status()
  }

  revokeDevice(deviceId) {
    const changed = this.deviceStore.revoke(deviceId)
    if (changed) this.terminateDevice(deviceId)
    this.emitStatus()
    return changed
  }

  revokeAll() {
    const changed = this.deviceStore.revokeAll()
    for (const device of this.deviceStore.listPublic()) this.terminateDevice(device.id)
    this.emitStatus()
    return changed
  }

  terminateDevice(deviceId) {
    const connections = this.activeConnections.get(deviceId) || new Set()
    for (const connection of connections) connection.response.destroy()
    this.activeConnections.delete(deviceId)
    for (const [sessionId, session] of this.sessions) {
      if (session.deviceId === deviceId) void this.closeSession(sessionId, deviceId, { force: true })
    }
  }

  assertLanPeer(request) {
    const peer = normalizeIpv4(request.socket.remoteAddress)
    if (!isPrivateIpv4(peer) || !isSameSubnet(this.host, peer, this.netmask)) {
      throw new RemoteError('LAN_ONLY', 403, 'Remote access is limited to the selected private LAN')
    }
    return peer
  }

  authenticate(request) {
    const header = String(request.headers.authorization || '')
    const match = /^Bearer ([A-Za-z0-9_-]{43})$/u.exec(header)
    const hash = sha256Base64Url(match ? match[1] : '')
    const device = this.deviceStore.authenticate(hash)
    if (!device) throw new RemoteError('AUTH_REQUIRED', 401, 'A valid paired-device credential is required')
    this.deviceStore.touch(device.id)
    return device
  }

  requireRuntime() {
    if (!this.runtimeReady) throw new RemoteError('RUNTIME_NOT_READY', 503, 'The protected NetWatch runtime is not ready')
  }

  rateLimit(key, limit, windowMs) {
    const retryAfter = this.limiter.take(key, limit, windowMs)
    if (retryAfter) throw new RemoteError('RATE_LIMITED', 429, 'Too many requests', retryAfter)
  }

  sendJson(response, status, body, extraHeaders = {}) {
    const payload = Buffer.from(JSON.stringify(body))
    response.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'content-length': String(payload.length),
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
      ...extraHeaders,
    })
    response.end(payload)
  }

  sendError(response, error) {
    const safe = error instanceof RemoteError
      ? error
      : new RemoteError('INTERNAL_ERROR', 500, 'The remote gateway could not complete the request')
    if (!(error instanceof RemoteError)) console.error('[RemoteGateway]', error)
    const headers = safe.retryAfter ? { 'retry-after': String(safe.retryAfter) } : {}
    this.sendJson(response, safe.status, { error: { code: safe.code, message: safe.message } }, headers)
  }

  async backendJson(method, pathname, options) {
    try {
      const payload = transformBackendPayload(await this.backend.json(method, pathname, options))
      assertSafeResponse(payload)
      return payload
    } catch (error) {
      throw mapBackendError(error)
    }
  }

  async backendInternalJson(method, pathname, options) {
    try {
      return await this.backend.json(method, pathname, options)
    } catch (error) {
      throw mapBackendError(error)
    }
  }

  async handle(request, response) {
    try {
      if (String(request.url || '').length > 2048) throw new RemoteError('INVALID_INPUT', 414, 'Request target is too long')
      const peer = this.assertLanPeer(request)
      if (String(request.headers.host || '') !== `${this.host}:${this.port}`) {
        throw new RemoteError('INVALID_HOST', 421, 'Request host does not match the selected gateway interface')
      }
      this.rateLimit(`request-peer:${peer}`, 600, 60_000)
      if (request.headers.origin) throw new RemoteError('BROWSER_ORIGIN_REJECTED', 403, 'Browser-origin requests are not accepted')
      if (request.method === 'OPTIONS') throw new RemoteError('METHOD_NOT_ALLOWED', 405, 'Method not allowed')
      const url = new URL(request.url, `https://${this.host}:${this.port}`)
      const pathname = url.pathname

      if (request.method === 'GET' && pathname === '/remote/v1/health') {
        if (!this.pairing || this.pairing.expiresAt <= Date.now()) throw new RemoteError('NOT_FOUND', 404, 'Not found')
        this.rateLimit(`health:${peer}`, 20, 60_000)
        this.sendJson(response, 200, { status: 'ok', protocol_min: 1, protocol_max: 1 })
        return
      }

      if (request.method === 'POST' && pathname === '/remote/v1/pair/claim') {
        await this.claimPairing(request, response, peer)
        return
      }

      let device
      try {
        device = this.authenticate(request)
      } catch (error) {
        if (error instanceof RemoteError && error.code === 'AUTH_REQUIRED') {
          this.rateLimit(`auth-failure:${peer}`, 30, 60_000)
        }
        throw error
      }
      this.trackConnection(device.id, request, response)

      if (request.method === 'GET' && pathname === '/remote/v1/status') {
        this.sendJson(response, 200, {
          protocol_min: PROTOCOL_VERSION,
          protocol_max: PROTOCOL_VERSION,
          desktop_version: this.desktopVersion,
          runtime_ready: this.runtimeReady,
        })
        return
      }

      if (request.method === 'DELETE' && pathname === '/remote/v1/device/self') {
        this.deviceStore.revoke(device.id)
        this.sendJson(response, 200, { revoked: true })
        setImmediate(() => {
          this.terminateDevice(device.id)
          this.emitStatus()
        })
        return
      }

      if (pathname.startsWith('/remote/v1/playback')) {
        await this.handlePlayback(request, response, url, device)
        return
      }

      this.requireRuntime()
      await this.handleCatalog(request, response, url, device)
    } catch (error) {
      if (!response.headersSent && !response.destroyed) this.sendError(response, error)
      else if (!response.destroyed) response.destroy()
    }
  }

  trackConnection(deviceId, request, response) {
    const connections = this.activeConnections.get(deviceId) || new Set()
    const item = { request, response }
    connections.add(item)
    this.activeConnections.set(deviceId, connections)
    response.once('close', () => {
      connections.delete(item)
      if (!connections.size) this.activeConnections.delete(deviceId)
    })
  }

  async claimPairing(request, response, peer) {
    this.rateLimit(`pair-ip:${peer}`, 8, 10 * 60_000)
    const pairing = this.pairing
    if (!pairing || pairing.expiresAt <= Date.now()) throw new RemoteError('PAIRING_EXPIRED', 410, 'Pairing is not active')
    const sourceAttempts = pairing.sourceAttempts.get(peer) || 0
    if (pairing.attempts >= 8 || sourceAttempts >= 5) {
      this.pairing = null
      this.emitStatus()
      throw new RemoteError('PAIRING_LOCKED', 429, 'Pairing was locked after repeated failures', 300)
    }
    const body = await jsonBody(request)
    const secret = String(body.pairing_secret || '')
    if (!timingSafeTextEqual(secret, pairing.secret)) {
      pairing.attempts += 1
      pairing.sourceAttempts.set(peer, sourceAttempts + 1)
      throw new RemoteError('PAIRING_REJECTED', 401, 'Pairing claim was rejected')
    }
    let name
    try {
      name = normalizeDeviceName(body.device_name)
    } catch {
      throw new RemoteError('INVALID_INPUT', 422, 'Device name must be 1-80 characters')
    }
    const credential = crypto.randomBytes(32).toString('base64url')
    const now = new Date().toISOString()
    const device = {
      id: crypto.randomUUID(),
      name,
      credential_hash: sha256Base64Url(credential),
      paired_at: now,
      last_seen: now,
      revoked: false,
    }
    this.deviceStore.add(device)
    this.pairing = null
    this.emitStatus()
    this.sendJson(response, 201, {
      device_id: device.id,
      device_credential: credential,
      protocol_min: PROTOCOL_VERSION,
      protocol_max: PROTOCOL_VERSION,
    })
  }

  async handleCatalog(request, response, url, device) {
    if (request.method !== 'GET') throw new RemoteError('METHOD_NOT_ALLOWED', 405, 'Method not allowed')
    const path = url.pathname
    const deviceKey = `catalog:${device.id}`
    this.rateLimit(deviceKey, 90, 60_000)

    let backendPath
    let shape = null
    if (path === '/remote/v1/home') {
      backendPath = '/api/metadata/home'
    } else if (path === '/remote/v1/discover/genres') {
      const media = String(url.searchParams.get('media') || 'movies')
      if (!['movies', 'tv', 'anime'].includes(media)) {
        throw new RemoteError('INVALID_INPUT', 422, 'Discover filters are invalid')
      }
      backendPath = `/api/metadata/discover/genres?media=${encodeURIComponent(media)}`
    } else if (path === '/remote/v1/discover') {
      const media = String(url.searchParams.get('media') || 'movies')
      const category = String(url.searchParams.get('category') || 'popular')
      if (!['movies', 'tv', 'anime'].includes(media) || !['popular', 'new', 'featured'].includes(category)) {
        throw new RemoteError('INVALID_INPUT', 422, 'Discover filters are invalid')
      }
      const genre = boundedInteger(url.searchParams.get('genre'), 'Genre', 1, 99999)
      backendPath = `/api/metadata/discover?media=${encodeURIComponent(media)}&category=${encodeURIComponent(category)}${genre ? `&genre=${genre}` : ''}`
    } else if (path === '/remote/v1/search') {
      const query = String(url.searchParams.get('q') || '').trim()
      if (!query || query.length > 160) throw new RemoteError('INVALID_INPUT', 422, 'Search query must be 1-160 characters')
      const page = boundedInteger(url.searchParams.get('page') || '1', 'Page', 1, 500)
      backendPath = `/api/metadata/search?query=${encodeURIComponent(query)}&page=${page}`
    } else if (path.startsWith('/remote/v1/artwork/')) {
      await this.handleArtwork(request, response, path)
      return
    } else {
      const match = /^\/remote\/v1\/title\/([^/]+)(.*)$/u.exec(path)
      if (!match) throw new RemoteError('NOT_FOUND', 404, 'Not found')
      const catalog = parseCatalogId(decodeURIComponent(match[1]))
      const suffix = match[2]
      const base = catalog.kind === 'movie' ? `/api/metadata/movies/${catalog.id}` : `/api/metadata/series/${catalog.id}`
      if (!suffix) {
        backendPath = base
      } else if (suffix === '/seasons' && catalog.kind === 'tv') {
        backendPath = base
        shape = payload => ({ catalog_id: `tv:${catalog.id}`, seasons: payload.seasons || [] })
      } else if (suffix === '/stream-options' && catalog.kind === 'movie') {
        backendPath = `${base}/stream-options`
      } else {
        const season = /^\/season\/(\d{1,4})$/u.exec(suffix)
        const episode = /^\/episode\/(\d{1,4})\/(\d{1,4})\/stream-options$/u.exec(suffix)
        if (season && catalog.kind === 'tv') {
          const seasonNumber = boundedInteger(season[1], 'Season', 0, 9999)
          backendPath = `${base}/seasons/${seasonNumber}`
        } else if (episode && catalog.kind === 'tv') {
          const seasonNumber = boundedInteger(episode[1], 'Season', 0, 9999)
          const episodeNumber = boundedInteger(episode[2], 'Episode', 0, 9999)
          backendPath = `${base}/episodes/${seasonNumber}/${episodeNumber}/stream-options`
        } else {
          throw new RemoteError('NOT_FOUND', 404, 'Not found')
        }
      }
    }

    let payload = await this.backendJson('GET', backendPath, { timeoutMs: 35_000 })
    if (shape) payload = shape(payload)
    this.sendJson(response, 200, payload)
  }

  async handleArtwork(request, response, pathname) {
    const match = /^\/remote\/v1\/artwork\/(w92|w154|w185|w300|w342|w500|w780|w1280|original)\/([A-Za-z0-9._-]{1,240})$/u.exec(pathname)
    if (!match) throw new RemoteError('NOT_FOUND', 404, 'Artwork was not found')
    await this.pipeBackendAsset(request, response, `/api/metadata/image/${match[1]}/${match[2]}`)
  }

  sessionFor(device, sessionId) {
    const session = this.sessions.get(sessionId)
    if (!session || session.deviceId !== device.id) throw new RemoteError('SESSION_EXPIRED', 404, 'Playback session is unavailable')
    if (Date.now() - session.lastActivity > SESSION_IDLE_MS) {
      void this.closeSession(sessionId, device.id, { force: true })
      throw new RemoteError('SESSION_EXPIRED', 410, 'Playback session expired')
    }
    session.lastActivity = Date.now()
    return session
  }

  async handlePlayback(request, response, url, device) {
    const pathname = url.pathname
    if (request.method === 'POST' && pathname === '/remote/v1/playback') {
      this.requireRuntime()
      this.rateLimit(`playback-create:${device.id}`, 6, 10 * 60_000)
      const body = await jsonBody(request)
      const releaseRef = String(body.release_ref || '').trim()
      const mediaName = String(body.media_name || '').trim()
      if (!/^[A-Za-z0-9_-]{32,128}$/u.test(releaseRef) || !mediaName || mediaName.length > 240) {
        throw new RemoteError('INVALID_INPUT', 422, 'Playback request is invalid')
      }
      const catalog = parseCatalogId(body.catalog_id)
      const season = boundedInteger(body.season, 'Season', 0, 9999)
      const episode = boundedInteger(body.episode, 'Episode', 0, 9999)
      if (catalog.kind === 'movie' && (season !== null || episode !== null)) {
        throw new RemoteError('INVALID_INPUT', 422, 'Movie playback cannot include episode context')
      }
      if (catalog.kind === 'tv' && (season === null || episode === null)) {
        throw new RemoteError('INVALID_INPUT', 422, 'Episode playback requires season and episode')
      }
      const added = await this.backendInternalJson('POST', '/api/torrents/add', {
        body: { release_ref: releaseRef, media_name: mediaName },
        timeoutMs: 45_000,
      })
      const internalHash = String(added.hash || '').toLowerCase()
      if (!/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/u.test(internalHash)) {
        throw new RemoteError('PLAYBACK_NOT_READY', 503, 'Torrent engine returned an invalid session')
      }
      const sessionId = crypto.randomBytes(24).toString('base64url')
      const session = {
        id: sessionId,
        deviceId: device.id,
        infoHash: internalHash,
        ownsTorrent: !added.already_existed,
        catalogId: `${catalog.kind}:${catalog.id}`,
        mediaName,
        season,
        episode,
        createdAt: Date.now(),
        lastActivity: Date.now(),
        subtitleOptionRefs: new Map(),
        subtitleRefs: new Map(),
      }
      this.sessions.set(sessionId, session)
      const lease = this.torrentLeases.get(internalHash) || { count: 0, owned: false }
      lease.count += 1
      lease.owned ||= session.ownsTorrent
      this.torrentLeases.set(internalHash, lease)
      this.sendJson(response, 201, { session_id: sessionId, state: 'buffering', catalog_id: session.catalogId })
      return
    }

    const match = /^\/remote\/v1\/playback\/([A-Za-z0-9_-]{32})(.*)$/u.exec(pathname)
    if (!match) throw new RemoteError('NOT_FOUND', 404, 'Not found')
    const session = this.sessionFor(device, match[1])
    const suffix = match[2]

    if (request.method === 'GET' && !suffix) {
      this.rateLimit(`playback-status:${device.id}`, 180, 60_000)
      const status = await this.backendInternalJson('GET', `/api/torrents/playback-status/${session.infoHash}`, { timeoutMs: 10_000 })
      this.sendJson(response, 200, {
        session_id: session.id,
        state: status.ready ? 'ready' : String(status.stage || 'buffering'),
        ready: Boolean(status.ready),
        progress: Number(status.video_progress ?? status.progress ?? 0),
        buffer_progress: Number(status.buffer_progress || 0),
        buffered_bytes: Number(status.buffered_bytes || 0),
        buffer_target_bytes: Number(status.buffer_target_bytes || 0),
        download_speed_bps: Number(status.dl_speed || 0),
        connected_peers: Number(status.peers || 0) + Number(status.seeds || 0),
        message: String(status.message || ''),
      })
      return
    }

    if (['GET', 'HEAD'].includes(request.method) && suffix === '/stream') {
      this.openMediaStream(request, response, device, session)
      return
    }

    if (request.method === 'GET' && suffix === '/tracks') {
      this.sendJson(response, 200, {
        embedded_tracks: 'client_managed',
        audio_selection: 'client_managed',
        subtitle_selection: 'client_managed',
      })
      return
    }

    if (request.method === 'GET' && suffix === '/subtitles') {
      this.rateLimit(`subtitle-search:${device.id}`, 10, 60_000)
      const languages = String(url.searchParams.get('languages') || 'en')
      if (!/^[A-Za-z,-]{1,80}$/u.test(languages)) throw new RemoteError('INVALID_INPUT', 422, 'Subtitle languages are invalid')
      const catalog = parseCatalogId(session.catalogId)
      const query = new URLSearchParams({ query: session.mediaName, languages })
      if (session.season !== null) query.set('season', String(session.season))
      if (session.episode !== null) query.set('episode', String(session.episode))
      const details = await this.backendJson('GET', catalog.kind === 'movie'
        ? `/api/metadata/movies/${catalog.id}`
        : `/api/metadata/series/${catalog.id}`)
      if (details.imdb_id) query.set('imdb_id', String(details.imdb_id).slice(0, 32))
      const payload = await this.backendInternalJson('GET', `/api/subtitles/search?${query.toString()}`, { timeoutMs: 35_000 })
      const results = Array.isArray(payload.results) ? payload.results.slice(0, 40) : []
      session.subtitleOptionRefs.clear()
      const safeResults = results.map(item => {
        const optionRef = crypto.randomBytes(18).toString('base64url')
        session.subtitleOptionRefs.set(optionRef, {
          subtitle_id: String(item.subtitle_id || item.id || '').slice(0, 200),
          source: String(item.source || ''),
          download_ref: String(item.download_ref || '').slice(0, 1024),
          format: item.format || null,
          file_name: item.file_name || null,
        })
        const safe = { subtitle_ref: optionRef }
        for (const key of ['language', 'language_code', 'release_name', 'file_name', 'format', 'source', 'hearing_impaired', 'score', 'download_count']) {
          if (item[key] !== undefined) safe[key] = item[key]
        }
        return safe
      })
      const remotePayload = {
        results: safeResults,
        count: safeResults.length,
        providers: sanitizeRemotePayload(payload.providers || {}),
      }
      assertSafeResponse(remotePayload)
      this.sendJson(response, 200, remotePayload)
      return
    }

    if (request.method === 'POST' && suffix === '/subtitles') {
      this.rateLimit(`subtitle-download:${device.id}`, 12, 60_000)
      const body = await jsonBody(request)
      const optionRef = String(body.subtitle_ref || '')
      const option = session.subtitleOptionRefs.get(optionRef)
      if (!/^[A-Za-z0-9_-]{24}$/u.test(optionRef) || !option) {
        throw new RemoteError('INVALID_INPUT', 422, 'Subtitle reference is invalid or expired')
      }
      session.subtitleOptionRefs.delete(optionRef)
      const payload = await this.backendInternalJson('POST', '/api/subtitles/download', { body: option, timeoutMs: 40_000 })
      const backendToken = String(payload.token || '')
      if (!/^[A-Za-z0-9_-]{16,64}$/u.test(backendToken)) throw new RemoteError('PLAYBACK_NOT_READY', 503, 'Subtitle service returned an invalid reference')
      const subtitleRef = crypto.randomBytes(18).toString('base64url')
      session.subtitleRefs.set(subtitleRef, backendToken)
      this.sendJson(response, 201, {
        subtitle_ref: subtitleRef,
        content_path: `/remote/v1/playback/${session.id}/subtitles/${subtitleRef}`,
        filename: String(payload.filename || 'subtitle.srt').slice(0, 240),
        source: String(payload.source || ''),
      })
      return
    }

    const subtitleMatch = /^\/subtitles\/([A-Za-z0-9_-]{24})$/u.exec(suffix)
    if (request.method === 'GET' && subtitleMatch) {
      this.rateLimit(`subtitle-content:${device.id}`, 30, 60_000)
      const backendToken = session.subtitleRefs.get(subtitleMatch[1])
      if (!backendToken) throw new RemoteError('NOT_FOUND', 404, 'Subtitle is unavailable')
      await this.pipeBackendAsset(request, response, `/api/subtitles/file/${backendToken}`)
      return
    }

    if (request.method === 'DELETE' && !suffix) {
      await this.closeSession(session.id, device.id)
      this.sendJson(response, 200, { removed: true })
      return
    }
    throw new RemoteError('METHOD_NOT_ALLOWED', 405, 'Method not allowed')
  }

  openMediaStream(request, response, device, session) {
    const perDevice = this.activeStreams.get(device.id) || 0
    const total = [...this.activeStreams.values()].reduce((sum, count) => sum + count, 0)
    const torrentStreams = this.activeTorrentStreams.get(session.infoHash) || 0
    // The current torrent engine owns one seek/deadline window per info hash.
    // Until it grows independent scheduler consumers, concurrent streams of the
    // same torrent would be able to supersede one another's far seeks.
    if (perDevice >= 1 || total >= MAX_GLOBAL_STREAMS || torrentStreams >= 1) {
      throw new RemoteError('STREAM_LIMIT', 429, 'Playback stream concurrency limit reached', 2)
    }
    this.activeStreams.set(device.id, perDevice + 1)
    this.activeTorrentStreams.set(session.infoHash, torrentStreams + 1)
    session.lastActivity = Date.now()
    this.backend.stream(session.infoHash, request, response, {
      onClosed: () => {
        const remaining = Math.max(0, (this.activeStreams.get(device.id) || 1) - 1)
        if (remaining) this.activeStreams.set(device.id, remaining)
        else this.activeStreams.delete(device.id)
        const torrentRemaining = Math.max(0, (this.activeTorrentStreams.get(session.infoHash) || 1) - 1)
        if (torrentRemaining) this.activeTorrentStreams.set(session.infoHash, torrentRemaining)
        else this.activeTorrentStreams.delete(session.infoHash)
        session.lastActivity = Date.now()
      },
    })
  }

  pipeBackendAsset(request, response, backendPath) {
    return new Promise((resolve, reject) => {
      const backendRequest = require('http').request(`${this.backend.baseUrl}${backendPath}`, {
        method: 'GET',
        headers: { Accept: '*/*' },
        timeout: 35_000,
      }, backendResponse => {
        if ((backendResponse.statusCode || 500) >= 400) {
          backendResponse.resume()
          reject(new RemoteError('NOT_FOUND', 404, 'Requested content is unavailable'))
          return
        }
        const declaredLength = Number(backendResponse.headers['content-length'] || 0)
        if (Number.isFinite(declaredLength) && declaredLength > MAX_ASSET_BYTES) {
          backendResponse.destroy()
          reject(new RemoteError('RESPONSE_TOO_LARGE', 502, 'Requested content exceeds the gateway limit'))
          return
        }
        const headers = {
          'content-type': String(backendResponse.headers['content-type'] || 'application/octet-stream'),
          'cache-control': backendPath.startsWith('/api/metadata/image/') ? 'private, max-age=86400' : 'no-store',
          'x-content-type-options': 'nosniff',
        }
        const length = backendResponse.headers['content-length']
        if (typeof length === 'string') headers['content-length'] = length
        response.writeHead(200, headers)
        let received = 0
        backendResponse.on('data', chunk => {
          received += chunk.length
          if (received > MAX_ASSET_BYTES) {
            backendResponse.destroy(new Error('Asset response exceeds the gateway limit'))
            response.destroy()
          }
        })
        backendResponse.pipe(response)
        backendResponse.on('end', resolve)
        backendResponse.on('error', reject)
      })
      backendRequest.on('timeout', () => backendRequest.destroy(new Error('Asset proxy timed out')))
      backendRequest.on('error', reject)
      request.on('aborted', () => backendRequest.destroy())
      backendRequest.end()
    })
  }

  async closeSession(sessionId, deviceId, { force = false } = {}) {
    const session = this.sessions.get(sessionId)
    if (!session || (!force && session.deviceId !== deviceId)) return false
    this.sessions.delete(sessionId)
    const lease = this.torrentLeases.get(session.infoHash)
    if (lease) {
      lease.count = Math.max(0, lease.count - 1)
      if (!lease.count) {
        this.torrentLeases.delete(session.infoHash)
        if (lease.owned && await this.canCleanupTorrent(session.infoHash)) {
          try {
            await this.backend.json('DELETE', `/api/torrents/${session.infoHash}?delete_files=true`, { timeoutMs: 20_000 })
          } catch (error) {
            console.warn('[RemoteGateway] Could not clean up remote torrent:', error?.message || error)
          }
        }
      }
    }
    for (const token of session.subtitleRefs.values()) {
      try {
        await this.backend.json('DELETE', `/api/subtitles/file/${token}`, { timeoutMs: 5_000 })
      } catch { /* best-effort ephemeral subtitle cleanup */ }
    }
    return true
  }

  async cleanupExpiredSessions() {
    const cutoff = Date.now() - SESSION_IDLE_MS
    const expired = [...this.sessions.values()].filter(session => session.lastActivity <= cutoff)
    await Promise.allSettled(expired.map(session => this.closeSession(session.id, session.deviceId, { force: true })))
  }
}

module.exports = {
  DEFAULT_PORT,
  MAX_BODY_BYTES,
  MAX_ASSET_BYTES,
  PAIRING_TTL_MS,
  PROTOCOL_VERSION,
  RemoteError,
  RemoteGateway,
  SESSION_IDLE_MS,
  transformBackendPayload,
}
