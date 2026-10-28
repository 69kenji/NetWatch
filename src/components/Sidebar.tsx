import { BookStack, Clock, Compass, Home, Folder, MediaVideoList, Settings, WarningTriangle, RefreshCircle, Check } from 'iconoir-react'
import type { NetWatchView } from '../types/torrents'
import { ProfileAvatar } from './ProfileAvatar'
import { useProfiles } from '../store/profiles'

type SidebarProps = {
  view: NetWatchView
  runtime: NetWatchRuntimeStatus
  runtimeOpen: boolean
  onNavigate: (view: NetWatchView) => void
  onRuntimeClick: () => void
}

export function Sidebar({ view, runtime, runtimeOpen, onNavigate, onRuntimeClick }: SidebarProps) {
  const profiles = useProfiles()
  const activeProfile = profiles?.profiles.find(profile => profile.id === profiles.activeId)
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
        <button className={`nw-nav-button ${view === 'collections' ? 'is-active' : ''}`} onClick={() => onNavigate('collections')}
          data-tooltip="Collections" aria-label="Collections" aria-current={view === 'collections' ? 'page' : undefined}>
          <BookStack width={21} height={21} />
        </button>
        <button className={`nw-nav-button ${view === 'library' ? 'is-active' : ''}`} onClick={() => onNavigate('library')}
          data-tooltip="Library" aria-label="Library" aria-current={view === 'library' ? 'page' : undefined}>
          <Folder width={21} height={21} />
        </button>
        <button className={`nw-nav-button ${view === 'history' ? 'is-active' : ''}`} onClick={() => onNavigate('history')}
          data-tooltip="History" aria-label="History" aria-current={view === 'history' ? 'page' : undefined}>
          <Clock width={21} height={21} />
        </button>
        <button className={`nw-nav-button ${view === 'queue' ? 'is-active' : ''}`} onClick={() => onNavigate('queue')}
          data-tooltip="Queue" aria-label="Queue" aria-current={view === 'queue' ? 'page' : undefined}>
          <MediaVideoList width={21} height={21} />
        </button>
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
        {activeProfile && <button type="button" className={`nw-nav-button nw-profile-nav ${view === 'profile' ? 'is-active' : ''}`}
          onClick={() => onNavigate('profile')} data-tooltip={`Profile: ${activeProfile.name}`} aria-label={`Open ${activeProfile.name} profile`}
          aria-current={view === 'profile' ? 'page' : undefined}><ProfileAvatar profile={activeProfile} size={24} /></button>}
        <button
          type="button"
          onClick={onRuntimeClick}
          className={`nw-runtime-indicator ${runtime.ready ? 'is-ready' : runtime.phase === 'error' ? 'is-error' : 'is-starting'}`}
          data-runtime-toggle="true"
          data-tooltip={runtimeLabel}
          aria-controls="netwatch-runtime-diagnostics"
          aria-expanded={runtimeOpen}
          aria-label={`${runtimeOpen ? 'Close' : 'Open'} NetWatch diagnostics: ${runtimeLabel}`}
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
