import { useRef, useState, useCallback } from 'react'
import { motion } from 'framer-motion'

interface Props {
  volume: number        // 0–150
  onChange: (v: number) => void
}

export function VolumeSlider({ volume, onChange }: Props) {
  const trackRef  = useRef<HTMLDivElement>(null)
  const [dragging, setDragging] = useState(false)

  const MAX = 150
  const pct = (volume / MAX) * 100

  // Colour shifts: green → yellow → orange as volume exceeds 100
  const fillColor =
    volume <= 100 ? 'var(--accent)'  :
    volume <= 125 ? 'var(--warning)' : 'var(--danger)'

  const volumeFromEvent = useCallback((e: MouseEvent | React.MouseEvent): number => {
    if (!trackRef.current) return volume
    const rect = trackRef.current.getBoundingClientRect()
    const ratio = 1 - Math.max(0, Math.min(1, (e.clientY - rect.top) / rect.height))
    return Math.round(ratio * MAX)
  }, [volume])

  const handleMouseDown = (e: React.MouseEvent) => {
    e.stopPropagation()
    setDragging(true)
    onChange(volumeFromEvent(e))

    const onMove = (ev: MouseEvent) => onChange(volumeFromEvent(ev))
    const onUp   = () => {
      setDragging(false)
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }

  const handleWheel = (e: React.WheelEvent) => {
    e.stopPropagation()
    const delta = e.deltaY < 0 ? 5 : -5
    onChange(Math.max(0, Math.min(MAX, volume + delta)))
  }

  return (
    <motion.div
      className="volume-popover"
      initial={{ opacity: 0, y: 6, scale: 0.95 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, y: 6, scale: 0.95 }}
      transition={{ duration: 0.12 }}
      onWheel={handleWheel}
    >
      {/* Percentage label */}
      <span className="volume-label">{volume}%</span>

      {/* Vertical track */}
      <div
        ref={trackRef}
        className="volume-track"
        onMouseDown={handleMouseDown}
      >
        {/* Filled portion */}
        <div
          className="volume-fill"
          style={{ height: `${pct}%`, background: fillColor }}
        >
          {/* Handle dot */}
          <div className={`volume-handle ${dragging ? 'volume-handle--dragging' : ''}`} />
        </div>
      </div>

    </motion.div>
  )
}
