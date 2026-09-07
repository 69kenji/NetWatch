'use strict'

const { MpvController } = require('./mpv-controller')
const { createPlayerProgressController } = require('./player-progress-controller')
const { createPlayerSubtitleController } = require('./player-subtitle-controller')
const { createPlayerWindowManager } = require('./player-window-manager')
const { METADATA_PREPARATION_TIMEOUT_MS, metadataPreparationTimedOut } = require('./preparation-policy')

const PREPARATION_POLL_MS = 400
const PREPARATION_REANNOUNCE_MS = 10_000
const PLAYER_TELEMETRY_POLL_MS = 1000

function createPlayerSessionController({
  backendBaseUrl,
  backendJson,
  getAppSettings,
  getMainWindow,
  hardenRendererNavigation,
  isDev,
  keepWatching,
  lifecycle,
  onQuitReady,
  playerRendererUrl,
  shouldMinimizeToTray,
}) {
  if (
    typeof backendJson !== 'function' ||
    typeof getAppSettings !== 'function' ||
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

  const progress = createPlayerProgressController({ getAppSettings, keepWatching, mpv })
  const subtitles = createPlayerSubtitleController({ backendBaseUrl, backendJson, mpv })
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
  
  function extractBtih(source) {
    if (typeof source !== 'string' || !source.toLowerCase().startsWith('magnet:?')) return null
    try {
      const url = new URL(source)
      for (const value of url.searchParams.getAll('xt')) {
        const match = /^urn:btih:([0-9a-f]{40})$/iu.exec(value.trim())
        if (match) return match[1].toLowerCase()
      }
    } catch (_) {}
    return null
  }
  
  async function deleteTorrentAndData(infoHash) {
    if (typeof infoHash !== 'string' || !infoHash.trim()) return true
  
    const normalized = infoHash.trim().toLowerCase()
    let lastError = null
  
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        const payload = await backendJson(
          `/api/torrents/${encodeURIComponent(normalized)}?delete_files=true`,
          { method: 'DELETE' },
          5000,
        )
        if (payload?.removed === true && payload?.verified_absent === true) {
          console.log(`[Player cleanup] Removed torrent ${normalized} and its data`)
          return true
        }
        throw new Error(`torrent cleanup was not verified for ${normalized}`)
      } catch (error) {
        if (error?.status === 404) return true
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
            await mpv.start(videoWindow, source)
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
    const torrentSource = typeof payload.torrentSource === 'string' ? payload.torrentSource.trim() : ''
    const mediaName = payload.mediaName || payload.title || 'NetWatch media'
    const expectedHash = payload.expectedHash || (torrentSource ? extractBtih(torrentSource) : null) || null
  
    try {
      const addPayload = {
        media_name: mediaName,
        expected_hash: expectedHash,
      }
      if (releaseRef) addPayload.release_ref = releaseRef
      else addPayload.magnet = torrentSource
  
      const added = await backendJson('/api/torrents/add', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(addPayload),
      }, 30_000)
  
      const infoHash = typeof added?.hash === 'string' ? added.hash.toLowerCase() : null
      if (!infoHash) throw new Error('Backend did not return a torrent hash')
  
      if (!preparationIsCurrent(generation)) {
        await deleteTorrentAndData(infoHash).catch(error => console.error('[Player cleanup]', error))
        return
      }
  
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
      if (!preparationIsCurrent(generation)) return
  
      const cleanupHash = playerSession?.infoHash || expectedHash
      if (cleanupHash) {
        await deleteTorrentAndData(cleanupHash).catch(cleanupError => {
          console.error('[Player cleanup after preparation failure]', cleanupError)
        })
      }
  
      setPlayerPreparation({
        stage: 'error',
        ready: false,
        message: 'Unable to prepare this source',
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }
  
  async function openPreparingPlayerSession(payload) {
    if (playerSession) throw new Error('A player session is already open')
    await windows.create()
    await mpv.stop({ graceful: false })
  
    const generation = ++playerPreparationGeneration
    progress.reset()
    const directSource = typeof payload.torrentSource === 'string' ? payload.torrentSource : ''
    const expectedHash = payload.infoHash || payload.expectedHash || (directSource ? extractBtih(directSource) : null) || null
  
    playerSession = {
      source: payload.source || null,
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
      stage: payload.infoHash ? 'metadata' : 'adding',
      ready: false,
      message: payload.infoHash ? 'Checking stream readiness…' : 'Adding torrent…',
      infoHash: expectedHash,
    })
  
    windows.setTitle(playerSession.title)
    sendToPlayerRenderer('player:session', playerSession)
    windows.showShell()
    return generation
  }
  
  async function openTorrentSession(payload, { allowDirectSource = false } = {}) {
    const releaseRef = typeof payload?.releaseRef === 'string' ? payload.releaseRef.trim() : ''
    const torrentSource = typeof payload?.torrentSource === 'string' ? payload.torrentSource.trim() : ''
    if (!releaseRef && !(allowDirectSource && torrentSource.toLowerCase().startsWith('magnet:?'))) {
      throw new Error('player.openTorrent requires a backend-issued release reference')
    }
  
    const normalizedPayload = { ...payload, releaseRef, torrentSource: allowDirectSource ? torrentSource : '' }
    const generation = await openPreparingPlayerSession(normalizedPayload)
    void runTorrentAddAndPreparation(normalizedPayload, generation)
    return {
      session: playerSession,
      state: mpv.getState(),
      preparation: { ...playerPreparation },
    }
  }
  
  async function openExistingTorrentSession(payload) {
    if (!payload || typeof payload.source !== 'string' || !payload.source.trim()) {
      throw new Error('Existing torrent playback requires a stream source')
    }
    if (!payload.infoHash) throw new Error('Existing torrent playback requires an info hash')
  
    const generation = await openPreparingPlayerSession(payload)
    void monitorTorrentPreparation(payload.infoHash.toLowerCase(), payload.source, generation)
    return {
      session: playerSession,
      state: mpv.getState(),
      preparation: { ...playerPreparation },
    }
  }
  
  async function openPlayerSession(payload) {
    if (!payload || typeof payload.source !== 'string' || !payload.source.trim()) {
      throw new Error('player.open requires a non-empty source')
    }
    if (playerSession) throw new Error('A player session is already open')
  
    await windows.create()
    progress.reset()
    ++playerPreparationGeneration
    playerPreparation = defaultPlayerPreparation()
    setPlayerPreparation({ stage: 'ready', ready: true, message: 'Playing' })
  
    playerSession = {
      source: payload.source,
      title: payload.title || null,
      infoHash: payload.infoHash || null,
      filePath: payload.filePath || null,
      mediaItem: payload.mediaItem || null,
      resumePositionSeconds: Number.isFinite(Number(payload.resumePositionSeconds))
        ? Math.max(0, Math.min(7 * 24 * 60 * 60, Number(payload.resumePositionSeconds)))
        : 0,
      resumePending: Number(payload.resumePositionSeconds) > 0,
      openedAt: new Date().toISOString(),
    }
  
    windows.setTitle(playerSession.title)
    if (getMainWindow() && !getMainWindow().isDestroyed()) getMainWindow().hide()
    windows.syncBounds()
    sendToPlayerRenderer('player:session', playerSession)
  
    try {
      windows.showVideoFromLaunchState()
      await new Promise(resolve => setTimeout(resolve, 100))
      await mpv.start(windows.getVideoWindow(), payload.source)
      await progress.applyResume(playerSession)
  
      windows.showOverlay()
  
      return { session: playerSession, state: mpv.getState(), preparation: { ...playerPreparation } }
    } catch (error) {
      sendToPlayerRenderer('player:state', {
        ...mpv.getState(),
        status: 'error',
        error: error.message,
      })
      throw error
    }
  }
  
  async function closePlayerSession({ restoreMainWindow = true } = {}) {
    if (closingPlayer) return
    closingPlayer = true
    ++playerPreparationGeneration
    const closingSession = playerSession
  
    try {
      progress.checkpointDesktop(playerSession, mpv.getState(), { force: true })
      windows.hide()
  
      await mpv.stop()
  
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
    return mpv.stop({ graceful: false })
  }

  return {
    checkpointRemotePlayback: progress.checkpointRemote,
    close: closePlayerSession,
    execute: subtitles.execute,
    foreground: windows.foreground,
    getPreparation: () => ({ ...playerPreparation }),
    getOverlayWindow: windows.getOverlayWindow,
    getSession: () => playerSession,
    getState: () => mpv.getState(),
    getWindowState: windows.getState,
    hasSession: () => Boolean(playerSession),
    isClosing: () => closingPlayer,
    isTorrentInUse: infoHash => Boolean(
      playerSession?.infoHash && String(playerSession.infoHash).toLowerCase() === String(infoHash).toLowerCase()
    ),
    openTorrent: openTorrentSession,
    setFullscreen: windows.setFullscreen,
    stopImmediately,
    toggleFullscreen: windows.toggleFullscreen,
  }
}

module.exports = { createPlayerSessionController }
