import { useEffect, useMemo, useState } from 'react'
import { Check, RefreshCircle, WarningTriangle } from 'iconoir-react'
import type { NetWatchUiPreferences } from '../utils/preferences'

type Props = {
  preferences: NetWatchUiPreferences
  onChange: (next: NetWatchUiPreferences) => void
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
  const update = (patch: Partial<NetWatchUiPreferences>) => onChange({ ...preferences, ...patch })
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

      <div className="nw-settings-grid">
        <section className="nw-settings-card nw-settings-card--compact">
          <div className="nw-settings-card__copy">
            <strong>Default quality</strong>
          </div>
          <select
            className="nw-settings-select"
            value={preferences.defaultQuality}
            onChange={event => update({ defaultQuality: event.target.value as NetWatchUiPreferences['defaultQuality'] })}
          >
            <option value="all">All</option>
            <option value="2160p">2160p</option>
            <option value="1080p">1080p</option>
            <option value="720p">720p</option>
          </select>
        </section>
      </div>

      <section className={`nw-settings-runtime nw-settings-runtime--privacy ${vpnEgressVerified ? 'is-safe' : vpnCheckError ? 'is-error' : ''}`}>
        <div className="nw-vpn-sanity-copy">
          <span className="nw-settings-label">Network</span>
          <strong>VPN</strong>

          <div className="nw-vpn-profile-controls">
            <label>
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

            {vpnProfile?.profile_type === 'vpnbook' && (
              <div className={`nw-vpn-expiry ${vpnBookStatus === 'Estimated expired' ? 'is-warning' : ''}`}>
                <span>Estimated profile expiry</span>
                <strong>{vpnBookStatus || 'Unknown — re-import a fresh config to enable the estimate'}</strong>
                <small>Reminder only. NetWatch still verifies the live tunnel and fails closed.</small>
              </div>
            )}

            {vpnRestartRequired && (
              <div className="nw-vpn-restart-notice">
                <strong>VPN configuration updated</strong>
                <small>Restart NetWatch to activate the replacement and run the normal VPN verification gate.</small>
              </div>
            )}

            {vpnProfileError && <p className="nw-vpn-profile-error">{vpnProfileError}</p>}

            <div className="nw-vpn-profile-actions">
              {vpnProfile?.profile_type === 'vpnbook' && (
                <button className="btn btn-secondary" onClick={() => void openVpnBook()} disabled={vpnProfileBusy}>
                  Get new VPNBook config
                </button>
              )}
              <button className="btn btn-secondary" onClick={() => void replaceWireGuard()} disabled={vpnProfileBusy || !vpnProfile || vpnRestartRequired}>
                {vpnProfileBusy ? 'Working…' : 'Replace configuration'}
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
        <button className="btn btn-secondary" onClick={() => void runVpnSanity()} disabled={vpnChecking}>
          {vpnChecking ? <RefreshCircle width={16} height={16} className="nw-spin" /> : null}
          {vpnChecking ? 'Checking…' : 'Test'}
        </button>
      </section>

      <section className="nw-settings-runtime nw-credentials-panel">
        <div className="nw-credentials-panel__header">
          <span className="nw-settings-label">Credentials</span>
          <strong>Provider access</strong>
          <p>NetWatch shows configuration status only. Saved API keys are never displayed.</p>
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
          <strong>Runtime</strong>
        </div>
        <button className="btn btn-secondary" onClick={onOpenDiagnostics}>Open</button>
      </section>
    </section>
  )
}
