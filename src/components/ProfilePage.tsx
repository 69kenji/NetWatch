import { useEffect, useMemo, useState } from 'react'
import { BookStack, Check, Clock, Download, EditPencil, Eye, Play, Settings, Trash, Upload, Xmark } from 'iconoir-react'
import type { TmdbCatalogSummary } from '../types/metadata'
import type { NetWatchView } from '../types/torrents'
import { publishProfiles, useProfiles } from '../store/profiles'
import { useLocalCatalog } from '../store/localCatalog'
import { ProfileAvatar } from './ProfileAvatar'
import { exportProfileStorage, stageProfileStorageRestore } from '../utils/profileStorage'

function duration(seconds: number) {
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes} min`
  const hours = Math.floor(minutes / 60), remainder = minutes % 60
  return `${hours}h${remainder ? ` ${remainder}m` : ''}`
}

function episodeLabel(entry: NetWatchViewingHistoryEntry) {
  return entry.type === 'tv' ? `S${String(entry.season || 0).padStart(2, '0')}E${String(entry.episode || 0).padStart(2, '0')}` : 'Movie'
}

function catalogItem(entry: NetWatchViewingHistoryEntry): TmdbCatalogSummary {
  return {
    id: Number(entry.catalogId.split(':')[1]), type: entry.type, title: entry.title, year: entry.year,
    overview: '', poster: entry.poster, backdrop: entry.backdrop, rating: 0, is_anime: entry.isAnime,
  }
}

export function ProfilePage({ onSelect, onPlay, onPlayNext, onNavigate, onOpenCollection }: {
  onSelect: (item: TmdbCatalogSummary) => void
  onPlay: (item: TmdbCatalogSummary) => void
  onPlayNext: (item: TmdbCatalogSummary) => void
  onNavigate: (view: NetWatchView) => void
  onOpenCollection: (id: string) => void
}) {
  const profiles = useProfiles()
  const local = useLocalCatalog()
  const profile = profiles?.profiles.find(item => item.id === profiles.activeId)
  const [history, setHistory] = useState<NetWatchViewingHistoryEntry[]>([])
  const [watching, setWatching] = useState<NetWatchKeepWatchingItem[]>([])
  const [editing, setEditing] = useState(false)
  const [name, setName] = useState('')
  const [tagline, setTagline] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [confirmClear, setConfirmClear] = useState(false)
  const [importPlan, setImportPlan] = useState<{ token: string; preview: { name: string; historyCount: number; progressCount: number; listCount: number; hasAvatar: boolean } } | null>(null)
  const [importOptions, setImportOptions] = useState({ library: true, searchHistory: true, viewingHistory: true, progress: true })

  useEffect(() => {
    let active = true
    const apply = (state: NetWatchViewingHistoryState) => { if (active) setHistory(state.entries) }
    const api = window.electron?.history
    if (!api) return
    const unsubscribe = api.onChanged(apply)
    void api.getState().then(apply).catch(reason => { if (active) setError(String(reason)) })
    return () => { active = false; unsubscribe() }
  }, [])
  useEffect(() => {
    let active = true
    const api = window.electron?.keepWatching
    if (!api) return
    const apply = (state: NetWatchKeepWatchingState) => { if (active) setWatching(state.items) }
    const unsubscribe = api.onChanged(apply)
    void api.getState().then(apply).catch(() => {})
    return () => { active = false; unsubscribe() }
  }, [])
  useEffect(() => { if (profile) { setName(profile.name); setTagline(profile.tagline) } }, [profile])

  const stats = useMemo(() => {
    const totalSeconds = history.reduce((sum, entry) => sum + entry.watchedSeconds, 0)
    const movies = new Set(history.filter(entry => entry.type === 'movie' && entry.completed).map(entry => entry.catalogId)).size
    const episodes = new Set(history.filter(entry => entry.type === 'tv' && entry.completed).map(entry => `${entry.catalogId}:${entry.season}:${entry.episode}`)).size
    const genres = new Map<string, number>(), watchedSeries = new Map<string, { title: string; seconds: number }>()
    for (const entry of history) for (const genre of entry.genres) genres.set(genre, (genres.get(genre) || 0) + entry.watchedSeconds)
    for (const entry of history.filter(item => item.type === 'tv')) {
      const current = watchedSeries.get(entry.catalogId) || { title: entry.title, seconds: 0 }
      current.seconds += entry.watchedSeconds; watchedSeries.set(entry.catalogId, current)
    }
    const favoriteGenre = [...genres.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || 'Not enough history'
    const favoriteSeries = [...watchedSeries.values()].sort((a, b) => b.seconds - a.seconds)[0]?.title || 'Not enough history'
    // shortcut: a session crossing midnight counts on its last day; split samples if daily precision becomes important.
    const days = Array.from({ length: 7 }, (_, offset) => {
      const date = new Date(); date.setHours(0, 0, 0, 0); date.setDate(date.getDate() - (6 - offset))
      const next = new Date(date); next.setDate(next.getDate() + 1)
      return { label: date.toLocaleDateString([], { weekday: 'narrow' }), seconds: history.filter(entry => {
        const time = Date.parse(entry.updatedAt); return time >= date.getTime() && time < next.getTime()
      }).reduce((sum, entry) => sum + entry.watchedSeconds, 0) }
    })
    const movieSeconds = history.filter(entry => entry.type === 'movie').reduce((sum, entry) => sum + entry.watchedSeconds, 0)
    const seriesSeconds = totalSeconds - movieSeconds
    const activeDays = new Set(history.filter(entry => entry.watchedSeconds > 0).map(entry => new Date(entry.updatedAt).toISOString().slice(0, 10)))
    const dayKey = (offset: number) => { const date = new Date(); date.setHours(12, 0, 0, 0); date.setDate(date.getDate() - offset); return date.toISOString().slice(0, 10) }
    let currentStreak = 0
    while (activeDays.has(dayKey(currentStreak))) currentStreak += 1
    const sortedDays = [...activeDays].sort()
    let longestStreak = 0, run = 0, previous = 0
    for (const value of sortedDays) {
      const time = Date.parse(`${value}T12:00:00Z`)
      run = previous && Math.round((time - previous) / 86_400_000) === 1 ? run + 1 : 1
      longestStreak = Math.max(longestStreak, run); previous = time
    }
    const monthSeconds = history.filter(entry => Date.now() - Date.parse(entry.updatedAt) < 30 * 86_400_000).reduce((sum, entry) => sum + entry.watchedSeconds, 0)
    return { totalSeconds, movies, episodes, favoriteGenre, favoriteSeries, days, movieSeconds, seriesSeconds, currentStreak, longestStreak, monthSeconds }
  }, [history])

  const series = useMemo(() => {
    const grouped = new Map<string, { latest: NetWatchViewingHistoryEntry; episodes: Set<string>; watchedSeconds: number; totalEpisodes: number }>()
    for (const entry of history.filter(item => item.type === 'tv')) {
      const current = grouped.get(entry.catalogId) || { latest: entry, episodes: new Set<string>(), watchedSeconds: 0, totalEpisodes: 0 }
      if (Date.parse(entry.updatedAt) > Date.parse(current.latest.updatedAt)) current.latest = entry
      if (entry.completed) current.episodes.add(`${entry.season}:${entry.episode}`)
      current.watchedSeconds += entry.watchedSeconds
      current.totalEpisodes = Math.max(current.totalEpisodes, Number(entry.totalEpisodes || 0))
      grouped.set(entry.catalogId, current)
    }
    return [...grouped.values()].sort((a, b) => Date.parse(b.latest.updatedAt) - Date.parse(a.latest.updatedAt)).slice(0, 8)
  }, [history])

  if (!profile || !profiles) return null
  const run = async (action: () => Promise<unknown>) => {
    setBusy(true); setError(null)
    try { await action() } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)) }
    finally { setBusy(false) }
  }
  const saveIdentity = () => run(async () => {
    const state = await window.electron!.profiles.update(profile.id, { name, tagline })
    publishProfiles(state); setEditing(false)
  })
  const exportCurrentProfile = () => run(async () => {
    await window.electron!.profiles.export(profile.id, exportProfileStorage([profile.id])[profile.id])
  })
  const importProfile = () => run(async () => {
    const result = await window.electron!.profiles.import()
    if (result.cancelled || !result.token || !result.preview) return
    setImportPlan({ token: result.token, preview: result.preview })
  })
  const commitProfileImport = () => run(async () => {
    if (!importPlan) return
    const result = await window.electron!.profiles.commitImport(importPlan.token, { history: importOptions.viewingHistory, progress: importOptions.progress })
    if (result.cancelled || !result.profileId || !result.localProfile) return
    const staged = stageProfileStorageRestore({ [result.profileId]: result.localProfile }, { library: importOptions.library, history: importOptions.searchHistory })
    staged.commit()
    publishProfiles(result.state); setImportPlan(null)
  })
  const maxDay = Math.max(1, ...stats.days.map(day => day.seconds))
  const continueWatching = watching.map(record => history.find(entry => entry.catalogId === record.catalog_id) || null).filter((entry): entry is NetWatchViewingHistoryEntry => Boolean(entry)).slice(0, 5)

  return <section className="nw-view nw-profile-page">
    <header className="nw-profile-hero">
      <button type="button" className="nw-profile-avatar-button" disabled={busy} title="Change profile picture"
        onClick={() => void run(async () => { const result = await window.electron!.profiles.importAvatar(profile.id); publishProfiles(result.state) })}>
        <ProfileAvatar profile={profile} size={104} />
      </button>
      <div className="nw-profile-hero__copy">
        {editing ? <div className="nw-profile-identity-editor">
          <input className="nw-settings-select" value={name} maxLength={40} aria-label="Profile name" onChange={event => setName(event.target.value)} />
          <input className="nw-settings-select" value={tagline} maxLength={120} aria-label="Profile tagline" placeholder="Add a short tagline" onChange={event => setTagline(event.target.value)} />
          <button className="nw-icon-button" disabled={busy || !name.trim()} onClick={() => void saveIdentity()} aria-label="Save profile"><Check width={18} /></button>
          <button className="nw-icon-button" disabled={busy} onClick={() => setEditing(false)} aria-label="Cancel"><Xmark width={18} /></button>
          <div className="nw-profile-avatar-presets" aria-label="Profile picture colors">{['violet','blue','amber','rose','green'].map(color => <button
            key={color} type="button" className={`nw-profile-avatar is-preset-${color}`} aria-label={`Use ${color} profile picture`}
            onClick={() => void run(async () => publishProfiles(await window.electron!.profiles.update(profile.id, { avatar: `preset:${color}` })))} />)}</div>
        </div> : <>
          <span className="nw-kicker">{profile.kind === 'guest' ? 'Guest profile' : 'Profile'}</span>
          <h1>{profile.name}</h1>
          <p>{profile.tagline || 'Your lists, history, and settings.'}</p>
          <button className="btn btn-ghost nw-compact-button" onClick={() => setEditing(true)}><EditPencil width={16} />Edit profile</button>
        </>}
      </div>
      <div className="nw-profile-member">Member since {new Date(profile.createdAt).toLocaleDateString([], { month: 'short', year: 'numeric' })}</div>
    </header>

    <div className="nw-profile-stat-grid">
      <article><strong>{duration(stats.totalSeconds)}</strong><span>Watch time</span></article>
      <article><strong>{stats.movies}</strong><span>Movies finished</span></article>
      <article><strong>{stats.episodes}</strong><span>Episodes finished</span></article>
      <article><strong>{stats.favoriteGenre}</strong><span>Most watched genre</span></article>
      <article><strong>{stats.favoriteSeries}</strong><span>Most watched series</span></article>
      <article><strong>{duration(stats.monthSeconds)}</strong><span>Last 30 days</span></article>
      <article><strong>{stats.currentStreak} day{stats.currentStreak === 1 ? '' : 's'}</strong><span>Current streak</span></article>
      <article><strong>{stats.longestStreak} day{stats.longestStreak === 1 ? '' : 's'}</strong><span>Longest streak</span></article>
    </div>

    <section className="nw-profile-overview-grid">
      <article className="nw-profile-panel"><header><div><span className="nw-kicker">Overview</span><h2>Your library</h2></div></header>
        <div className="nw-profile-counts"><span><strong>{local.titles.length}</strong> My List</span><span><strong>{local.collections.groups.length}</strong> collections</span><span><strong>{local.collections.watched.length}</strong> watched titles</span></div>
        <div className="nw-profile-quick-links">
          <button onClick={() => onOpenCollection('my-list')}><BookStack width={17} />My List</button>
          <button onClick={() => onOpenCollection('watched')}><Eye width={17} />Watched</button>
          <button onClick={() => onNavigate('collections')}><BookStack width={17} />Collections</button>
          <button onClick={() => onNavigate('history')}><Clock width={17} />History</button>
          <button onClick={() => onNavigate('settings')}><Settings width={17} />Settings</button>
        </div>
      </article>
      <article className="nw-profile-panel"><header><div><span className="nw-kicker">Continue</span><h2>Keep Watching</h2></div></header>
        {continueWatching.length ? <div className="nw-profile-continue">{continueWatching.map(entry => <button key={entry.catalogId} onClick={() => onPlay(catalogItem(entry))}>
          {entry.poster ? <img src={entry.poster} alt="" /> : <span>NW</span>}<span><strong>{entry.title}</strong><small>{episodeLabel(entry)}</small></span><Play width={17} />
        </button>)}</div> : <p className="nw-profile-empty">Nothing waiting to be continued.</p>}
      </article>
    </section>

    <section className="nw-profile-panel">
      <header><div><span className="nw-kicker">Last 7 days</span><h2>Viewing time</h2></div></header>
      <div className="nw-profile-chart" aria-label="Viewing time during the last seven days">
        {stats.days.map((day, index) => <div key={index}><span style={{ height: `${Math.max(3, day.seconds / maxDay * 100)}%` }} title={duration(day.seconds)} /><small>{day.label}</small></div>)}
      </div>
      <p className="nw-profile-breakdown">Movies {duration(stats.movieSeconds)} · Series {duration(stats.seriesSeconds)}</p>
    </section>

    <section className="nw-profile-panel">
      <header><div><span className="nw-kicker">Series</span><h2>Progress</h2></div></header>
      {series.length ? <div className="nw-profile-series-list">{series.map(item => {
        const remaining = item.totalEpisodes > 0 ? Math.max(0, item.totalEpisodes - item.episodes.size) : null
        const complete = item.totalEpisodes > 0 && remaining === 0
        return <article key={item.latest.catalogId}>
          <button onClick={() => onSelect(catalogItem(item.latest))}>
            {item.latest.poster ? <img src={item.latest.poster} alt="" /> : <span className="nw-profile-series-fallback">NW</span>}
            <span><strong>{item.latest.title}</strong><small>{complete ? 'Series completed' : `${item.episodes.size} finished${remaining == null ? '' : ` · ${remaining} remaining`} · Last ${episodeLabel(item.latest)}`}</small>
              {item.totalEpisodes > 0 && <i><span style={{ width: `${Math.min(100, item.episodes.size / item.totalEpisodes * 100)}%` }} /></i>}
            </span><Eye width={18} />
          </button>
          {!complete && <button className="nw-icon-button" title="Play next unwatched" aria-label={`Play next unwatched episode of ${item.latest.title}`} onClick={() => onPlayNext(catalogItem(item.latest))}><Play width={17} /></button>}
        </article>
      })}</div> : <p className="nw-profile-empty">Series progress will appear after you watch an episode.</p>}
    </section>

    <section className="nw-profile-panel">
      <header><div><span className="nw-kicker">History</span><h2>Recent activity</h2></div>
        {!confirmClear ? <button className="btn btn-ghost nw-compact-button" disabled={!history.length} onClick={() => setConfirmClear(true)}>Clear history</button>
          : <div className="nw-compact-actions"><button className="btn btn-ghost nw-compact-button" onClick={() => setConfirmClear(false)}>Cancel</button><button className="btn btn-ghost nw-compact-button" onClick={() => void run(async () => { const result = await window.electron!.history.clear(); setHistory(result.state.entries); setConfirmClear(false) })}>Clear all</button></div>}
      </header>
      {history.length ? <div className="nw-profile-history">{history.slice(0, 30).map(entry => <article key={entry.id}>
        <button className="nw-profile-history__title" onClick={() => onSelect(catalogItem(entry))}>
          {entry.poster ? <img src={entry.poster} alt="" /> : <span>NW</span>}
          <span><strong>{entry.title}</strong><small>{episodeLabel(entry)} · {duration(entry.watchedSeconds)} · {new Date(entry.updatedAt).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' })}</small></span>
        </button>
        <div className="nw-compact-actions">
          <button className="nw-icon-button" title="Clear this title" aria-label={`Clear all ${entry.title} history`} onClick={() => void run(async () => { const result = await window.electron!.history.clearTitle(entry.catalogId); setHistory(result.state.entries) })}><Xmark width={17} /></button>
          <button className="nw-icon-button" title="Remove entry" aria-label={`Remove ${entry.title} history entry`} onClick={() => void run(async () => { const result = await window.electron!.history.remove(entry.id); setHistory(result.state.entries) })}><Trash width={17} /></button>
        </div>
      </article>)}</div> : <p className="nw-profile-empty">Nothing watched yet.</p>}
    </section>

    <section className="nw-profile-panel nw-profile-controls-panel">
      <header><div><span className="nw-kicker">Profile</span><h2>Profile settings</h2></div></header>
      <label><span>Profile type</span><select className="nw-settings-select" value={profile.kind} disabled={busy} onChange={event => void run(async () => publishProfiles(await window.electron!.profiles.update(profile.id, { kind: event.target.value as NetWatchProfileSummary['kind'] })))}>
        <option value="standard">Standard</option><option value="guest">Guest</option>
      </select></label>
      <div className="nw-profile-transfer-row">
        <span><strong>Export or import</strong><small>Lists, settings, progress, history, and picture.</small></span>
        <button className="btn btn-ghost nw-compact-button" disabled={busy} onClick={() => void exportCurrentProfile()}><Download width={16} />Export</button>
        <button className="btn btn-ghost nw-compact-button" disabled={busy} onClick={() => void importProfile()}><Upload width={16} />Import</button>
      </div>
      {importPlan && <div className="nw-profile-import-preview">
        <div><strong>{importPlan.preview.name}</strong><small>{importPlan.preview.historyCount} history entries · {importPlan.preview.progressCount} episode records{importPlan.preview.hasAvatar ? ' · Picture included' : ''}</small></div>
        <label><input type="checkbox" checked={importOptions.library} onChange={event => setImportOptions(value => ({ ...value, library: event.target.checked }))} />Lists and collections</label>
        <label><input type="checkbox" checked={importOptions.searchHistory} onChange={event => setImportOptions(value => ({ ...value, searchHistory: event.target.checked }))} />Search history</label>
        <label><input type="checkbox" checked={importOptions.viewingHistory} onChange={event => setImportOptions(value => ({ ...value, viewingHistory: event.target.checked }))} />Viewing history and statistics</label>
        <label><input type="checkbox" checked={importOptions.progress} onChange={event => setImportOptions(value => ({ ...value, progress: event.target.checked }))} />Keep Watching and episode progress</label>
        <div className="nw-compact-actions"><button className="btn btn-ghost nw-compact-button" disabled={busy} onClick={() => void commitProfileImport()}>Import profile</button>
          <button className="btn btn-ghost nw-compact-button" disabled={busy} onClick={() => { void window.electron?.profiles.cancelImport(importPlan.token); setImportPlan(null) }}>Cancel</button></div>
      </div>}
    </section>
    {error && <p className="nw-inline-notice is-error" role="alert">{error}</p>}
  </section>
}
