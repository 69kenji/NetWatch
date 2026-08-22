import { useEffect, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { Collapse, Download, Expand, Group, HardDrive, NavArrowLeft } from 'iconoir-react'
import type { MediaItem } from '../../store'

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MB`
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(0)} KB`
  return `${Math.round(bytes)} B`
}

function formatRate(bytesPerSecond: number): string {
  if (!Number.isFinite(bytesPerSecond) || bytesPerSecond <= 0) return '0 B/s'
  return `${formatBytes(bytesPerSecond)}/s`
}

function stageLabel(stage: NativePlayerPreparationStage | undefined): string {
  switch (stage) {
    case 'adding': return 'Adding source'
    case 'metadata': return 'Metadata'
    case 'peers': return 'Peers'
    case 'buffering': return 'Buffering'
    case 'starting': return 'Starting'
    default: return 'Preparing'
  }
}

type Props = {
  title: string
  mediaItem: MediaItem | null
  preparation: NativePlayerPreparationState | null
  nativeState: NativePlayerState | null
  rebuffering: boolean
  waitingForVideo: boolean
  fullscreen: boolean
  onBack: () => void
  onToggleFullscreen: () => void
}

export function BufferingOverlay({ title, mediaItem, preparation, nativeState, rebuffering, waitingForVideo, fullscreen, onBack, onToggleFullscreen }: Props) {
  const [panelOpen, setPanelOpen] = useState(false)

  const fallbackBackdrop = mediaItem?.backdrop || null
  const originalBackdrop = mediaItem?.backdrop_original || null
  const logo = mediaItem?.logo || null

  const startupBuffering = preparation?.stage === 'buffering' && (preparation.bufferTargetBytes || 0) > 0
  const starting = preparation?.stage === 'starting' || waitingForVideo
  const hasProgress = rebuffering || startupBuffering || starting
  const progressPercent = rebuffering
    ? Math.max(0, Math.min(100, Number(nativeState?.cacheBufferingState) || 0))
    : starting
      ? 100
      : startupBuffering
        ? Math.max(0, Math.min(100, (Number(preparation?.bufferProgress) || 0) * 100))
        : null

  const speed = Math.max(0, Number(preparation?.dlSpeed) || Number(nativeState?.cacheSpeed) || 0)
  const peers = Math.max(0, Number(preparation?.peers) || 0)
  const seeders = Math.max(0, Number(preparation?.seeders) || 0)
  const state = rebuffering ? 'Buffering' : waitingForVideo ? 'Starting video' : stageLabel(preparation?.stage)

  const bufferLabel = rebuffering
    ? `${Math.max(0, Number(nativeState?.cacheDuration) || 0).toFixed(1)} s · ${Math.round(progressPercent || 0)}%`
    : (preparation?.bufferTargetBytes || 0) > 0
      ? `${formatBytes(preparation?.bufferedBytes || 0)} / ${formatBytes(preparation?.bufferTargetBytes || 0)}`
      : progressPercent != null
        ? `${Math.round(progressPercent)}%`
        : '—'

  useEffect(() => {
    if (!panelOpen) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setPanelOpen(false)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [panelOpen])

  const brandContent = () => logo ? (
    <img src={logo} alt="" draggable={false} />
  ) : (
    <span>{mediaItem?.title || title}</span>
  )

  return (
    <motion.div
      className="player-buffer-overlay"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.22, ease: 'easeOut' }}
      onClick={event => {
        event.stopPropagation()
        if (panelOpen) setPanelOpen(false)
      }}
    >
      {fallbackBackdrop && (
        <div
          className="player-buffer-overlay__backdrop"
          style={{ backgroundImage: `url(\"${fallbackBackdrop.replace(/\"/g, '%22')}\")` }}
        />
      )}
      {originalBackdrop && originalBackdrop !== fallbackBackdrop && (
        <div
          className="player-buffer-overlay__backdrop player-buffer-overlay__backdrop--original"
          style={{ backgroundImage: `url(\"${originalBackdrop.replace(/\"/g, '%22')}\")` }}
        />
      )}
      <div className="player-buffer-overlay__veil" />

      <button
        className="player-buffer-back"
        type="button"
        title="Back to NetWatch"
        aria-label="Back to NetWatch"
        onClick={event => {
          event.stopPropagation()
          onBack()
        }}
      >
        <NavArrowLeft width={23} height={23} />
      </button>

      <button
        className="player-buffer-fullscreen"
        type="button"
        title={fullscreen ? 'Exit fullscreen' : 'Fullscreen'}
        aria-label={fullscreen ? 'Exit fullscreen' : 'Enter fullscreen'}
        onClick={event => {
          event.stopPropagation()
          onToggleFullscreen()
        }}
      >
        {fullscreen ? <Collapse width={21} height={21} /> : <Expand width={21} height={21} />}
      </button>

      <div className={`player-buffer-brand ${hasProgress ? 'is-buffering' : 'is-pulsing'} ${logo ? 'has-logo' : 'is-text'}`}>
        <div className="player-buffer-brand__base">{brandContent()}</div>
        {progressPercent != null && (
          <div
            className="player-buffer-brand__fill"
            style={{ clipPath: `inset(0 ${Math.max(0, 100 - progressPercent)}% 0 0)` }}
            aria-hidden="true"
          >
            {brandContent()}
          </div>
        )}
      </div>

      <div className={`player-connection-hotspot ${panelOpen ? 'is-open' : ''}`}>
        <button
          className="player-connection-button"
          type="button"
          aria-label="Connection status"
          title="Connection status"
          aria-expanded={panelOpen}
          onClick={event => {
            event.stopPropagation()
            setPanelOpen(current => !current)
          }}
        >
          <Download width={18} height={18} />
        </button>

        <AnimatePresence>
          {panelOpen && (
            <motion.div
              className="player-connection-panel"
              initial={{ opacity: 0, y: 8, scale: 0.98 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: 6, scale: 0.985 }}
              transition={{ duration: 0.14 }}
              onClick={event => event.stopPropagation()}
            >
              <strong>Connection</strong>
              <dl>
                <div><dt><Download width={13} height={13} /> Speed</dt><dd>{formatRate(speed)}</dd></div>
                <div><dt><Group width={13} height={13} /> Peers</dt><dd>{peers}</dd></div>
                <div><dt>Seeds</dt><dd>{seeders}</dd></div>
                <div><dt><HardDrive width={13} height={13} /> Buffer</dt><dd>{bufferLabel}</dd></div>
                <div><dt>State</dt><dd>{state}</dd></div>
              </dl>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </motion.div>
  )
}
