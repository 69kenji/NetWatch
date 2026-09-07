import { useEffect, useRef, useState } from 'react'
import { motion } from 'framer-motion'
import { Check, RefreshCircle, WarningTriangle, Xmark } from 'iconoir-react'

type Props = {
  runtime: NetWatchRuntimeStatus
  onClose: () => void
  onRetry: () => void
}

const SERVICE_LABELS: Array<[keyof NetWatchRuntimeStatus['services'], string]> = [
  ['docker', 'Docker Desktop'],
  ['stack', 'VPN Tunnel'],
  ['backend', 'Backend API'],
  ['torrentEngine', 'Torrent Engine'],
  ['prowlarr', 'Prowlarr'],
]

function stateMode(value: string) {
  const normalized = String(value || '').toLowerCase()
  if (['error', 'unhealthy', 'failed', 'dead', 'disconnected', 'not connected', 'unavailable', 'stopped', 'missing'].some(token => normalized.includes(token))) return 'error'
  if (['ready', 'healthy', 'running', 'ok', 'connected'].some(token => normalized.includes(token))) return 'ready'
  return 'pending'
}

export function RuntimeDiagnostics({ runtime, onClose, onRetry }: Props) {
  const drawerRef = useRef<HTMLElement>(null)
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'error'>('idle')

  const copyDiagnostics = async () => {
    try {
      const api = window.electron?.diagnostics
      if (!api) throw new Error('Diagnostics bridge unavailable')
      await api.copy()
      setCopyState('copied')
    } catch {
      setCopyState('error')
    }
  }

  useEffect(() => {
    const handlePointerDown = (event: PointerEvent) => {
      if ((event.target as Element | null)?.closest?.('[data-runtime-toggle="true"]')) return
      if (!drawerRef.current?.contains(event.target as Node)) onClose()
    }

    document.addEventListener('pointerdown', handlePointerDown)
    return () => document.removeEventListener('pointerdown', handlePointerDown)
  }, [onClose])

  return (
    <motion.aside
      id="netwatch-runtime-diagnostics"
      ref={drawerRef}
      className="nw-diagnostics-drawer"
      initial={{ x: '100%' }}
      animate={{ x: 0 }}
      exit={{ x: '100%' }}
      transition={{ type: 'spring', stiffness: 330, damping: 34 }}
    >
      <header className="nw-diagnostics-drawer__header">
        <div>
          <h2>Runtime</h2>
        </div>
        <button className="nw-icon-button" onClick={onClose} aria-label="Close diagnostics" title="Close">
          <Xmark width={18} height={18} />
        </button>
      </header>

      <div className={`nw-runtime-summary ${runtime.ready ? 'is-ready' : runtime.phase === 'error' ? 'is-error' : 'is-starting'}`}>
        <span className="nw-runtime-summary__icon">
          {runtime.ready ? <Check width={21} height={21} /> : runtime.phase === 'error' ? <WarningTriangle width={21} height={21} /> : <RefreshCircle width={21} height={21} className="nw-spin" />}
        </span>
        <div>
          <strong>{runtime.ready ? 'Ready' : runtime.message}</strong>
          {!runtime.ready && <span>{runtime.error || 'Starting services…'}</span>}
        </div>
      </div>

      <section className="nw-diagnostics-section">
                <div className="nw-service-list">
          {SERVICE_LABELS.map(([key, label]) => {
            const value = runtime.services[key]
            const mode = stateMode(value)
            return (
              <div className="nw-service-row" key={key}>
                <span className={`nw-service-dot is-${mode}`} />
                <div>
                  <strong>{label}</strong>
                  <span>{value || 'pending'}</span>
                </div>
              </div>
            )
          })}
        </div>
      </section>

      <div className="nw-diagnostics-drawer__spacer" />
      <div className="nw-diagnostics-actions">
        <button className="btn btn-secondary nw-diagnostics-copy" onClick={() => void copyDiagnostics()}>
          {copyState === 'copied' ? 'Copied' : copyState === 'error' ? 'Copy failed' : 'Copy diagnostics'}
        </button>
        {!runtime.ready && (
          <button className="btn btn-primary nw-diagnostics-retry" onClick={onRetry}>
            <RefreshCircle width={17} height={17} /> Retry
          </button>
        )}
      </div>
    </motion.aside>
  )
}
