import { useEffect, useRef, useState, useCallback } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import {
  IconoirProvider,
  Play, Pause, SoundHigh, SoundOff, Expand, Collapse, NavArrowLeft,
  ClosedCaptionsTag, Download, WarningTriangle
} from 'iconoir-react'
import { useAppStore } from '../../store'
import { TracksPanel } from './TracksPanel'
import { NetworkPanel } from './NetworkPanel'
import { VolumeSlider } from './VolumeSlider'
import { ProgressBar } from './ProgressBar'
import { BufferingOverlay } from './BufferingOverlay'


function SkipTenIcon({ direction, width = 24, height = 24 }: { direction: 'back' | 'forward'; width?: number; height?: number }) {
  const backward = direction === 'back'
  const arrow = (
    <>
      <path
        d="M21.8883 13.5C21.1645 18.3113 17.013 22 12 22C6.47715 22 2 17.5228 2 12C2 6.47715 6.47715 2 12 2C16.1006 2 19.6248 4.46819 21.1679 8"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M17 8H21.4C21.7314 8 22 7.73137 22 7.4V3"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </>
  )

  return (
    <svg
      width={width}
      height={height}
      viewBox="0 0 24 24"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
      focusable="false"
      strokeWidth="1.5"
    >
      {backward ? <g transform="translate(24 0) scale(-1 1)">{arrow}</g> : arrow}
      <text
        x="12"
        y="14.1"
        fill="currentColor"
        stroke="none"
        fontSize="7"
        fontWeight="650"
        textAnchor="middle"
        style={{ fontFamily: 'inherit', userSelect: 'none' }}
      >
        10
      </text>
    </svg>
  )
}

function defaultNativeState(error: string | null = null): NativePlayerState {
  return {
    status: error ? 'error' : 'idle',
    ready: false,
    paused: true,
    position: 0,
    duration: 0,
    volume: 100,
    muted: false,
    eofReached: false,
    idle: true,
    title: null,
    source: null,
    audioTrack: null,
    subtitleTrack: null,
    subtitleDelay: 0,
    tracks: [],
    cacheDuration: 0,
    cacheBufferingState: 0,
    pausedForCache: false,
    seeking: false,
    seekBuffering: false,
    cacheSpeed: 0,
    voConfigured: false,
    hwdecCurrent: null,
    error,
  }
}

function applyNativeState(state: NativePlayerState, updatePlayer: (patch: any) => void) {
  updatePlayer({
    paused: state.paused,
    position: state.position || 0,
    duration: state.duration || 0,
    volume: Number.isFinite(state.volume) ? state.volume : 100,
    subtitleDelay: Math.round((state.subtitleDelay || 0) * 1000),
    ...(typeof state.audioTrack === 'number' ? { audioTrack: state.audioTrack } : {}),
  })
}

function formatDelay(ms: number) {
  if (ms === 0) return 'Subtitles synced'
  const seconds = Math.abs(ms / 1000).toFixed(1)
  return `Subtitles ${ms > 0 ? '+' : '−'}${seconds}s`
}

export function Player() {
  const { player, setPlayerMedia, updatePlayer, closePlayer } = useAppStore()
  const [controlsVisible, setControlsVisible] = useState(true)
  const [cursorVisible, setCursorVisible] = useState(true)
  const [tracksPanelOpen, setTracksPanelOpen] = useState(false)
  const [networkPanelOpen, setNetworkPanelOpen] = useState(false)
  const [fullscreen, setFullscreen] = useState(false)
  const [volumeOpen, setVolumeOpen] = useState(false)
  const [nativeState, setNativeState] = useState<NativePlayerState | null>(null)
  const [session, setSession] = useState<NativePlayerSession | null>(null)
  const [preparation, setPreparation] = useState<NativePlayerPreparationState | null>(null)
  const [feedback, setFeedback] = useState<string | null>(null)
  const [switchingAudioTrack, setSwitchingAudioTrack] = useState<number | string | null>(null)
  const controlsHideTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const cursorHideTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const feedbackTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const bridge = window.electron?.player

  const showFeedback = useCallback((message: string) => {
    setFeedback(message)
    if (feedbackTimer.current) clearTimeout(feedbackTimer.current)
    feedbackTimer.current = setTimeout(() => setFeedback(null), 1100)
  }, [])

  const syncSession = useCallback((next: NativePlayerSession | null) => {
    setSession(next)
    if (!next) {
      closePlayer()
      return
    }
    if (next.infoHash && next.mediaItem) {
      setPlayerMedia(next.infoHash, next.mediaItem, next.filePath || '')
    } else {
      updatePlayer({
        isOpen: true,
        infoHash: next.infoHash,
        mediaItem: next.mediaItem,
        filePath: next.filePath,
      })
    }
  }, [closePlayer, setPlayerMedia, updatePlayer])

  useEffect(() => {
    if (!bridge) {
      setNativeState(defaultNativeState('Native player bridge is unavailable. Open NetWatch through Electron.'))
      return
    }

    let mounted = true
    void Promise.all([
      bridge.getSession(),
      bridge.getState(),
      bridge.getPreparation(),
      bridge.getWindowState(),
    ]).then(([initialSession, state, initialPreparation, windowState]) => {
      if (!mounted) return
      syncSession(initialSession)
      setNativeState(state)
      setPreparation(initialPreparation)
      applyNativeState(state, updatePlayer)
      setFullscreen(windowState.fullscreen)
    }).catch(error => {
      if (!mounted) return
      setNativeState(current => ({
        ...(current || defaultNativeState()),
        status: 'error',
        error: error instanceof Error ? error.message : String(error),
      }))
    })

    const offState = bridge.onState(state => {
      setNativeState(state)
      applyNativeState(state, updatePlayer)
    })
    const offPreparation = bridge.onPreparation(setPreparation)
    const offSession = bridge.onSession(syncSession)
    const offWindow = bridge.onWindowState(state => setFullscreen(state.fullscreen))

    return () => {
      mounted = false
      offState()
      offPreparation()
      offSession()
      offWindow()
    }
  }, [bridge, syncSession, updatePlayer])

  const preparing = Boolean(
    preparation &&
    preparation.stage !== 'idle' &&
    preparation.stage !== 'ready' &&
    preparation.stage !== 'error'
  )
  // The torrent can be fully prebuffered before mpv has actually produced a
  // playable video state. With --force-window=immediate the native HWND exists
  // earlier than it used to, so exposing the player as soon as preparation hits
  // `ready` briefly reveals mpv's blank surface and 0:00 / 0:00 controls. Keep
  // the cinematic loading overlay in place until mpv has loaded a real duration,
  // configured video output, and entered an active playback state.
  const videoReady = Boolean(
    nativeState &&
    !nativeState.idle &&
    nativeState.voConfigured &&
    Number.isFinite(nativeState.duration) &&
    nativeState.duration > 0 &&
    (nativeState.status === 'playing' || nativeState.status === 'paused')
  )
  const waitingForVideo = Boolean(
    !preparing &&
    preparation?.stage === 'ready' &&
    session?.source &&
    !videoReady
  )
  const seekRestartBuffering = Boolean(
    nativeState?.seekBuffering || (
      nativeState?.seeking &&
      ((Number(nativeState.cacheBufferingState) || 0) < 100 || (Number(nativeState.cacheDuration) || 0) < 0.5)
    )
  )
  const rebuffering = Boolean(
    !preparing &&
    !waitingForVideo &&
    preparation?.stage === 'ready' &&
    (nativeState?.pausedForCache || seekRestartBuffering)
  )
  const bufferOverlayActive = preparing || waitingForVideo || rebuffering

  const menuOpen = tracksPanelOpen || networkPanelOpen

  const showPointerAndControls = useCallback(() => {
    setCursorVisible(true)
    if (cursorHideTimer.current) clearTimeout(cursorHideTimer.current)
    if (!menuOpen) cursorHideTimer.current = setTimeout(() => setCursorVisible(false), 3000)

    setControlsVisible(true)
    if (controlsHideTimer.current) clearTimeout(controlsHideTimer.current)
    if (!player.paused && !bufferOverlayActive && !menuOpen) {
      controlsHideTimer.current = setTimeout(() => setControlsVisible(false), 3000)
    }
  }, [bufferOverlayActive, menuOpen, player.paused])

  useEffect(() => {
    showPointerAndControls()
    return () => {
      if (controlsHideTimer.current) clearTimeout(controlsHideTimer.current)
      if (cursorHideTimer.current) clearTimeout(cursorHideTimer.current)
      if (feedbackTimer.current) clearTimeout(feedbackTimer.current)
    }
  }, [showPointerAndControls])

  useEffect(() => {
    if (bufferOverlayActive) {
      setControlsVisible(false)
      setTracksPanelOpen(false)
      setNetworkPanelOpen(false)
      setVolumeOpen(false)
      if (controlsHideTimer.current) clearTimeout(controlsHideTimer.current)
      return
    }
    if (player.paused || menuOpen) {
      setControlsVisible(true)
      if (controlsHideTimer.current) clearTimeout(controlsHideTimer.current)
    }
  }, [bufferOverlayActive, menuOpen, player.paused])

  const command = async (action: NativePlayerAction) => {
    if (!bridge || bufferOverlayActive) return
    try {
      await bridge.command(action)
    } catch (error) {
      console.error('mpv command failed', action.type, error)
    }
  }

  const togglePlay = () => {
    if (bufferOverlayActive || preparation?.stage === 'error') return
    void command({ type: player.paused ? 'play' : 'pause' })
  }

  const seek = (seconds: number, withFeedback = false) => {
    const newPos = Math.max(0, Math.min(player.duration || Infinity, player.position + seconds))
    updatePlayer({ position: Number.isFinite(newPos) ? newPos : 0 })
    void command({ type: 'seekRelative', seconds })
    if (withFeedback) showFeedback(`${seconds > 0 ? '+' : '−'}${Math.abs(seconds)} seconds`)
  }

  const setVolume = (volume: number) => {
    updatePlayer({ volume })
    void command({ type: 'setVolume', volume })
  }

  const toggleMute = (withFeedback = false) => {
    const next = !(nativeState?.muted || false)
    void command({ type: 'setMute', muted: next })
    if (withFeedback) showFeedback(next ? 'Muted' : 'Sound on')
  }

  const selectAudioTrack = async (id: number | string) => {
    if (!bridge || switchingAudioTrack != null || bufferOverlayActive) return
    setSwitchingAudioTrack(id)
    showFeedback('Switching audio…')
    try {
      await bridge.command({ type: 'setAudioTrack', id })
      showFeedback('Audio track changed')
    } catch (error) {
      console.error('Failed to switch audio track', error)
      showFeedback('Audio switch failed')
    } finally {
      setSwitchingAudioTrack(null)
    }
  }

  const toggleFullscreen = async (withFeedback = false) => {
    if (!bridge) return
    try {
      const next = await bridge.toggleFullscreen()
      setFullscreen(next)
      if (withFeedback) showFeedback(next ? 'Fullscreen' : 'Windowed')
    } catch (error) {
      console.error('Failed to toggle player fullscreen', error)
    }
  }

  const setFullscreenState = async (enabled: boolean) => {
    if (!bridge) return
    try {
      setFullscreen(await bridge.setFullscreen(enabled))
    } catch (error) {
      console.error('Failed to set player fullscreen', error)
    }
  }

  const handleClose = useCallback(async () => {
    closePlayer()
    try {
      await bridge?.close()
    } catch (error) {
      console.error('Failed to close native player', error)
    }
  }, [bridge, closePlayer])

  useEffect(() => {
    const handleMouseBack = (event: MouseEvent) => {
      // DOM button 3 is the standard browser/back side button (commonly called MB4/MB5).
      if (event.button !== 3) return
      event.preventDefault()
      void handleClose()
    }

    window.addEventListener('mouseup', handleMouseBack)
    return () => window.removeEventListener('mouseup', handleMouseBack)
  }, [handleClose])

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      // Space is a player command, never a focused-button activation. Chromium
      // otherwise re-clicks the last focused control and leaves a keyboard focus
      // ring behind, which makes playback controls feel "stuck".
      if (event.code === 'Space') {
        event.preventDefault()
        if (document.activeElement instanceof HTMLButtonElement) document.activeElement.blur()
        if (!event.repeat) togglePlay()
        return
      }

      const target = event.target as HTMLElement | null
      const tagName = target?.tagName
      if (
        target?.isContentEditable ||
        tagName === 'INPUT' ||
        tagName === 'TEXTAREA' ||
        tagName === 'SELECT' ||
        tagName === 'BUTTON'
      ) return

      if (event.key === 'Escape') {
        if (tracksPanelOpen || networkPanelOpen) {
          event.preventDefault()
          setTracksPanelOpen(false)
          setNetworkPanelOpen(false)
          return
        }
        if (fullscreen) {
          event.preventDefault()
          void setFullscreenState(false)
        }
        return
      }

      if (bufferOverlayActive) {
        if (event.key.toLowerCase() === 'f' && !event.repeat) {
          event.preventDefault()
          void toggleFullscreen(true)
        }
        return
      }

      if (event.key === 'ArrowLeft') {
        event.preventDefault()
        if (!event.repeat) seek(-10, true)
        return
      }

      if (event.key === 'ArrowRight') {
        event.preventDefault()
        if (!event.repeat) seek(10, true)
        return
      }

      if (event.key.toLowerCase() === 'f' && !event.repeat) {
        event.preventDefault()
        void toggleFullscreen(true)
        return
      }

      if (event.key.toLowerCase() === 'm' && !event.repeat) {
        event.preventDefault()
        toggleMute(true)
        return
      }

      if (event.key.toLowerCase() === 's' && !event.repeat) {
        event.preventDefault()
        setNetworkPanelOpen(false)
        setTracksPanelOpen(current => !current)
      }
    }

    window.addEventListener('keydown', handleKeyDown, true)
    return () => window.removeEventListener('keydown', handleKeyDown, true)
  }, [fullscreen, networkPanelOpen, tracksPanelOpen, player.position, player.duration, player.paused, nativeState?.muted, bufferOverlayActive])

  const formatTime = (secs: number) => {
    if (!Number.isFinite(secs) || secs < 0) return '0:00'
    const h = Math.floor(secs / 3600)
    const m = Math.floor((secs % 3600) / 60)
    const s = Math.floor(secs % 60)
    return h > 0
      ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
      : `${m}:${String(s).padStart(2, '0')}`
  }

  const title = player.mediaItem?.title || session?.title || nativeState?.title || 'NetWatch'
  const muted = Boolean(nativeState?.muted)
  const preparationError = preparation?.stage === 'error' ? preparation.error || preparation.message : null
  const nativeError = nativeState?.status === 'error' ? nativeState.error : null
  const errorMessage = preparationError || nativeError
  const hasError = Boolean(errorMessage)
  const topBarVisible = !bufferOverlayActive && (controlsVisible || hasError || menuOpen)

  return (
    <IconoirProvider iconProps={{ strokeWidth: 1.65 }}>
      <motion.div
        className={`player-container ${cursorVisible ? '' : 'player-cursor-hidden'}`}
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        onMouseMove={showPointerAndControls}
        onMouseEnter={showPointerAndControls}
      >
        <div className="player-video-area" onClick={togglePlay}>
          <div className="player-title-bar">
            <AnimatePresence>
              {topBarVisible && (
                <motion.div
                  initial={{ opacity: 0, y: -14 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -14 }}
                  transition={{ duration: 0.16 }}
                  className="player-top-bar"
                >
                  <div className="player-top-bar-left">
                    <button
                      className="btn btn-ghost btn-icon player-back-button player-no-drag"
                      onClick={(event) => {
                        event.stopPropagation()
                        void handleClose()
                      }}
                      title="Back to NetWatch"
                      aria-label="Back to NetWatch"
                    >
                      <NavArrowLeft width={23} height={23} />
                    </button>
                    <span className="player-media-title">{title}</span>
                  </div>
                  <button
                    className="btn btn-ghost btn-icon player-no-drag player-fullscreen-top"
                    onClick={(event) => {
                      event.stopPropagation()
                      void toggleFullscreen()
                    }}
                    title={fullscreen ? 'Exit fullscreen (F)' : 'Fullscreen (F)'}
                    aria-label={fullscreen ? 'Exit fullscreen' : 'Enter fullscreen'}
                  >
                    {fullscreen ? <Collapse width={21} height={21} /> : <Expand width={21} height={21} />}
                  </button>
                </motion.div>
              )}
            </AnimatePresence>
          </div>

          <AnimatePresence>
            {bufferOverlayActive && !hasError && (
              <BufferingOverlay
                title={title}
                mediaItem={player.mediaItem || session?.mediaItem || null}
                preparation={preparation}
                nativeState={nativeState}
                rebuffering={rebuffering}
                waitingForVideo={waitingForVideo}
                fullscreen={fullscreen}
                onBack={() => void handleClose()}
                onToggleFullscreen={() => void toggleFullscreen()}
              />
            )}
          </AnimatePresence>

          {hasError && (
            <div className="player-native-error" onClick={event => event.stopPropagation()}>
              <div className="player-native-error__icon"><WarningTriangle width={27} height={27} /></div>
              <strong>{preparation?.stage === 'error' ? 'This source could not start' : 'Player unavailable'}</strong>
              <span>{errorMessage}</span>
              <button className="btn btn-secondary" onClick={() => void handleClose()}>Back</button>
            </div>
          )}

          <AnimatePresence>
            {feedback && !bufferOverlayActive && !hasError && (
              <motion.div
                className="player-feedback"
                initial={{ opacity: 0, scale: 0.96, y: 5 }}
                animate={{ opacity: 1, scale: 1, y: 0 }}
                exit={{ opacity: 0, scale: 0.98, y: -4 }}
              >
                {feedback}
              </motion.div>
            )}
          </AnimatePresence>
        </div>

        <AnimatePresence>
          {controlsVisible && !bufferOverlayActive && !hasError && preparation?.stage !== 'adding' && (
            <motion.div
              className="player-controls"
              initial={{ opacity: 0, y: 14 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: 14 }}
              transition={{ duration: 0.16 }}
            >
              <ProgressBar
                position={player.position}
                duration={player.duration}
                bufferAheadSeconds={nativeState?.cacheDuration || 0}
                onSeek={(position) => {
                  updatePlayer({ position })
                  void command({ type: 'seekAbsolute', seconds: position })
                }}
              />

              <div className="player-controls-row">
                <div className="player-controls-left">
                  <button className="btn btn-ghost btn-icon" onClick={() => seek(-10)} title="Back 10 seconds (←)" aria-label="Back 10 seconds">
                    <SkipTenIcon direction="back" width={23} height={23} />
                  </button>
                  <button
                    className="btn btn-ghost btn-icon player-play-btn"
                    onClick={togglePlay}
                    title={player.paused ? 'Play (Space)' : 'Pause (Space)'}
                    aria-label={player.paused ? 'Play' : 'Pause'}
                  >
                    {player.paused ? <Play width={27} height={27} /> : <Pause width={26} height={26} />}
                  </button>
                  <button className="btn btn-ghost btn-icon" onClick={() => seek(10)} title="Forward 10 seconds (→)" aria-label="Forward 10 seconds">
                    <SkipTenIcon direction="forward" width={23} height={23} />
                  </button>

                  <div className="volume-control" onMouseEnter={() => setVolumeOpen(true)} onMouseLeave={() => setVolumeOpen(false)}>
                    <button
                      className="btn btn-ghost btn-icon"
                      onClick={() => toggleMute()}
                      title={muted || player.volume === 0 ? 'Unmute (M)' : 'Mute (M)'}
                      aria-label={muted || player.volume === 0 ? 'Unmute' : 'Mute'}
                    >
                      {muted || player.volume === 0 ? <SoundOff width={21} height={21} /> : <SoundHigh width={21} height={21} />}
                    </button>
                    <AnimatePresence>
                      {volumeOpen && <VolumeSlider volume={player.volume} onChange={setVolume} />}
                    </AnimatePresence>
                  </div>

                  <span className="player-time">{formatTime(player.position)} <i>/</i> {formatTime(player.duration)}</span>
                </div>

                <div className="player-controls-right">
                  <button
                    className={`btn btn-ghost btn-icon ${tracksPanelOpen ? 'active' : ''}`}
                    onClick={() => {
                      setNetworkPanelOpen(false)
                      setTracksPanelOpen(current => !current)
                    }}
                    title="Tracks (S)"
                    aria-label="Audio and subtitle tracks"
                  >
                    <ClosedCaptionsTag width={21} height={21} />
                  </button>
                  <button
                    className={`btn btn-ghost btn-icon ${networkPanelOpen ? 'active' : ''}`}
                    onClick={() => {
                      setTracksPanelOpen(false)
                      setNetworkPanelOpen(current => !current)
                    }}
                    title="Network"
                    aria-label="Network status"
                  >
                    <Download width={20} height={20} />
                  </button>
                </div>
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        <AnimatePresence>
          {menuOpen && !bufferOverlayActive && !hasError && (
            <motion.div
              className="player-panel-scrim"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.12 }}
              onClick={(event) => {
                event.stopPropagation()
                setTracksPanelOpen(false)
                setNetworkPanelOpen(false)
              }}
            />
          )}
        </AnimatePresence>

        <AnimatePresence>
          {tracksPanelOpen && !bufferOverlayActive && !hasError && (
            <TracksPanel
              mediaItem={player.mediaItem}
              mediaTitle={title}
              filePath={player.filePath || session?.filePath}
              tracks={nativeState?.tracks || []}
              activeSubtitleTrack={nativeState?.subtitleTrack ?? null}
              activeAudioTrack={nativeState?.audioTrack ?? null}
              switchingAudioTrack={switchingAudioTrack}
              onSelectAudio={selectAudioTrack}
              onSyncFeedback={(ms) => showFeedback(formatDelay(ms))}
              onClose={() => setTracksPanelOpen(false)}
            />
          )}
        </AnimatePresence>

        <AnimatePresence>
          {networkPanelOpen && !bufferOverlayActive && !hasError && (
            <NetworkPanel
              preparation={preparation}
              nativeState={nativeState}
              onClose={() => setNetworkPanelOpen(false)}
            />
          )}
        </AnimatePresence>
      </motion.div>
    </IconoirProvider>
  )
}
