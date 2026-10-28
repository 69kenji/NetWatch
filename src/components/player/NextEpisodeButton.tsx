import { useEffect, useRef, useState } from 'react'
import { NavArrowRight } from 'iconoir-react'

// A bounded, local SVG wave; no shader, remote asset, or playback side effect.
export function wavePath(progress: number, phase: number, reduced = false, layer = 0) {
  const fill = Math.max(0, Math.min(1, progress))
  const amplitude = reduced ? 0 : (3.2 + layer * 0.45) * Math.min(1, fill * 4, (1 - fill) * 4)
  const points = Array.from({ length: 25 }, (_, index) => {
    const position = index / 24
    const y = position * 100
    const drift = Math.sin(position * Math.PI * 2.3 + phase * (0.42 + layer * 0.04)) * 0.58
      + Math.sin(position * Math.PI * 0.9 - phase * 0.26 + layer * 1.4) * 0.28
      + Math.cos(position * Math.PI * 3.5 + phase * 0.14 - layer) * 0.14
    const x = Math.max(0, Math.min(100, fill * 100 + drift * amplitude + layer * 1.1 - 1.1))
    return [x, y]
  })
  const [first, ...rest] = points
  const curve = rest.map(([x, y], index) => {
    if (index === rest.length - 1) return `Q${x.toFixed(2)},${y.toFixed(2)} ${x.toFixed(2)},${y.toFixed(2)}`
    const [nextX, nextY] = rest[index + 1]
    return `Q${x.toFixed(2)},${y.toFixed(2)} ${((x + nextX) / 2).toFixed(2)},${((y + nextY) / 2).toFixed(2)}`
  }).join(' ')
  return `M0,0 L${first[0].toFixed(2)},${first[1].toFixed(2)} ${curve} L0,100 Z`
}

export function NextEpisodeButton({ autoplay, countdown, disabled, title, label, onClick }: {
  autoplay: boolean; countdown: number; disabled: boolean; title?: string; label: string; onClick: () => void
}) {
  const [hovered, setHovered] = useState(false)
  const [focused, setFocused] = useState(false)
  const [reduced, setReduced] = useState(() => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches || false)
  const paths = useRef<Array<SVGPathElement | null>>([])
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
      paths.current.forEach((path, layer) => path?.setAttribute('d', wavePath(value, time / 240, reduced, layer)))
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
      <path ref={element => { paths.current[2] = element }} d={wavePath(0, 0, false, 2)} fill="#d5d2ca" opacity="0.55" />
      <path ref={element => { paths.current[1] = element }} d={wavePath(0, 0, false, 1)} fill="#ebe8e0" opacity="0.72" />
      <path ref={element => { paths.current[0] = element }} d={wavePath(0, 0)} fill="#f7f5ef" opacity="0.9" />
    </svg>
    <span className="player-next-episode__label">{label}<NavArrowRight width={18} height={18} /></span>
  </button>
}
