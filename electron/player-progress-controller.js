'use strict'

function createPlayerProgressController({ getAppSettings, keepWatching, mpv }) {
  if (typeof getAppSettings !== 'function' || !keepWatching || !mpv) {
    throw new Error('Player progress controller dependencies are invalid')
  }

  let lastCheckpointAt = 0

  function reset() {
    lastCheckpointAt = 0
  }

  function checkpointDesktop(session, state = mpv.getState(), { force = false } = {}) {
    if (!session?.mediaItem || session.resumePending || !getAppSettings().keepWatchingEnabled) return false
    const now = Date.now()
    if (!force && now - lastCheckpointAt < 15_000) return false
    const status = String(state?.status || '')
    if (!force && status !== 'playing' && status !== 'paused') return false
    try {
      const changed = keepWatching.checkpoint(session.mediaItem, state?.position, state?.duration)
      if (changed) lastCheckpointAt = now
      return changed
    } catch (error) {
      lastCheckpointAt = now
      console.error('[KeepWatching] Could not save desktop playback progress:', error)
      return false
    }
  }

  async function applyResume(session) {
    if (!session?.resumePending) return
    const requested = Number(session.resumePositionSeconds)
    if (!Number.isFinite(requested) || requested <= 0) {
      session.resumePending = false
      return
    }
    const duration = Number(mpv.getState()?.duration)
    const target = Number.isFinite(duration) && duration > 0
      ? Math.max(0, Math.min(requested, Math.max(0, duration - 1)))
      : Math.max(0, requested)
    try {
      await mpv.execute({ type: 'seekAbsolute', seconds: target })
    } catch (error) {
      console.warn('[KeepWatching] Could not restore the saved playback position:', error?.message || error)
    } finally {
      session.resumePending = false
      lastCheckpointAt = Date.now()
    }
  }

  function checkpointRemote(payload) {
    const catalogId = String(payload?.catalogId || '')
    const match = /^(movie|tv):([1-9]\d{0,11})$/u.exec(catalogId)
    if (!match) return false
    return keepWatching.checkpoint({
      id: Number(match[2]),
      tmdb_id: Number(match[2]),
      type: match[1],
      title: payload?.title,
      season: payload?.season,
      episode: payload?.episode,
    }, payload?.positionSeconds, payload?.durationSeconds)
  }

  return {
    applyResume,
    checkpointDesktop,
    checkpointRemote,
    reset,
  }
}

module.exports = { createPlayerProgressController }
