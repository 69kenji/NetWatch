import { useState } from 'react'
import { Check, RefreshCircle, WarningTriangle } from 'iconoir-react'
import type { NetWatchUiPreferences } from '../utils/preferences'

type Props = {
  preferences: NetWatchUiPreferences
  onChange: (next: NetWatchUiPreferences) => void
  onOpenDiagnostics: () => void
}

export function SettingsView({ preferences, onChange, onOpenDiagnostics }: Props) {
  const update = (patch: Partial<NetWatchUiPreferences>) => onChange({ ...preferences, ...patch })
  const [vpnCheck, setVpnCheck] = useState<NetWatchVpnSanityResult | null>(null)
  const [vpnChecking, setVpnChecking] = useState(false)
  const [vpnCheckError, setVpnCheckError] = useState<string | null>(null)

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

  const checkedTime = vpnCheck?.checked_at
    ? new Date(vpnCheck.checked_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : null
  const vpnEgressVerified = Boolean(vpnCheck?.connected && vpnCheck?.public_ip && vpnCheck?.structural_verified)
  const vpnDnsDegraded = Boolean(vpnEgressVerified && vpnCheck?.dns_ok === false)

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

      <section className="nw-settings-runtime nw-settings-runtime--tmdb">
        <div>
          <span className="nw-settings-label">Metadata</span>
          <strong>TMDB</strong>
          <p>This product uses the TMDB API but is not endorsed or certified by TMDB.</p>
        </div>
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
