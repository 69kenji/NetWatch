import { motion } from 'framer-motion'
import { Download, Group, HardDrive, Xmark } from 'iconoir-react'

interface Props {
  preparation: NativePlayerPreparationState | null
  nativeState: NativePlayerState | null
  onClose: () => void
}

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

function formatPercent(preparation: NativePlayerPreparationState | null): string {
  const explicit = Number(preparation?.progress)
  if (Number.isFinite(explicit) && explicit >= 0) return `${Math.min(100, Math.max(0, explicit * 100)).toFixed(explicit > 0 && explicit < 0.1 ? 1 : 0)}%`
  const downloaded = Number(preparation?.downloaded) || 0
  const size = Number(preparation?.size) || 0
  if (downloaded > 0 && size > 0) return `${Math.min(100, downloaded / size * 100).toFixed(1)}%`
  return '—'
}

function formatTorrentState(value: string | null | undefined): string {
  if (!value) return 'Unknown'
  const labels: Record<string, string> = {
    metaDL: 'Metadata',
    checkingDL: 'Checking',
    downloading: 'Downloading',
    finished: 'Finished',
    seeding: 'Seeding',
    stalledDL: 'Stalled',
    pausedDL: 'Paused',
    queuedDL: 'Queued',
  }
  return labels[value] || value.replace(/([a-z])([A-Z])/g, '$1 $2')
}

export function NetworkPanel({ preparation, nativeState, onClose }: Props) {
  const speed = Math.max(0, Number(preparation?.dlSpeed) || Number(nativeState?.cacheSpeed) || 0)
  const peers = Math.max(0, Number(preparation?.peers) || 0)
  const bufferAhead = Math.max(0, Number(nativeState?.cacheDuration) || 0)
  const downloaded = Math.max(0, Number(preparation?.downloaded) || 0)
  const size = Math.max(0, Number(preparation?.size) || 0)

  return (
    <motion.aside
      className="player-side-panel player-floating-panel player-network-panel"
      initial={{ opacity: 0, y: 12, scale: 0.985 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, y: 8, scale: 0.99 }}
      transition={{ duration: 0.14, ease: 'easeOut' }}
      onClick={event => event.stopPropagation()}
    >
      <header className="player-side-panel__header">
        <div className="player-side-panel__heading">
          <strong>Network</strong>
          <span>Live torrent connection</span>
        </div>
        <button className="btn btn-ghost btn-icon" onClick={onClose} title="Close network" aria-label="Close network">
          <Xmark width={18} height={18} />
        </button>
      </header>

      <div className="player-side-panel__body player-network-panel__body">
        <dl className="player-network-list">
          <div>
            <dt><Download width={15} height={15} /> Download speed</dt>
            <dd>{formatRate(speed)}</dd>
          </div>
          <div>
            <dt><HardDrive width={15} height={15} /> Downloaded</dt>
            <dd>
              <strong>{formatPercent(preparation)}</strong>
              {size > 0 && <small>{formatBytes(downloaded)} / {formatBytes(size)}</small>}
            </dd>
          </div>
          <div>
            <dt><Group width={15} height={15} /> Connected peers</dt>
            <dd>{peers}</dd>
          </div>
          <div>
            <dt>Buffer ahead</dt>
            <dd>{bufferAhead.toFixed(1)} s</dd>
          </div>
          <div>
            <dt>Torrent state</dt>
            <dd>{formatTorrentState(preparation?.torrentState)}</dd>
          </div>
        </dl>
      </div>
    </motion.aside>
  )
}
