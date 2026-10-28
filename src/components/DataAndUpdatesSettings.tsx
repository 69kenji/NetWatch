import { useState } from 'react'
import { Download, RefreshCircle, Upload } from 'iconoir-react'
import { useProfiles } from '../store/profiles'
import { exportProfileStorage, stageProfileStorageRestore, type ProfileStorageBackup } from '../utils/profileStorage'
import type { NetWatchUiPreferences } from '../utils/preferences'

type RestorePlan = {
  token: string
  localProfiles: ProfileStorageBackup
  summary: { createdAt: string | null; sourceVersion: string; profileCount: number; profileNames: string[]; keepWatchingCount: number }
}

function formatBytes(bytes: number | null) {
  if (!bytes) return 'Size unavailable'
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`
  return `${(bytes / 1024 ** 2).toFixed(1)} MB`
}

export function DataAndUpdatesSettings({ preferences, onChange }: {
  preferences: NetWatchUiPreferences
  onChange: (patch: Partial<NetWatchUiPreferences>) => void
}) {
  const profiles = useProfiles()
  const [busy, setBusy] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [restore, setRestore] = useState<RestorePlan | null>(null)
  const [restoreOptions, setRestoreOptions] = useState({ library: true, history: true, keepWatching: true })
  const [update, setUpdate] = useState<NetWatchUpdateState | null>(null)
  const [downloaded, setDownloaded] = useState(false)

  const run = async (name: string, action: () => Promise<void>) => {
    setBusy(name); setError(null); setMessage(null)
    try { await action() } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)) }
    finally { setBusy(null) }
  }

  const exportBackup = () => void run('export', async () => {
    const api = window.electron?.backup
    if (!api || !profiles) throw new Error('Backup is unavailable')
    const result = await api.export(exportProfileStorage(profiles.profiles.map(profile => profile.id)))
    if (!result.cancelled) setMessage(`${result.fileName || 'Backup'} saved.`)
  })

  const chooseBackup = () => void run('import', async () => {
    const api = window.electron?.backup
    if (!api) throw new Error('Restore is unavailable')
    if (restore) await api.cancelImport(restore.token)
    const result = await api.prepareImport()
    if (!result.cancelled && result.token && result.localProfiles && result.summary) {
      setRestore({ token: result.token, localProfiles: result.localProfiles, summary: result.summary })
    }
  })

  const cancelRestore = () => {
    if (restore) void window.electron?.backup.cancelImport(restore.token)
    setRestore(null)
  }

  const commitRestore = () => void run('restore', async () => {
    const api = window.electron?.backup
    if (!api || !restore) throw new Error('Restore is unavailable')
    const staged = stageProfileStorageRestore(restore.localProfiles, restoreOptions)
    try {
      const result = await api.commitImport(restore.token, restoreOptions)
      if (result.cancelled) { staged.rollback(); return }
      staged.commit()
      if (window.electron?.runtime.restartApp) await window.electron.runtime.restartApp()
      else window.location.reload()
    } catch (reason) {
      staged.rollback()
      throw reason
    }
  })

  const checkUpdates = () => void run('check', async () => {
    const api = window.electron?.updates
    if (!api) throw new Error('Update checks are unavailable')
    setUpdate(await api.check())
    setDownloaded(false)
  })

  const downloadUpdate = () => void run('download', async () => {
    const result = await window.electron!.updates.download()
    if (!result.cancelled) {
      setDownloaded(true)
      setMessage(`${result.fileName || 'Installer'} downloaded and verified.`)
    }
  })

  const openInstaller = () => void run('installer', async () => {
    await window.electron!.updates.openInstaller()
  })

  return <>
    <section className="nw-settings-group" aria-labelledby="backup-settings-title">
      <header className="nw-settings-group__header"><h2 id="backup-settings-title">Backup and restore</h2></header>
      <div className="nw-settings-list">
        <section className="nw-settings-card nw-settings-card--compact">
          <div className="nw-settings-card__copy"><strong>Local backup</strong><small>Includes profiles, preferences, lists, collections, search history, Keep Watching, and episode progress. Credentials, VPN settings, pictures, and local media are excluded. Export a profile from its page to include its picture and viewing history.</small></div>
          <div className="nw-settings-row-actions">
            <button className="btn btn-secondary" disabled={Boolean(busy)} onClick={exportBackup}><Download width={17} />Export</button>
            <button className="btn btn-secondary" disabled={Boolean(busy)} onClick={chooseBackup}><Upload width={17} />Restore</button>
          </div>
        </section>
        {restore && <section className="nw-backup-restore" aria-label="Restore options">
          <div><strong>{restore.summary.profileCount} profile{restore.summary.profileCount === 1 ? '' : 's'}</strong><span>{restore.summary.profileNames.join(', ')}</span><small>Created with NetWatch {restore.summary.sourceVersion}{restore.summary.createdAt ? ` · ${new Date(restore.summary.createdAt).toLocaleDateString()}` : ''}</small></div>
          <p>Profiles and preferences will be replaced. Choose the other data to restore.</p>
          <label><input type="checkbox" checked={restoreOptions.library} onChange={event => setRestoreOptions(value => ({ ...value, library: event.target.checked }))} />My List, collections, and watched titles</label>
          <label><input type="checkbox" checked={restoreOptions.history} onChange={event => setRestoreOptions(value => ({ ...value, history: event.target.checked }))} />Search history</label>
          <label><input type="checkbox" checked={restoreOptions.keepWatching} onChange={event => setRestoreOptions(value => ({ ...value, keepWatching: event.target.checked }))} />Keep Watching and episode progress ({restore.summary.keepWatchingCount})</label>
          <div className="nw-settings-row-actions"><button className="btn btn-ghost" disabled={Boolean(busy)} onClick={cancelRestore}>Cancel</button><button className="btn btn-primary" disabled={Boolean(busy)} onClick={commitRestore}>Restore selected</button></div>
        </section>}
      </div>
    </section>

    <section className="nw-settings-group" aria-labelledby="updates-settings-title">
      <header className="nw-settings-group__header"><h2 id="updates-settings-title">Updates</h2></header>
      <div className="nw-settings-list">
        <section className="nw-settings-card nw-settings-card--compact">
          <div className="nw-settings-card__copy"><strong>Update notifications</strong></div>
          <select className="nw-settings-select" aria-label="Update notifications" value={preferences.updateNotifications ? 'enabled' : 'disabled'} onChange={event => onChange({ updateNotifications: event.target.value === 'enabled' })}>
            <option value="disabled">Off</option><option value="enabled">On</option>
          </select>
        </section>
        <section className="nw-settings-card nw-settings-card--compact">
          <div className="nw-settings-card__copy"><strong>Windows app</strong><small>{update ? `Installed ${update.installedVersion}` : 'Check the official NetWatch release.'}</small></div>
          <div className="nw-settings-row-actions"><button className="btn btn-secondary" disabled={Boolean(busy)} onClick={checkUpdates}>{busy === 'check' ? <RefreshCircle className="nw-spin" width={17} /> : <RefreshCircle width={17} />}Check</button></div>
        </section>
        {update && <section className={`nw-update-result${update.updateAvailable ? '' : ' is-current'}`} aria-live="polite">
          <div><strong>{update.updateAvailable ? `NetWatch ${update.availableVersion}` : 'NetWatch is up to date'}</strong>
            {update.updateAvailable && <small>{formatBytes(update.downloadSize)}{update.publishedAt ? ` · ${new Date(update.publishedAt).toLocaleDateString()}` : ''}</small>}
          </div>
          {update.updateAvailable && update.releaseNotes && <p className="nw-update-notes">{update.releaseNotes}</p>}
          <div className="nw-settings-row-actions">
            <button className="btn btn-ghost" disabled={Boolean(busy)} onClick={() => void window.electron?.updates.openReleasePage()}>Release page</button>
            {update.updateAvailable && update.canDownload && !downloaded && <button className="btn btn-primary" disabled={Boolean(busy)} onClick={downloadUpdate}><Download width={17} />Download</button>}
            {downloaded && <button className="btn btn-primary" disabled={Boolean(busy)} onClick={openInstaller}>Open installer</button>}
          </div>
        </section>}
      </div>
    </section>
    {message && <p className="nw-settings-feedback" role="status">{message}</p>}
    {error && <p className="nw-settings-feedback is-error" role="alert">{error}</p>}
  </>
}
