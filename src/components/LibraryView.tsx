import { useEffect, useMemo, useRef, useState } from 'react'
import { Folder, Link as LinkIcon, Play, RefreshCircle, Search, Xmark } from 'iconoir-react'
import type { LibraryItem, LibraryState } from '../types/library'
import type { TmdbCatalogSummary } from '../types/metadata'
import { useCardActions } from './CardActions'
import '../styles/library.css'

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error)).replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '').slice(0, 240)

function DirectStreamDialog({ onClose }: { onClose: () => void }) {
  const [source, setSource] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const dialog = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null
    dialog.current?.querySelector('input')?.focus()
    return () => previous?.focus()
  }, [])
  const play = async () => {
    const value = source.trim()
    if (busy || !value) return
    if (!value.toLowerCase().startsWith('magnet:?') && !value.toLowerCase().startsWith('https://')) {
      setError('Enter a magnet link or HTTPS .torrent URL')
      return
    }
    setBusy(true); setError(null)
    try { await window.electron!.player.openDirectTorrent({ source: value }); onClose() }
    catch (error) { setError(errorText(error)); setBusy(false) }
  }
  return <div className="nw-library-modal" onClick={event => { if (event.target === event.currentTarget && !busy) onClose() }}>
    <div className="nw-library-match" role="dialog" aria-modal="true" aria-labelledby="direct-stream-title" ref={dialog}
      onKeyDown={event => {
        if (event.key === 'Escape') { event.stopPropagation(); if (!busy) onClose() }
        if (event.key === 'Tab') {
          const controls = Array.from(dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled)') || [])
          const first = controls[0], last = controls.at(-1)
          if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus() }
          if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus() }
        }
      }}>
      <header><h2 id="direct-stream-title">Open torrent link</h2><button className="btn btn-ghost btn-icon" disabled={busy} onClick={onClose} aria-label="Close"><Xmark /></button></header>
      <form className="nw-library-direct-form" onSubmit={event => { event.preventDefault(); void play() }}>
        <input aria-label="Magnet or torrent URL" placeholder="Magnet or HTTPS .torrent URL" value={source} maxLength={16 * 1024} disabled={busy} onChange={event => setSource(event.target.value)} />
        <button className="btn btn-primary" disabled={busy || !source.trim()} type="submit"><Play width={17} /> {busy ? 'Opening…' : 'Play'}</button>
      </form>
      <p className="nw-library-note">Torrent and peer traffic use the VPN. Links are not saved.</p>
      {error && <p role="alert" className="nw-library-error">{error}</p>}
    </div>
  </div>
}

function MatchDialog({ item, onClose, onSaved }: { item: LibraryItem; onClose: () => void; onSaved: (state: LibraryState) => void }) {
  const [query, setQuery] = useState(item.match?.title || item.episode?.series || '')
  const [results, setResults] = useState<TmdbCatalogSummary[]>([])
  const [selected, setSelected] = useState<TmdbCatalogSummary | null>(null)
  const [season, setSeason] = useState(item.match?.season ?? item.episode?.season ?? 1)
  const [episode, setEpisode] = useState(item.match?.episode ?? item.episode?.episode ?? 1)
  const [busy, setBusy] = useState(false)
  const [searched, setSearched] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const dialog = useRef<HTMLDivElement>(null)
  const active = useRef(true)
  useEffect(() => {
    active.current = true
    const previous = document.activeElement as HTMLElement | null
    dialog.current?.querySelector('input')?.focus()
    return () => { active.current = false; previous?.focus() }
  }, [])
  const search = async () => {
    if (busy || !query.trim()) return
    setBusy(true); setError(null); setSelected(null)
    try {
      const data = await window.electron!.library.search(query)
      if (active.current) { setResults(data.results.slice(0, 40)); setSearched(true) }
    } catch (error) { if (active.current) setError(errorText(error)) }
    finally { if (active.current) setBusy(false) }
  }
  const save = async () => {
    if (!selected || busy) return
    setBusy(true); setError(null)
    try {
      const state = await window.electron!.library.match(item.id, {
        id: selected.id, type: selected.type,
        ...(selected.type === 'tv' ? { season, episode } : {}),
      })
      if (active.current) { onSaved(state); onClose() }
    } catch (error) { if (active.current) setError(errorText(error)) }
    finally { if (active.current) setBusy(false) }
  }
  return <div className="nw-library-modal" onClick={event => { if (event.target === event.currentTarget && !busy) onClose() }}>
    <div className="nw-library-match" role="dialog" aria-modal="true" aria-labelledby="library-match-title" ref={dialog}
      onKeyDown={event => {
        if (event.key === 'Escape') { event.stopPropagation(); if (!busy) onClose() }
        if (event.key === 'Tab') {
          const controls = Array.from(dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled)') || [])
          const first = controls[0], last = controls.at(-1)
          if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus() }
          if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus() }
        }
      }}>
      <header><h2 id="library-match-title">Match title</h2><button className="btn btn-ghost btn-icon" disabled={busy} onClick={onClose} aria-label="Close matching"><Xmark /></button></header>
      <p className="nw-library-filename">{item.filename}</p>
      <form className="nw-library-search" onSubmit={event => { event.preventDefault(); void search() }}>
        <input aria-label="TMDB title search" placeholder="Title" value={query} maxLength={160} disabled={busy} onChange={event => setQuery(event.target.value)} />
        <button className="btn btn-secondary" disabled={busy || !query.trim()} type="submit">{busy ? 'Working…' : 'Search TMDB'}</button>
      </form>
      <p className="nw-library-note">Search uses the VPN. No match is saved until you confirm.</p>
      {error && <p role="alert" className="nw-library-error">{error}</p>}
      <div className="nw-library-matches">
        {searched && !results.length && !busy && <p>No matching titles.</p>}
        {results.map(result => <button key={`${result.type}:${result.id}`} type="button" disabled={busy}
          className={`nw-library-match-result ${selected?.id === result.id && selected.type === result.type ? 'is-active' : ''}`}
          onClick={() => setSelected(result)}>
          <strong>{result.title}</strong><span>{result.type === 'tv' ? 'TV' : 'Movie'} · {result.year || '—'}</span>
        </button>)}
      </div>
      {selected && <section className="nw-library-confirm">
        <strong>{selected.title} · {selected.year}</strong>
        {selected.type === 'tv' && <div className="nw-library-coordinates">
          <label>Season<input type="number" min={0} max={9999} value={season} disabled={busy} onChange={event => setSeason(Number(event.target.value))} /></label>
          <label>Episode<input type="number" min={1} max={9999} value={episode} disabled={busy} onChange={event => setEpisode(Number(event.target.value))} /></label>
        </div>}
        <button className="btn btn-primary" disabled={busy} onClick={() => void save()}>Confirm match</button>
      </section>}
    </div>
  </div>
}

function LocalFileDetails({ item, onClose }: { item: LibraryItem; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null)
  useEffect(() => { dialog.current?.showModal() }, [])
  return <dialog ref={dialog} className="nw-library-match" aria-labelledby="local-file-title" onClose={onClose}
    onKeyDown={event => { if (event.key === 'Escape') event.stopPropagation() }}
    onClick={event => { if (event.target === event.currentTarget) {
      const bounds = event.currentTarget.getBoundingClientRect()
      if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) onClose()
    } }}>
    <header><h2 id="local-file-title">{item.episode?.series || item.filename}</h2>
      <button className="nw-icon-button" title="Close details" aria-label="Close details" onClick={onClose}><Xmark width={18} height={18} /></button></header>
    {item.episode && <p className="nw-library-note">Season {item.episode.season} · Episode {item.episode.episode}</p>}
    <p className="nw-library-filename">{item.relativePath}</p>
  </dialog>
}

export function LibraryView({ runtimeReady, onDetails, onQueue }: { runtimeReady: boolean; onDetails: (item: TmdbCatalogSummary) => void; onQueue: (item: LibraryItem) => void }) {
  const [library, setLibrary] = useState<LibraryState>({ roots: [], items: [], warning: null })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [filter, setFilter] = useState('')
  const [category, setCategory] = useState('all')
  const [folder, setFolder] = useState('all')
  const [page, setPage] = useState(0)
  const [matching, setMatching] = useState<LibraryItem | null>(null)
  const [details, setDetails] = useState<LibraryItem | null>(null)
  const [directOpen, setDirectOpen] = useState(false)
  const actions = useCardActions()
  const mounted = useRef(true)
  const api = window.electron?.library
  const run = async (action: () => Promise<LibraryState | void>) => {
    if (busy) return
    setBusy(true); setError(null)
    try { const result = await action(); if (mounted.current && result) setLibrary(result) }
    catch (error) { if (mounted.current) setError(errorText(error)) }
    finally { if (mounted.current) setBusy(false) }
  }
  const openMenu = (item: LibraryItem, trigger: HTMLElement, x: number, y: number) => actions?.open({
    x, y, trigger, title: item.match?.title || item.filename, resume: false, playDisabled: busy || !api,
    item: item.match ? { ...item.match, rating: 0 } : undefined,
    play: () => { void run(async () => { await api!.play(item.id) }) },
    details: () => item.match ? onDetails({ ...item.match, rating: 0 }) : setDetails(item),
    queue: () => onQueue(item),
  })
  useEffect(() => {
    mounted.current = true
    if (api) void run(() => api.list())
    return () => { mounted.current = false }
  }, [api])
  useEffect(() => setPage(0), [filter, category, folder, library.items.length])
  const visible = useMemo(() => library.items.filter(item => {
    const type = item.match?.type || (item.episode ? 'tv' : 'movie')
    return (folder === 'all' || item.rootId === folder) &&
      (category === 'all' || (category === 'unmatched' ? !item.match : type === category)) &&
      `${item.filename} ${item.match?.title || ''}`.toLowerCase().includes(filter.toLowerCase())
  }).sort((a, b) => a.relativePath.localeCompare(b.relativePath, undefined, { numeric: true })), [library, folder, category, filter])
  return <section className="nw-view nw-library-view">
    <header className="nw-library-header"><h1>Library</h1><div>
      <button className="btn btn-secondary" disabled={!runtimeReady} onClick={() => setDirectOpen(true)}><LinkIcon width={17} /> Open link</button>
      <button className="btn btn-secondary" disabled={busy || !api} onClick={() => void run(() => api!.list())}><RefreshCircle width={17} /> Refresh</button>
      <button className="btn btn-primary" disabled={busy || !api} onClick={() => void run(() => api!.addFolder())}><Folder width={17} /> Add folder</button>
    </div></header>
    <div className="nw-library-toolbar">
      <label className="nw-library-filter"><Search width={18} /><input aria-label="Filter library" placeholder="Filter library" value={filter} onChange={event => setFilter(event.target.value)} /></label>
      <select aria-label="Library category" value={category} onChange={event => setCategory(event.target.value)}><option value="all">All</option><option value="movie">Movies</option><option value="tv">TV</option><option value="unmatched">Unmatched</option></select>
      <select aria-label="Library folder" value={folder} onChange={event => setFolder(event.target.value)}><option value="all">All folders</option>{library.roots.map(root => <option key={root.id} value={root.id}>{root.name}</option>)}</select>
    </div>
    <details className="nw-library-folders"><summary>Folders · {library.roots.length}</summary>{library.roots.map(root => <div key={root.id}>
      <span title={root.path}>{root.path}</span><button className="btn btn-ghost" disabled={busy} onClick={() => void run(() => api!.removeFolder(root.id))}>Remove</button>
    </div>)}</details>
    {busy && <p role="status">Working…</p>}
    {error && <p role="alert" className="nw-library-error">{error}</p>}
    {library.warning && <p role="status" className="nw-library-note">{library.warning}</p>}
    {!busy && !visible.length && <p className="nw-library-note">{library.roots.length ? 'No matching videos.' : 'Add a folder to browse local movies and episodes.'}</p>}
    <div className="nw-library-grid">{visible.slice(page * 60, (page + 1) * 60).map(item => {
      const episode = item.match?.type === 'tv' ? item.match : item.match ? null : item.episode
      const title = item.match?.title || item.episode?.series || item.filename
      return <article className="nw-library-card" key={item.id} onContextMenu={event => {
        if (!actions) return
        event.preventDefault()
        openMenu(item, event.currentTarget.querySelector<HTMLButtonElement>('button') || event.currentTarget, event.clientX, event.clientY)
      }}>
        <button className="nw-library-play" disabled={busy} title={`Play ${item.filename}`} aria-label={`Play ${title}${episode ? ` S${episode.season}E${episode.episode}` : ''}`}
          onKeyDown={event => {
            if (!actions || !(event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10'))) return
            event.preventDefault()
            const bounds = event.currentTarget.getBoundingClientRect()
            openMenu(item, event.currentTarget, bounds.left + 12, bounds.top + 12)
          }}
          onClick={() => void run(async () => { await api!.play(item.id) })}>
          {item.match?.poster && runtimeReady ? <img src={item.match.poster} alt="" loading="lazy" /> : <Folder width={38} height={38} />}
          <Play className="nw-library-play-icon" width={28} height={28} />
        </button>
        <div className="nw-library-card-copy"><strong>{title}</strong><span>{episode ? `S${episode.season} · E${episode.episode}` : 'Movie'}{item.match?.year ? ` · ${item.match.year}` : ''}</span>
          <small title={item.relativePath}>{item.filename}</small>
          {item.match?.overview && <details className="nw-library-description"><summary>Synopsis</summary><p>{item.match.overview}</p></details>}
          <div><button className="btn btn-ghost" disabled={busy || !runtimeReady} onClick={() => setMatching(item)}>{item.match ? 'Change match' : 'Match title'}</button>
            {item.match && <button className="btn btn-ghost btn-icon" disabled={busy} onClick={() => void run(() => api!.match(item.id, null))} aria-label={`Clear match for ${title}`}><Xmark width={16} /></button>}
          </div>
        </div>
      </article>
    })}</div>
    {visible.length > 60 && <nav className="nw-library-pagination" aria-label="Library pages">
      <button className="btn btn-secondary" disabled={page === 0} onClick={() => setPage(value => value - 1)}>Previous</button>
      <span>{page + 1} / {Math.ceil(visible.length / 60)}</span>
      <button className="btn btn-secondary" disabled={(page + 1) * 60 >= visible.length} onClick={() => setPage(value => value + 1)}>Next</button>
    </nav>}
    {matching && <MatchDialog item={matching} onClose={() => setMatching(null)} onSaved={setLibrary} />}
    {details && <LocalFileDetails item={details} onClose={() => setDetails(null)} />}
    {directOpen && <DirectStreamDialog onClose={() => setDirectOpen(false)} />}
  </section>
}
