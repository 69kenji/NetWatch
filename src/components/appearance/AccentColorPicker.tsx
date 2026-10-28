import { useEffect, useLayoutEffect, useRef, useState, type PointerEvent } from 'react'
import { createPortal } from 'react-dom'
import { DEFAULT_ACCENT, hexColor, resolveAppearance, rgb, validHex } from '../../../shared/appearance.mjs'
import { previewAccent, updateAppearance, useAppearance } from '../../theme/appearance'

function hsv(hex: string) {
  const [r, g, b] = rgb(hex).map((v: number) => v / 255), max = Math.max(r, g, b), min = Math.min(r, g, b), delta = max - min
  const h = !delta ? 0 : max === r ? ((g - b) / delta + 6) % 6 : max === g ? (b - r) / delta + 2 : (r - g) / delta + 4
  return { h: h * 60, s: max ? delta / max * 100 : 0, v: max * 100 }
}
function fromHsv(h: number, s: number, v: number) {
  const c = v / 100 * s / 100, x = c * (1 - Math.abs((h / 60) % 2 - 1)), m = v / 100 - c
  const channels = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x]
  return hexColor(channels.map(n => (n + m) * 255))
}
export function AccentColorPicker({ trigger, onClose }: { trigger: HTMLElement; onClose: () => void }) {
  const { preferences } = useAppearance()
  const [draft, setDraft] = useState(preferences.customAccentColor)
  const [channels, setChannels] = useState(() => hsv(preferences.customAccentColor))
  const [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null)
  const ref = useRef<HTMLDivElement>(null), timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [position, setPosition] = useState({ left: 0, top: 0 })
  const valid = validHex(draft)
  const applied = resolveAppearance({ ...preferences, accentColor: valid ? draft : preferences.accentColor }).tokens['--nw-accent-interactive']
  const close = () => { onClose(); if (trigger.isConnected) trigger.focus({ preventScroll: true }) }
  useLayoutEffect(() => {
    const bounds = trigger.getBoundingClientRect(), menu = ref.current!.getBoundingClientRect()
    setPosition({ left: Math.max(8, Math.min(bounds.left, innerWidth - menu.width - 8)), top: Math.max(8, Math.min(bounds.bottom + 8, innerHeight - menu.height - 8)) })
    ref.current?.querySelector<HTMLInputElement>('input')?.focus()
  }, [trigger])
  useEffect(() => {
    if (!valid) return
    previewAccent(draft.toUpperCase())
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => { void window.electron?.appearance.preview(draft.toUpperCase()).catch(() => {}) }, 60)
    return () => { if (timer.current) clearTimeout(timer.current) }
  }, [draft, valid])
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); previewAccent(null); void window.electron?.appearance.preview(null).catch(() => {}) }, [])
  useEffect(() => {
    const outside = (event: globalThis.PointerEvent) => { if (!busy && !ref.current?.contains(event.target as Node)) close() }
    const resize = () => { if (!busy) close() }
    document.addEventListener('pointerdown', outside, true); window.addEventListener('resize', resize)
    return () => { document.removeEventListener('pointerdown', outside, true); window.removeEventListener('resize', resize) }
  }, [busy, onClose])
  const adjust = (patch: Partial<typeof channels>) => { const next = { ...channels, ...patch }; setChannels(next); setDraft(fromHsv(next.h, next.s, next.v)) }
  const drag = (event: PointerEvent<HTMLDivElement>) => {
    if (busy || event.type === 'pointermove' && !event.currentTarget.hasPointerCapture(event.pointerId)) return
    if (event.type === 'pointerdown') event.currentTarget.setPointerCapture(event.pointerId)
    const bounds = event.currentTarget.getBoundingClientRect()
    adjust({ s: Math.max(0, Math.min(100, (event.clientX - bounds.left) / bounds.width * 100)), v: Math.max(0, Math.min(100, 100 - (event.clientY - bounds.top) / bounds.height * 100)) })
  }
  return createPortal(<div className="nw-accent-picker" ref={ref} style={position} role="dialog" aria-modal="true" aria-label="Custom accent color" onKeyDown={event => {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); if (!busy) close() }
    if (event.key === 'Tab') {
      const targets = Array.from(ref.current!.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled)'))
      const first = targets[0], last = targets.at(-1)
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus() }
      if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus() }
    }
  }}>
    <strong>Accent color</strong>
    <div className="nw-color-map" aria-hidden="true" style={{ backgroundColor: fromHsv(channels.h, 100, 100) }} onPointerDown={drag} onPointerMove={drag} onPointerUp={event => { if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId) }}>
      <i style={{ left: `${channels.s}%`, top: `${100 - channels.v}%` }} />
    </div>
    {(['h', 's', 'v'] as const).map((channel, index) => <label key={channel}>{['Hue', 'Saturation', 'Value'][index]}<input disabled={busy} type="range" min={0} max={channel === 'h' ? 359 : 100} value={Math.round(channels[channel])} className={channel === 'h' ? 'nw-hue-strip' : ''} onChange={event => adjust({ [channel]: Number(event.target.value) })} /><output>{Math.round(channels[channel])}{channel === 'h' ? '°' : '%'}</output></label>)}
    <label>Hex<input aria-invalid={!valid} aria-describedby={!valid ? 'accent-validation' : undefined} disabled={busy} value={draft} maxLength={7} spellCheck={false} onChange={event => {
      const value = event.target.value.startsWith('#') ? event.target.value : '#' + event.target.value
      setDraft(value); if (validHex(value)) setChannels(hsv(value))
    }} onBlur={() => { if (valid) setDraft(draft.toUpperCase()) }} /></label>
    {!valid && <p id="accent-validation" role="status">Enter six hex digits, such as #7B61FF.</p>}
    <div className="nw-accent-sample"><span style={{ background: valid ? draft : preferences.accentColor }} aria-label="Requested color" /><button type="button" className="btn btn-primary" tabIndex={-1}>Sample</button><small>{valid && applied !== draft.toUpperCase() ? `Applied ${applied} for contrast` : 'Contrast-safe controls'}</small></div>
    <button className="btn btn-ghost nw-compact-button" disabled={busy} onClick={() => { setDraft(DEFAULT_ACCENT); setChannels(hsv(DEFAULT_ACCENT)) }}>Reset to NetWatch Violet</button>
    {error && <p role="alert">{error}</p>}
    <footer><button className="btn btn-ghost" disabled={busy} onClick={close}>Cancel</button><button className="btn btn-primary" disabled={!valid || busy} onClick={async () => {
      setBusy(true); setError(null); if (timer.current) clearTimeout(timer.current)
      try { await updateAppearance({ accentColor: draft.toUpperCase(), customAccentColor: draft.toUpperCase() }); close() } catch { setError('Could not save accent color. Try again.') } finally { setBusy(false) }
    }}>Apply</button></footer>
  </div>, document.body)
}
