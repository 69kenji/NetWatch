import { useEffect, useMemo, useState } from 'react'
import { Check, NavArrowDown, NavArrowUp, RefreshCircle, WarningTriangle } from 'iconoir-react'
import { HOME_RAIL_LABELS, type NetWatchUiPreferences } from '../utils/preferences'
import { PlaybackSettings } from './PlaybackSettings'
import { localCatalog, useLocalCatalog } from '../store/localCatalog'
import { ProfileControls } from './ProfileControls'
import { AppearanceSettings } from './appearance/AppearanceSettings'
import { DataAndUpdatesSettings } from './DataAndUpdatesSettings'

type Props = {
  preferences: NetWatchUiPreferences
  onChange: (patch: Partial<NetWatchUiPreferences>) => void
  onOpenDiagnostics: () => void
}

type SubtitleCredentialProvider = 'opensubtitles' | 'subdl'


function vpnBookRemaining(expiresAt: string | null | undefined, nowMs: number) {
  if (!expiresAt) return null
  const expiryMs = Date.parse(expiresAt)
  if (!Number.isFinite(expiryMs)) return null
  const remaining = expiryMs - nowMs
  if (remaining <= 0) return 'Estimated expired'
  const day = 24 * 60 * 60 * 1000
  const hour = 60 * 60 * 1000
  const minute = 60 * 1000
  const days = Math.floor(remaining / day)
  const hours = Math.floor((remaining % day) / hour)
  if (days > 0) return `${days}d ${hours}h remaining`
  const minutes = Math.max(1, Math.floor((remaining % hour) / minute))
  return `${hours}h ${minutes}m remaining`
}

export function SettingsView({ preferences, onChange, onOpenDiagnostics }: Props) {
  const { historyEnabled } = useLocalCatalog()
  const update = (patch: Partial<NetWatchUiPreferences>) => onChange(patch)
  const [vpnCheck, setVpnCheck] = useState<NetWatchVpnSanityResult | null>(null)
  const [vpnChecking, setVpnChecking] = useState(false)
  const [vpnCheckError, setVpnCheckError] = useState<string | null>(null)
  const [vpnProfile, setVpnProfile] = useState<NetWatchVpnProfile | null>(null)
  const [vpnProfileBusy, setVpnProfileBusy] = useState(false)
  const [vpnProfileError, setVpnProfileError] = useState<string | null>(null)
  const [vpnRestartRequired, setVpnRestartRequired] = useState(false)
  const [nowMs, setNowMs] = useState(() => Date.now())
  const [credentialStatus, setCredentialStatus] = useState<NetWatchCredentialStatus | null>(null)
  const [credentialBusy, setCredentialBusy] = useState<SubtitleCredentialProvider | null>(null)
  const [credentialError, setCredentialError] = useState<string | null>(null)
  const [editingCredential, setEditingCredential] = useState<SubtitleCredentialProvider | null>(null)
  const [credentialDraft, setCredentialDraft] = useState('')
  const [remoteStatus, setRemoteStatus] = useState<NetWatchRemoteStatus | null>(null)
  const [remoteHost, setRemoteHost] = useState('')
  const [remotePort, setRemotePort] = useState('42117')
  const [remoteBusy, setRemoteBusy] = useState(false)
  const [remoteError, setRemoteError] = useState<string | null>(null)
  const [pairing, setPairing] = useState<NetWatchPairingPayload | null>(null)

  useEffect(() => {
    let active = true
    const load = async () => {
      try {
        const api = window.electron?.runtime
        if (!api?.getVpnProfile) return
        const profile = await api.getVpnProfile()
        if (active) {
          setVpnProfile(profile)
          setVpnRestartRequired(Boolean(profile.replacement_pending))
        }
      } catch (error) {
        if (active) setVpnProfileError(error instanceof Error ? error.message : String(error))
      }
    }
    void load()
    return () => { active = false }
  }, [])

  useEffect(() => {
    let active = true
    const api = window.electron?.remote
    if (!api) return
    const apply = (status: NetWatchRemoteStatus) => {
      if (!active) return
      setRemoteStatus(status)
      setRemoteHost(current => current || status.selected_host || status.interfaces?.[0]?.address || '')
      setRemotePort(current => current === '42117' && status.selected_port ? String(status.selected_port) : current)
      if (!status.pairing_active) setPairing(null)
    }
    void api.getStatus().then(apply, error => {
      if (active) setRemoteError(error instanceof Error ? error.message : String(error))
    })
    const unsubscribe = api.onStatus(apply)
    return () => {
      active = false
      unsubscribe()
    }
  }, [])

  useEffect(() => {
    let active = true
    const load = async () => {
      try {
        const api = window.electron?.runtime
        if (!api?.getCredentialStatus) return
        const status = await api.getCredentialStatus()
        if (active) setCredentialStatus(status)
      } catch (error) {
        if (active) setCredentialError(error instanceof Error ? error.message : String(error))
      }
    }
    void load()
    return () => { active = false }
  }, [])

  useEffect(() => {
    if (vpnProfile?.profile_type !== 'vpnbook') return
    const timer = window.setInterval(() => setNowMs(Date.now()), 60_000)
    return () => window.clearInterval(timer)
  }, [vpnProfile?.profile_type])

  const runVpnSanity = async () => {
    setVpnChecking(true)
    setVpnCheckError(null)
    try {
      const api = window.electron?.runtime
      if (!api?.vpnSanity) throw new Error('VPN sanity check is unavailable in this build.')
      const result = await api.vpnSanity()
      setVpnCheck(result)
    } catch (error) {
      setVpnCheck(null)
      setVpnCheckError(error instanceof Error ? error.message : String(error))
    } finally {
      setVpnChecking(false)
    }
  }

  const changeVpnProfileType = async (profileType: 'generic' | 'vpnbook') => {
    setVpnProfileBusy(true)
    setVpnProfileError(null)
    try {
      const api = window.electron?.runtime
      if (!api?.setVpnProfileType) throw new Error('VPN profile settings are unavailable in this build.')
      setVpnProfile(await api.setVpnProfileType(profileType))
      setNowMs(Date.now())
    } catch (error) {
      setVpnProfileError(error instanceof Error ? error.message : String(error))
    } finally {
      setVpnProfileBusy(false)
    }
  }

  const replaceWireGuard = async () => {
    setVpnProfileBusy(true)
    setVpnProfileError(null)
    try {
      const api = window.electron?.runtime
      if (!api?.replaceWireGuard) throw new Error('VPN configuration replacement is unavailable in this build.')
      const result = await api.replaceWireGuard(vpnProfile?.profile_type === 'vpnbook' ? 'vpnbook' : 'generic')
      setVpnProfile(result.profile)
      setNowMs(Date.now())
      if (!result.cancelled && result.restart_required) setVpnRestartRequired(true)
    } catch (error) {
      setVpnProfileError(error instanceof Error ? error.message : String(error))
    } finally {
      setVpnProfileBusy(false)
    }
  }

  const openVpnBook = async () => {
    setVpnProfileError(null)
    try {
      const api = window.electron?.runtime
      if (!api?.openVpnBook) throw new Error('VPNBook link is unavailable in this build.')
      await api.openVpnBook()
    } catch (error) {
      setVpnProfileError(error instanceof Error ? error.message : String(error))
    }
  }

  const restartApp = async () => {
    setVpnProfileBusy(true)
    try {
      const api = window.electron?.runtime
      if (!api?.restartApp) throw new Error('Application restart is unavailable in this build.')
      await api.restartApp()
    } catch (error) {
      setVpnProfileError(error instanceof Error ? error.message : String(error))
      setVpnProfileBusy(false)
    }
  }

  const beginCredentialEdit = (provider: SubtitleCredentialProvider) => {
    setCredentialError(null)
    setCredentialDraft('')
    setEditingCredential(provider)
  }

  const cancelCredentialEdit = () => {
    setCredentialDraft('')
    setEditingCredential(null)
    setCredentialError(null)
  }

  const openCredentialSite = async (provider: SubtitleCredentialProvider) => {
    setCredentialError(null)
    try {
      const api = window.electron?.runtime
      if (!api?.openCredentialSite) throw new Error('Credential links are unavailable in this build.')
      await api.openCredentialSite(provider)
    } catch (error) {
      setCredentialError(error instanceof Error ? error.message : String(error))
    }
  }

  const saveSubtitleCredential = async () => {
    const provider = editingCredential
    if (!provider || credentialBusy) return
    const raw = credentialDraft.trim()
    let candidate = raw
    if (provider === 'opensubtitles') {
      if (raw.length !== 32) {
        setCredentialError('OpenSubtitles API key must be exactly 32 characters.')
        return
      }
    } else {
      if (raw.startsWith('subdl_')) {
        setCredentialError('Paste only the 43 characters after subdl_.')
        return
      }
      if (raw.length !== 43) {
        setCredentialError('SubDL requires exactly 43 characters after subdl_.')
        return
      }
      candidate = `subdl_${raw}`
    }

    setCredentialBusy(provider)
    setCredentialError(null)
    try {
      const api = window.electron?.runtime
      if (!api?.setSubtitleCredential) throw new Error('Credential management is unavailable in this build.')
      const status = await api.setSubtitleCredential(provider, candidate)
      setCredentialStatus(status)
      setEditingCredential(null)
    } catch (error) {
      setCredentialError(error instanceof Error ? error.message : String(error))
    } finally {
      candidate = ''
      setCredentialDraft('')
      setCredentialBusy(null)
    }
  }

  const runRemoteAction = async (action: () => Promise<NetWatchRemoteStatus>) => {
    setRemoteBusy(true)
    setRemoteError(null)
    try {
      setRemoteStatus(await action())
    } catch (error) {
      setRemoteError(error instanceof Error ? error.message : String(error))
    } finally {
      setRemoteBusy(false)
    }
  }

  const enableRemote = () => {
    const port = Number(remotePort)
    if (!remoteHost || !Number.isInteger(port) || port < 1024 || port > 65535) {
      setRemoteError('Select a private network interface and a port from 1024 to 65535.')
      return
    }
    const api = window.electron?.remote
    if (!api) return
    void runRemoteAction(() => api.enable({ host: remoteHost, port }))
  }

  const beginPairing = async () => {
    const api = window.electron?.remote
    if (!api) return
    setRemoteBusy(true)
    setRemoteError(null)
    try {
      setPairing(await api.beginPairing())
    } catch (error) {
      setRemoteError(error instanceof Error ? error.message : String(error))
    } finally {
      setRemoteBusy(false)
    }
  }

  const checkedTime = vpnCheck?.checked_at
    ? new Date(vpnCheck.checked_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : null
  const vpnEgressVerified = Boolean(vpnCheck?.connected && vpnCheck?.public_ip && vpnCheck?.structural_verified)
  const vpnDnsDegraded = Boolean(vpnEgressVerified && vpnCheck?.dns_ok === false)
  const vpnBookStatus = useMemo(
    () => vpnProfile?.profile_type === 'vpnbook' ? vpnBookRemaining(vpnProfile.estimated_expires_at, nowMs) : null,
    [vpnProfile, nowMs],
  )

  return (
    <section className="nw-view nw-settings-view">
      <header className="nw-settings-header">
        <h1>Settings</h1>
      </header>

      <div className="nw-settings-stack">
        <AppearanceSettings />

        <section className="nw-settings-group" aria-labelledby="profiles-settings-title">
          <header className="nw-settings-group__header">
            <h2 id="profiles-settings-title">Profiles</h2>
          </header>
          <div className="nw-settings-list"><ProfileControls /></div>
        </section>

        <section className="nw-settings-group" aria-labelledby="playback-settings-title">
          <header className="nw-settings-group__header">
            <h2 id="playback-settings-title">Playback</h2>
          </header>
          <div className="nw-settings-list"><PlaybackSettings preferences={preferences} onChange={update} /></div>
        </section>

        <section className="nw-settings-group" aria-labelledby="accessibility-settings-title">
          <header className="nw-settings-group__header">
            <h2 id="accessibility-settings-title">Accessibility and TV</h2>
          </header>
          <div className="nw-settings-list">
            <section className="nw-settings-card nw-settings-card--compact">
              <div className="nw-settings-card__copy">
                <strong>Interface size</strong>
              </div>
              <select className="nw-settings-select" aria-label="Interface size" value={preferences.interfaceScale}
                onChange={event => update({ interfaceScale: Number(event.target.value) as NetWatchUiPreferences['interfaceScale'] })}>
                <option value={100}>100%</option>
                <option value={115}>115%</option>
                <option value={130}>130%</option>
              </select>
            </section>

            <section className="nw-settings-card nw-settings-card--compact">
              <div className="nw-settings-card__copy">
                <strong>High contrast</strong>
              </div>
              <select className="nw-settings-select" aria-label="High contrast" value={preferences.contrastMode}
                onChange={event => update({ contrastMode: event.target.value as NetWatchUiPreferences['contrastMode'] })}>
                <option value="standard">Standard</option>
                <option value="strong">Strong</option>
              </select>
            </section>

            <section className="nw-settings-card nw-settings-card--compact">
              <div className="nw-settings-card__copy">
                <strong>Reduced motion</strong>
              </div>
              <select className="nw-settings-select" aria-label="Reduced motion" value={preferences.reducedMotion ? 'enabled' : 'disabled'}
                onChange={event => update({ reducedMotion: event.target.value === 'enabled' })}>
                <option value="disabled">Follow Windows</option>
                <option value="enabled">Reduce</option>
              </select>
            </section>

            <section className="nw-settings-card nw-settings-card--compact">
              <div className="nw-settings-card__copy">
                <strong>TV mode</strong>
                <small>Larger controls. Controller: A select, B back, X options.</small>
              </div>
              <select className="nw-settings-select" aria-label="TV and controller mode" value={preferences.tvMode ? 'enabled' : 'disabled'}
                onChange={event => update({ tvMode: event.target.value === 'enabled' })}>
                <option value="disabled">Off</option>
                <option value="enabled">On</option>
              </select>
            </section>
          </div>
        </section>

        <section className="nw-settings-group" aria-labelledby="home-settings-title">
          <header className="nw-settings-group__header"><h2 id="home-settings-title">Home</h2></header>
          <div className="nw-settings-list">
            {preferences.homeRailOrder.map((key, index) => <section className="nw-settings-card nw-settings-card--compact" key={key}>
              <div className="nw-settings-card__copy"><strong>{HOME_RAIL_LABELS[key]}</strong></div>
              <div className="nw-compact-actions">
                <select className="nw-settings-select" aria-label={`${HOME_RAIL_LABELS[key]} visibility`}
                  value={preferences.hiddenHomeRails.includes(key) ? 'hidden' : 'visible'} onChange={event => onChange({
                    hiddenHomeRails: event.target.value === 'hidden'
                      ? [...new Set([...preferences.hiddenHomeRails, key])]
                      : preferences.hiddenHomeRails.filter(item => item !== key),
                  })}>
                  <option value="visible">Show</option><option value="hidden">Hide</option>
                </select>
                <button className="nw-icon-button" disabled={index === 0} title="Move up" aria-label={`Move ${HOME_RAIL_LABELS[key]} up`} onClick={() => {
                  const order = [...preferences.homeRailOrder]; [order[index - 1], order[index]] = [order[index], order[index - 1]]; onChange({ homeRailOrder: order })
                }}><NavArrowUp width={17} /></button>
                <button className="nw-icon-button" disabled={index === preferences.homeRailOrder.length - 1} title="Move down" aria-label={`Move ${HOME_RAIL_LABELS[key]} down`} onClick={() => {
                  const order = [...preferences.homeRailOrder]; [order[index + 1], order[index]] = [order[index], order[index + 1]]; onChange({ homeRailOrder: order })
                }}><NavArrowDown width={17} /></button>
              </div>
            </section>)}
            <section className="nw-settings-card nw-settings-card--compact">
              <div className="nw-settings-card__copy"><strong>New episode notifications</strong><small>Notify me about new episodes.</small></div>
              <select className="nw-settings-select" value={preferences.trackedSeriesNotifications ? 'enabled' : 'disabled'} aria-label="New episode notifications"
                onChange={event => onChange({ trackedSeriesNotifications: event.target.value === 'enabled' })}>
                <option value="disabled">Off</option><option value="enabled">On</option>
              </select>
            </section>
          </div>
        </section>

        <section className="nw-settings-group" aria-labelledby="general-settings-title">
          <header className="nw-settings-group__header">
            <h2 id="general-settings-title">General</h2>
          </header>
          <div className="nw-settings-list">
        <section className="nw-settings-card nw-settings-card--compact">
          <div className="nw-settings-card__copy">
            <strong>Video quality</strong>
          </div>
          <select
            className="nw-settings-select"
            aria-label="Video quality"
            value={preferences.defaultQuality}
            onChange={event => update({ defaultQuality: event.target.value as NetWatchUiPreferences['defaultQuality'] })}
          >
            <option value="all">All</option>
            <option value="2160p">2160p</option>
            <option value="1080p">1080p</option>
            <option value="720p">720p</option>
          </select>
        </section>

        <section className="nw-settings-card nw-settings-card--compact">
          <div className="nw-settings-card__copy">
            <strong>Always skip intro</strong>
          </div>
          <select
            className="nw-settings-select"
            aria-label="Always skip intro"
            value={preferences.alwaysSkipIntro ? 'enabled' : 'disabled'}
            onChange={event => update({ alwaysSkipIntro: event.target.value === 'enabled' })}
          >
            <option value="disabled">Off</option>
            <option value="enabled">On</option>
          </select>
        </section>

        <section className="nw-settings-card nw-settings-card--compact">
          <div className="nw-settings-card__copy">
            <strong>Close button</strong>
          </div>
          <select
            className="nw-settings-select"
            aria-label="On close"
            value={preferences.onClose}
            onChange={event => update({ onClose: event.target.value as NetWatchUiPreferences['onClose'] })}
          >
            <option value="minimize-to-tray">Minimize to tray</option>
            <option value="exit">Exit</option>
          </select>
        </section>

        <section className="nw-settings-card nw-settings-card--compact">
          <div className="nw-settings-card__copy">
            <strong>Launch with Windows</strong>
          </div>
          <select
            className="nw-settings-select"
            aria-label="Launch with Windows"
            value={preferences.startWithWindows ? 'enabled' : 'disabled'}
            onChange={event => update({ startWithWindows: event.target.value === 'enabled' })}
          >
            <option value="disabled">Disabled</option>
            <option value="enabled">Enabled</option>
          </select>
        </section>

        <section className="nw-settings-card nw-settings-card--compact">
          <div className="nw-settings-card__copy">
            <strong>Startup window</strong>
          </div>
          <select
            className="nw-settings-select"
            aria-label="Startup window state"
            value={preferences.startMinimized ? 'minimized' : 'window'}
            disabled={!preferences.startWithWindows}
            onChange={event => update({ startMinimized: event.target.value === 'minimized' })}
          >
            <option value="window">Open window</option>
            <option value="minimized">Minimize to tray</option>
          </select>
        </section>

        <section className="nw-settings-card nw-settings-card--compact">
          <div className="nw-settings-card__copy">
            <strong>Search history</strong>
            <small>Keeps the last 20 searches. Turning it off clears them.</small>
          </div>
          <select
            className="nw-settings-select"
            aria-label="Search history"
            value={historyEnabled ? 'enabled' : 'disabled'}
            onChange={event => localCatalog.setHistoryEnabled(event.target.value === 'enabled')}
          >
            <option value="enabled">Enabled</option>
            <option value="disabled">Disabled</option>
          </select>
        </section>

        <section className="nw-settings-card nw-settings-card--compact">
          <div className="nw-settings-card__copy">
            <strong>Keep Watching and episode progress</strong>
          </div>
          <select
            className="nw-settings-select"
            aria-label="Keep Watching and episode progress"
            value={preferences.keepWatchingEnabled ? 'enabled' : 'disabled'}
            onChange={event => update({ keepWatchingEnabled: event.target.value === 'enabled' })}
          >
            <option value="enabled">Enabled</option>
            <option value="disabled">Disabled</option>
          </select>
        </section>

        <section className="nw-settings-card nw-settings-card--compact">
          <div className="nw-settings-card__copy">
            <strong>Keep Watching limit</strong>
          </div>
          <select
            className="nw-settings-select"
            aria-label="Keep Watching limit"
            value={preferences.keepWatchingLimit}
            disabled={!preferences.keepWatchingEnabled}
            onChange={event => update({ keepWatchingLimit: Number(event.target.value) })}
          >
            {Array.from({ length: 20 }, (_, index) => index + 1).map(value => (
              <option value={value} key={value}>{value}</option>
            ))}
          </select>
        </section>

        <section className="nw-settings-card nw-settings-card--compact">
          <div className="nw-settings-card__copy">
            <strong>FlareSolverr</strong>
            <small>Use only when an indexer needs it.</small>
          </div>
          <select
            className="nw-settings-select"
            aria-label="FlareSolverr"
            value={preferences.flareSolverrEnabled ? 'enabled' : 'disabled'}
            onChange={event => update({ flareSolverrEnabled: event.target.value === 'enabled' })}
          >
            <option value="disabled">Off</option>
            <option value="enabled">On</option>
          </select>
        </section>

        <section className="nw-settings-card nw-settings-card--compact">
          <div className="nw-settings-card__copy">
            <strong>Resource usage</strong>
          </div>
          <select
            className="nw-settings-select"
            aria-label="Resource usage"
            value={preferences.resourceProfile}
            onChange={event => update({ resourceProfile: event.target.value as NetWatchUiPreferences['resourceProfile'] })}
          >
            <option value="standard">Standard</option>
            <option value="reduced">Reduced</option>
          </select>
        </section>
          </div>
        </section>

        <DataAndUpdatesSettings preferences={preferences} onChange={update} />
      </div>

      <section className={`nw-settings-runtime nw-settings-runtime--privacy ${vpnEgressVerified ? 'is-safe' : vpnCheckError ? 'is-error' : ''}`}>
        <div className="nw-vpn-sanity-copy">
          <span className="nw-settings-label">Network</span>
          <strong>VPN</strong>

          <div className="nw-vpn-profile-controls">
            <label className="nw-vpn-profile-field">
              <span>VPN provider</span>
              <select
                className="nw-settings-select nw-vpn-profile-select"
                value={vpnProfile?.profile_type || 'generic'}
                disabled={!vpnProfile || vpnProfileBusy || vpnRestartRequired}
                onChange={event => void changeVpnProfileType(event.target.value === 'vpnbook' ? 'vpnbook' : 'generic')}
              >
                <option value="generic">Generic WireGuard</option>
                <option value="vpnbook">VPNBook</option>
              </select>
            </label>

            {vpnProfile && !vpnRestartRequired && (
              <div className="nw-vpn-config-status">
                <span>Configuration</span>
                <strong>In use</strong>
              </div>
            )}

            {vpnProfile?.profile_type === 'vpnbook' && (
              <div className={`nw-vpn-expiry ${vpnBookStatus === 'Estimated expired' ? 'is-warning' : ''}`}>
                <span>Estimated profile expiry</span>
                <strong>{vpnBookStatus || 'Expiry unknown'}</strong>
                <small>Connection checks still apply.</small>
              </div>
            )}

            {vpnRestartRequired && (
              <div className="nw-vpn-restart-notice">
                <strong>VPN configuration updated</strong>
                <small>Restart NetWatch to use it.</small>
              </div>
            )}

            {vpnProfileError && <p className="nw-vpn-profile-error">{vpnProfileError}</p>}

            <div className="nw-vpn-profile-actions">
              <button className="btn btn-secondary" onClick={() => void replaceWireGuard()} disabled={vpnProfileBusy || !vpnProfile || vpnRestartRequired}>
                {vpnProfileBusy ? 'Working…' : 'Replace configuration'}
              </button>
              {vpnProfile?.profile_type === 'vpnbook' && (
                <button className="btn btn-secondary" onClick={() => void openVpnBook()} disabled={vpnProfileBusy}>
                  Get new VPNBook config
                </button>
              )}
              <button className="btn btn-secondary" onClick={() => void runVpnSanity()} disabled={vpnChecking}>
                {vpnChecking ? <RefreshCircle width={16} height={16} className="nw-spin" /> : null}
                {vpnChecking ? 'Checking…' : 'Test connection'}
              </button>
              {vpnRestartRequired && (
                <button className="btn btn-primary" onClick={() => void restartApp()} disabled={vpnProfileBusy}>
                  Restart NetWatch
                </button>
              )}
            </div>
          </div>

          {(vpnCheck || vpnCheckError) && (
            <div className={`nw-vpn-sanity-result ${vpnEgressVerified ? 'is-safe' : 'is-error'}`}>
              <span className="nw-vpn-sanity-result__icon">
                {vpnEgressVerified && !vpnDnsDegraded
                  ? <Check width={17} height={17} />
                  : <WarningTriangle width={17} height={17} />}
              </span>
              <div>
                {vpnEgressVerified && vpnCheck?.public_ip ? (
                  <>
                    <span>Public IP</span>
                    <strong className="nw-vpn-sanity-ip">{vpnCheck.public_ip}</strong>
                    <small>
                      Connected
                      {vpnCheck.dns_ok === true ? ' · DNS OK' : ''}
                      {vpnDnsDegraded ? ` · DNS failed${vpnCheck.dns_host ? ` · ${vpnCheck.dns_host}` : ''}` : ''}
                      {checkedTime ? ` · ${checkedTime}` : ''}
                    </small>
                  </>
                ) : (
                  <>
                    <span>Verification failed</span>
                    <strong>{vpnCheckError || vpnCheck?.error || 'Unknown error'}</strong>
                  </>
                )}
              </div>
            </div>
          )}
        </div>
      </section>

      <section className={`nw-settings-runtime nw-remote-panel ${remoteStatus?.enabled ? 'is-safe' : remoteStatus?.error ? 'is-error' : ''}`}>
        <div className="nw-remote-panel__header">
          <div>
            <span className="nw-settings-label">Remote access</span>
            <strong>{remoteStatus?.enabled ? 'On' : 'Off'}</strong>
          </div>
        </div>

        {!remoteStatus?.enabled ? (
          <>
            <div className="nw-remote-enable-row">
              <label>
                <span>Network address</span>
                <select className="nw-settings-select" value={remoteHost} onChange={event => setRemoteHost(event.target.value)} disabled={remoteBusy}>
                  {!remoteStatus?.interfaces?.length && <option value="">No private IPv4 interface found</option>}
                  {remoteStatus?.interfaces?.map(item => (
                    <option value={item.address} key={item.id}>{item.name} · {item.address}</option>
                  ))}
                </select>
              </label>
              <label>
                <span>Port</span>
                <input value={remotePort} inputMode="numeric" maxLength={5} onChange={event => setRemotePort(event.target.value.replace(/\D/gu, ''))} disabled={remoteBusy} />
              </label>
              <button className="btn btn-primary" onClick={enableRemote} disabled={remoteBusy || !remoteHost}>Enable</button>
            </div>
            {!!remoteStatus?.paired_devices?.some(item => !item.revoked) && (
              <div className="nw-remote-devices">
                <div className="nw-remote-devices__heading"><strong>Paired devices</strong></div>
                {remoteStatus.paired_devices.filter(item => !item.revoked).map(device => (
                  <div className="nw-remote-device" key={device.id}>
                    <div><strong>{device.name}{device.fingerprint ? ` · ${device.fingerprint}` : ''}</strong><small>{device.last_seen ? `Last seen ${new Date(device.last_seen).toLocaleString()}` : 'Not connected yet'}</small></div>
                    <button className="btn btn-secondary" disabled={remoteBusy} onClick={() => {
                      const api = window.electron?.remote
                      if (api) void runRemoteAction(() => api.revokeDevice(device.id))
                    }}>Revoke</button>
                  </div>
                ))}
                <button className="btn btn-secondary" disabled={remoteBusy} onClick={() => {
                  const api = window.electron?.remote
                  if (api) void runRemoteAction(() => api.revokeAll())
                }}>Revoke all devices</button>
              </div>
            )}
          </>
        ) : (
          <>
            <div className="nw-remote-overview">
              <div className="nw-remote-address">
                <span>Local address</span>
                <strong>{remoteStatus.host || remoteStatus.selected_host}:{remoteStatus.port || remoteStatus.selected_port}</strong>
                <small>{remoteStatus.runtime_ready ? 'Ready' : 'Waiting for NetWatch services'}</small>
              </div>
              {!pairing && <button className="btn btn-primary" onClick={() => void beginPairing()} disabled={remoteBusy}>Pair device</button>}
            </div>

            {pairing && (
              <div className="nw-pairing-card">
                <img src={pairing.qr_data_url} alt="NetWatch Android pairing QR code" />
                <div>
                  <strong>Scan with NetWatch Android</strong>
                  <span>{pairing.host}:{pairing.port}</span>
                  <small>Expires {new Date(pairing.expires_at).toLocaleTimeString()}.</small>
                  <button className="btn btn-secondary" onClick={() => {
                    const api = window.electron?.remote
                    if (api) void runRemoteAction(() => api.cancelPairing())
                  }}>Cancel pairing</button>
                </div>
              </div>
            )}

            <div className="nw-remote-devices">
              <div className="nw-remote-devices__heading"><strong>Paired devices</strong><span>{remoteStatus.paired_devices?.filter(item => !item.revoked).length || 0}</span></div>
              {remoteStatus.paired_devices?.filter(item => !item.revoked).map(device => (
                <div className="nw-remote-device" key={device.id}>
                  <div><strong>{device.name}{device.fingerprint ? ` · ${device.fingerprint}` : ''}</strong><small>{device.last_seen ? `Last seen ${new Date(device.last_seen).toLocaleString()}` : 'Not connected yet'}</small></div>
                  <button className="btn btn-secondary" disabled={remoteBusy} onClick={() => {
                    const api = window.electron?.remote
                    if (api) void runRemoteAction(() => api.revokeDevice(device.id))
                  }}>Revoke</button>
                </div>
              ))}
              {!remoteStatus.paired_devices?.some(item => !item.revoked) && <p className="nw-remote-empty">No paired devices.</p>}
            </div>

            <div className="nw-remote-actions">
              <button className="btn btn-secondary" disabled={remoteBusy} onClick={() => {
                const api = window.electron?.remote
                if (api) void runRemoteAction(() => api.disable())
              }}>Disable</button>
              <button className="btn btn-secondary" disabled={remoteBusy} onClick={() => {
                const api = window.electron?.remote
                if (api) void runRemoteAction(() => api.revokeAll())
              }}>Revoke all devices</button>
              <button className="btn btn-secondary" disabled={remoteBusy} onClick={() => {
                const api = window.electron?.remote
                if (api) void runRemoteAction(() => api.regenerateIdentity())
              }}>Regenerate identity</button>
            </div>
          </>
        )}
        {(remoteError || remoteStatus?.error) && <p className="nw-credential-error">{remoteError || remoteStatus?.error}</p>}
      </section>

      <section className="nw-settings-runtime nw-credentials-panel">
        <div className="nw-credentials-panel__header">
          <span className="nw-settings-label">Credentials</span>
          <strong>API keys</strong>
          <p>Saved keys are hidden.</p>
        </div>

        <div className="nw-credentials-list">
          <div className="nw-credential-row">
            <div><strong>TMDB</strong><small>Required · Metadata</small></div>
            <span className={`nw-credential-status ${credentialStatus?.tmdb ? 'is-configured' : ''}`}>{credentialStatus === null ? 'Checking…' : credentialStatus.tmdb ? 'Configured' : 'Not configured'}</span>
          </div>
          <div className="nw-credential-row">
            <div><strong>Prowlarr</strong><small>Required · Torrent discovery</small></div>
            <span className={`nw-credential-status ${credentialStatus?.prowlarr ? 'is-configured' : ''}`}>{credentialStatus === null ? 'Checking…' : credentialStatus.prowlarr ? 'Configured' : 'Not configured'}</span>
          </div>

          {(['opensubtitles', 'subdl'] as const).map(provider => {
            const label = provider === 'opensubtitles' ? 'OpenSubtitles' : 'SubDL'
            const statusLoaded = credentialStatus !== null
            const configured = Boolean(credentialStatus?.[provider])
            const editing = editingCredential === provider
            const requiredLength = provider === 'subdl' ? 43 : 32
            return (
              <div className="nw-credential-group" key={provider}>
                <div className="nw-credential-row">
                  <div><strong>{label}</strong><small>Optional · Online subtitles</small></div>
                  <div className="nw-credential-row__actions">
                    <span className={`nw-credential-status ${configured ? 'is-configured' : ''}`}>{!statusLoaded ? 'Checking…' : configured ? 'Configured' : 'Not configured'}</span>
                    <button className="btn btn-secondary" onClick={() => void openCredentialSite(provider)} disabled={Boolean(credentialBusy)}>Get key</button>
                    <button className="btn btn-secondary" onClick={() => beginCredentialEdit(provider)} disabled={Boolean(credentialBusy) || !statusLoaded}>{configured ? 'Replace' : 'Add'}</button>
                  </div>
                </div>

                {editing && (
                  <div className="nw-credential-editor">
                    <label>
                      <span>{label} API key</span>
                      {provider === 'subdl' ? (
                        <div className="nw-credential-prefixed-input">
                          <span>subdl_</span>
                          <input
                            type="password"
                            autoComplete="off"
                            spellCheck={false}
                            maxLength={43}
                            value={credentialDraft}
                            onChange={event => setCredentialDraft(event.target.value)}
                            placeholder="43 characters after subdl_"
                          />
                        </div>
                      ) : (
                        <input
                          type="password"
                          autoComplete="off"
                          spellCheck={false}
                          maxLength={32}
                          value={credentialDraft}
                          onChange={event => setCredentialDraft(event.target.value)}
                          placeholder="32-character API key"
                        />
                      )}
                    </label>
                    <div className="nw-credential-editor__footer">
                      <small>{provider === 'subdl' ? 'Paste only what comes after subdl_.' : 'Exactly 32 characters.'} {credentialDraft.trim().length} / {requiredLength}</small>
                      <div>
                        <button className="btn btn-secondary" onClick={cancelCredentialEdit} disabled={credentialBusy === provider}>Cancel</button>
                        <button className="btn btn-primary" onClick={() => void saveSubtitleCredential()} disabled={credentialBusy === provider || credentialDraft.trim().length !== requiredLength}>
                          {credentialBusy === provider ? 'Validating…' : 'Validate & save'}
                        </button>
                      </div>
                    </div>
                  </div>
                )}
              </div>
            )
          })}
        </div>

        {credentialError && <p className="nw-credential-error">{credentialError}</p>}
        <p className="nw-tmdb-attribution">This product uses the TMDB API but is not endorsed or certified by TMDB.</p>
      </section>

      <section className="nw-settings-runtime">
        <div>
          <span className="nw-settings-label">System</span>
          <strong>Diagnostics</strong>
        </div>
        <button className="btn btn-secondary" onClick={onOpenDiagnostics}>Open</button>
      </section>
    </section>
  )
}
