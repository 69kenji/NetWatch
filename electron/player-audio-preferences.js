'use strict'

function normalizeAudioPreferences(value = {}) {
  const candidate = value && typeof value === 'object' ? value : {}
  return {
    playbackVolume: typeof candidate.playbackVolume === 'number' && Number.isFinite(candidate.playbackVolume)
      ? Math.max(0, Math.min(150, candidate.playbackVolume)) : 100,
    playbackMuted: candidate.playbackMuted === true,
  }
}

function createPlayerAudioPreferences({ getAppSettings, saveAppSettings }) {
  let current = normalizeAudioPreferences(getAppSettings())
  let pending = false
  let timer = null
  let commands = Promise.resolve()

  function flush() {
    clearTimeout(timer)
    timer = null
    if (!pending) return
    try {
      saveAppSettings(current)
      pending = false
    } catch (error) {
      console.warn('[Player] Could not save audio preferences:', error.message)
    }
  }

  function execute(action, send) {
    if (action?.type !== 'setVolume' && action?.type !== 'setMute') return send(action)
    if (action.type === 'setVolume' && (typeof action.volume !== 'number' || !Number.isFinite(action.volume))) {
      return Promise.reject(new Error('Volume must be a finite number'))
    }
    if (action.type === 'setMute' && typeof action.muted !== 'boolean') {
      return Promise.reject(new Error('Mute must be a boolean'))
    }
    const normalized = action.type === 'setVolume'
      ? { type: 'setVolume', volume: Math.max(0, Math.min(150, action.volume)) }
      : { type: 'setMute', muted: action.muted }
    // Preserve slider order even if IPC replies arrive on different turns.
    const result = commands.then(async () => {
      const response = await send(normalized)
      current = { ...current, ...(normalized.type === 'setVolume'
        ? { playbackVolume: normalized.volume } : { playbackMuted: normalized.muted }) }
      pending = true
      clearTimeout(timer)
      timer = setTimeout(flush, 250)
      return response
    })
    commands = result.catch(() => {})
    return result
  }

  return {
    get: () => ({ ...current }),
    execute,
    flush,
    settle: async () => { await commands; flush() },
  }
}

module.exports = { createPlayerAudioPreferences, normalizeAudioPreferences }
