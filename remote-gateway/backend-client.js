const http = require('http')

const DEFAULT_TIMEOUT_MS = 30_000
const MAX_JSON_BYTES = 8 * 1024 * 1024

class BackendError extends Error {
  constructor(status, payload) {
    const detail = payload?.detail
    const message = typeof detail === 'string'
      ? detail
      : detail?.error || payload?.error || `Backend request failed with status ${status}`
    super(String(message))
    this.status = status
    this.payload = payload
  }
}

class BackendClient {
  constructor(baseUrl = 'http://127.0.0.1:8000') {
    const parsed = new URL(baseUrl)
    if (parsed.protocol !== 'http:' || parsed.hostname !== '127.0.0.1' || parsed.username || parsed.password) {
      throw new Error('Remote gateway backend must be fixed to IPv4 loopback HTTP')
    }
    this.baseUrl = parsed.origin
  }

  async json(method, pathname, { body, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
    if (!/^\/api\/[A-Za-z0-9/?=&._%-]+$/u.test(pathname) || pathname.includes('://')) {
      throw new Error('Backend path is not on the approved API surface')
    }
    const rawPath = pathname.split('?', 1)[0]
    const target = new URL(pathname, this.baseUrl)
    if (rawPath.includes('%') || target.origin !== this.baseUrl || !target.pathname.startsWith('/api/')) {
      throw new Error('Backend path is not on the approved API surface')
    }
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const response = await fetch(target, {
        method,
        headers: {
          Accept: 'application/json',
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        cache: 'no-store',
        redirect: 'error',
        signal: controller.signal,
      })
      const raw = Buffer.from(await response.arrayBuffer())
      if (raw.length > MAX_JSON_BYTES) throw new Error('Backend JSON response exceeds the gateway limit')
      let payload = null
      if (raw.length) {
        try {
          payload = JSON.parse(raw.toString('utf8'))
        } catch {
          throw new Error('Backend returned malformed JSON')
        }
      }
      if (!response.ok) throw new BackendError(response.status, payload)
      return payload
    } catch (error) {
      if (error?.name === 'AbortError') throw new BackendError(504, { error: 'Backend request timed out' })
      throw error
    } finally {
      clearTimeout(timer)
    }
  }

  stream(infoHash, remoteRequest, remoteResponse, { onClosed } = {}) {
    const normalizedHash = String(infoHash || '').toLowerCase()
    if (!/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/u.test(normalizedHash)) {
      throw new Error('Playback session contains an invalid torrent identifier')
    }

    const headers = { Accept: '*/*' }
    const range = remoteRequest.headers.range
    if (range) headers.Range = range
    const backendRequest = http.request(`${this.baseUrl}/api/torrents/stream/${normalizedHash}`, {
      method: remoteRequest.method,
      headers,
      timeout: 250_000,
    })

    let finished = false
    const finish = () => {
      if (finished) return
      finished = true
      onClosed?.()
    }

    backendRequest.on('response', backendResponse => {
      const responseHeaders = {}
      for (const name of ['content-type', 'content-length', 'content-range', 'accept-ranges', 'x-netwatch-piece-gated']) {
        const value = backendResponse.headers[name]
        if (typeof value === 'string') responseHeaders[name] = value
      }
      responseHeaders['cache-control'] = 'no-store'
      responseHeaders['x-content-type-options'] = 'nosniff'
      remoteResponse.writeHead(backendResponse.statusCode || 502, responseHeaders)
      backendResponse.on('error', () => remoteResponse.destroy())
      backendResponse.on('close', finish)
      backendResponse.pipe(remoteResponse)
    })
    backendRequest.on('timeout', () => backendRequest.destroy(new Error('Backend stream timed out')))
    backendRequest.on('error', error => {
      if (!remoteResponse.headersSent) {
        const payload = Buffer.from(JSON.stringify({ error: { code: 'PLAYBACK_NOT_READY', message: 'Media stream is unavailable' } }))
        remoteResponse.writeHead(503, {
          'content-type': 'application/json',
          'content-length': String(payload.length),
          'cache-control': 'no-store',
        })
        remoteResponse.end(payload)
      } else {
        remoteResponse.destroy(error)
      }
      finish()
    })
    remoteRequest.on('aborted', () => backendRequest.destroy())
    remoteRequest.on('close', () => {
      if (!remoteRequest.complete) backendRequest.destroy()
    })
    backendRequest.end()
    return backendRequest
  }
}

module.exports = { BackendClient, BackendError, MAX_JSON_BYTES }
