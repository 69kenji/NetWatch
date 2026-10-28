import { useEffect, useMemo, useState } from 'react'
import { InfoCircle, Play, Search, Trash, Xmark } from 'iconoir-react'
import type { TmdbCatalogSummary } from '../types/metadata'

type Filter = 'all' | 'movie' | 'tv' | 'anime'

function catalogItem(entry: NetWatchViewingHistoryEntry): TmdbCatalogSummary {
  return {
    id: Number(entry.catalogId.split(':')[1]), type: entry.type, title: entry.title, year: entry.year,
    overview: '', poster: entry.poster, backdrop: entry.backdrop, rating: 0, is_anime: entry.isAnime,
  }
}

function episodeLabel(entry: NetWatchViewingHistoryEntry) {
  return entry.type === 'tv' ? `S${String(entry.season || 0).padStart(2, '0')}E${String(entry.episode || 0).padStart(2, '0')}` : 'Movie'
}

function duration(seconds: number) {
  const minutes = Math.max(0, Math.round(seconds / 60))
  return minutes < 60 ? `${minutes} min` : `${Math.floor(minutes / 60)}h ${minutes % 60}m`
}

export function HistoryView({ onDetails, onPlay }: {
  onDetails: (item: TmdbCatalogSummary) => void
  onPlay: (entry: NetWatchViewingHistoryEntry) => void
}) {
  const [entries, setEntries] = useState<NetWatchViewingHistoryEntry[]>([])
  const [filter, setFilter] = useState<Filter>('all')
  const [query, setQuery] = useState('')
  const [confirmClear, setConfirmClear] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let active = true
    const api = window.electron?.history
    if (!api) { setError('Viewing history is unavailable.'); return }
    const apply = (state: NetWatchViewingHistoryState) => { if (active) setEntries(state.entries) }
    const unsubscribe = api.onChanged(apply)
    void api.getState().then(apply).catch(reason => { if (active) setError(String(reason)) })
    return () => { active = false; unsubscribe() }
  }, [])

  const visible = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase()
    return entries.filter(entry => filter === 'all' || (filter === 'anime' ? entry.isAnime : entry.type === filter))
      .filter(entry => !needle || `${entry.title} ${entry.episodeTitle || ''}`.toLocaleLowerCase().includes(needle))
  }, [entries, filter, query])

  const update = (result: { state: NetWatchViewingHistoryState }) => setEntries(result.state.entries)
  return <section className="nw-view nw-history-view">
    <header className="nw-settings-header"><div><h1>History</h1><p>Your watch history.</p></div></header>
    <div className="nw-history-toolbar">
      <label className="nw-collection-search"><Search width={17} /><input className="nw-settings-select" value={query} onChange={event => setQuery(event.target.value)} placeholder="Search history" aria-label="Search viewing history" /></label>
      <select className="nw-settings-select" value={filter} onChange={event => setFilter(event.target.value as Filter)} aria-label="Filter viewing history">
        <option value="all">All</option><option value="movie">Movies</option><option value="tv">Series</option><option value="anime">Anime</option>
      </select>
      {!confirmClear ? <button className="btn btn-ghost nw-compact-button" disabled={!entries.length} onClick={() => setConfirmClear(true)}><Trash width={16} />Clear history</button>
        : <div className="nw-compact-actions"><button className="btn btn-ghost nw-compact-button" onClick={() => setConfirmClear(false)}>Cancel</button><button className="btn btn-ghost nw-compact-button" onClick={() => void window.electron?.history.clear().then(result => { update(result); setConfirmClear(false) })}>Clear all</button></div>}
    </div>
    {error && <p className="nw-inline-notice is-error" role="alert">{error}</p>}
    {!error && !visible.length && <p className="nw-profile-empty">{entries.length ? 'No matching history.' : 'Nothing watched yet.'}</p>}
    <div className="nw-history-list">{visible.map(entry => {
      const item = catalogItem(entry)
      const completion = entry.durationSeconds > 0 ? Math.min(100, Math.round(entry.lastPositionSeconds / entry.durationSeconds * 100)) : 0
      return <article key={entry.id} className="nw-history-entry">
        <button className="nw-history-entry__art" onClick={() => onDetails(item)} aria-label={`Open ${entry.title} details`}>
          {entry.poster ? <img src={entry.poster} alt="" /> : <span>NW</span>}
        </button>
        <div className="nw-history-entry__copy"><strong>{entry.title}</strong><span>{episodeLabel(entry)}{entry.episodeTitle ? ` · ${entry.episodeTitle}` : ''}</span>
          <div className="nw-history-entry__meta">
            <small>{entry.completed ? 'Watched' : `${completion}% watched`}</small>
            <small>{duration(entry.watchedSeconds)}</small>
            <small>{new Date(entry.updatedAt).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}</small>
          </div>
        </div>
        <div className="nw-compact-actions">
          <button className="nw-icon-button" title="Play now" aria-label={`Play ${entry.title}`} onClick={() => onPlay(entry)}><Play width={18} /></button>
          <button className="nw-icon-button" title="Details" aria-label={`Open ${entry.title} details`} onClick={() => onDetails(item)}><InfoCircle width={18} /></button>
          <button className="nw-icon-button" title="Clear title history" aria-label={`Clear all ${entry.title} history`} onClick={() => void window.electron?.history.clearTitle(entry.catalogId).then(update)}><Xmark width={17} /></button>
          <button className="nw-icon-button" title="Remove entry" aria-label={`Remove ${entry.title} history entry`} onClick={() => void window.electron?.history.remove(entry.id).then(update)}><Trash width={17} /></button>
        </div>
      </article>
    })}</div>
  </section>
}
