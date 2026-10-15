import { useEffect, useRef, useState } from 'react'
import { NavArrowRight } from 'iconoir-react'

// A bounded, local SVG wave; no shader, remote asset, or playback side effect.
export function wavePath(progress: number, phase: number, reduced = false) {
  const fill = Math.max(0, Math.min(1, progress))
  const amplitude = reduced ? 0 : 12 * fill * (1 - fill)
  const points = Array.from({ length: 33 }, (_, index) => {
    const y = index * 100 / 32
    const x = Math.max(0, Math.min(100, fill * 100 + Math.sin(index * Math.PI / 8 + phase) * amplitude))
    return `${x.toFixed(3)},${y.toFixed(3)}`
  })
  return `M0,0 L${points.join(' L')} L0,100 Z`
}

export function NextEpisodeButton({ autoplay, countdown, disabled, title, label, onClick }: {
  autoplay: boolean; countdown: number; disabled: boolean; title?: string; label: string; onClick: () => void
}) {
  const [hovered, setHovered] = useState(false)
  const [focused, setFocused] = useState(false)
  const [reduced, setReduced] = useState(() => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches || false)
  const path = useRef<SVGPathElement>(null)
  const progress = useRef(0)
  useEffect(() => {
    const media = window.matchMedia?.('(prefers-reduced-motion: reduce)')
    const changed = () => setReduced(Boolean(media?.matches))
    media?.addEventListener('change', changed)
    return () => media?.removeEventListener('change', changed)
  }, [])
  useEffect(() => {
    const target = disabled ? 0 : autoplay ? Math.min(1, (11 - countdown) / 10) : hovered || focused ? 1 : 0
    const paint = (value: number, time: number) => {
      progress.current = value
      path.current?.setAttribute('d', wavePath(value, time / 180, reduced))
    }
    if (reduced) { paint(autoplay ? Math.max(0, (10 - countdown) / 10) : target, 0); return }
    const from = progress.current, duration = autoplay ? 1000 : target > from ? 500 : 180
    let frame = 0, started: number | undefined
    const animate = (time: number) => {
      started ??= time
      const elapsed = Math.min(1, (time - started) / duration)
      paint(from + (target - from) * elapsed, time)
      if (elapsed < 1) frame = window.requestAnimationFrame(animate)
    }
    frame = window.requestAnimationFrame(animate)
    return () => window.cancelAnimationFrame(frame)
  }, [autoplay, countdown, disabled, hovered, focused, reduced])
  return <button type="button" className="player-episode-action player-next-episode" disabled={disabled}
    title={title} onClick={onClick} onMouseEnter={() => setHovered(true)} onMouseLeave={() => setHovered(false)}
    onFocus={() => setFocused(true)} onBlur={() => setFocused(false)}>
    <svg className="player-next-episode__fill" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true" focusable="false">
      <path ref={path} d={wavePath(0, 0)} fill="white" />
    </svg>
    <span className="player-next-episode__label">{label}<NavArrowRight width={18} height={18} /></span>
  </button>
}
