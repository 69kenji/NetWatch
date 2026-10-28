import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'

export function ActionMenu({ x, y, trigger, label, onClose, children, toggleTrigger = false }: {
  x: number
  y: number
  trigger: HTMLElement
  label: string
  onClose: () => void
  children: ReactNode
  toggleTrigger?: boolean
}) {
  const ref = useRef<HTMLDivElement>(null)
  const [position, setPosition] = useState({ left: x, top: y })
  useLayoutEffect(() => {
    const element = ref.current
    if (!element) return
    const bounds = element.getBoundingClientRect()
    setPosition({
      left: Math.max(8, Math.min(x, window.innerWidth - bounds.width - 8)),
      top: Math.max(8, Math.min(y, window.innerHeight - bounds.height - 8)),
    })
    const focusTarget = element.querySelector<HTMLButtonElement>('button:not(:disabled)') || element
    focusTarget.focus({ preventScroll: true })
  }, [x, y])
  useEffect(() => {
    const outside = (event: PointerEvent) => {
      if (toggleTrigger && trigger.contains(event.target as Node)) return
      if (!ref.current?.contains(event.target as Node)) onClose()
    }
    const scroll = (event: Event) => { if (!ref.current?.contains(event.target as Node)) onClose() }
    document.addEventListener('pointerdown', outside, true)
    document.addEventListener('scroll', scroll, true)
    window.addEventListener('resize', onClose)
    window.addEventListener('blur', onClose)
    return () => {
      document.removeEventListener('pointerdown', outside, true)
      document.removeEventListener('scroll', scroll, true)
      window.removeEventListener('resize', onClose)
      window.removeEventListener('blur', onClose)
    }
  }, [onClose, trigger, toggleTrigger])
  return createPortal(<div ref={ref} role="menu" aria-label={label} tabIndex={-1}
    className="nw-card-menu" style={position} onContextMenu={event => event.preventDefault()}
    onKeyDown={event => {
      if (event.key === 'Escape' || event.key === 'Tab') {
        event.preventDefault(); event.stopPropagation(); onClose()
        if (trigger.isConnected) trigger.focus({ preventScroll: true })
      }
      if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
        event.preventDefault(); event.stopPropagation()
        const buttons = Array.from(ref.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') || [])
        const current = buttons.indexOf(document.activeElement as HTMLButtonElement)
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1
          : (current + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length
        buttons[next]?.focus()
      }
    }}>{children}</div>, document.body)
}
