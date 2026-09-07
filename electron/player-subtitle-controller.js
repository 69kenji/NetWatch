'use strict'

function createPlayerSubtitleController({ backendBaseUrl, backendJson, mpv }) {
  if (!backendBaseUrl || typeof backendJson !== 'function' || !mpv) {
    throw new Error('Player subtitle controller dependencies are invalid')
  }

  let activeToken = null

  async function releaseToken(token) {
    if (!token) return
    try {
      await backendJson(`/api/subtitles/file/${encodeURIComponent(token)}`, { method: 'DELETE' }, 3000)
    } catch (error) {
      // Subtitle payloads live only in the backend's in-memory cache and expire on
      // their own. Cleanup is best-effort so a provider/backend hiccup never blocks
      // closing the native player.
      console.warn('[Subtitle cleanup]', error?.message || error)
    }
  }

  function isLoopbackHostname(hostname) {
    const normalized = String(hostname || '').toLowerCase().replace(/^\[|\]$/gu, '')
    return normalized === '127.0.0.1' || normalized === 'localhost' || normalized === '::1'
  }

  function effectiveUrlPort(url) {
    if (url.port) return url.port
    if (url.protocol === 'http:') return '80'
    if (url.protocol === 'https:') return '443'
    return ''
  }

  function validateLocalSubtitleAction(action) {
    const token = typeof action?.token === 'string' ? action.token.trim() : ''
    if (!token) throw new Error('Subtitle token is required')
    if (typeof action?.path !== 'string' || !action.path.trim()) {
      throw new Error('Subtitle path is required')
    }

    let subtitleUrl
    let backendUrl
    try {
      subtitleUrl = new URL(action.path)
      backendUrl = new URL(backendBaseUrl)
    } catch (_) {
      throw new Error('Subtitle URL is invalid')
    }

    if (
      !isLoopbackHostname(subtitleUrl.hostname) ||
      !isLoopbackHostname(backendUrl.hostname) ||
      subtitleUrl.protocol !== backendUrl.protocol ||
      effectiveUrlPort(subtitleUrl) !== effectiveUrlPort(backendUrl) ||
      subtitleUrl.username ||
      subtitleUrl.password ||
      subtitleUrl.search ||
      subtitleUrl.hash
    ) {
      throw new Error('Subtitle URL must use the local NetWatch backend')
    }

    const prefix = '/api/subtitles/file/'
    if (!subtitleUrl.pathname.startsWith(prefix)) {
      throw new Error('Subtitle URL must use the NetWatch subtitle endpoint')
    }
    const encodedToken = subtitleUrl.pathname.slice(prefix.length)
    if (!encodedToken || encodedToken.includes('/')) {
      throw new Error('Subtitle URL contains an invalid token')
    }

    let pathToken
    try {
      pathToken = decodeURIComponent(encodedToken)
    } catch (_) {
      throw new Error('Subtitle URL contains an invalid token')
    }
    if (pathToken !== token) throw new Error('Subtitle URL token does not match the active subtitle')

    return { ...action, path: subtitleUrl.toString(), token }
  }

  async function execute(action) {
    if (!action || typeof action.type !== 'string') return mpv.execute(action)

    if (action.type === 'loadSubtitle') {
      const validatedAction = validateLocalSubtitleAction(action)
      const newToken = validatedAction.token
      const previousToken = activeToken
      try {
        const result = await mpv.execute(validatedAction)
        activeToken = newToken
        if (previousToken && previousToken !== newToken) void releaseToken(previousToken)
        return result
      } catch (error) {
        if (newToken) void releaseToken(newToken)
        throw error
      }
    }

    if (action.type === 'disableSubtitles') {
      const previousToken = activeToken
      const result = await mpv.execute(action)
      activeToken = null
      if (previousToken) void releaseToken(previousToken)
      return result
    }

    return mpv.execute(action)
  }

  async function releaseActive() {
    const token = activeToken
    activeToken = null
    if (token) await releaseToken(token)
  }

  return { execute, releaseActive }
}

module.exports = { createPlayerSubtitleController }
