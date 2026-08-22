import { Compass, Home, Settings, WarningTriangle, RefreshCircle, Check } from 'iconoir-react'
import type { NetWatchView } from '../types/torrents'

type SidebarProps = {
  view: NetWatchView
  runtime: NetWatchRuntimeStatus
  onNavigate: (view: NetWatchView) => void
  onRuntimeClick: () => void
}

export function Sidebar({ view, runtime, onNavigate, onRuntimeClick }: SidebarProps) {
  const runtimeLabel = runtime.phase === 'error' ? 'Needs attention' : runtime.ready ? 'Ready' : runtime.message || 'Starting'

  return (
    <aside className="nw-sidebar" aria-label="Primary navigation">
      <nav className="nw-sidebar__nav">
        <button
          className={`nw-nav-button ${view === 'home' ? 'is-active' : ''}`}
          onClick={() => onNavigate('home')}
          data-tooltip="Home"
          aria-label="Home"
          aria-current={view === 'home' ? 'page' : undefined}
        >
          <Home width={21} height={21} />
        </button>
        <button
          className={`nw-nav-button ${view === 'discover' ? 'is-active' : ''}`}
          onClick={() => onNavigate('discover')}
          data-tooltip="Discover"
          aria-label="Discover"
          aria-current={view === 'discover' ? 'page' : undefined}
        >
          <Compass width={21} height={21} />
        </button>

        <span className="nw-sidebar__divider" />
        <button
          className={`nw-nav-button ${view === 'settings' ? 'is-active' : ''}`}
          onClick={() => onNavigate('settings')}
          data-tooltip="Settings"
          aria-label="Settings"
          aria-current={view === 'settings' ? 'page' : undefined}
        >
          <Settings width={20} height={20} />
        </button>
      </nav>

      <div className="nw-sidebar__footer">
        <button
          type="button"
          onClick={onRuntimeClick}
          className={`nw-runtime-indicator ${runtime.ready ? 'is-ready' : runtime.phase === 'error' ? 'is-error' : 'is-starting'}`}
          data-tooltip={runtimeLabel}
          aria-label={`Open NetWatch diagnostics: ${runtimeLabel}`}
        >
          {runtime.ready ? (
            <Check width={18} height={18} />
          ) : runtime.phase === 'error' ? (
            <WarningTriangle width={18} height={18} />
          ) : (
            <RefreshCircle width={18} height={18} className="nw-spin" />
          )}
        </button>
      </div>
    </aside>
  )
}
