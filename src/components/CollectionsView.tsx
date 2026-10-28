import { useEffect, useState } from 'react'
import { Check, EditPencil, NavArrowDown, NavArrowUp, Plus, Search, Trash, Xmark } from 'iconoir-react'
import { CatalogCard } from './CatalogCard'
import { localCatalog, useLocalCatalog } from '../store/localCatalog'
import { titleKey } from '../utils/localCatalog'
import type { TmdbCatalogSummary } from '../types/metadata'

export function CollectionsView({ onSelect, initialCollection = 'my-list' }: { onSelect: (item: TmdbCatalogSummary) => void; initialCollection?: string }) {
  const { titles, collections } = useLocalCatalog()
  const [selectedId, setSelectedId] = useState(initialCollection)
  useEffect(() => setSelectedId(initialCollection), [initialCollection])
  const [editing, setEditing] = useState<'new' | 'rename' | null>(null)
  const [name, setName] = useState('')
  const [deleting, setDeleting] = useState(false)
  const [filter, setFilter] = useState('all')
  const [sort, setSort] = useState('added')
  const [query, setQuery] = useState('')
  const selected = collections.groups.find(group => group.id === selectedId)
  const groupIndex = collections.groups.findIndex(group => group.id === selectedId)
  const isWatched = selectedId === 'watched'
  const source = isWatched ? collections.items.filter(item => collections.watched.includes(titleKey(item)))
    : selected ? collections.items.filter(item => selected.keys.includes(titleKey(item))) : titles
  const items = source.filter(item => item.title.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()))
    .filter(item => filter === 'all' || (filter === 'watched' ? collections.watched.includes(titleKey(item))
      : filter === 'unwatched' ? !collections.watched.includes(titleKey(item)) : filter === 'anime' ? item.is_anime : item.type === filter))
    .sort((a, b) => sort === 'title' ? a.title.localeCompare(b.title) : sort === 'year' ? b.year.localeCompare(a.year) : b.addedAt - a.addedAt)
  const choose = (id: string) => { setSelectedId(id); setEditing(null); setDeleting(false); setQuery(''); setFilter('all') }

  return <section className="nw-view nw-collections-view">
    <header className="nw-settings-header"><h1>Collections</h1></header>
    <div className="nw-collections-toolbar">
      <select className="nw-settings-select" aria-label="Collection" value={selectedId} onChange={event => choose(event.target.value)}>
        <option value="my-list">My List</option>
        <option value="watched">Watched</option>
        {collections.groups.map(group => <option key={group.id} value={group.id}>{group.name}</option>)}
      </select>
      <div className="nw-compact-actions">
        <button className="nw-icon-button" title="New collection" aria-label="New collection" onClick={() => { setEditing('new'); setName(''); setDeleting(false) }}><Plus width={18} height={18} /></button>
        {selected && <>
          <button className="nw-icon-button" title="Rename collection" aria-label="Rename collection" onClick={() => { setEditing('rename'); setName(selected.name); setDeleting(false) }}><EditPencil width={17} height={17} /></button>
          <button className="nw-icon-button" title="Move collection up" aria-label="Move collection up" disabled={groupIndex === 0} onClick={() => localCatalog.moveCollection(selected.id, -1)}><NavArrowUp width={18} height={18} /></button>
          <button className="nw-icon-button" title="Move collection down" aria-label="Move collection down" disabled={groupIndex === collections.groups.length - 1} onClick={() => localCatalog.moveCollection(selected.id, 1)}><NavArrowDown width={18} height={18} /></button>
          <button className="nw-icon-button" title="Delete collection" aria-label="Delete collection" onClick={() => { setDeleting(true); setEditing(null) }}><Trash width={17} height={17} /></button>
        </>}
      </div>
    </div>
    {editing && <form className="nw-inline-editor" onSubmit={event => {
      event.preventDefault()
      if (editing === 'rename' && selected) {
        if (!localCatalog.renameCollection(selected.id, name)) return
      }
      else {
        const id = localCatalog.createCollection(name)
        if (!id) return
        setSelectedId(id)
      }
      setEditing(null); setName('')
    }}>
      <input autoFocus className="nw-settings-select" aria-label="Collection name" placeholder="Collection name" value={name} maxLength={80} onChange={event => setName(event.target.value)} />
      <button type="submit" className="nw-icon-button" disabled={!name.trim()} title="Save collection" aria-label="Save collection"><Check width={18} height={18} /></button>
      <button type="button" className="nw-icon-button" title="Cancel" aria-label="Cancel" onClick={() => setEditing(null)}><Xmark width={18} height={18} /></button>
    </form>}
    {deleting && selected && <div className="nw-collection-confirm" role="group" aria-label="Confirm collection deletion">
      <p>Delete “{selected.name}”? My List, media files and Keep Watching are kept.</p>
      <button className="btn btn-ghost nw-compact-button" onClick={() => { if (localCatalog.deleteCollection(selected.id)) choose('my-list') }}>Delete collection</button>
      <button className="btn btn-ghost nw-compact-button" onClick={() => setDeleting(false)}>Cancel</button>
    </div>}
    <div className="nw-collections-toolbar">
      <label className="nw-collection-search"><Search width={16} height={16} /><input className="nw-settings-select" aria-label="Filter saved titles" placeholder="Filter titles" value={query} maxLength={200} onChange={event => setQuery(event.target.value)} /></label>
      <select className="nw-settings-select" aria-label="Filter collections" value={filter} onChange={event => setFilter(event.target.value)}>
        <option value="all">All titles</option><option value="unwatched">Unwatched</option><option value="watched">Watched</option><option value="movie">Movies</option><option value="tv">TV</option><option value="anime">Anime</option>
      </select>
      <select className="nw-settings-select" aria-label="Sort saved titles" value={sort} onChange={event => setSort(event.target.value)}>
        <option value="added">Recently added</option><option value="title">Title A–Z</option><option value="year">Year</option>
      </select>
    </div>
    {!items.length && <p className="nw-profile-note">{query || filter !== 'all' ? 'No matching titles.' : isWatched ? 'No watched titles.' : selected ? 'Add titles from their details.' : 'No saved titles.'}</p>}
    <div className="nw-movie-grid">
      {items.map(item => {
        const summary = { ...item, overview: '', rating: 0 }
        const label = isWatched ? 'Mark as Unwatched' : selected ? 'Remove from collection' : 'Remove from My List'
        return <div className="nw-keep-watching-card" key={titleKey(item)}>
          <CatalogCard item={summary} onSelect={() => onSelect(summary)} status={collections.watched.includes(titleKey(item)) ? 'Watched' : null} />
          <button type="button" className="nw-keep-watching-remove" aria-label={`${label}: ${item.title}`} title={label}
            onClick={() => isWatched ? localCatalog.toggleWatched(item) : selected ? localCatalog.setCollectionTitle(selected.id, item, false) : localCatalog.removeTitle(item)}>
            <Xmark width={20} height={20} />
          </button>
        </div>
      })}
    </div>
  </section>
}
