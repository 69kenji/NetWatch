import { useEffect, useRef } from 'react'

type Direction = 'up' | 'down' | 'left' | 'right'

type DirectionalNavigationOptions = {
  arrowKeys?: boolean
  navigationKey: string
  onBack?: () => void
  onForward?: () => void
  onMenu?: () => void
}

const FOCUSABLE = [
  'button:not(:disabled)',
  'a[href]',
  'input:not(:disabled)',
  'select:not(:disabled)',
  'textarea:not(:disabled)',
  '[tabindex]:not([tabindex="-1"])',
].join(',')

const focusMemory = new Map<string, number>()

function visibleFocusableElements() {
  return Array.from(document.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(element => {
    const style = window.getComputedStyle(element)
    const rect = element.getBoundingClientRect()
    return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0
  })
}

function focusInDirection(direction: Direction) {
  const candidates = visibleFocusableElements()
  if (!candidates.length) return

  const active = document.activeElement instanceof HTMLElement && candidates.includes(document.activeElement)
    ? document.activeElement
    : null
  if (!active) {
    const initial = candidates.find(element => element.matches('.nw-sidebar .is-active'))
      || candidates.find(element => element.closest('.nw-content'))
      || candidates[0]
    initial.focus({ preventScroll: true })
    initial.scrollIntoView({ block: 'nearest', inline: 'nearest' })
    return
  }

  const origin = active.getBoundingClientRect()
  const originX = origin.left + origin.width / 2
  const originY = origin.top + origin.height / 2
  let best: { element: HTMLElement; score: number } | null = null

  for (const element of candidates) {
    if (element === active) continue
    const rect = element.getBoundingClientRect()
    const x = rect.left + rect.width / 2
    const y = rect.top + rect.height / 2
    const dx = x - originX
    const dy = y - originY
    const primary = direction === 'left' ? -dx : direction === 'right' ? dx : direction === 'up' ? -dy : dy
    if (primary <= 3) continue
    const cross = direction === 'left' || direction === 'right' ? Math.abs(dy) : Math.abs(dx)
    const score = primary + cross * 2.4
    if (!best || score < best.score) best = { element, score }
  }

  if (best) {
    best.element.focus({ preventScroll: true })
    best.element.scrollIntoView({
      behavior: document.documentElement.dataset.nwReducedMotion === 'true' ? 'auto' : 'smooth',
      block: 'nearest',
      inline: 'nearest',
    })
  }
}

function isEditingTarget(target: EventTarget | null) {
  const element = target instanceof HTMLElement ? target : null
  return Boolean(
    element?.isContentEditable ||
    element?.tagName === 'INPUT' ||
    element?.tagName === 'TEXTAREA' ||
    element?.tagName === 'SELECT',
  )
}

export function useDirectionalNavigation({
  arrowKeys = false,
  navigationKey,
  onBack,
  onForward,
  onMenu,
}: DirectionalNavigationOptions) {
  const actions = useRef({ onBack, onForward, onMenu })
  actions.current = { onBack, onForward, onMenu }
  const gamepadPressed = useRef(new Map<string, boolean>())
  useEffect(() => {
    if (!arrowKeys) return
    const remembered = focusMemory.get(navigationKey)
    if (remembered == null) return
    const timer = window.setTimeout(() => {
      const candidates = visibleFocusableElements()
      candidates[Math.min(remembered, candidates.length - 1)]?.focus({ preventScroll: true })
    }, 0)
    return () => window.clearTimeout(timer)
  }, [arrowKeys, navigationKey])

  useEffect(() => {
    const rememberFocus = () => {
      if (!(document.activeElement instanceof HTMLElement)) return
      const index = visibleFocusableElements().indexOf(document.activeElement)
      if (index >= 0) focusMemory.set(navigationKey, index)
    }
    document.addEventListener('focusin', rememberFocus)
    return () => document.removeEventListener('focusin', rememberFocus)
  }, [navigationKey])

  useEffect(() => {
    if (!arrowKeys) return
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.altKey || event.ctrlKey || event.metaKey || isEditingTarget(event.target)) return
      const direction = ({ ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right' } as const)[event.key]
      if (!direction) return
      event.preventDefault()
      focusInDirection(direction)
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [arrowKeys])

  useEffect(() => {
    let frame = 0
    let lastMove = 0
    const edge = (key: string, down: boolean, action: () => void) => {
      const wasDown = gamepadPressed.current.get(key) || false
      gamepadPressed.current.set(key, down)
      if (down && !wasDown) action()
    }
    const poll = (now: number) => {
      const pad = Array.from(navigator.getGamepads?.() || []).find((candidate): candidate is Gamepad => Boolean(candidate))
      if (pad) {
        const horizontal = Math.abs(pad.axes[0] || 0) > 0.58 ? Math.sign(pad.axes[0]) : 0
        const vertical = Math.abs(pad.axes[1] || 0) > 0.58 ? Math.sign(pad.axes[1]) : 0
        const direction: Direction | null = pad.buttons[12]?.pressed || vertical < 0 ? 'up'
          : pad.buttons[13]?.pressed || vertical > 0 ? 'down'
            : pad.buttons[14]?.pressed || horizontal < 0 ? 'left'
              : pad.buttons[15]?.pressed || horizontal > 0 ? 'right'
                : null
        if (direction && now - lastMove > 180) {
          focusInDirection(direction)
          lastMove = now
        } else if (!direction) {
          lastMove = 0
        }
        edge('select', Boolean(pad.buttons[0]?.pressed), () => {
          if (document.activeElement instanceof HTMLElement) document.activeElement.click()
          else focusInDirection('down')
        })
        edge('back', Boolean(pad.buttons[1]?.pressed), () => actions.current.onBack?.())
        edge('context', Boolean(pad.buttons[2]?.pressed), () => {
          if (!(document.activeElement instanceof HTMLElement)) return
          const rect = document.activeElement.getBoundingClientRect()
          document.activeElement.dispatchEvent(new MouseEvent('contextmenu', {
            bubbles: true,
            cancelable: true,
            clientX: rect.left + rect.width / 2,
            clientY: rect.top + rect.height / 2,
          }))
        })
        edge('menu', Boolean(pad.buttons[9]?.pressed), () => actions.current.onMenu?.())
        edge('history-back', Boolean(pad.buttons[4]?.pressed), () => actions.current.onBack?.())
        edge('history-forward', Boolean(pad.buttons[5]?.pressed), () => actions.current.onForward?.())
      }
      frame = window.requestAnimationFrame(poll)
    }
    frame = window.requestAnimationFrame(poll)
    return () => window.cancelAnimationFrame(frame)
  }, [])
}
