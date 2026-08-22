import { useRef, useState, useCallback } from 'react'

interface Props {
  position: number
  duration: number
  bufferAheadSeconds?: number
  onSeek: (position: number) => void
}

function formatTime(secs: number): string {
  const h = Math.floor(secs / 3600)
  const m = Math.floor((secs % 3600) / 60)
  const s = Math.floor(secs % 60)
  return h > 0
    ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
    : `${m}:${String(s).padStart(2, '0')}`
}

export function ProgressBar({ position, duration, bufferAheadSeconds = 0, onSeek }: Props) {
  const trackRef = useRef<HTMLDivElement>(null)
  const [hovering, setHovering] = useState(false)
  const [hoverX, setHoverX] = useState(0)
  const [hoverTime, setHoverTime] = useState(0)
  const [scrubbing, setScrubbing] = useState(false)

  const played = duration > 0 ? Math.max(0, Math.min(100, (position / duration) * 100)) : 0
  const bufferedPosition = Math.max(position, position + Math.max(0, bufferAheadSeconds))
  const buffered = duration > 0
    ? Math.max(played, Math.min(100, (bufferedPosition / duration) * 100))
    : played

  const positionFromEvent = useCallback((e: React.MouseEvent | MouseEvent): number => {
    if (!trackRef.current || duration <= 0) return 0
    const rect = trackRef.current.getBoundingClientRect()
    const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width))
    return ratio * duration
  }, [duration])

  const handleMouseMove = (e: React.MouseEvent) => {
    if (!trackRef.current) return
    const rect = trackRef.current.getBoundingClientRect()
    const x = Math.max(0, Math.min(rect.width, e.clientX - rect.left))
    setHoverX(x)
    setHoverTime(positionFromEvent(e))
    if (scrubbing) onSeek(positionFromEvent(e))
  }

  const handleMouseDown = (e: React.MouseEvent) => {
    if (duration <= 0) return
    setScrubbing(true)
    onSeek(positionFromEvent(e))

    const onMove = (ev: MouseEvent) => onSeek(positionFromEvent(ev))
    const onUp = () => {
      setScrubbing(false)
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }

  return (
    <div className="progress-wrapper">
      {hovering && duration > 0 && (
        <div
          className="progress-tooltip"
          style={{ left: Math.max(24, Math.min(hoverX, (trackRef.current?.offsetWidth ?? 0) - 24)) }}
        >
          {formatTime(hoverTime)}
        </div>
      )}

      <div
        ref={trackRef}
        className={`progress-track ${scrubbing ? 'progress-track--scrubbing' : ''}`}
        onMouseEnter={() => setHovering(true)}
        onMouseLeave={() => setHovering(false)}
        onMouseMove={handleMouseMove}
        onMouseDown={handleMouseDown}
      >
        <div className="progress-buffer" style={{ width: `${buffered}%` }} />
        <div className="progress-played" style={{ width: `${played}%` }}>
          <div className={`progress-handle ${hovering || scrubbing ? 'progress-handle--visible' : ''}`} />
        </div>
      </div>
    </div>
  )
}
