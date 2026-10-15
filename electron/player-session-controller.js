'use strict'

const crypto = require('crypto')
const { MpvController } = require('./mpv-controller')
const { createPlayerProgressController } = require('./player-progress-controller')
const { createPlayerSubtitleController } = require('./player-subtitle-controller')
const { createPlayerWindowManager } = require('./player-window-manager')
const { createPlayerAudioPreferences } = require('./player-audio-preferences')
const { createPlayerEpisodeController } = require('./player-episode-controller')
const { playbackDuration, withFileTimings } = require('./player-episode-timing')
const { normalizePlaybackPreferences, PLAYBACK_DEFAULTS } = require('../shared/playback-preferences.mjs')
const { playbackProperties } = require('./player-playback-preferences')
const { METADATA_PREPARATION_TIMEOUT_MS, metadataPreparationTimedOut } = require('./preparation-policy')

const PREPARATION_POLL_MS = 400
const PREPARATION_REANNOUNCE_MS = 10_000
const PLAYER_TELEMETRY_POLL_MS = 1000

function createPlayerSessionController({
  backendBaseUrl,
  backendJson,
  getAppSettings,
  saveAppSettings,
  getMainWindow,
  hardenRendererNavigation,
  isDev,
  keepWatching,
  lifecycle,
  localLibrary = null,
  onQuitReady,
  playerRendererUrl,
  shouldMinimizeToTray,
}) {
  if (
    typeof backendJson !== 'function' ||
    typeof getAppSettings !== 'function' ||
    typeof saveAppSettings !== 'function' ||
    typeof getMainWindow !== 'function' ||
    typeof shouldMinimizeToTray !== 'function'
  ) {
    throw new Error('Player controller dependencies are invalid')
  }

  const mpv = new MpvController()
  let playerSession = null
  let playerPreparation = defaultPlayerPreparation()
  let playerPreparationGeneration = 0
  let closingPlayer = false
  let openingPlayer = false
  let nextEpisodePromise = null
  let nextEpisodeAbort = null
  let episodeInfoCache = null
  let preferenceQueue = Promise.resolve()
  let localStartupPromise = null
  const torrentOwners = new Map()

  const progress = createPlayerProgressController({ getAppSettings, keepWatching, mpv })
  const subtitles = createPlayerSubtitleController({ backendBaseUrl, backendJson, mpv })
  const audioPreferences = createPlayerAudioPreferences({ getAppSettings, saveAppSettings })
  const episodes = createPlayerEpisodeController({ backendJson, getAppSettings })
  const windows = createPlayerWindowManager({
    getMainWindow,
    hardenRendererNavigation,
    isDev,
    mpv,
    onNativeCloseRequested: () => handleNativeCloseRequested(),
    onOverlayClosed: () => {
      if (!closingPlayer && playerSession) void closePlayerSession()
    },
    onWindowStateChanged: state => sendToPlayerRenderer('player:window-state', state),
    playerRendererUrl,
    shouldAllowNativeClose: () => closingPlayer || lifecycle.quitCleanupComplete,
  })

  function defaultPlayerPreparation() {
    return {
      stage: 'idle',
      ready: false,
      message: null,
      infoHash: null,
      progress: null,
      videoProgress: null,
      downloaded: 0,
      size: 0,
      dlSpeed: 0,
      seeders: 0,
      peers: 0,
      torrentState: null,
      firstReady: false,
      lastReady: false,
      bufferedBytes: 0,
      bufferTargetBytes: 0,
      bufferProgress: 0,
      error: null,
      updatedAt: new Date().toISOString(),
    }
  }
  
  function sendToPlayerRenderer(channel, payload) {
    const overlayWindow = windows.getOverlayWindow()
    if (overlayWindow && !overlayWindow.isDestroyed()) {
      overlayWindow.webContents.send(channel, payload)
    }
    if (getMainWindow() && !getMainWindow().isDestroyed()) {
      getMainWindow().webContents.send(channel, payload)
    }
  }
  
  function setPlayerPreparation(patch) {
    playerPreparation = {
      ...playerPreparation,
      ...patch,
      updatedAt: new Date().toISOString(),
    }
    sendToPlayerRenderer('player:preparation', { ...playerPreparation })
    return { ...playerPreparation }
  }
  
  
  async function deleteTorrentAndData(infoHash, ownerToken = torrentOwners.get(String(infoHash).toLowerCase())) {
    if (typeof infoHash !== 'string' || !infoHash.trim()) return true
    if (!ownerToken) return true
  
    const normalized = infoHash.trim().toLowerCase()
    let lastError = null
  
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        const payload = await backendJson(
          `/api/torrents/${encodeURIComponent(normalized)}?delete_files=true`,
          { method: 'DELETE', headers: { 'X-NetWatch-Owner': ownerToken } },
          5000,
        )
        if (payload?.removed === true && payload?.verified_absent === true) {
          if (torrentOwners.get(normalized) === ownerToken) torrentOwners.delete(normalized)
          console.log(`[Player cleanup] Removed torrent ${normalized} and its data`)
          return true
        }
        throw new Error(`torrent cleanup was not verified for ${normalized}`)
      } catch (error) {
        if (error?.status === 404 || error?.status === 409) {
          if (torrentOwners.get(normalized) === ownerToken) torrentOwners.delete(normalized)
          return true
        }
        lastError = error
        if (attempt < 3) {
          await new Promise(resolve => setTimeout(resolve, attempt * 250))
        }
      }
    }
  
    throw lastError || new Error(`torrent cleanup failed for ${normalized}`)
  }
  
  function preparationFromBackend(status) {
    return {
      stage: status.stage || 'buffering',
      ready: Boolean(status.ready),
      message: status.message || 'Preparing stream…',
      infoHash: status.hash || playerSession?.infoHash || null,
      progress: Number.isFinite(status.progress) ? status.progress : null,
      videoProgress: Number.isFinite(status.video_progress) ? status.video_progress : null,
      downloaded: Number(status.downloaded) || 0,
      size: Number(status.size) || 0,
      dlSpeed: Number(status.dl_speed) || 0,
      seeders: Number(status.seeds) || 0,
      peers: Number(status.peers) || 0,
      torrentState: status.state || null,
      firstReady: Boolean(status.first_ready),
      lastReady: Boolean(status.last_ready),
      bufferedBytes: Number(status.buffered_bytes) || 0,
      bufferTargetBytes: Number(status.buffer_target_bytes) || 0,
      bufferProgress: Number.isFinite(status.buffer_progress)
        ? Math.max(0, Math.min(1, status.buffer_progress))
        : 0,
      error: null,
    }
  }
  
  function preparationIsCurrent(generation, infoHash = null) {
    if (generation !== playerPreparationGeneration) return false
    if (!playerSession) return false
    if (infoHash && playerSession.infoHash && playerSession.infoHash !== infoHash) return false
    return true
  }
  
  async function monitorTorrentTelemetry(infoHash, generation) {
    while (preparationIsCurrent(generation, infoHash)) {
      try {
        const progress = await backendJson(
          `/api/torrents/progress/${encodeURIComponent(infoHash)}`,
          { method: 'GET' },
          5000,
        )
        if (!preparationIsCurrent(generation, infoHash)) return
  
        setPlayerPreparation({
          stage: 'ready',
          ready: true,
          progress: Number.isFinite(progress?.progress) ? progress.progress : playerPreparation.progress,
          downloaded: Number(progress?.downloaded) || 0,
          size: Number(progress?.size) || 0,
          dlSpeed: Number(progress?.dl_speed) || 0,
          seeders: Number(progress?.num_seeds) || 0,
          peers: Number(progress?.num_leechs) || 0,
          torrentState: progress?.state || playerPreparation.torrentState || null,
          error: null,
        })
      } catch (error) {
        if (!preparationIsCurrent(generation, infoHash)) return
        if (error?.status === 404) return
        // Telemetry is informational only. Playback and the cache state remain
        // authoritative if this lightweight status poll is temporarily unavailable.
      }
  
      await new Promise(resolve => setTimeout(resolve, PLAYER_TELEMETRY_POLL_MS))
    }
  }
  
  async function monitorTorrentPreparation(infoHash, source, generation) {
    const startedAt = Date.now()
    let reannounced = false
    let consecutiveErrors = 0
  
    while (preparationIsCurrent(generation, infoHash)) {
      const elapsed = Date.now() - startedAt
      const shouldReannounce = !reannounced && elapsed >= PREPARATION_REANNOUNCE_MS
      const suffix = shouldReannounce ? '?reannounce=true' : ''
  
      try {
        const status = await backendJson(
          `/api/torrents/playback-status/${encodeURIComponent(infoHash)}${suffix}`,
          { method: 'GET' },
          6000,
        )
        if (!preparationIsCurrent(generation, infoHash)) return
  
        if (shouldReannounce) reannounced = true
        consecutiveErrors = 0
        setPlayerPreparation(preparationFromBackend(status || {}))
  
        if (metadataPreparationTimedOut(status, elapsed)) {
          const timeoutSeconds = Math.round(METADATA_PREPARATION_TIMEOUT_MS / 1000)
          setPlayerPreparation({
            stage: 'error',
            ready: false,
            message: 'Unable to prepare this source',
            error: `Torrent metadata did not become available within ${timeoutSeconds} seconds.`,
          })
          await deleteTorrentAndData(infoHash).catch(error => {
            console.error('[Player metadata-timeout cleanup]', error)
          })
          return
        }
  
        if (status?.path && playerSession) {
          playerSession = { ...playerSession, filePath: status.path }
          sendToPlayerRenderer('player:session', playerSession)
        }
  
        if (status?.ready) {
          setPlayerPreparation({
            stage: 'starting',
            ready: false,
            message: 'Starting video…',
            error: null,
          })
  
          const videoWindow = windows.getVideoWindow()
          if (!videoWindow || videoWindow.isDestroyed()) return
          try {
            await mpv.start(videoWindow, source, { ...getAppSettings(), ...audioPreferences.get() })
            await progress.applyResume(playerSession)
          } catch (error) {
            if (!preparationIsCurrent(generation, infoHash)) return
            console.error('[Player mpv startup]', error)
            await mpv.stop({ graceful: false }).catch(stopError => {
              console.error('[Player mpv startup cleanup]', stopError)
            })
            setPlayerPreparation({
              stage: 'error',
              ready: false,
              message: 'Player could not start',
              error: error instanceof Error ? error.message : String(error),
            })
            return
          }
          if (!preparationIsCurrent(generation, infoHash)) {
            await mpv.stop({ graceful: false })
            return
          }
  
          // mpv's child surface is now alive. Reassert the transparent controls
          // window above it, preserving the HWND ordering that made embedding stable.
          windows.showOverlay()
  
          setPlayerPreparation({
            stage: 'ready',
            ready: true,
            message: 'Playing',
            error: null,
          })
          void monitorTorrentTelemetry(infoHash, generation)
          return
        }
      } catch (error) {
        if (!preparationIsCurrent(generation, infoHash)) return
        consecutiveErrors += 1
  
        if (error?.status === 404) {
          setPlayerPreparation({
            stage: 'error',
            ready: false,
            message: 'Source is no longer available',
            error: error.message,
          })
          return
        }
  
        // Short backend/torrent-service interruptions should not kill a healthy playback
        // attempt. Keep the player visible and retry while surfacing the condition.
        setPlayerPreparation({
          stage: consecutiveErrors >= 3 ? 'peers' : playerPreparation.stage,
          ready: false,
          message: consecutiveErrors >= 3
            ? 'Waiting for torrent service…'
            : playerPreparation.message,
          error: null,
        })
      }
  
      await new Promise(resolve => setTimeout(resolve, PREPARATION_POLL_MS))
    }
  }
  
  async function runTorrentAddAndPreparation(payload, generation) {
    const releaseRef = typeof payload.releaseRef === 'string' ? payload.releaseRef.trim() : ''
    const mediaName = payload.mediaName || payload.title || 'NetWatch media'
    const expectedHash = payload.expectedHash || null
    const ownerToken = crypto.randomBytes(24).toString('hex')
    let acquiredHash = null
  
    try {
      const addPayload = {
        media_name: mediaName,
        expected_hash: expectedHash,
        release_ref: releaseRef,
        owner_token: ownerToken,
      }
  
      const added = await backendJson('/api/torrents/add', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(addPayload),
      }, 30_000)
  
      const infoHash = typeof added?.hash === 'string' ? added.hash.toLowerCase() : null
      if (!infoHash) throw new Error('Backend did not return a torrent hash')
      acquiredHash = infoHash
  
      if (!preparationIsCurrent(generation)) {
        await deleteTorrentAndData(infoHash, ownerToken).catch(error => console.error('[Player cleanup]', error))
        return
      }
      torrentOwners.set(infoHash, ownerToken)
  
      const source = `${backendBaseUrl}/api/torrents/stream/${encodeURIComponent(infoHash)}`
      playerSession = {
        ...playerSession,
        source,
        infoHash,
      }
      sendToPlayerRenderer('player:session', playerSession)
      setPlayerPreparation({
        stage: 'metadata',
        ready: false,
        message: 'Acquiring torrent metadata…',
        infoHash,
        error: null,
      })
  
      await monitorTorrentPreparation(infoHash, source, generation)
    } catch (error) {
      const cleanupHash = acquiredHash || expectedHash
      if (cleanupHash) {
        await deleteTorrentAndData(cleanupHash, ownerToken).catch(cleanupError => {
          console.error('[Player cleanup after preparation failure]', cleanupError)
        })
      }
      if (!preparationIsCurrent(generation)) return
  
      setPlayerPreparation({
        stage: 'error',
        ready: false,
        message: 'Unable to prepare this source',
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }
  
  async function openPreparingPlayerSession(payload) {
    if (playerSession || closingPlayer || openingPlayer || nextEpisodePromise) throw new Error('A player session is already open')
    openingPlayer = true
    const generation = playerPreparationGeneration
    try {
      await windows.create()
      await mpv.stop({ graceful: false })
      if (generation !== playerPreparationGeneration || lifecycle.quittingApp) throw new Error('Player opening was cancelled')
      return beginPreparingSession(payload)
    } catch (error) {
      if (!playerSession) windows.destroy()
      throw error
    } finally { openingPlayer = false }
  }

  function beginPreparingSession(payload, { reuseWindow = false } = {}) {
    const generation = ++playerPreparationGeneration
    progress.reset()
    const expectedHash = payload.infoHash || payload.expectedHash || null
  
    playerSession = {
      source: payload.source || null,
      localFileId: payload.localFileId || null,
      localEpisode: payload.localEpisode === true,
      title: payload.title || null,
      infoHash: expectedHash,
      filePath: payload.filePath || null,
      mediaItem: payload.mediaItem || null,
      resumePositionSeconds: Number.isFinite(Number(payload.resumePositionSeconds))
        ? Math.max(0, Math.min(7 * 24 * 60 * 60, Number(payload.resumePositionSeconds)))
        : 0,
      resumePending: Number(payload.resumePositionSeconds) > 0,
      openedAt: new Date().toISOString(),
    }
  
    playerPreparation = defaultPlayerPreparation()
    setPlayerPreparation({
      stage: payload.localFileId ? 'starting' : payload.infoHash ? 'metadata' : 'adding',
      ready: false,
      message: payload.localFileId ? 'Opening file…' : payload.infoHash ? 'Checking stream readiness…' : 'Adding torrent…',
      infoHash: expectedHash,
    })
  
    windows.setTitle(playerSession.title)
    sendToPlayerRenderer('player:session', playerSession)
    if (reuseWindow) windows.showOverlay()
    else windows.showShell()
    return generation
  }
  
  async function openTorrentSession(payload) {
    const releaseRef = typeof payload?.releaseRef === 'string' ? payload.releaseRef.trim() : ''
    if (!/^[A-Za-z0-9_-]{32,128}$/u.test(releaseRef)) {
      throw new Error('player.openTorrent requires a backend-issued release reference')
    }
  
    const normalizedPayload = { ...payload, releaseRef, localFileId: null, localEpisode: false, source: null }
    const generation = await openPreparingPlayerSession(normalizedPayload)
    void runTorrentAddAndPreparation(normalizedPayload, generation)
    return {
      session: playerSession,
      state: mpv.getState(),
      preparation: { ...playerPreparation },
    }
  }

  function localPayload(item) {
    const match = item.match
    return {
      localFileId: item.id,
      localEpisode: match ? match.type === 'tv' : Boolean(item.episode),
      source: item.absolutePath,
      filePath: item.absolutePath,
      title: match ? `${match.title}${match.type === 'tv' ? ` · S${match.season}E${match.episode}` : ''}` : item.filename,
      mediaItem: match ? { ...match, tmdb_id: match.id, overview: '', rating: 0 } : null,
    }
  }

  async function startLocalPlayback(payload, generation) {
    if (!preparationIsCurrent(generation)) return
    setPlayerPreparation({ stage: 'starting', ready: false, message: 'Opening file…', error: null })
    try {
      // Revalidate immediately before handing a local path to mpv.
      const item = await localLibrary.resolve(payload.localFileId)
      if (!preparationIsCurrent(generation)) return
      const startup = mpv.start(windows.getVideoWindow(), item.absolutePath, { ...getAppSettings(), ...audioPreferences.get() })
      localStartupPromise = startup
      try { await startup }
      finally { if (localStartupPromise === startup) localStartupPromise = null }
      if (!preparationIsCurrent(generation)) { await mpv.stop({ graceful: false }); return }
      windows.showOverlay()
      setPlayerPreparation({ stage: 'ready', ready: true, message: 'Playing', error: null })
    } catch (error) {
      if (!preparationIsCurrent(generation)) return
      await mpv.stop({ graceful: false }).catch(() => {})
      if (preparationIsCurrent(generation)) setPlayerPreparation({ stage: 'error', ready: false, message: 'File could not start', error: error.message })
    }
  }

  async function openLocal(id) {
    if (!localLibrary) throw new Error('Local library is unavailable')
    const payload = localPayload(await localLibrary.resolve(id))
    const generation = await openPreparingPlayerSession(payload)
    void startLocalPlayback(payload, generation)
    return { session: playerSession }
  }

  async function closePlayerSession({ restoreMainWindow = true } = {}) {
    if (closingPlayer) return
    closingPlayer = true
    nextEpisodeAbort?.abort()
    ++playerPreparationGeneration
    const closingSession = playerSession
  
    try {
      progress.checkpointDesktop(playerSession, mpv.getState(), { force: true })
      windows.hide()
      // Cancel a pending next-episode lookup/handoff before touching its resources.
      // The handoff checks its generation after every await and cannot reopen us.
      if (nextEpisodePromise) await nextEpisodePromise.catch(() => {})
      await audioPreferences.settle()
      await preferenceQueue
  
      await mpv.stop()
      if (localStartupPromise) {
        // Keep new sessions blocked until a cancelled startup has settled.
        await localStartupPromise.catch(() => {})
        await mpv.stop({ graceful: false })
      }
  
      await subtitles.releaseActive()
  
      if (closingSession?.infoHash) {
        try {
          await deleteTorrentAndData(closingSession.infoHash)
        } catch (error) {
          console.error('[Player cleanup]', error)
          sendToPlayerRenderer('player:log', {
            level: 'error',
            message: `Torrent cleanup failed: ${error.message}`,
            timestamp: new Date().toISOString(),
          })
        }
      }
  
      playerSession = null
      playerPreparation = defaultPlayerPreparation()
      sendToPlayerRenderer('player:session', null)
      sendToPlayerRenderer('player:preparation', { ...playerPreparation })
  
      windows.destroy()
  
      if (restoreMainWindow && !lifecycle.quittingApp && getMainWindow() && !getMainWindow().isDestroyed()) {
        getMainWindow().show()
        getMainWindow().focus()
      }
    } finally {
      closingPlayer = false
    }
  }

  async function handleNativeCloseRequested() {
    if (!shouldMinimizeToTray()) {
      await quitAppFromPlayer()
      return
    }

    const mainWindow = getMainWindow()
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.hide()
    await closePlayerSession({ restoreMainWindow: false })
  }

  function requireSession(openedAt) {
    if (closingPlayer || !playerSession || typeof openedAt !== 'string' || playerSession.openedAt !== openedAt) {
      throw new Error('Player session is closed')
    }
    return playerSession
  }

  async function episodeInfo(openedAt) {
    const session = requireSession(openedAt)
    const duration = playbackDuration(mpv.getState())
    if (episodeInfoCache?.openedAt !== openedAt || episodeInfoCache.duration !== duration) {
      // Chapters remain usable even if an optional metadata service is down.
      const empty = {
        genres: [], rating: null, guidance: [], guidance_scope: 'series',
        alwaysSkipIntro: getAppSettings().alwaysSkipIntro === true,
      }
      const promise = (session.localFileId && !session.mediaItem
        ? Promise.resolve(empty) : episodes.info(session, duration)).catch(() => empty)
      episodeInfoCache = { openedAt, duration, promise }
    }
    const result = await episodeInfoCache.promise
    requireSession(openedAt)
    return withFileTimings(result, mpv.getState())
  }

  async function nextEpisodeInfo(openedAt) {
    const session = requireSession(openedAt)
    const item = session.localFileId ? await localLibrary.next(session.localFileId) : null
    const episode = item?.match || item?.episode
    const result = session.localFileId ? (item && episode ? {
      season_number: episode.season, episode_number: episode.episode, name: item.match?.episode_title || item.filename,
    } : null) : await episodes.successor(session)
    requireSession(openedAt)
    return result
  }

  function playNextEpisode(openedAt) {
    const previous = requireSession(openedAt)
    if (nextEpisodePromise) return nextEpisodePromise
    if (!playerPreparation.ready) throw new Error('Wait for playback to be ready')
    nextEpisodeAbort = new AbortController()
    let generation = playerPreparationGeneration
    const assertCurrent = () => {
      requireSession(openedAt)
      if (generation !== playerPreparationGeneration) throw new Error('Playback changed')
    }
    nextEpisodePromise = (async () => {
      const nextLocal = previous.localFileId ? await localLibrary.next(previous.localFileId) : null
      if (previous.localFileId && !nextLocal) throw new Error('The next episode is not available in your library.')
      const payload = nextLocal ? localPayload(nextLocal) : await episodes.resolveNext(previous, assertCurrent, nextEpisodeAbort.signal)
      assertCurrent()
      progress.checkpointDesktop(playerSession, mpv.getState(), { force: true })
      generation = ++playerPreparationGeneration
      setPlayerPreparation({ stage: 'adding', ready: false, message: 'Preparing next episode…', error: null })
      try {
        await audioPreferences.settle()
        await preferenceQueue
        assertCurrent()
        await mpv.stop()
        assertCurrent()
        await subtitles.releaseActive()
        assertCurrent()
        await deleteTorrentAndData(previous.infoHash)
        assertCurrent()
        // Reuse both windows so fullscreen and the overlay survive the handoff.
        const nextGeneration = beginPreparingSession(payload, { reuseWindow: true })
        if (payload.localFileId) void startLocalPlayback(payload, nextGeneration)
        else void runTorrentAddAndPreparation(payload, nextGeneration)
        return { session: playerSession }
      } catch (error) {
        if (!closingPlayer && generation === playerPreparationGeneration) {
          setPlayerPreparation({ stage: 'error', ready: false, message: 'Next episode could not start', error: error.message })
        }
        throw error
      }
    })().finally(() => { nextEpisodePromise = null; nextEpisodeAbort = null })
    return nextEpisodePromise
  }

  async function skipIntro(openedAt) {
    const info = await episodeInfo(openedAt)
    requireSession(openedAt)
    const { position, duration, seeking, seekBuffering, pausedForCache } = mpv.getState()
    const intro = info?.intro
    if (seeking || seekBuffering || pausedForCache || !intro || !Number.isFinite(intro.start) || !Number.isFinite(intro.end) ||
        intro.start < 0 || intro.end <= intro.start || intro.end - intro.start > 300 ||
        !Number.isFinite(duration) || intro.end >= duration ||
        !Number.isFinite(position) || position < intro.start || position >= intro.end || !playerPreparation.ready) return false
    await mpv.execute({ type: 'seekAbsolute', seconds: intro.end })
    return true
  }
  
  async function quitAppFromPlayer() {
    if (lifecycle.quittingApp || lifecycle.quitCleanupComplete) return
    lifecycle.quittingApp = true
  
    try {
      if (playerSession && !closingPlayer) await closePlayerSession()
    } finally {
      // closePlayerSession already stops mpv and removes torrent data. Mark that
      // cleanup complete before app.quit() so before-quit does not start it again.
      lifecycle.quitCleanupComplete = true
      await onQuitReady()
    }
  }
  
  mpv.on('state', state => {
    sendToPlayerRenderer('player:state', state)
    progress.checkpointDesktop(playerSession, state)
  })
  mpv.on('log', entry => sendToPlayerRenderer('player:log', entry))

  function stopImmediately() {
    closingPlayer = true
    nextEpisodeAbort?.abort()
    audioPreferences.flush()
    return mpv.stop({ graceful: false })
  }

  function updatePreferences(patch) {
    if (!patch || typeof patch !== 'object' || Array.isArray(patch) ||
        Object.keys(patch).some(key => !Object.hasOwn(PLAYBACK_DEFAULTS, key))) return Promise.reject(new Error('Invalid playback preferences'))
    const openedAt = playerSession?.openedAt
    const generation = playerPreparationGeneration
    const assertCurrent = () => {
      requireSession(openedAt)
      if (generation !== playerPreparationGeneration || !playerPreparation.ready) throw new Error('Playback changed')
    }
    const task = preferenceQueue.then(async () => {
      assertCurrent()
      const previous = normalizePlaybackPreferences(getAppSettings())
      const settings = normalizePlaybackPreferences(patch, previous)
      if (Object.entries(patch).some(([key, value]) => settings[key] !== value)) throw new Error('Invalid playback preference value')
      const oldProperties = playbackProperties(previous)
      const changed = Object.entries(playbackProperties(settings)).filter(([key, value]) => oldProperties[key] !== value)
      try {
        for (const [name, value] of changed) {
          assertCurrent()
          await mpv.request(['set_property', name, value])
        }
        assertCurrent()
        saveAppSettings(patch)
        return normalizePlaybackPreferences(getAppSettings())
      } catch (error) {
        // A failed live update must not leave half of a preference applied.
        for (const [name] of changed) {
          try { assertCurrent(); await mpv.request(['set_property', name, oldProperties[name]]) }
          catch { break }
        }
        throw error
      }
    })
    preferenceQueue = task.catch(() => {})
    return task
  }

  return {
    getPreferences: () => normalizePlaybackPreferences(getAppSettings()),
    updatePreferences,
    checkpointRemotePlayback: progress.checkpointRemote,
    close: closePlayerSession,
    execute: action => {
      if (action?.type !== 'setVolume' && action?.type !== 'setMute') return subtitles.execute(action)
      const session = playerSession
      return audioPreferences.execute(action, command => {
        if (!session || session.openedAt !== playerSession?.openedAt || closingPlayer) throw new Error('Player session is closed')
        return subtitles.execute(command)
      })
    },
    foreground: windows.foreground,
    getPreparation: () => ({ ...playerPreparation }),
    getEpisodeInfo: episodeInfo,
    getNextEpisode: nextEpisodeInfo,
    playNextEpisode,
    skipIntro,
    getOverlayWindow: windows.getOverlayWindow,
    getSession: () => playerSession,
    getState: () => mpv.getState(),
    getWindowState: windows.getState,
    hasSession: () => Boolean(playerSession),
    isClosing: () => closingPlayer,
    isTorrentInUse: infoHash => Boolean(
      torrentOwners.has(String(infoHash).toLowerCase())
    ),
    openTorrent: openTorrentSession,
    openLocal,
    setFullscreen: windows.setFullscreen,
    stopImmediately,
    toggleFullscreen: windows.toggleFullscreen,
  }
}

module.exports = { createPlayerSessionController }
